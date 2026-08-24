const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const { STATUS_OPERADO, SQL_TIPODOC_REPORTES_SI } = require('../lib/documento-status');
const { fechaIsoFromValue } = require('../lib/documento-fecha');
const {
  SQL_TIPODOC_CUENTAS_COBRAR_IN,
  SQL_DOC_SALDO_PENDIENTE,
  SQL_DOC_SALDO_PENDIENTE_POSITIVO,
} = require('../lib/cuentas-docs');
const {
  parseCorrelativo,
  loadFacturaCxc,
  fetchAbonosFactura,
  crearAbonoRcc,
  crearAbonoRar,
  corregirSaldosCxc,
  listTiposDocRcc,
  previewSiguienteRcc,
  listTiposDocRar,
  previewSiguienteRar,
  listRetencionesFelDeFac,
} = require('../lib/cuentas-abono');
const { fetchEstadoCuentaCliente } = require('../lib/cuentas-estado-cliente');
const { fetchSaldoMesesCxc } = require('../lib/cuentas-saldo-meses');
const { fetchConsolidadoProductos, fetchConsolidadoProductoDocumentos } = require('../lib/cuentas-consolidado-productos');
const {
  fetchResumenPartes,
  partyFilterSql,
  bindPartyFilter,
  SQL_NOMBRE_CLIENTE,
  SQL_JOIN_CLIENTES,
} = require('../lib/cuentas-resumen-partes');
const { listCajasAbiertasConDefault } = require('../lib/empleado-coddoc-preferido');

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
  // DOC_SALDO ya es el restante; SALDO_PENDIENTE del SQL debe coincidir.
  const saldoPendiente = toNumber(r.SALDO_PENDIENTE ?? docSaldo);
  return {
    FECHA: fechaIsoFromValue(r.FECHA) || null,
    VENCIMIENTO: fechaIsoFromValue(r.VENCIMIENTO) || null,
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
    CODCLIENTE: r.CODCLIENTE ?? null,
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
  const hasParty = req.query.codcliente !== undefined && String(req.query.codcliente) !== '';
  const partyFilter = hasParty
    ? partyFilterSql(req.query.codcliente, req.query.nit, req.query.nombre)
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
      LEFT JOIN dbo.CLIENTES c ON d.EMPNIT = c.EMPNIT AND d.CODCLIENTE = c.CODCLIENTE
    `;
    const sqlEmpleadoNombre = `ISNULL((
      SELECT TOP 1 e.NOMEMPLEADO
      FROM dbo.Empleados e
      WHERE e.EMPNIT = d.EMPNIT AND e.CODEMPLEADO = d.CODVEN
    ), '')`;
    const partyWhere = partyFilter ? partyFilter.sql : '';
    const baseWhere = `
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_COBRAR_IN})
        AND d.STATUS = '${STATUS_OPERADO}'
        AND ISNULL(d.CONCRE, 'CON') = 'CRE'
        AND ${SQL_TIPODOC_REPORTES_SI}
        AND ${SQL_DOC_SALDO_PENDIENTE_POSITIVO}
        ${partyWhere}
        AND (
          @q IS NULL OR @q = ''
          OR CAST(d.CORRELATIVO AS VARCHAR(30)) LIKE @qLike
          OR d.CODDOC LIKE @qLike
          OR t.DESDOC LIKE @qLike
          OR d.DOC_NOMCLIE LIKE @qLike
          OR c.NEGOCIO LIKE @qLike
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
        c.NEGOCIO,
        ${sqlEmpleadoNombre} AS NOMEMPLEADO,
        ${sqlEmpleadoNombre} AS EMPLEADO,
        ${sqlEmpleadoNombre} AS VENDEDOR,
        d.CODCLIENTE,
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
      tiposFactura: ['FAC', 'FEF', 'FEC', 'FES'],
    });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/documentos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/saldo-meses', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await fetchSaldoMesesCxc(pool, sql, empnit, {
      mes: req.query.mes,
      anio: req.query.anio,
    });
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/saldo-meses]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/resumen-clientes', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await fetchResumenPartes(pool, sql, empnit, {
      tipodocSqlIn: SQL_TIPODOC_CUENTAS_COBRAR_IN,
      saldoWhereSql: SQL_DOC_SALDO_PENDIENTE_POSITIVO,
      extraWhereSql: SQL_TIPODOC_REPORTES_SI,
      partyJoinSql: SQL_JOIN_CLIENTES,
      partyNameSql: SQL_NOMBRE_CLIENTE,
      q: req.query.q,
    });
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/resumen-clientes]', err.message);
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
      tipodocSqlIn: SQL_TIPODOC_CUENTAS_COBRAR_IN,
      saldoWhereSql: `${SQL_DOC_SALDO_PENDIENTE_POSITIVO} AND ${SQL_TIPODOC_REPORTES_SI}`,
    });
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/consolidado-productos]', err.message);
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
      tipodocSqlIn: SQL_TIPODOC_CUENTAS_COBRAR_IN,
      saldoWhereSql: `${SQL_DOC_SALDO_PENDIENTE_POSITIVO} AND ${SQL_TIPODOC_REPORTES_SI}`,
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
    console.warn('[API GET /cuentas-cobrar/consolidado-productos/detalle]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/clientes/:codcliente/estado-cuenta', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await fetchEstadoCuentaCliente(pool, sql, empnit, req.params.codcliente);
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/clientes/estado-cuenta]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/rcc/tipos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await listTiposDocRcc(pool, sql, empnit);
    res.json({ rows, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/rcc/tipos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/cajas-abiertas', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await listCajasAbiertasConDefault(pool, sql, empnit, req.query.codempleado);
    res.json({
      rows: data.rows || [],
      cajaDefault: data.cajaDefault,
      preferredCaja: data.preferredCaja,
      empnit,
    });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/cajas-abiertas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/rcc/siguiente', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.query.coddoc || '').trim() || null;
  try {
    const pool = await req.app.locals.getDbPool();
    const rcc = await previewSiguienteRcc(pool, sql, empnit, coddoc);
    if (!rcc) {
      return res.status(404).json({
        error: coddoc
          ? `No hay documento RCC activo con código ${coddoc}`
          : 'No hay tipo de documento RCC activo para la empresa',
      });
    }
    res.json({ rcc, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/rcc/siguiente]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/facturas/:coddoc/:correlativo', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const row = await loadFacturaCxc(pool, sql, empnit, coddoc, correlativo);
    if (!row) return res.status(404).json({ error: 'Factura no encontrada' });
    const abonos = await fetchAbonosFactura(pool, sql, empnit, coddoc, correlativo);
    res.json({
      factura: mapRow({
        ...row,
        NOMEMPLEADO: row.VENDEDOR,
        EMPLEADO: row.VENDEDOR,
        VENDEDOR: row.VENDEDOR,
      }),
      abonos,
    });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/facturas/:coddoc/:correlativo]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/facturas/:coddoc/:correlativo/abonos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await fetchAbonosFactura(pool, sql, empnit, coddoc, correlativo);
    res.json({ rows, empnit, factura: { CODDOC: coddoc, CORRELATIVO: correlativo } });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/facturas/abonos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/corregir-saldos', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await corregirSaldosCxc(pool, sql, empnit);
    res.json({ ...result, empnit });
  } catch (err) {
    console.warn('[API POST /cuentas-cobrar/corregir-saldos]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/facturas/:coddoc/:correlativo/abonos', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await crearAbonoRcc(pool, sql, empnit, coddoc, correlativo, req.body);
    res.status(201).json(result);
  } catch (err) {
    console.warn('[API POST /cuentas-cobrar/facturas/abonos]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/rar/tipos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await listTiposDocRar(pool, sql, empnit);
    res.json({ rows, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/rar/tipos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/rar/siguiente', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.query.coddoc || '').trim() || null;
  try {
    const pool = await req.app.locals.getDbPool();
    const rar = await previewSiguienteRar(pool, sql, empnit, coddoc);
    if (!rar) {
      return res.status(404).json({
        error: coddoc
          ? `No hay documento RAR activo con código ${coddoc}`
          : 'No hay tipo de documento RAR activo. Créelo en Tipo Documentos (TIPODOC = RAR).',
      });
    }
    res.json({ rar, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/rar/siguiente]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/facturas/:coddoc/:correlativo/retenciones-fel', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await listRetencionesFelDeFac(pool, sql, empnit, coddoc, correlativo);
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /cuentas-cobrar/facturas/retenciones-fel]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/facturas/:coddoc/:correlativo/abono-rar', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await crearAbonoRar(pool, sql, empnit, coddoc, correlativo, req.body);
    res.status(201).json(result);
  } catch (err) {
    console.warn('[API POST /cuentas-cobrar/facturas/abono-rar]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
