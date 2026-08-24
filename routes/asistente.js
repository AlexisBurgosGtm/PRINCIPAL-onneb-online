const express = require('express');
const { isDbConfigured } = require('../config/database');
const { searchMovimientoProductos } = require('../lib/movimiento-productos-search');

const router = express.Router();
const PRODUCT_LIMIT = 10;

function getEmpNitFromReq(req) {
  return String(req.query.empnit || req.headers['x-emp-nit'] || '').trim();
}

function publicPrecioRow(row) {
  return {
    CODPROD: String(row?.CODPROD || '').trim(),
    DESPROD: String(row?.DESPROD || '').trim(),
    DESPROD2: String(row?.DESPROD2 || '').trim(),
    CODMEDIDA: String(row?.CODMEDIDA || '').trim(),
    PRECIO: Number(row?.PRECIO) || 0,
    EQUIVALE: Number(row?.EQUIVALE) || 0,
    EXISTENCIA: Number(row?.EXISTENCIA) || 0,
    MAYOREOA: Number(row?.MAYOREOA) || 0,
    MAYOREOB: Number(row?.MAYOREOB) || 0,
    MAYOREOC: Number(row?.MAYOREOC) || 0,
  };
}

router.get('/productos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = getEmpNitFromReq(req);
  if (!empnit) return res.status(400).json({ error: 'EMPNIT requerido (empresa de la sesión)' });

  const q = String(req.query.q || '').trim();
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await searchMovimientoProductos(pool, {
      empnit,
      q,
      limitProducts: PRODUCT_LIMIT,
      includeMayoreo: true,
    });
    const rows = (data.rows || []).map(publicPrecioRow);
    const productos = new Set(rows.map((r) => r.CODPROD)).size;
    res.json({
      rows,
      q: data.q || q || null,
      limit: PRODUCT_LIMIT,
      productos,
    });
  } catch (err) {
    console.warn('[API GET /asistente/productos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
