const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const { STATUS_OPERADO } = require('../lib/documento-status');
const { fechaIsoFromValue } = require('../lib/documento-fecha');
const {
  SQL_TIPODOC_CUENTAS_PAGAR_IN,
  SQL_DOC_SALDO_PENDIENTE,
  SQL_DOC_SALDO_PENDIENTE_POSITIVO,
} = require('../lib/cuentas-pagar-docs');
const {
  parseCorrelativo,
  loadCompraCxp,
  fetchPagosCompra,
  crearPagoRcp,
  listTiposDocRcp,
  previewSiguienteRcp,
  corregirSaldosCxp,
} = require('../lib/cuentas-pago');
const { fetchEstadoCuentaProveedor } = require('../lib/cuentas-estado-proveedor');
const { fetchConsolidadoProductos, fetchConsolidadoProductoDocumentos } = require('../lib/cuentas-consolidado-productos');
const {
  fetchResumenPartes,
  partyFilterSql,
  bindPartyFilter,
  SQL_NOMBRE_PROVEEDOR,
  SQL_JOIN_PROVEEDORES,
} = require('../lib/cuentas-resumen-partes');

const router = express.Router();
const DEFAULT_LIMIT = 500;
const SEARCH_LIMIT = 500;
const PARTY_DOC_LIMIT = 10000;

function getEmpNitFromReq(req) {
  return String(req.query.empnit || req.headers['x-emp-nit'] || '').trim();
}

function requireEmpNit(req, res) {
  const empnit = getEmpNitFromReq(req);
  if (!empnit) {
    res.status(400).json({ error: 'EMPNIT requerido (empresa de la sesión)' });
    return null;
  }
  return empnit;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapRow(r) {
  const docSaldo = toNumber(r.DOC_SALDO);
  const docAbono = toNumber(r.DOC_ABONO);
  const saldoPendiente = toNumber(r.SALDO_PENDIENTE ?? docSaldo);
  return {
    FECHA: r.FECHA ?? null,
    VENCIMIENTO: r.VENCIMIENTO ?? null,
    CODDOC: r.CODDOC ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: r.TIPODOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    DOC_NOMCLIE: r.DOC_NOMCLIE ?? null,
    DOC_NIT: r.DOC_NIT ?? null,
    NEGOCIO: r.NEGOCIO ?? null,
    VENDEDOR: String(r.VENDEDOR ?? r.NOMEMPLEADO ?? '').trim(),
    EMPLEADO: String(r.EMPLEADO ?? r.NOMEMPLEADO ?? r.VENDEDOR ?? '').trim(),
    CODVEN: r.CODVEN ?? null,
    CODPROV: r.CODPROV ?? r.CODCLIENTE ?? null,
    TOTALPRECIO: toNumber(r.TOTALPRECIO),
    DOC_SALDO: docSaldo,
    DOC_ABONO: docAbono,
    SALDO_PENDIENTE: saldoPendiente,
    CONCRE: r.CONCRE ?? null,
    STATUS: r.STATUS ?? null,
    FEL_UUDI: r.FEL_UUDI ?? null,
    FEL_SERIE: r.FEL_SERIE ?? null,
    FEL_NUMERO: r.FEL_NUMERO ?? null,
    CORTE: r.CORTE ?? null,
  };
}

router.get('/documentos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const q = String(req.query.q || '').trim();
  const qLike = q ? `%${q}%` : null;
  const hasParty = req.query.codprov !== undefined && String(req.query.codprov) !== '';
  const partyFilter = hasParty
    ? partyFilterSql(req.query.codprov, req.query.nit, req.query.nombre)
    : null;
  let limit = DEFAULT_LIMIT;
  const requested = parseInt(req.query.limit, 10);
  if (!Number.isNaN(requested)) {
    limit = Math.min(Math.max(requested, 1), hasParty ? PARTY_DOC_LIMIT : SEARCH_LIMIT);
  } else if (hasParty) {
    limit = PARTY_DOC_LIMIT;
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const baseFrom = `
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.PROVEEDORES p ON d.EMPNIT = p.EMPNIT AND d.CODCLIENTE = p.CODPROV
    `;
    const sqlEmpleadoNombre = `ISNULL((
      SELECT TOP 1 e.NOMEMPLEADO
      FROM dbo.Empleados e
      WHERE e.EMPNIT = d.EMPNIT AND e.CODEMPLEADO = d.CODVEN
    ), '')`;
    const partyWhere = partyFilter ? partyFilter.sql : '';
    const baseWhere = `
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_PAGAR_IN})
        AND d.STATUS = '${STATUS_OPERADO}'
        AND ISNULL(d.CONCRE, 'CON') = 'CRE'
        AND ${SQL_DOC_SALDO_PENDIENTE_POSITIVO}
        ${partyWhere}
        AND (
          @q IS NULL OR @q = ''
          OR CAST(d.CORRELATIVO AS VARCHAR(30)) LIKE @qLike
          OR d.CODDOC LIKE @qLike
          OR t.DESDOC LIKE @qLike
          OR d.DOC_NOMCLIE LIKE @qLike
          OR p.EMPRESA LIKE @qLike
          OR p.RAZONSOCIAL LIKE @qLike
          OR d.DOC_NIT LIKE @qLike
          OR ${sqlEmpleadoNombre} LIKE @qLike
          OR t.TIPODOC LIKE @qLike
        )
    `;

    const bind = (request) => {
      request
        .input('EMPNIT', sql.VarChar, empnit)
        .input('q', sql.NVarChar, q || null)
        .input('qLike', sql.NVarChar, qLike);
      if (partyFilter) bindPartyFilter(request, sql, partyFilter);
      return request;
    };

    const totalsRes = await bind(pool.request()).query(`
      SELECT
        COUNT(*) AS total,
        ISNULL(SUM(ISNULL(d.DOC_SALDO, 0)), 0) AS sumSaldo,
        ISNULL(SUM(ISNULL(d.DOC_ABONO, 0)), 0) AS sumAbono,
        ISNULL(SUM(ISNULL(d.TOTALPRECIO, 0)), 0) AS sumTotal
      ${baseFrom}
      ${baseWhere}
    `);
    const totals = totalsRes.recordset[0] || {};

    const listReq = bind(pool.request()).input('limit', sql.Int, limit);
    const listRes = await listReq.query(`
      SELECT TOP (@limit)
        d.FECHA,
        d.VENCIMIENTO,
        d.CODDOC,
        t.DESDOC,
        t.TIPODOC,
        d.CORRELATIVO,
        d.DOC_NOMCLIE,
        d.DOC_NIT,
        p.EMPRESA AS NEGOCIO,
        ${sqlEmpleadoNombre} AS NOMEMPLEADO,
        ${sqlEmpleadoNombre} AS EMPLEADO,
        ${sqlEmpleadoNombre} AS VENDEDOR,
        d.CODCLIENTE AS CODPROV,
        d.CODVEN,
        ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
        ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
        ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
        ${SQL_DOC_SALDO_PENDIENTE} AS SALDO_PENDIENTE,
        ISNULL(d.CONCRE, 'CON') AS CONCRE,
        d.STATUS,
        ISNULL(d.CORTE, 'NO') AS CORTE,
        d.FEL_UUDI,
        d.FEL_SERIE,
        d.FEL_NUMERO
      ${baseFrom}
      ${baseWhere}
      ORDER BY
        CASE WHEN d.VENCIMIENTO IS NULL THEN 1 ELSE 0 END,
        d.VENCIMIENTO ASC,
        d.FECHA DESC,
        d.CORRELATIVO DESC
    `);

    const rows = listRes.recordset.map(mapRow);
    const total = Number(totals.total) || 0;

    res.json({
      rows,
      total,
      sumSaldo: toNumber(totals.sumSaldo),
      sumAbono: toNumber(totals.sumAbono),
      sumTotal: toNumber(totals.sumTotal),
      limit,
      truncated: total > rows.length,
      empnit,
      q: q || null,
      tiposCompra: ['COM', 'COP'],
    });
  } catch (err) {
    console.warn('[API GET /cuentas-pagar/documentos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/resumen-proveedores', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await fetchResumenPartes(pool, sql, empnit, {
      tipodocSqlIn: SQL_TIPODOC_CUENTAS_PAGAR_IN,
      saldoWhereSql: SQL_DOC_SALDO_PENDIENTE_POSITIVO,
      partyJoinSql: SQL_JOIN_PROVEEDORES,
      partyNameSql: SQL_NOMBRE_PROVEEDOR,
      q: req.query.q,
    });
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-pagar/resumen-proveedores]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/consolidado-productos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await fetchConsolidadoProductos(pool, sql, empnit, {
      tipodocSqlIn: SQL_TIPODOC_CUENTAS_PAGAR_IN,
      saldoWhereSql: SQL_DOC_SALDO_PENDIENTE_POSITIVO,
    });
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-pagar/consolidado-productos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/consolidado-productos/detalle', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await fetchConsolidadoProductoDocumentos(pool, sql, empnit, req.query.codprod, {
      tipodocSqlIn: SQL_TIPODOC_CUENTAS_PAGAR_IN,
      saldoWhereSql: SQL_DOC_SALDO_PENDIENTE_POSITIVO,
    });
    res.json({
      ...data,
      rows: data.rows.map((r) => ({
        ...r,
        FECHA: fechaIsoFromValue(r.FECHA) || null,
        VENCIMIENTO: fechaIsoFromValue(r.VENCIMIENTO) || null,
      })),
      empnit,
    });
  } catch (err) {
    console.warn('[API GET /cuentas-pagar/consolidado-productos/detalle]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/proveedores/:codprov/estado-cuenta', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await fetchEstadoCuentaProveedor(pool, sql, empnit, req.params.codprov);
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-pagar/proveedores/estado-cuenta]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/rcp/tipos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await listTiposDocRcp(pool, sql, empnit);
    res.json({ rows, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-pagar/rcp/tipos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/rcp/siguiente', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.query.coddoc || '').trim() || null;
  try {
    const pool = await req.app.locals.getDbPool();
    const rcp = await previewSiguienteRcp(pool, sql, empnit, coddoc);
    if (!rcp) {
      return res.status(404).json({
        error: coddoc
          ? `No hay documento RCP activo con código ${coddoc}`
          : 'No hay tipo de documento RCP activo para la empresa',
      });
    }
    res.json({ rcp, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-pagar/rcp/siguiente]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/compras/:coddoc/:correlativo', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const row = await loadCompraCxp(pool, sql, empnit, coddoc, correlativo);
    if (!row) return res.status(404).json({ error: 'Compra no encontrada' });
    const pagos = await fetchPagosCompra(pool, sql, empnit, coddoc, correlativo);
    res.json({
      compra: mapRow({
        ...row,
        NOMEMPLEADO: row.VENDEDOR,
        EMPLEADO: row.VENDEDOR,
        VENDEDOR: row.VENDEDOR,
        CODPROV: row.CODCLIENTE,
      }),
      pagos,
    });
  } catch (err) {
    console.warn('[API GET /cuentas-pagar/compras/:coddoc/:correlativo]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/compras/:coddoc/:correlativo/pagos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await fetchPagosCompra(pool, sql, empnit, coddoc, correlativo);
    res.json({ rows, empnit, compra: { CODDOC: coddoc, CORRELATIVO: correlativo } });
  } catch (err) {
    console.warn('[API GET /cuentas-pagar/compras/pagos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/corregir-saldos', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await corregirSaldosCxp(pool, sql, empnit);
    res.json({ ...result, empnit });
  } catch (err) {
    console.warn('[API POST /cuentas-pagar/corregir-saldos]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/compras/:coddoc/:correlativo/pagos', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await crearPagoRcp(pool, sql, empnit, coddoc, correlativo, req.body);
    res.status(201).json(result);
  } catch (err) {
    console.warn('[API POST /cuentas-pagar/compras/pagos]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
