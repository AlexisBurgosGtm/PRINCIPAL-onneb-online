const express = require('express');
const sql = require('mssql');
const { createCatalogoRouter } = require('./lib/catalogo-empresa');
const { isDbConfigured } = require('../config/database');
const { assertEliminacionRegistro } = require('../lib/config-auth');

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

function parseIntId(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDateValue(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function normalizeStatus(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return s === 'FINALIZADA' ? 'FINALIZADA' : s === 'ACTIVA' ? 'ACTIVA' : null;
}

function validateFechas(inicio, fin) {
  if (inicio && fin && fin < inicio) {
    return 'La fecha fin no puede ser anterior a la fecha inicio';
  }
  return null;
}

const router = createCatalogoRouter({
  logName: 'promociones',
  entityLabel: 'Promoción',
  table: 'PROMOCIONES',
  orderBy: 'FECHA_INICIO DESC, ID DESC',
  idColumn: 'ID',
  idType: 'int',
  idRouteParam: 'id',
  identityColumn: true,
  listColumns: ['ID', 'NOMBRE', 'FECHA_INICIO', 'FECHA_FIN', 'STATUS'],
  fields: [
    { name: 'NOMBRE', type: 'varcharmax', required: true },
    { name: 'FECHA_INICIO', type: 'date' },
    { name: 'FECHA_FIN', type: 'date' },
    { name: 'STATUS', type: 'varchar' },
  ],
  insertFields: ['NOMBRE', 'FECHA_INICIO', 'FECHA_FIN'],
  updateFields: ['NOMBRE', 'FECHA_INICIO', 'FECHA_FIN'],
  validateInsert: async (_pool, _empnit, data) => {
    if (!String(data.NOMBRE || '').trim()) return 'NOMBRE es obligatorio';
    return validateFechas(data.FECHA_INICIO, data.FECHA_FIN);
  },
  validateUpdate: async (_pool, _empnit, data) => {
    if (!String(data.NOMBRE || '').trim()) return 'NOMBRE es obligatorio';
    return validateFechas(data.FECHA_INICIO, data.FECHA_FIN);
  },
});

router.patch('/:id/status', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const status = normalizeStatus(req.body?.STATUS ?? req.body?.status);
  if (!status) return res.status(400).json({ error: 'STATUS debe ser ACTIVA o FINALIZADA' });

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ID', sql.Int, id)
      .input('STATUS', sql.VarChar(20), status)
      .query(`
        UPDATE dbo.PROMOCIONES
        SET STATUS = @STATUS
        WHERE EMPNIT = @EMPNIT AND ID = @ID
      `);
    if (!result.rowsAffected[0]) {
      return res.status(404).json({ error: 'Promoción no encontrada' });
    }
    res.json({ ok: true, ID: id, STATUS: status });
  } catch (err) {
    console.warn('[API PATCH /promociones/:id/status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function requirePromo(pool, empnit, idPromo) {
  const found = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ID', sql.Int, idPromo)
    .query(`SELECT ID, NOMBRE FROM dbo.PROMOCIONES WHERE EMPNIT = @EMPNIT AND ID = @ID`);
  return found.recordset[0] || null;
}

function readRegistroBody(req) {
  const fecha = parseDateValue(req.body?.FECHA ?? req.body?.fecha);
  const codigoRaw = req.body?.CODIGO ?? req.body?.codigo;
  let codigo = null;
  if (codigoRaw !== undefined && codigoRaw !== null && String(codigoRaw).trim() !== '') {
    codigo = parseInt(codigoRaw, 10);
    if (!Number.isFinite(codigo)) codigo = NaN;
  }
  const tipo = String(req.body?.TIPO ?? req.body?.tipo ?? '').trim().slice(0, 50);
  const valor = String(req.body?.VALOR ?? req.body?.valor ?? '').trim().slice(0, 200);
  return { fecha, codigo, tipo, valor };
}

function validateRegistro(data) {
  if (!data.fecha) return 'FECHA es obligatorio';
  if (Number.isNaN(data.codigo)) return 'CODIGO debe ser un número entero';
  if (!data.tipo) return 'TIPO es obligatorio';
  return null;
}

router.get('/:id/registros', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const idPromo = parseIntId(req.params.id);
  if (!idPromo) return res.status(400).json({ error: 'ID de promoción inválido' });

  try {
    const pool = await req.app.locals.getDbPool();
    const promo = await requirePromo(pool, empnit, idPromo);
    if (!promo) return res.status(404).json({ error: 'Promoción no encontrada' });
    const result = await pool
      .request()
      .input('IDPROMO', sql.Int, idPromo)
      .query(`
        SELECT ID, IDPROMO, FECHA, CODIGO, TIPO, VALOR
        FROM dbo.PROMOCIONES_REGISTROS
        WHERE IDPROMO = @IDPROMO
        ORDER BY FECHA DESC, ID DESC
      `);
    res.json({ promo, rows: result.recordset || [] });
  } catch (err) {
    console.warn('[API GET /promociones/:id/registros]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/registros', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const idPromo = parseIntId(req.params.id);
  if (!idPromo) return res.status(400).json({ error: 'ID de promoción inválido' });
  const data = readRegistroBody(req);
  const errVal = validateRegistro(data);
  if (errVal) return res.status(400).json({ error: errVal });

  try {
    const pool = await req.app.locals.getDbPool();
    const promo = await requirePromo(pool, empnit, idPromo);
    if (!promo) return res.status(404).json({ error: 'Promoción no encontrada' });
    const result = await pool
      .request()
      .input('IDPROMO', sql.Int, idPromo)
      .input('FECHA', sql.Date, data.fecha)
      .input('CODIGO', sql.Int, data.codigo)
      .input('TIPO', sql.VarChar(50), data.tipo)
      .input('VALOR', sql.VarChar(200), data.valor || null)
      .query(`
        INSERT INTO dbo.PROMOCIONES_REGISTROS (IDPROMO, FECHA, CODIGO, TIPO, VALOR)
        OUTPUT INSERTED.ID, INSERTED.IDPROMO, INSERTED.FECHA, INSERTED.CODIGO, INSERTED.TIPO, INSERTED.VALOR
        VALUES (@IDPROMO, @FECHA, @CODIGO, @TIPO, @VALOR)
      `);
    res.status(201).json({ ok: true, row: result.recordset[0] });
  } catch (err) {
    console.warn('[API POST /promociones/:id/registros]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/registros/:regId', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const idPromo = parseIntId(req.params.id);
  const regId = parseIntId(req.params.regId);
  if (!idPromo || !regId) return res.status(400).json({ error: 'ID inválido' });
  const data = readRegistroBody(req);
  const errVal = validateRegistro(data);
  if (errVal) return res.status(400).json({ error: errVal });

  try {
    const pool = await req.app.locals.getDbPool();
    const promo = await requirePromo(pool, empnit, idPromo);
    if (!promo) return res.status(404).json({ error: 'Promoción no encontrada' });
    const result = await pool
      .request()
      .input('ID', sql.Int, regId)
      .input('IDPROMO', sql.Int, idPromo)
      .input('FECHA', sql.Date, data.fecha)
      .input('CODIGO', sql.Int, data.codigo)
      .input('TIPO', sql.VarChar(50), data.tipo)
      .input('VALOR', sql.VarChar(200), data.valor || null)
      .query(`
        UPDATE dbo.PROMOCIONES_REGISTROS
        SET FECHA = @FECHA, CODIGO = @CODIGO, TIPO = @TIPO, VALOR = @VALOR
        WHERE ID = @ID AND IDPROMO = @IDPROMO
      `);
    if (!result.rowsAffected[0]) {
      return res.status(404).json({ error: 'Registro no encontrado' });
    }
    res.json({ ok: true, ID: regId });
  } catch (err) {
    console.warn('[API PUT /promociones/:id/registros/:regId]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/registros/:regId', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const idPromo = parseIntId(req.params.id);
  const regId = parseIntId(req.params.regId);
  if (!idPromo || !regId) return res.status(400).json({ error: 'ID inválido' });

  try {
    const pool = await req.app.locals.getDbPool();
    await assertEliminacionRegistro(pool, String(req.body?.pass ?? req.body?.PASS ?? ''));
    const promo = await requirePromo(pool, empnit, idPromo);
    if (!promo) return res.status(404).json({ error: 'Promoción no encontrada' });
    const result = await pool
      .request()
      .input('ID', sql.Int, regId)
      .input('IDPROMO', sql.Int, idPromo)
      .query(`DELETE FROM dbo.PROMOCIONES_REGISTROS WHERE ID = @ID AND IDPROMO = @IDPROMO`);
    if (!result.rowsAffected[0]) {
      return res.status(404).json({ error: 'Registro no encontrado' });
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ error: err.message });
    }
    console.warn('[API DELETE /promociones/:id/registros/:regId]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
