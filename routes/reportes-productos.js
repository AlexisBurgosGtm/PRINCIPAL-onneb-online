const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const { parseFechaInput, fechaIsoFromRow, normalizeDocumentoRows } = require('../lib/documento-fecha');
const { STATUS_ANULADO, SQL_TIPODOC_REPORTES_SI } = require('../lib/documento-status');

const router = express.Router();

const TIPODOC_VENTA = ['FAC', 'FEF', 'FEC', 'FES'];
const SQL_TIPODOC_VENTA_IN = TIPODOC_VENTA.map((t) => `'${t}'`).join(', ');

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
  AND t.TIPODOC IN (${SQL_TIPODOC_VENTA_IN})
  AND ${SQL_TIPODOC_REPORTES_SI}
`;

const SQL_JOIN_DOC = `
  INNER JOIN dbo.DOCUMENTOS d
    ON dp.EMPNIT = d.EMPNIT AND dp.CODDOC = d.CODDOC AND dp.CORRELATIVO = d.CORRELATIVO
  INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
`;

function parseCodProd(req) {
  const codprod = String(req.query.codprod ?? '').trim();
  return codprod || null;
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
          LTRIM(RTRIM(dp.CODPROD)) AS CODPROD,
          MAX(LTRIM(RTRIM(ISNULL(dp.DESPROD, '')))) AS DESPROD,
          SUM(ISNULL(dp.TOTALUNIDADES, 0)) AS TOTALUNIDADES,
          SUM(ISNULL(dp.TOTALPRECIO, 0)) AS TOTALPRECIO
        FROM dbo.DOCPRODUCTOS dp
        ${SQL_JOIN_DOC}
        WHERE ${SQL_DOC_WHERE}
        GROUP BY LTRIM(RTRIM(dp.CODPROD))
        ORDER BY SUM(ISNULL(dp.TOTALPRECIO, 0)) DESC, LTRIM(RTRIM(dp.CODPROD))
      `);

    const productos = (result.recordset || []).map((row) => ({
      CODPROD: String(row.CODPROD || '').trim(),
      DESPROD: String(row.DESPROD || '').trim(),
      TOTALUNIDADES: roundQty(row.TOTALUNIDADES),
      TOTALPRECIO: roundMoney(row.TOTALPRECIO),
    }));

    const totales = {
      unidades: roundQty(productos.reduce((s, p) => s + (Number(p.TOTALUNIDADES) || 0), 0)),
      precio: roundMoney(productos.reduce((s, p) => s + (Number(p.TOTALPRECIO) || 0), 0)),
    };

    res.json({ desde, hasta, productos, totales });
  } catch (err) {
    console.warn('[API GET /reportes-productos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/detalle', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const codprod = parseCodProd(req);
  if (!codprod) {
    return res.status(400).json({ error: 'codprod requerido' });
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
        .input('CODPROD', sql.VarChar, codprod);

    const prodWhere = `
      ${SQL_DOC_WHERE}
      AND LTRIM(RTRIM(dp.CODPROD)) = @CODPROD
    `;

    const [serieRes, docsRes, clientesRes, prodInfoRes] = await Promise.all([
      baseReq().query(`
        SELECT
          CAST(d.FECHA AS DATE) AS FECHA,
          SUM(ISNULL(dp.TOTALUNIDADES, 0)) AS UNIDADES,
          SUM(ISNULL(dp.TOTALPRECIO, 0)) AS MONTO
        FROM dbo.DOCPRODUCTOS dp
        ${SQL_JOIN_DOC}
        WHERE ${prodWhere}
        GROUP BY CAST(d.FECHA AS DATE)
        ORDER BY CAST(d.FECHA AS DATE)
      `),
      baseReq().query(`
        SELECT
          d.ID, d.FECHA, d.ANIO, d.MES, d.DIA,
          d.CODDOC, d.CORRELATIVO,
          ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
          ISNULL(d.FEL_SERIE, '') AS FEL_SERIE,
          ISNULL(d.FEL_NUMERO, '') AS FEL_NUMERO,
          UPPER(LTRIM(RTRIM(ISNULL(t.TIPODOC, '')))) AS TIPODOC,
          ISNULL(t.DESDOC, '') AS DESDOC,
          LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, ''))) AS DOC_NOMCLIE,
          SUM(ISNULL(dp.TOTALUNIDADES, 0)) AS LINE_UNIDADES,
          SUM(ISNULL(dp.TOTALPRECIO, 0)) AS LINE_PRECIO
        FROM dbo.DOCPRODUCTOS dp
        ${SQL_JOIN_DOC}
        WHERE ${prodWhere}
        GROUP BY
          d.ID, d.FECHA, d.ANIO, d.MES, d.DIA,
          d.CODDOC, d.CORRELATIVO, d.TOTALPRECIO,
          d.FEL_SERIE, d.FEL_NUMERO, t.TIPODOC, t.DESDOC, d.DOC_NOMCLIE
        ORDER BY d.FECHA, d.CODDOC, d.CORRELATIVO
      `),
      baseReq().query(`
        SELECT
          ISNULL(d.CODCLIENTE, 0) AS CODCLIENTE,
          LTRIM(RTRIM(ISNULL(d.DOC_NIT, ''))) AS DOC_NIT,
          MAX(LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, '')))) AS DOC_NOMCLIE,
          SUM(ISNULL(dp.TOTALUNIDADES, 0)) AS TOTALUNIDADES,
          SUM(ISNULL(dp.TOTALPRECIO, 0)) AS TOTALPRECIO
        FROM dbo.DOCPRODUCTOS dp
        ${SQL_JOIN_DOC}
        WHERE ${prodWhere}
        GROUP BY ISNULL(d.CODCLIENTE, 0), LTRIM(RTRIM(ISNULL(d.DOC_NIT, '')))
        ORDER BY SUM(ISNULL(dp.TOTALPRECIO, 0)) DESC
      `),
      baseReq().query(`
        SELECT TOP 1
          LTRIM(RTRIM(dp.CODPROD)) AS CODPROD,
          LTRIM(RTRIM(ISNULL(dp.DESPROD, ''))) AS DESPROD
        FROM dbo.DOCPRODUCTOS dp
        ${SQL_JOIN_DOC}
        WHERE ${prodWhere}
      `),
    ]);

    const serie = (serieRes.recordset || []).map((row) => ({
      FECHA: row.FECHA ? String(row.FECHA).slice(0, 10) : null,
      UNIDADES: roundQty(row.UNIDADES),
      MONTO: roundMoney(row.MONTO),
    }));

    const documentos = normalizeDocumentoRows(docsRes.recordset || []).map((row) => ({
      CODDOC: row.CODDOC,
      CORRELATIVO: row.CORRELATIVO,
      FECHA: fechaIsoFromRow(row) || null,
      TOTALPRECIO: roundMoney(row.TOTALPRECIO),
      TIPODOC: String(row.TIPODOC || '').trim().toUpperCase(),
      DESDOC: row.DESDOC || '',
      DOC_NOMCLIE: String(row.DOC_NOMCLIE || '').trim(),
      FEL_SERIE: String(row.FEL_SERIE || '').trim(),
      FEL_NUMERO: String(row.FEL_NUMERO || '').trim(),
      LINE_UNIDADES: roundQty(row.LINE_UNIDADES),
      LINE_PRECIO: roundMoney(row.LINE_PRECIO),
    }));

    const clientes = (clientesRes.recordset || []).map((row) => ({
      CODCLIENTE: Number(row.CODCLIENTE) || 0,
      DOC_NIT: String(row.DOC_NIT || '').trim(),
      DOC_NOMCLIE: String(row.DOC_NOMCLIE || '').trim(),
      TOTALUNIDADES: roundQty(row.TOTALUNIDADES),
      TOTALPRECIO: roundMoney(row.TOTALPRECIO),
    }));

    const info = prodInfoRes.recordset?.[0];
    const totalUnidades = roundQty(serie.reduce((s, r) => s + (Number(r.UNIDADES) || 0), 0));
    const totalPrecio = roundMoney(serie.reduce((s, r) => s + (Number(r.MONTO) || 0), 0));

    res.json({
      desde,
      hasta,
      codprod,
      desprod: String(info?.DESPROD || '').trim(),
      resumen: {
        unidades: totalUnidades,
        precio: totalPrecio,
        precioPromedio: totalUnidades > 0 ? roundMoney(totalPrecio / totalUnidades) : 0,
        numClientes: clientes.length,
        numDocumentos: documentos.length,
      },
      serie,
      documentos,
      clientes,
    });
  } catch (err) {
    console.warn('[API GET /reportes-productos/detalle]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
