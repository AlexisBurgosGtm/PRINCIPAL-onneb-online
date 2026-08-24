/**
 * Despachos en Cocina — líneas CRS con DOCPRODUCTOS.SOLICITADO = 1.
 * Despachar → SOLICITADO = 2. Filtro por Ubicación (CLASIFICACIONTRES / CODCLATRES).
 */
const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const { STATUS_ANULADO } = require('../lib/documento-status');
const {
  TIPODOC_COMANDA,
  SOLICITADO_COCINA,
  SELECT_COCINA_ROWS,
} = require('../lib/despachos-en-cocina');

const router = express.Router();
const SOLICITADO_DESPACHADO = 2;

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

async function hasSolicitadoColumn(pool) {
  try {
    const r = await pool.request().query(`
      SELECT CASE WHEN COL_LENGTH('dbo.DOCPRODUCTOS', 'SOLICITADO') IS NULL THEN 0 ELSE 1 END AS HAS_COL
    `);
    return Number(r.recordset[0]?.HAS_COL) === 1;
  } catch {
    return false;
  }
}

router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const codclatresRaw = String(req.query.codclatres || req.query.ubicacion || '').trim();
  const codclatres =
    codclatresRaw && codclatresRaw.toUpperCase() !== 'TODAS' && codclatresRaw !== '*'
      ? parseInt(codclatresRaw, 10)
      : null;
  if (codclatresRaw && codclatres !== null && Number.isNaN(codclatres)) {
    return res.status(400).json({ error: 'Ubicación inválida' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    if (!(await hasSolicitadoColumn(pool))) {
      return res.status(503).json({
        error: 'Ejecute el Actualizador BD (columna DOCPRODUCTOS.SOLICITADO) antes de usar Despachos en Cocina',
      });
    }

    const ubicaciones = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .query(`
        SELECT CODCLATRES, DESCLATRES
        FROM dbo.CLASIFICACIONTRES
        WHERE EMPNIT = @EMPNIT
        ORDER BY DESCLATRES
      `);

    const request = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('SOL', sql.Int, SOLICITADO_COCINA);
    let ubFilter = '';
    if (codclatres != null) {
      request.input('CODCLATRES', sql.Int, codclatres);
      ubFilter = ' AND ISNULL(p.CODCLATRES, 0) = @CODCLATRES';
    }

    const result = await request.query(`
      ${SELECT_COCINA_ROWS}
      WHERE l.EMPNIT = @EMPNIT
        AND t.TIPODOC = '${TIPODOC_COMANDA}'
        AND ISNULL(d.STATUS, '') <> '${STATUS_ANULADO}'
        AND ISNULL(l.SOLICITADO, 0) = @SOL
        ${ubFilter}
      ORDER BY d.FECHA DESC, d.HORA DESC, d.MINUTO DESC, l.Id
    `);

    res.json({
      rows: result.recordset,
      ubicaciones: ubicaciones.recordset,
      filtro: { codclatres },
    });
  } catch (err) {
    console.warn('[API GET /despachos-en-cocina]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/lineas/:id/despachar', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Línea inválida' });

  try {
    const pool = await req.app.locals.getDbPool();
    if (!(await hasSolicitadoColumn(pool))) {
      return res.status(503).json({
        error: 'Ejecute el Actualizador BD (columna DOCPRODUCTOS.SOLICITADO)',
      });
    }

    const check = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ID', sql.Int, id)
      .query(`
        SELECT TOP 1
          l.Id AS ID,
          ISNULL(l.SOLICITADO, 0) AS SOLICITADO,
          l.DESPROD,
          d.CODDOC,
          d.CORRELATIVO,
          t.TIPODOC,
          d.STATUS
        FROM dbo.DOCPRODUCTOS l
        INNER JOIN dbo.DOCUMENTOS d
          ON d.EMPNIT = l.EMPNIT AND d.CODDOC = l.CODDOC AND d.CORRELATIVO = l.CORRELATIVO
        INNER JOIN dbo.TIPODOCUMENTOS t
          ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        WHERE l.EMPNIT = @EMPNIT AND l.Id = @ID
      `);
    const row = check.recordset[0];
    if (!row) return res.status(404).json({ error: 'Línea no encontrada' });
    if (String(row.TIPODOC || '').trim().toUpperCase() !== TIPODOC_COMANDA) {
      return res.status(400).json({ error: 'La línea no pertenece a una comanda' });
    }
    if (String(row.STATUS || '').trim().toUpperCase() === STATUS_ANULADO) {
      return res.status(400).json({ error: 'La comanda está anulada' });
    }
    if (Number(row.SOLICITADO) === SOLICITADO_DESPACHADO) {
      return res.json({ ok: true, already: true, id });
    }
    if (Number(row.SOLICITADO) !== SOLICITADO_COCINA) {
      return res.status(400).json({ error: 'La línea no está pendiente de despacho en cocina' });
    }

    const upd = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ID', sql.Int, id)
      .input('SOL', sql.Int, SOLICITADO_DESPACHADO)
      .input('ESPERADO', sql.Int, SOLICITADO_COCINA)
      .query(`
        UPDATE dbo.DOCPRODUCTOS
        SET SOLICITADO = @SOL
        WHERE EMPNIT = @EMPNIT AND Id = @ID AND ISNULL(SOLICITADO, 0) = @ESPERADO
      `);
    if (!upd.rowsAffected?.[0]) {
      return res.status(409).json({ error: 'No se pudo despachar (estado cambió)' });
    }
    res.json({ ok: true, id, solicitado: SOLICITADO_DESPACHADO, desprod: row.DESPROD });
  } catch (err) {
    console.warn('[API POST /despachos-en-cocina/lineas/despachar]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
