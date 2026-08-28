const express = require('express');
const { isDbConfigured } = require('../config/database');
const { requireEmpNit, parsePeriod } = require('../lib/nomina-utils');
const { buildIgssPlanillaTxt } = require('../lib/igss-planilla-export');
const {
  getNominaConfig,
  saveNominaConfig,
  listConceptos,
  upsertConcepto,
  deleteConcepto,
  listDepartamentos,
  upsertDepartamento,
  deleteDepartamento,
  listEmpleadosActivos,
  saveNominaEmpleado,
  listPlanillas,
  loadPlanilla,
  createPlanilla,
  updateDetalleLine,
  recalcularPlanilla,
  cerrarPlanilla,
  deletePlanilla,
} = require('../lib/nomina-planillas');
const {
  getDeduccionesModalData,
  confirmarAbonoValeNomina,
  deleteDeduccionLinea,
} = require('../lib/nomina-deducciones');

const router = express.Router();

function parseId(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

router.get('/config', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const config = await getNominaConfig(pool, empnit);
    res.json({ config });
  } catch (err) {
    console.warn('[API GET /nomina/config]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/config', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const config = await saveNominaConfig(pool, empnit, req.body || {});
    res.json({ config });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code >= 500) console.warn('[API PUT /nomina/config]', err.message);
    res.status(code).json({ error: err.message });
  }
});

router.get('/conceptos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await listConceptos(pool, empnit);
    res.json({ rows });
  } catch (err) {
    console.warn('[API GET /nomina/conceptos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/conceptos', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const row = await upsertConcepto(pool, empnit, req.body || {});
    res.status(201).json(row);
  } catch (err) {
    const code = err.statusCode || 500;
    if (code >= 500) console.warn('[API POST /nomina/conceptos]', err.message);
    res.status(code).json({ error: err.message });
  }
});

router.put('/conceptos/:id', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const row = await upsertConcepto(pool, empnit, req.body || {}, id);
    res.json(row);
  } catch (err) {
    const code = err.statusCode || 500;
    if (code >= 500) console.warn('[API PUT /nomina/conceptos]', err.message);
    res.status(code).json({ error: err.message });
  }
});

router.delete('/conceptos/:id', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    await deleteConcepto(pool, empnit, id);
    res.json({ ok: true });
  } catch (err) {
    console.warn('[API DELETE /nomina/conceptos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/departamentos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const soloActivos = String(req.query.activos || '').toLowerCase() === '1' ||
      String(req.query.activos || '').toLowerCase() === 'si';
    const rows = await listDepartamentos(pool, empnit, { soloActivos });
    res.json({ rows });
  } catch (err) {
    console.warn('[API GET /nomina/departamentos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/departamentos', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const row = await upsertDepartamento(pool, empnit, req.body || {});
    res.status(201).json(row);
  } catch (err) {
    const code = err.statusCode || 500;
    if (code >= 500) console.warn('[API POST /nomina/departamentos]', err.message);
    res.status(code).json({ error: err.message });
  }
});

router.put('/departamentos/:id', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const row = await upsertDepartamento(pool, empnit, req.body || {}, id);
    res.json(row);
  } catch (err) {
    const code = err.statusCode || 500;
    if (code >= 500) console.warn('[API PUT /nomina/departamentos]', err.message);
    res.status(code).json({ error: err.message });
  }
});

router.delete('/departamentos/:id', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    await deleteDepartamento(pool, empnit, id);
    res.json({ ok: true });
  } catch (err) {
    console.warn('[API DELETE /nomina/departamentos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/empleados', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await listEmpleadosActivos(pool, empnit);
    res.json({ rows });
  } catch (err) {
    console.warn('[API GET /nomina/empleados]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/empleados/:codempleado', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const row = await saveNominaEmpleado(pool, empnit, req.params.codempleado, req.body || {});
    res.json({ ok: true, row });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code >= 500) console.warn('[API PUT /nomina/empleados]', err.message);
    res.status(code).json({ error: err.message });
  }
});

function planillaRouter(tipo) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
    const empnit = requireEmpNit(req, res);
    if (!empnit) return;
    const period = parsePeriod(req, res);
    if (!period) return;
    try {
      const pool = await req.app.locals.getDbPool();
      const rows = await listPlanillas(pool, empnit, tipo, period.mes, period.anio);
      res.json({ rows, mes: period.mes, anio: period.anio, tipo });
    } catch (err) {
      console.warn(`[API GET /nomina/${tipo.toLowerCase()}]`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/', async (req, res) => {
    if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
    const empnit = requireEmpNit(req, res);
    if (!empnit) return;
    try {
      const pool = await req.app.locals.getDbPool();
      const planilla = await createPlanilla(pool, empnit, tipo, req.body || {});
      res.status(201).json(planilla);
    } catch (err) {
      const code = err.statusCode || 500;
      if (code >= 500) console.warn(`[API POST /nomina/${tipo.toLowerCase()}]`, err.message);
      res.status(code).json({ error: err.message });
    }
  });

  r.get('/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
    const empnit = requireEmpNit(req, res);
    if (!empnit) return;
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    try {
      const pool = await req.app.locals.getDbPool();
      const planilla = await loadPlanilla(pool, empnit, id);
      if (!planilla) return res.status(404).json({ error: 'Planilla no encontrada' });
      res.json(planilla);
    } catch (err) {
      console.warn(`[API GET /nomina/${tipo.toLowerCase()}/:id]`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  r.patch('/:id/lineas/:detalleId', async (req, res) => {
    if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
    const empnit = requireEmpNit(req, res);
    if (!empnit) return;
    const id = parseId(req.params.id);
    const detalleId = parseId(req.params.detalleId);
    if (!id || !detalleId) return res.status(400).json({ error: 'ID inválido' });
    try {
      const pool = await req.app.locals.getDbPool();
      const planilla = await updateDetalleLine(pool, empnit, id, detalleId, req.body || {});
      res.json(planilla);
    } catch (err) {
      const code = err.statusCode || 500;
      if (code >= 500) console.warn(`[API PATCH /nomina/${tipo.toLowerCase()}/lineas]`, err.message);
      res.status(code).json({ error: err.message });
    }
  });

  if (tipo === 'INTERNA') {
    r.get('/:id/lineas/:detalleId/deducciones', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
      const empnit = requireEmpNit(req, res);
      if (!empnit) return;
      const planillaId = parseId(req.params.id);
      const detalleId = parseId(req.params.detalleId);
      const codemp = parseId(req.query.codemp);
      if (!planillaId || !detalleId || !codemp) {
        return res.status(400).json({ error: 'Parámetros inválidos' });
      }
      try {
        const pool = await req.app.locals.getDbPool();
        const data = await getDeduccionesModalData(pool, empnit, planillaId, detalleId, codemp);
        res.json(data);
      } catch (err) {
        const code = err.statusCode || 500;
        if (code >= 500) console.warn('[API GET deducciones nomina]', err.message);
        res.status(code).json({ error: err.message });
      }
    });

    r.post('/:id/lineas/:detalleId/deducciones/vale-abono', async (req, res) => {
      if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
      const empnit = requireEmpNit(req, res);
      if (!empnit) return;
      const planillaId = parseId(req.params.id);
      const detalleId = parseId(req.params.detalleId);
      if (!planillaId || !detalleId) return res.status(400).json({ error: 'ID inválido' });
      try {
        const pool = await req.app.locals.getDbPool();
        const data = await confirmarAbonoValeNomina(
          pool,
          empnit,
          planillaId,
          detalleId,
          req.body || {}
        );
        const planilla = await loadPlanilla(pool, empnit, planillaId);
        res.status(201).json({ ...data, planilla });
      } catch (err) {
        const code = err.statusCode || 500;
        if (code >= 500) console.warn('[API POST deducciones vale-abono]', err.message);
        res.status(code).json({ error: err.message });
      }
    });

    r.delete('/:id/lineas/:detalleId/deducciones/:deduccionId', async (req, res) => {
      if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
      const empnit = requireEmpNit(req, res);
      if (!empnit) return;
      const planillaId = parseId(req.params.id);
      const detalleId = parseId(req.params.detalleId);
      const deduccionId = parseId(req.params.deduccionId);
      if (!planillaId || !detalleId || !deduccionId) {
        return res.status(400).json({ error: 'ID inválido' });
      }
      try {
        const pool = await req.app.locals.getDbPool();
        const data = await deleteDeduccionLinea(pool, empnit, planillaId, detalleId, deduccionId);
        const planilla = await loadPlanilla(pool, empnit, planillaId);
        res.json({ ...data, planilla });
      } catch (err) {
        const code = err.statusCode || 500;
        if (code >= 500) console.warn('[API DELETE deduccion nomina]', err.message);
        res.status(code).json({ error: err.message });
      }
    });
  }

  r.post('/:id/recalcular', async (req, res) => {
    if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
    const empnit = requireEmpNit(req, res);
    if (!empnit) return;
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    try {
      const pool = await req.app.locals.getDbPool();
      const planilla = await recalcularPlanilla(pool, empnit, id);
      res.json(planilla);
    } catch (err) {
      const code = err.statusCode || 500;
      if (code >= 500) console.warn(`[API POST /nomina/${tipo.toLowerCase()}/recalcular]`, err.message);
      res.status(code).json({ error: err.message });
    }
  });

  r.post('/:id/cerrar', async (req, res) => {
    if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
    const empnit = requireEmpNit(req, res);
    if (!empnit) return;
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    try {
      const pool = await req.app.locals.getDbPool();
      const planilla = await cerrarPlanilla(pool, empnit, id);
      res.json(planilla);
    } catch (err) {
      const code = err.statusCode || 500;
      if (code >= 500) console.warn(`[API POST /nomina/${tipo.toLowerCase()}/cerrar]`, err.message);
      res.status(code).json({ error: err.message });
    }
  });

  r.delete('/:id', async (req, res) => {
    if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
    const empnit = requireEmpNit(req, res);
    if (!empnit) return;
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    try {
      const pool = await req.app.locals.getDbPool();
      await deletePlanilla(pool, empnit, id);
      res.json({ ok: true });
    } catch (err) {
      const code = err.statusCode || 500;
      if (code >= 500) console.warn(`[API DELETE /nomina/${tipo.toLowerCase()}]`, err.message);
      res.status(code).json({ error: err.message });
    }
  });

  if (tipo === 'IGSS') {
    r.get('/:id/export-igss', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
      const empnit = requireEmpNit(req, res);
      if (!empnit) return;
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });
      try {
        const pool = await req.app.locals.getDbPool();
        const [config, planilla] = await Promise.all([
          getNominaConfig(pool, empnit),
          loadPlanilla(pool, empnit, id),
        ]);
        if (!planilla) return res.status(404).json({ error: 'Planilla no encontrada' });
        const exported = buildIgssPlanillaTxt({
          config,
          planilla: planilla.header,
          lines: planilla.lines,
        });
        res.setHeader('Content-Type', exported.mime);
        res.setHeader('Content-Disposition', `attachment; filename="${exported.fileName}"`);
        res.send(exported.body);
      } catch (err) {
        console.warn('[API GET /nomina/igss/export]', err.message);
        res.status(500).json({ error: err.message });
      }
    });
  }

  return r;
}

router.use('/interna', planillaRouter('INTERNA'));
router.use('/igss', planillaRouter('IGSS'));

module.exports = router;
