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

const SQL_BASE_WHERE = `
  d.EMPNIT = @EMPNIT
  AND CAST(d.FECHA AS DATE) BETWEEN @DESDE AND @HASTA
  AND ISNULL(d.STATUS, '') <> '${STATUS_ANULADO}'
  AND t.TIPODOC IN (${SQL_TIPODOC_VENTA_IN})
  AND ${SQL_TIPODOC_REPORTES_SI}
`;

const SQL_JOIN_LINES = `
  INNER JOIN dbo.DOCPRODUCTOS dp
    ON dp.EMPNIT = d.EMPNIT AND dp.CODDOC = d.CODDOC AND dp.CORRELATIVO = d.CORRELATIVO
`;

function parseClienteParams(req) {
  const codcliente = parseInt(req.query.codcliente, 10);
  const docNit = String(req.query.doc_nit ?? '').trim();
  if (!Number.isFinite(codcliente) && !docNit) {
    return null;
  }
  return {
    codcliente: Number.isFinite(codcliente) ? codcliente : 0,
    docNit,
  };
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
          ISNULL(d.CODCLIENTE, 0) AS CODCLIENTE,
          LTRIM(RTRIM(ISNULL(d.DOC_NIT, ''))) AS DOC_NIT,
          MAX(LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, '')))) AS DOC_NOMCLIE,
          SUM(ISNULL(d.TOTALPRECIO, 0)) AS MONTO,
          SUM(ISNULL(dp.TOTALUNIDADES, 0)) AS TOTALUNIDADES
        FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        ${SQL_JOIN_LINES}
        WHERE ${SQL_BASE_WHERE}
        GROUP BY ISNULL(d.CODCLIENTE, 0), LTRIM(RTRIM(ISNULL(d.DOC_NIT, '')))
        ORDER BY SUM(ISNULL(d.TOTALPRECIO, 0)) DESC, MAX(LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, ''))))
      `);

    const clientes = (result.recordset || []).map((row) => ({
      CODCLIENTE: Number(row.CODCLIENTE) || 0,
      DOC_NIT: String(row.DOC_NIT || '').trim(),
      DOC_NOMCLIE: String(row.DOC_NOMCLIE || '').trim(),
      MONTO: roundMoney(row.MONTO),
      TOTALUNIDADES: roundQty(row.TOTALUNIDADES),
    }));

    const totales = {
      unidades: roundQty(clientes.reduce((s, c) => s + (Number(c.TOTALUNIDADES) || 0), 0)),
      precio: roundMoney(clientes.reduce((s, c) => s + (Number(c.MONTO) || 0), 0)),
    };

    res.json({ desde, hasta, clientes, totales });
  } catch (err) {
    console.warn('[API GET /reportes-clientes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/detalle', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const cliente = parseClienteParams(req);
  if (!cliente) {
    return res.status(400).json({ error: 'codcliente o doc_nit requerido' });
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
        .input('CODCLIENTE', sql.Int, cliente.codcliente)
        .input('DOC_NIT', sql.VarChar, cliente.docNit);

    const clientWhere = `
      ${SQL_BASE_WHERE}
      AND ISNULL(d.CODCLIENTE, 0) = @CODCLIENTE
      AND LTRIM(RTRIM(ISNULL(d.DOC_NIT, ''))) = @DOC_NIT
    `;

    const [serieRes, docsRes, prodsRes, infoRes] = await Promise.all([
      baseReq().query(`
        SELECT
          CAST(d.FECHA AS DATE) AS FECHA,
          SUM(ISNULL(dp.TOTALUNIDADES, 0)) AS UNIDADES,
          SUM(ISNULL(dp.TOTALPRECIO, 0)) AS MONTO
        FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        ${SQL_JOIN_LINES}
        WHERE ${clientWhere}
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
          ISNULL(t.DESDOC, '') AS DESDOC
        FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        WHERE ${clientWhere}
        ORDER BY d.FECHA, d.CODDOC, d.CORRELATIVO
      `),
      baseReq().query(`
        SELECT
          LTRIM(RTRIM(dp.CODPROD)) AS CODPROD,
          MAX(LTRIM(RTRIM(ISNULL(dp.DESPROD, '')))) AS DESPROD,
          SUM(ISNULL(dp.TOTALUNIDADES, 0)) AS TOTALUNIDADES,
          SUM(ISNULL(dp.TOTALPRECIO, 0)) AS TOTALPRECIO
        FROM dbo.DOCPRODUCTOS dp
        INNER JOIN dbo.DOCUMENTOS d
          ON dp.EMPNIT = d.EMPNIT AND dp.CODDOC = d.CODDOC AND dp.CORRELATIVO = d.CORRELATIVO
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        WHERE ${clientWhere}
        GROUP BY LTRIM(RTRIM(dp.CODPROD))
        ORDER BY SUM(ISNULL(dp.TOTALPRECIO, 0)) DESC, LTRIM(RTRIM(dp.CODPROD))
      `),
      baseReq().query(`
        SELECT TOP 1
          MAX(LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, '')))) AS DOC_NOMCLIE
        FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        WHERE ${clientWhere}
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
      FEL_SERIE: String(row.FEL_SERIE || '').trim(),
      FEL_NUMERO: String(row.FEL_NUMERO || '').trim(),
    }));

    const productos = (prodsRes.recordset || []).map((row) => ({
      CODPROD: row.CODPROD,
      DESPROD: row.DESPROD || '',
      TOTALUNIDADES: roundQty(row.TOTALUNIDADES),
      TOTALPRECIO: roundMoney(row.TOTALPRECIO),
    }));

    const totalUnidades = roundQty(serie.reduce((s, r) => s + (Number(r.UNIDADES) || 0), 0));
    const totalPrecio = roundMoney(serie.reduce((s, r) => s + (Number(r.MONTO) || 0), 0));
    const numDocumentos = documentos.length;
    const ticketPromedio = numDocumentos > 0 ? roundMoney(totalPrecio / numDocumentos) : 0;

    res.json({
      desde,
      hasta,
      codcliente: cliente.codcliente,
      doc_nit: cliente.docNit,
      doc_nomclie: String(infoRes.recordset?.[0]?.DOC_NOMCLIE || '').trim(),
      resumen: {
        unidades: totalUnidades,
        precio: totalPrecio,
        precioPromedio: totalUnidades > 0 ? roundMoney(totalPrecio / totalUnidades) : 0,
        ticketPromedio,
        numProductos: productos.length,
        numDocumentos,
      },
      serie,
      documentos,
      productos,
    });
  } catch (err) {
    console.warn('[API GET /reportes-clientes/detalle]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
