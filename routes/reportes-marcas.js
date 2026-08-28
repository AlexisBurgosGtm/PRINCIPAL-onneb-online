const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const { parseFechaInput } = require('../lib/documento-fecha');
const { STATUS_ANULADO, SQL_TIPODOC_REPORTES_SI } = require('../lib/documento-status');

const router = express.Router();

const TIPODOC_VENTA = ['FAC', 'FEF', 'FEC', 'FES'];
const TIPODOC_DEVOLUCION = ['DEV', 'FNC', 'FNA'];
const TIPODOC_COMPRA = ['COM', 'COP'];

const SQL_TIPODOC_VENTA_IN = TIPODOC_VENTA.map((t) => `'${t}'`).join(', ');
const SQL_TIPODOC_DEV_IN = TIPODOC_DEVOLUCION.map((t) => `'${t}'`).join(', ');
const SQL_TIPODOC_VENTA_DEV_IN = [...TIPODOC_VENTA, ...TIPODOC_DEVOLUCION].map((t) => `'${t}'`).join(', ');
const SQL_TIPODOC_COMPRA_IN = TIPODOC_COMPRA.map((t) => `'${t}'`).join(', ');

const SQL_JOIN_LINES = `
  INNER JOIN dbo.DOCPRODUCTOS dp
    ON dp.EMPNIT = d.EMPNIT AND dp.CODDOC = d.CODDOC AND dp.CORRELATIVO = d.CORRELATIVO
`;

const SQL_JOIN_PRODUCTO_MARCA = `
  LEFT JOIN dbo.PRODUCTOS p
    ON p.EMPNIT = dp.EMPNIT AND LTRIM(RTRIM(p.CODPROD)) = LTRIM(RTRIM(dp.CODPROD))
  LEFT JOIN dbo.Marcas m ON m.EMPNIT = p.EMPNIT AND m.CODMARCA = p.CODMARCA
`;

const SQL_SIGNO_VENTA_IMPORTE = `
  CASE
    WHEN t.TIPODOC IN (${SQL_TIPODOC_VENTA_IN}) THEN ISNULL(dp.TOTALPRECIO, 0)
    WHEN t.TIPODOC IN (${SQL_TIPODOC_DEV_IN}) THEN -ISNULL(dp.TOTALPRECIO, 0)
    ELSE 0
  END
`;

const SQL_SIGNO_VENTA_UNIDADES = `
  CASE
    WHEN t.TIPODOC IN (${SQL_TIPODOC_VENTA_IN}) THEN ISNULL(dp.TOTALUNIDADES, 0)
    WHEN t.TIPODOC IN (${SQL_TIPODOC_DEV_IN}) THEN -ISNULL(dp.TOTALUNIDADES, 0)
    ELSE 0
  END
`;

const SQL_COMPRA_IMPORTE = `
  CASE WHEN t.TIPODOC IN (${SQL_TIPODOC_COMPRA_IN}) THEN ISNULL(dp.TOTALPRECIO, 0) ELSE 0 END
`;

const SQL_COMPRA_UNIDADES = `
  CASE WHEN t.TIPODOC IN (${SQL_TIPODOC_COMPRA_IN}) THEN ISNULL(dp.TOTALUNIDADES, 0) ELSE 0 END
`;

function getEmpNitFromReq(req) {
  return String(req.query.empnit || req.body?.empnit || req.headers['x-emp-nit'] || '').trim();
}

function requireEmpNit(req, res) {
  const empnit = getEmpNitFromReq(req);
  if (!empnit) {
    res.status(400).json({ error: 'EMPNIT requerido (empresa de la sesión)' });
    return null;
  }
  return empnit;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function roundQty(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function resolveRango(req) {
  const ahora = new Date();
  const y = ahora.getFullYear();
  const m = String(ahora.getMonth() + 1).padStart(2, '0');
  const d = String(ahora.getDate()).padStart(2, '0');
  const hoy = `${y}-${m}-${d}`;

  let desde = parseFechaInput(req.query.desde ?? req.body?.desde);
  let hasta = parseFechaInput(req.query.hasta ?? req.body?.hasta);
  if (!desde) desde = { fecha: hoy };
  if (!hasta) hasta = { fecha: hoy };
  if (desde.fecha > hasta.fecha) {
    const tmp = desde;
    desde = hasta;
    hasta = tmp;
  }
  return { desde: desde.fecha, hasta: hasta.fecha };
}

const SQL_DOC_WHERE = `
  d.EMPNIT = @EMPNIT
  AND CAST(d.FECHA AS DATE) BETWEEN @DESDE AND @HASTA
  AND ISNULL(d.STATUS, '') <> '${STATUS_ANULADO}'
  AND (
    (t.TIPODOC IN (${SQL_TIPODOC_VENTA_DEV_IN}) AND ${SQL_TIPODOC_REPORTES_SI})
    OR t.TIPODOC IN (${SQL_TIPODOC_COMPRA_IN})
  )
`;

const SQL_MARCA_GROUP = `
  ISNULL(p.CODMARCA, 0) AS CODMARCA,
  ISNULL(NULLIF(LTRIM(RTRIM(m.DESMARCA)), ''), 'Sin marca') AS DESMARCA
`;

function parseCodMarca(req) {
  const raw = req.query.codmarca;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const { desde, hasta } = resolveRango(req);

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('DESDE', sql.Date, desde)
      .input('HASTA', sql.Date, hasta)
      .query(`
        SELECT
          ${SQL_MARCA_GROUP},
          SUM(${SQL_SIGNO_VENTA_IMPORTE}) AS VENTAS,
          SUM(${SQL_COMPRA_IMPORTE}) AS COMPRAS,
          SUM(${SQL_SIGNO_VENTA_UNIDADES}) AS UNIDADES_VENTA,
          SUM(${SQL_COMPRA_UNIDADES}) AS UNIDADES_COMPRA
        FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        ${SQL_JOIN_LINES}
        ${SQL_JOIN_PRODUCTO_MARCA}
        WHERE ${SQL_DOC_WHERE}
        GROUP BY ISNULL(p.CODMARCA, 0), ISNULL(NULLIF(LTRIM(RTRIM(m.DESMARCA)), ''), 'Sin marca')
        ORDER BY SUM(${SQL_SIGNO_VENTA_IMPORTE}) DESC, DESMARCA
      `);

    const marcas = (result.recordset || []).map((row) => ({
      CODMARCA: Number(row.CODMARCA) || 0,
      DESMARCA: String(row.DESMARCA || 'Sin marca').trim(),
      VENTAS: roundMoney(row.VENTAS),
      COMPRAS: roundMoney(row.COMPRAS),
      UNIDADES_VENTA: roundQty(row.UNIDADES_VENTA),
      UNIDADES_COMPRA: roundQty(row.UNIDADES_COMPRA),
    }));

    const totales = {
      ventas: roundMoney(marcas.reduce((s, m) => s + (Number(m.VENTAS) || 0), 0)),
      compras: roundMoney(marcas.reduce((s, m) => s + (Number(m.COMPRAS) || 0), 0)),
      unidadesVenta: roundQty(marcas.reduce((s, m) => s + (Number(m.UNIDADES_VENTA) || 0), 0)),
      unidadesCompra: roundQty(marcas.reduce((s, m) => s + (Number(m.UNIDADES_COMPRA) || 0), 0)),
    };

    res.json({ desde, hasta, marcas, totales });
  } catch (err) {
    console.warn('[API GET /reportes-marcas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/detalle', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const codmarca = parseCodMarca(req);
  if (codmarca === null) {
    return res.status(400).json({ error: 'codmarca requerido' });
  }

  const { desde, hasta } = resolveRango(req);

  try {
    const pool = await req.app.locals.getDbPool();
    const baseReq = () =>
      pool
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('DESDE', sql.Date, desde)
        .input('HASTA', sql.Date, hasta)
        .input('CODMARCA', sql.Int, codmarca);

    const marcaWhere = `
      ${SQL_DOC_WHERE}
      AND ISNULL(p.CODMARCA, 0) = @CODMARCA
    `;

    const [serieRes, prodsRes, clientesRes, proveedoresRes, infoRes] = await Promise.all([
      baseReq().query(`
        SELECT
          CAST(d.FECHA AS DATE) AS FECHA,
          SUM(${SQL_SIGNO_VENTA_UNIDADES}) AS UNIDADES_VENTA,
          SUM(${SQL_SIGNO_VENTA_IMPORTE}) AS VENTAS,
          SUM(${SQL_COMPRA_IMPORTE}) AS COMPRAS
        FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        ${SQL_JOIN_LINES}
        ${SQL_JOIN_PRODUCTO_MARCA}
        WHERE ${marcaWhere}
        GROUP BY CAST(d.FECHA AS DATE)
        ORDER BY CAST(d.FECHA AS DATE)
      `),
      baseReq().query(`
        SELECT
          LTRIM(RTRIM(dp.CODPROD)) AS CODPROD,
          MAX(LTRIM(RTRIM(ISNULL(dp.DESPROD, '')))) AS DESPROD,
          SUM(${SQL_SIGNO_VENTA_UNIDADES}) AS UNIDADES_VENTA,
          SUM(${SQL_SIGNO_VENTA_IMPORTE}) AS VENTAS,
          SUM(${SQL_COMPRA_UNIDADES}) AS UNIDADES_COMPRA,
          SUM(${SQL_COMPRA_IMPORTE}) AS COMPRAS
        FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        ${SQL_JOIN_LINES}
        ${SQL_JOIN_PRODUCTO_MARCA}
        WHERE ${marcaWhere}
        GROUP BY LTRIM(RTRIM(dp.CODPROD))
        ORDER BY SUM(${SQL_SIGNO_VENTA_IMPORTE}) DESC, LTRIM(RTRIM(dp.CODPROD))
      `),
      baseReq().query(`
        SELECT
          ISNULL(d.CODCLIENTE, 0) AS CODCLIENTE,
          LTRIM(RTRIM(ISNULL(d.DOC_NIT, ''))) AS DOC_NIT,
          MAX(LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, '')))) AS DOC_NOMCLIE,
          SUM(${SQL_SIGNO_VENTA_UNIDADES}) AS UNIDADES_VENTA,
          SUM(${SQL_SIGNO_VENTA_IMPORTE}) AS VENTAS
        FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        ${SQL_JOIN_LINES}
        ${SQL_JOIN_PRODUCTO_MARCA}
        WHERE ${marcaWhere}
          AND t.TIPODOC IN (${SQL_TIPODOC_VENTA_DEV_IN})
        GROUP BY ISNULL(d.CODCLIENTE, 0), LTRIM(RTRIM(ISNULL(d.DOC_NIT, '')))
        ORDER BY SUM(${SQL_SIGNO_VENTA_IMPORTE}) DESC
      `),
      baseReq().query(`
        SELECT
          ISNULL(d.CODCLIENTE, 0) AS CODPROVEEDOR,
          LTRIM(RTRIM(ISNULL(d.DOC_NIT, ''))) AS DOC_NIT,
          MAX(LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, '')))) AS DOC_NOMCLIE,
          SUM(${SQL_COMPRA_UNIDADES}) AS UNIDADES_COMPRA,
          SUM(${SQL_COMPRA_IMPORTE}) AS COMPRAS
        FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        ${SQL_JOIN_LINES}
        ${SQL_JOIN_PRODUCTO_MARCA}
        WHERE ${marcaWhere}
          AND t.TIPODOC IN (${SQL_TIPODOC_COMPRA_IN})
        GROUP BY ISNULL(d.CODCLIENTE, 0), LTRIM(RTRIM(ISNULL(d.DOC_NIT, '')))
        ORDER BY SUM(${SQL_COMPRA_IMPORTE}) DESC
      `),
      baseReq().query(`
        SELECT TOP 1
          ISNULL(NULLIF(LTRIM(RTRIM(m.DESMARCA)), ''), 'Sin marca') AS DESMARCA
        FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        ${SQL_JOIN_LINES}
        ${SQL_JOIN_PRODUCTO_MARCA}
        WHERE ${marcaWhere}
      `),
    ]);

    const serie = (serieRes.recordset || []).map((row) => ({
      FECHA: row.FECHA ? String(row.FECHA).slice(0, 10) : null,
      UNIDADES_VENTA: roundQty(row.UNIDADES_VENTA),
      VENTAS: roundMoney(row.VENTAS),
      COMPRAS: roundMoney(row.COMPRAS),
    }));

    const productos = (prodsRes.recordset || []).map((row) => ({
      CODPROD: row.CODPROD,
      DESPROD: row.DESPROD || '',
      UNIDADES_VENTA: roundQty(row.UNIDADES_VENTA),
      VENTAS: roundMoney(row.VENTAS),
      UNIDADES_COMPRA: roundQty(row.UNIDADES_COMPRA),
      COMPRAS: roundMoney(row.COMPRAS),
    }));

    const clientes = (clientesRes.recordset || []).map((row) => ({
      CODCLIENTE: Number(row.CODCLIENTE) || 0,
      DOC_NIT: String(row.DOC_NIT || '').trim(),
      DOC_NOMCLIE: String(row.DOC_NOMCLIE || '').trim(),
      UNIDADES_VENTA: roundQty(row.UNIDADES_VENTA),
      VENTAS: roundMoney(row.VENTAS),
    }));

    const proveedores = (proveedoresRes.recordset || []).map((row) => ({
      CODPROVEEDOR: Number(row.CODPROVEEDOR) || 0,
      DOC_NIT: String(row.DOC_NIT || '').trim(),
      DOC_NOMCLIE: String(row.DOC_NOMCLIE || '').trim(),
      UNIDADES_COMPRA: roundQty(row.UNIDADES_COMPRA),
      COMPRAS: roundMoney(row.COMPRAS),
    }));

    const ventas = roundMoney(serie.reduce((s, r) => s + (Number(r.VENTAS) || 0), 0));
    const compras = roundMoney(serie.reduce((s, r) => s + (Number(r.COMPRAS) || 0), 0));
    const unidadesVenta = roundQty(serie.reduce((s, r) => s + (Number(r.UNIDADES_VENTA) || 0), 0));
    const unidadesCompra = roundQty(
      productos.reduce((s, p) => s + (Number(p.UNIDADES_COMPRA) || 0), 0)
    );

    res.json({
      desde,
      hasta,
      codmarca,
      desmarca: String(infoRes.recordset?.[0]?.DESMARCA || 'Sin marca').trim(),
      resumen: {
        ventas,
        compras,
        margen: roundMoney(ventas - compras),
        unidadesVenta,
        unidadesCompra,
        numProductos: productos.length,
        numClientes: clientes.length,
        numProveedores: proveedores.length,
      },
      serie,
      productos,
      clientes,
      proveedores,
    });
  } catch (err) {
    console.warn('[API GET /reportes-marcas/detalle]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
