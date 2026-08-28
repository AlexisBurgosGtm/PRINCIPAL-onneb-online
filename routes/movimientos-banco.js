const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const {
  tipodocForTipo,
  listTiposDocBanco,
  previewSiguienteBanco,
  listMovimientosBanco,
  getMovimientoBanco,
  listDocumentosPendientes,
  crearMovimientoBanco,
  actualizarMovimientoBanco,
  eliminarMovimientoBanco,
} = require('../lib/movimientos-banco');

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

router.get('/documentos-pendientes', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await listDocumentosPendientes(pool, sql, empnit, {
      tipo: req.query.tipo,
      q: req.query.q,
      limit: req.query.limit,
    });
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /movimientos-banco/documentos-pendientes]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/tipos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const tipo = String(req.query.tipo || '').trim().toUpperCase();
    const tipodoc =
      String(req.query.tipodoc || '').trim().toUpperCase() || tipodocForTipo(tipo === 'S' ? 'S' : 'E');
    const pool = await req.app.locals.getDbPool();
    const rows = await listTiposDocBanco(pool, sql, empnit, tipodoc);
    res.json({ rows, tipodoc, empnit });
  } catch (err) {
    console.warn('[API GET /movimientos-banco/tipos]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/siguiente', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const tipo = String(req.query.tipo || '').trim().toUpperCase();
    const tipodoc =
      String(req.query.tipodoc || '').trim().toUpperCase() || tipodocForTipo(tipo === 'S' ? 'S' : 'E');
    const pool = await req.app.locals.getDbPool();
    const siguiente = await previewSiguienteBanco(pool, sql, empnit, tipodoc, req.query.coddoc);
    res.json({ siguiente, tipodoc, empnit });
  } catch (err) {
    console.warn('[API GET /movimientos-banco/siguiente]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await listMovimientosBanco(pool, sql, empnit, {
      q: req.query.q,
      limit: req.query.limit,
      codcuenta: req.query.codcuenta,
      mes: req.query.mes,
      anio: req.query.anio,
    });
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /movimientos-banco]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await getMovimientoBanco(pool, sql, empnit, req.params.id);
    res.json({ ...data, empnit });
  } catch (err) {
    console.warn('[API GET /movimientos-banco/:id]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await crearMovimientoBanco(pool, sql, empnit, req.body || {});
    res.status(201).json(result);
  } catch (err) {
    console.warn('[API POST /movimientos-banco]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await actualizarMovimientoBanco(pool, sql, empnit, req.params.id, req.body || {});
    res.json({ ok: true, ...data });
  } catch (err) {
    console.warn('[API PUT /movimientos-banco/:id]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const pass = String(req.body?.pass ?? req.body?.PASS ?? req.query.pass ?? '');
    const result = await eliminarMovimientoBanco(pool, sql, empnit, req.params.id, { pass });
    res.json(result);
  } catch (err) {
    console.warn('[API DELETE /movimientos-banco/:id]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
