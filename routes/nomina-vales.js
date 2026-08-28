const express = require('express');
const { isDbConfigured } = require('../config/database');
const {
  parseMesAnio,
  listVales,
  listValesPendientesEmpleado,
  listEmpleadosActivosCombo,
  listCajasAbiertas,
  listCuentasBancariasCombo,
  createVale,
  updateVale,
  deleteVale,
  listPagosVale,
  crearPagoVale,
  eliminarPagoVale,
} = require('../lib/nomina-vales');
const {
  resolveEmpleadoCoddocPreferido,
  pickCajaDefault,
  OPCION_SERIES,
} = require('../lib/empleado-coddoc-preferido');
const sql = require('mssql');

const router = express.Router();

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

async function cajasConDefault(pool, empnit, codempleado) {
  const cajas = await listCajasAbiertas(pool, empnit);
  const preferred = await resolveEmpleadoCoddocPreferido(
    pool,
    sql,
    empnit,
    codempleado,
    OPCION_SERIES.CAJAS
  );
  return {
    cajas,
    cajaDefault: pickCajaDefault(cajas, preferred),
    preferredCaja: preferred,
  };
}

router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const { mes, anio } = parseMesAnio(req.query.mes, req.query.anio);
  try {
    const pool = await req.app.locals.getDbPool();
    const [rows, empleados, cajaData, cuentas] = await Promise.all([
      listVales(pool, empnit, mes, anio),
      listEmpleadosActivosCombo(pool, empnit),
      cajasConDefault(pool, empnit, req.query.codempleado),
      listCuentasBancariasCombo(pool, empnit),
    ]);
    res.json({
      mes,
      anio,
      rows,
      empleados,
      cajas: cajaData.cajas,
      cajaDefault: cajaData.cajaDefault,
      preferredCaja: cajaData.preferredCaja,
      cuentas,
    });
  } catch (err) {
    console.warn('[API GET /nomina/vales]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/** Vales pendientes (saldo > 0) de un empleado — deducciones de nómina. */
router.get('/pendientes/:codemp', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codemp = parseInt(req.params.codemp, 10);
  if (!Number.isFinite(codemp) || codemp <= 0) {
    return res.status(400).json({ error: 'CODEMP inválido' });
  }
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await listValesPendientesEmpleado(pool, empnit, codemp);
    const totalCuota = rows.reduce((s, r) => s + (Number(r.CUOTA_SUGERIDA) || 0), 0);
    const totalSaldo = rows.reduce((s, r) => s + (Number(r.SALDO) || 0), 0);
    res.json({
      CODEMP: codemp,
      rows,
      totalCuota: Math.round(totalCuota * 1000) / 1000,
      totalSaldo: Math.round(totalSaldo * 1000) / 1000,
    });
  } catch (err) {
    console.warn('[API GET /nomina/vales/pendientes/:codemp]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/lookups', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const [empleados, cajaData, cuentas] = await Promise.all([
      listEmpleadosActivosCombo(pool, empnit),
      cajasConDefault(pool, empnit, req.query.codempleado),
      listCuentasBancariasCombo(pool, empnit),
    ]);
    res.json({
      empleados,
      cajas: cajaData.cajas,
      cajaDefault: cajaData.cajaDefault,
      preferredCaja: cajaData.preferredCaja,
      cuentas,
    });
  } catch (err) {
    console.warn('[API GET /nomina/vales/lookups]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await createVale(pool, empnit, req.body || {});
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    console.warn('[API POST /nomina/vales]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const body = { ...(req.body || {}) };
    if (req.query.mes != null) body.listMes = req.query.mes;
    if (req.query.anio != null) body.listAnio = req.query.anio;
    const result = await updateVale(pool, empnit, id, body);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.warn('[API PUT /nomina/vales/:id]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/:id/pagos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const pagos = await listPagosVale(pool, empnit, id);
    res.json({ ok: true, pagos });
  } catch (err) {
    console.warn('[API GET /nomina/vales/:id/pagos]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/:id/pagos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const body = { ...(req.body || {}) };
    if (req.query.mes != null) body.listMes = req.query.mes;
    if (req.query.anio != null) body.listAnio = req.query.anio;
    const result = await crearPagoVale(pool, empnit, id, body);
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    console.warn('[API POST /nomina/vales/:id/pagos]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.delete('/:id/pagos/:pagoId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseInt(req.params.id, 10);
  const pagoId = parseInt(req.params.pagoId, 10);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(pagoId) || pagoId <= 0) {
    return res.status(400).json({ error: 'ID inválido' });
  }
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await eliminarPagoVale(pool, empnit, id, pagoId, {
      listMes: req.query.mes,
      listAnio: req.query.anio,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.warn('[API DELETE /nomina/vales/:id/pagos/:pagoId]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const deleted = await deleteVale(pool, empnit, id);
    const rows = await listVales(pool, empnit, deleted.mes, deleted.anio);
    res.json({ ok: true, rows, mes: deleted.mes, anio: deleted.anio });
  } catch (err) {
    console.warn('[API DELETE /nomina/vales/:id]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
