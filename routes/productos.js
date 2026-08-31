const express = require('express');
const sql = require('mssql');
const multer = require('multer');
const { isDbConfigured } = require('../config/database');
const { ensureInvSaldoForProduct } = require('../lib/invsaldo');
const { assertAdminPass, assertEliminacionRegistro } = require('../lib/config-auth');
const { corregirProductosYPrecios } = require('../lib/correccion-productos-precios');
const {
  listMovimientosProducto,
  listMovimientosFiscalesProducto,
  listVentasProducto,
  listComprasProducto,
} = require('../lib/producto-reportes');
const {
  resolveProductoFoto,
  readProductoFotoBuffer,
  saveProductoFoto,
  removeProductoFotos,
} = require('../lib/producto-fotos');
const { getSettingSino, SETTING_OPCION } = require('../lib/settings');

const router = express.Router();
const uploadFoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = /^image\/(jpeg|jpg|png|webp|gif)$/i.test(String(file.mimetype || ''));
    cb(ok ? null : new Error('Solo se permiten imágenes jpg, png, webp o gif'), ok);
  },
});

const DEFAULT_LIMIT = 50;
const SEARCH_LIMIT = 500;

const PRODUCT_BODY_FIELDS = [
  'CODPROD2',
  'DESPROD',
  'DESPROD2',
  'DESPROD3',
  'UXC',
  'CODMEDIDACOMPRA',
  'COSTO',
  'CODMARCA',
  'CODCLAUNO',
  'CODCLADOS',
  'CODCLATRES',
  'HABILITADO',
  'VENCIMIENTO',
  'SERIE',
  'PORCDESCUENTO',
  'INVMINIMO',
  'INVMAXIMO',
  'EXENTO',
  'NF',
  'TIPOPROD',
  'FACTURAR',
  'BONO',
];

const PRECIO_BODY_FIELDS = [
  'CODMEDIDA',
  'EQUIVALE',
  'COSTO',
  'PRECIO',
  'UTILIDAD',
  'PORCUTILIDAD',
  'HABILITADO',
  'MAYOREOA',
  'MAYOREOB',
  'MAYOREOC',
  'PESO',
  'MARGEN',
];

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

function parseListQuery(req) {
  const q = String(req.query.q || '').trim();
  const habilitadoRaw = String(req.query.habilitado || '').trim().toUpperCase();
  const habilitado = habilitadoRaw === 'SI' || habilitadoRaw === 'NO' ? habilitadoRaw : null;
  const codmarcaRaw = parseInt(req.query.codmarca, 10);
  const codmarca = Number.isNaN(codmarcaRaw) ? null : codmarcaRaw;
  let limit = DEFAULT_LIMIT;
  if (q) {
    const requested = parseInt(req.query.limit, 10);
    limit = Number.isNaN(requested)
      ? SEARCH_LIMIT
      : Math.min(Math.max(requested, 1), SEARCH_LIMIT);
  } else {
    const requested = parseInt(req.query.limit, 10);
    if (!Number.isNaN(requested)) {
      limit = Math.min(Math.max(requested, 1), SEARCH_LIMIT);
    }
  }
  return { q, habilitado, codmarca, limit };
}

const LIST_FROM = `
  FROM dbo.PRODUCTOS p
  LEFT JOIN dbo.Marcas m ON p.EMPNIT = m.EMPNIT AND p.CODMARCA = m.CODMARCA
  LEFT JOIN dbo.CLASIFICACIONUNO c1 ON p.EMPNIT = c1.EMPNIT AND p.CODCLAUNO = c1.CODCLAUNO
  LEFT JOIN dbo.PROVEEDORES pr ON p.EMPNIT = pr.EMPNIT AND p.CODCLADOS = pr.CODPROV
  LEFT JOIN dbo.CLASIFICACIONTRES c3 ON p.EMPNIT = c3.EMPNIT AND p.CODCLATRES = c3.CODCLATRES
`;

const LIST_SELECT = `
  p.CODPROD,
  p.CODPROD2,
  p.DESPROD,
  p.DESPROD2,
  p.COSTO,
  p.COSTO_PROMEDIO,
  p.HABILITADO,
  p.EXISTENCIA,
  p.CODMARCA,
  m.DESMARCA,
  c1.DESCLAUNO,
  pr.EMPRESA AS DESPROVEEDOR,
  c3.DESCLATRES
`;

function buildListWhere(useDesprod2) {
  const desprodFilter = useDesprod2
    ? `(LTRIM(RTRIM(ISNULL(p.DESPROD, ''))) + ' ' + LTRIM(RTRIM(ISNULL(p.DESPROD2, '')))) LIKE @qLike`
    : `p.DESPROD LIKE @qLike`;
  return `
  WHERE p.EMPNIT = @EMPNIT
    AND (@habilitado IS NULL OR UPPER(LTRIM(RTRIM(ISNULL(p.HABILITADO, '')))) = @habilitado)
    AND (@codmarca IS NULL OR p.CODMARCA = @codmarca)
    AND (
      @q IS NULL OR @q = ''
      OR p.CODPROD LIKE @qLike
      OR p.CODPROD2 LIKE @qLike
      OR ${desprodFilter}
      OR p.DESPROD3 LIKE @qLike
      OR m.DESMARCA LIKE @qLike
      OR c1.DESCLAUNO LIKE @qLike
      OR pr.EMPRESA LIKE @qLike
      OR c3.DESCLATRES LIKE @qLike
    )
`;
}

function bindListFilters(request, { empnit, q, habilitado, codmarca }) {
  request.input('EMPNIT', sql.VarChar, empnit);
  request.input('q', sql.NVarChar, q || null);
  request.input('qLike', sql.NVarChar, q ? `%${q}%` : null);
  request.input('habilitado', sql.VarChar, habilitado);
  request.input('codmarca', sql.Int, codmarca);
}

function parseNum(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isNaN(n) ? fallback : n;
}

function parseIntField(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

function normalizeHabilitado(raw, defaultVal = 'SI') {
  const s = String(raw ?? defaultVal).trim().toUpperCase();
  return s === 'SI' ? 'SI' : 'NO';
}

function readProductBody(body, { includeCodprod = false } = {}) {
  const data = {};
  if (includeCodprod) {
    data.CODPROD = String(body?.CODPROD ?? '').trim();
  }
  for (const name of PRODUCT_BODY_FIELDS) {
    if (body[name] === undefined) continue;
    if (['UXC', 'COSTO', 'CODMARCA', 'CODCLAUNO', 'CODCLADOS', 'CODCLATRES', 'SERIE', 'PORCDESCUENTO', 'INVMINIMO', 'INVMAXIMO', 'EXENTO', 'NF', 'BONO'].includes(name)) {
      data[name] = parseNum(body[name], name === 'NF' || name === 'EXENTO' ? 0 : null);
    } else if (name === 'VENCIMIENTO') {
      const v = String(body[name] ?? '').trim();
      data[name] = v || null;
    } else {
      data[name] = body[name] === null ? null : String(body[name]).trim();
    }
  }
  if (body.HABILITADO !== undefined) {
    data.HABILITADO = normalizeHabilitado(body.HABILITADO);
  }
  return data;
}

function readPrecioBody(body) {
  const data = {};
  for (const name of PRECIO_BODY_FIELDS) {
    if (body[name] === undefined) continue;
    if (name === 'CODMEDIDA' || name === 'HABILITADO') {
      data[name] = String(body[name] ?? '').trim();
    } else if (name === 'EQUIVALE') {
      data[name] = parseIntField(body[name]) ?? 1;
    } else {
      data[name] = parseNum(body[name], 0);
    }
  }
  if (data.HABILITADO !== undefined) {
    data.HABILITADO = normalizeHabilitado(data.HABILITADO);
  }
  return data;
}

function validatePrecioEquivalencia(data, { requireMedida = true } = {}) {
  if (requireMedida && !data.CODMEDIDA) return 'CODMEDIDA es obligatorio';
  if (data.EQUIVALE === undefined || data.EQUIVALE === null) return null;
  const eq = parseInt(data.EQUIVALE, 10);
  if (!Number.isFinite(eq) || eq <= 0) return 'El equivalente debe ser mayor a cero';
  return null;
}

async function countDocProductosMovimientos(pool, empnit, codprod) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROD', sql.VarChar, codprod)
    .query(`
      SELECT COUNT(*) AS cnt
      FROM dbo.DOCPRODUCTOS
      WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD
    `);
  return result.recordset[0]?.cnt ?? 0;
}

async function getProductoCostoUnitario(pool, empnit, codprod) {
  try {
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, codprod)
      .query(`
        SELECT ISNULL(COSTOUNITARIO, COSTO) AS COSTOUNITARIO
        FROM dbo.PRODUCTOS
        WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD
      `);
    if (!result.recordset.length) return null;
    return Number(result.recordset[0].COSTOUNITARIO) || 0;
  } catch {
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, codprod)
      .query(`
        SELECT ISNULL(COSTO, 0) AS COSTOUNITARIO
        FROM dbo.PRODUCTOS
        WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD
      `);
    if (!result.recordset.length) return null;
    return Number(result.recordset[0].COSTOUNITARIO) || 0;
  }
}

async function applyPrecioCostoFromProduct(pool, empnit, codprod, data) {
  const costoUnitario = await getProductoCostoUnitario(pool, empnit, codprod);
  if (costoUnitario === null) return { error: 'Producto no encontrado' };
  const eq = parseInt(data.EQUIVALE, 10) || 0;
  data.COSTO = costoUnitario * eq;
  return { costoUnitario };
}

router.get('/stats', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
      SELECT
        SUM(CASE WHEN UPPER(LTRIM(RTRIM(ISNULL(HABILITADO, '')))) = 'SI' THEN 1 ELSE 0 END) AS habilitados,
        SUM(CASE WHEN UPPER(LTRIM(RTRIM(ISNULL(HABILITADO, '')))) <> 'SI' THEN 1 ELSE 0 END) AS no_habilitados,
        COUNT(*) AS total
      FROM dbo.PRODUCTOS
      WHERE EMPNIT = @EMPNIT
    `);
    const row = result.recordset[0] || {};
    res.json({
      habilitados: row.habilitados ?? 0,
      no_habilitados: row.no_habilitados ?? 0,
      total: row.total ?? 0,
      empnit,
    });
  } catch (err) {
    console.warn('[API GET /productos/stats]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Deduplica PRODUCTOS / INVSALDO / PRECIOS y crea índices únicos.
 */
router.post('/correccion-duplicados', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await corregirProductosYPrecios(pool, empnit);
    res.json(result);
  } catch (err) {
    console.warn('[API POST /productos/correccion-duplicados]', err.message);
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
    const [marcas, fabricantes, proveedores, ubicaciones] = await Promise.all([
      pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
        SELECT CODMARCA, DESMARCA FROM dbo.Marcas WHERE EMPNIT = @EMPNIT ORDER BY DESMARCA
      `),
      pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
        SELECT CODCLAUNO, DESCLAUNO FROM dbo.CLASIFICACIONUNO WHERE EMPNIT = @EMPNIT ORDER BY DESCLAUNO
      `),
      pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
        SELECT CODPROV, EMPRESA FROM dbo.PROVEEDORES WHERE EMPNIT = @EMPNIT ORDER BY EMPRESA
      `),
      pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
        SELECT CODCLATRES, DESCLATRES FROM dbo.CLASIFICACIONTRES WHERE EMPNIT = @EMPNIT ORDER BY DESCLATRES
      `),
    ]);
    const medRes = await pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
      SELECT CODMEDIDA, TIPOPRECIO FROM dbo.Medidas WHERE EMPNIT = @EMPNIT ORDER BY CODMEDIDA
    `);
    const medidasRows = medRes.recordset;
    res.json({
      marcas: marcas.recordset,
      fabricantes: fabricantes.recordset,
      proveedores: proveedores.recordset,
      ubicaciones: ubicaciones.recordset,
      medidas: medidasRows,
      empnit,
    });
  } catch (err) {
    console.warn('[API GET /productos/lookups]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const { q, habilitado, codmarca, limit } = parseListQuery(req);
  try {
    const pool = await req.app.locals.getDbPool();
    const muestraDesprod2 = await getSettingSino(
      pool,
      SETTING_OPCION.MUESTRA_DESPROD2_EN_DOCS_Y_PRODS
    );
    const listWhere = buildListWhere(muestraDesprod2 === 'SI');
    const countReq = pool.request();
    bindListFilters(countReq, { empnit, q, habilitado, codmarca });
    const total = (await countReq.query(`SELECT COUNT(*) AS total ${LIST_FROM} ${listWhere}`)).recordset[0]
      .total;

    const listReq = pool.request();
    bindListFilters(listReq, { empnit, q, habilitado, codmarca });
    listReq.input('limit', sql.Int, limit);
    const rows = (
      await listReq.query(`
        SELECT TOP (@limit) ${LIST_SELECT}
        ${LIST_FROM}
        ${listWhere}
        ORDER BY p.DESPROD, p.CODPROD
      `)
    ).recordset;

    res.json({
      rows,
      total,
      limit,
      truncated: total > rows.length,
      empnit,
      q: q || null,
      habilitado,
      codmarca,
      muestraDesprod2,
    });
  } catch (err) {
    console.warn('[API GET /productos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codprod/precios', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, codprod)
      .query(`
        SELECT ID, CODPROD, CODMEDIDA, EQUIVALE, COSTO, PRECIO, UTILIDAD, PORCUTILIDAD,
          HABILITADO, MAYOREOA, MAYOREOB, MAYOREOC, PESO, MARGEN
        FROM dbo.PRECIOS
        WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD
        ORDER BY CODMEDIDA
      `);
    res.json({ rows: result.recordset, codprod, empnit });
  } catch (err) {
    console.warn('[API GET /productos/:codprod/precios]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:codprod/precios', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  const data = readPrecioBody(req.body);
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  const precioErr = validatePrecioEquivalencia(data);
  if (precioErr) return res.status(400).json({ error: precioErr });
  try {
    const pool = await req.app.locals.getDbPool();
    const costApply = await applyPrecioCostoFromProduct(pool, empnit, codprod, data);
    if (costApply.error) return res.status(404).json({ error: costApply.error });
    if (!data.HABILITADO) data.HABILITADO = 'SI';

    const exists = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, codprod)
      .query(`SELECT 1 AS ok FROM dbo.PRODUCTOS WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD`);
    if (!exists.recordset.length) return res.status(404).json({ error: 'Producto no encontrado' });

    const dup = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, codprod)
      .input('CODMEDIDA', sql.VarChar, data.CODMEDIDA)
      .query(`
        SELECT ID FROM dbo.PRECIOS
        WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD AND CODMEDIDA = @CODMEDIDA
      `);
    if (dup.recordset.length) {
      return res.status(409).json({ error: 'Ya existe un precio para esa medida' });
    }

    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, codprod)
      .input('CODMEDIDA', sql.VarChar, data.CODMEDIDA)
      .input('EQUIVALE', sql.Int, data.EQUIVALE ?? 1)
      .input('COSTO', sql.Float, data.COSTO ?? 0)
      .input('PRECIO', sql.Decimal(18, 3), data.PRECIO ?? 0)
      .input('UTILIDAD', sql.Float, data.UTILIDAD ?? 0)
      .input('PORCUTILIDAD', sql.Float, data.PORCUTILIDAD ?? 0)
      .input('HABILITADO', sql.VarChar, data.HABILITADO ?? 'SI')
      .input('MAYOREOA', sql.Decimal(18, 3), data.MAYOREOA ?? 0)
      .input('MAYOREOB', sql.Decimal(18, 3), data.MAYOREOB ?? 0)
      .input('MAYOREOC', sql.Decimal(18, 3), data.MAYOREOC ?? 0)
      .input('PESO', sql.Decimal(18, 3), data.PESO ?? 0)
      .input('MARGEN', sql.Float, data.MARGEN ?? null)
      .query(`
        INSERT INTO dbo.PRECIOS (
          EMPNIT, CODPROD, CODMEDIDA, EQUIVALE, COSTO, PRECIO, UTILIDAD, PORCUTILIDAD,
          HABILITADO, MAYOREOA, MAYOREOB, MAYOREOC, PESO, MARGEN
        ) VALUES (
          @EMPNIT, @CODPROD, @CODMEDIDA, @EQUIVALE, @COSTO, @PRECIO, @UTILIDAD, @PORCUTILIDAD,
          @HABILITADO, @MAYOREOA, @MAYOREOB, @MAYOREOC, @PESO, @MARGEN
        );
        SELECT SCOPE_IDENTITY() AS ID;
      `);
    res.status(201).json({ ok: true, ID: result.recordset[0]?.ID, ...data, CODPROD: codprod });
  } catch (err) {
    console.warn('[API POST /productos/:codprod/precios]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:codprod/precios/:precioId', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  const precioId = parseInt(req.params.precioId, 10);
  const data = readPrecioBody(req.body);
  if (!codprod || Number.isNaN(precioId)) return res.status(400).json({ error: 'Parámetros inválidos' });
  const precioErr = validatePrecioEquivalencia(data, { requireMedida: false });
  if (precioErr) return res.status(400).json({ error: precioErr });
  try {
    const pool = await req.app.locals.getDbPool();
    if (data.EQUIVALE !== undefined) {
      const costApply = await applyPrecioCostoFromProduct(pool, empnit, codprod, data);
      if (costApply.error) return res.status(404).json({ error: costApply.error });
    }
    const fields = [];
    const request = pool
      .request()
      .input('ID', sql.Int, precioId)
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, codprod);

    if (data.CODMEDIDA !== undefined) {
      request.input('CODMEDIDA', sql.VarChar, data.CODMEDIDA);
      fields.push('CODMEDIDA = @CODMEDIDA');
    }
    if (data.EQUIVALE !== undefined) {
      request.input('EQUIVALE', sql.Int, data.EQUIVALE);
      fields.push('EQUIVALE = @EQUIVALE');
    }
    if (data.COSTO !== undefined) {
      request.input('COSTO', sql.Float, data.COSTO);
      fields.push('COSTO = @COSTO');
    }
    if (data.PRECIO !== undefined) {
      request.input('PRECIO', sql.Decimal(18, 3), data.PRECIO);
      fields.push('PRECIO = @PRECIO');
    }
    if (data.UTILIDAD !== undefined) {
      request.input('UTILIDAD', sql.Float, data.UTILIDAD);
      fields.push('UTILIDAD = @UTILIDAD');
    }
    if (data.PORCUTILIDAD !== undefined) {
      request.input('PORCUTILIDAD', sql.Float, data.PORCUTILIDAD);
      fields.push('PORCUTILIDAD = @PORCUTILIDAD');
    }
    if (data.HABILITADO !== undefined) {
      request.input('HABILITADO', sql.VarChar, data.HABILITADO);
      fields.push('HABILITADO = @HABILITADO');
    }
    if (data.MAYOREOA !== undefined) {
      request.input('MAYOREOA', sql.Decimal(18, 3), data.MAYOREOA);
      fields.push('MAYOREOA = @MAYOREOA');
    }
    if (data.MAYOREOB !== undefined) {
      request.input('MAYOREOB', sql.Decimal(18, 3), data.MAYOREOB);
      fields.push('MAYOREOB = @MAYOREOB');
    }
    if (data.MAYOREOC !== undefined) {
      request.input('MAYOREOC', sql.Decimal(18, 3), data.MAYOREOC);
      fields.push('MAYOREOC = @MAYOREOC');
    }
    if (data.PESO !== undefined) {
      request.input('PESO', sql.Decimal(18, 3), data.PESO);
      fields.push('PESO = @PESO');
    }
    if (data.MARGEN !== undefined) {
      request.input('MARGEN', sql.Float, data.MARGEN);
      fields.push('MARGEN = @MARGEN');
    }
    if (!fields.length) return res.status(400).json({ error: 'Sin campos para actualizar' });

    const result = await request.query(`
      UPDATE dbo.PRECIOS SET ${fields.join(', ')}
      WHERE ID = @ID AND EMPNIT = @EMPNIT AND CODPROD = @CODPROD
    `);
    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Precio no encontrado' });
    res.json({ ok: true, ID: precioId });
  } catch (err) {
    console.warn('[API PUT /productos/:codprod/precios/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:codprod/precios/:precioId', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  const precioId = parseInt(req.params.precioId, 10);
  if (!codprod || Number.isNaN(precioId)) return res.status(400).json({ error: 'Parámetros inválidos' });
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('ID', sql.Int, precioId)
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, codprod)
      .query(`DELETE FROM dbo.PRECIOS WHERE ID = @ID AND EMPNIT = @EMPNIT AND CODPROD = @CODPROD`);
    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Precio no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    console.warn('[API DELETE /productos/:codprod/precios/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codprod/movimientos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const count = await countDocProductosMovimientos(pool, empnit, codprod);
    res.json({ codprod, empnit, count, tieneMovimientos: count > 0 });
  } catch (err) {
    console.warn('[API GET /productos/:codprod/movimientos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codprod/reporte/movimientos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  const q = String(req.query.q || '').trim();
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await listMovimientosProducto(pool, sql, empnit, codprod, q);
    res.json({ rows, codprod, empnit, q: q || null });
  } catch (err) {
    console.warn('[API GET /productos/:codprod/reporte/movimientos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codprod/reporte/movimientos-fiscales', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  const q = String(req.query.q || '').trim();
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await listMovimientosFiscalesProducto(pool, sql, empnit, codprod, q);
    res.json({ rows, codprod, empnit, q: q || null, tiposFiscal: ['FEF', 'FEC', 'FES', 'FNC'] });
  } catch (err) {
    console.warn('[API GET /productos/:codprod/reporte/movimientos-fiscales]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codprod/reporte/ventas', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await listVentasProducto(pool, sql, empnit, codprod);
    res.json({ rows, codprod, empnit });
  } catch (err) {
    console.warn('[API GET /productos/:codprod/reporte/ventas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codprod/reporte/compras', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const rows = await listComprasProducto(pool, sql, empnit, codprod);
    res.json({ rows, codprod, empnit });
  } catch (err) {
    console.warn('[API GET /productos/:codprod/reporte/compras]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:codprod/habilitado', async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  const raw = String(req.body?.HABILITADO ?? req.body?.habilitado ?? '')
    .trim()
    .toUpperCase();
  if (raw !== 'SI' && raw !== 'NO') {
    return res.status(400).json({ error: 'HABILITADO debe ser SI o NO' });
  }
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, codprod)
      .input('HABILITADO', sql.VarChar, raw)
      .query(`
        UPDATE dbo.PRODUCTOS SET HABILITADO = @HABILITADO
        WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD
      `);
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json({ ok: true, CODPROD: codprod, HABILITADO: raw });
  } catch (err) {
    console.warn('[API PATCH /productos/:codprod/habilitado]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codprod/foto', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const wantMeta =
      String(req.query.meta || '') === '1' || String(req.headers.accept || '').includes('application/json');
    if (wantMeta) {
      const meta = await resolveProductoFoto(pool, empnit, codprod);
      if (!meta) return res.status(404).json({ error: 'Sin foto', url: null });
      return res.json({ ok: true, url: meta.url, filename: meta.filename, modo: meta.modo });
    }
    const file = await readProductoFotoBuffer(pool, empnit, codprod);
    if (!file) return res.status(404).json({ error: 'Sin foto', url: null });
    const ext = String(file.filename || '').toLowerCase();
    const type =
      ext.endsWith('.png')
        ? 'image/png'
        : ext.endsWith('.webp')
          ? 'image/webp'
          : ext.endsWith('.gif')
            ? 'image/gif'
            : 'image/jpeg';
    res.setHeader('Content-Type', type);
    res.send(file.buffer);
  } catch (err) {
    console.warn('[API GET /productos/:codprod/foto]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/:codprod/foto', (req, res) => {
  uploadFoto.single('foto')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || 'Error al subir imagen' });
    }
    if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
    const empnit = requireEmpNit(req, res);
    if (!empnit) return;
    const codprod = String(req.params.codprod || '').trim();
    if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
    if (!req.file) return res.status(400).json({ error: 'Seleccione una imagen' });
    try {
      const pool = await req.app.locals.getDbPool();
      const exists = await pool
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODPROD', sql.VarChar, codprod)
        .query(`SELECT TOP 1 CODPROD FROM dbo.PRODUCTOS WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD`);
      if (!exists.recordset.length) return res.status(404).json({ error: 'Producto no encontrado' });
      const saved = await saveProductoFoto(pool, empnit, codprod, req.file);
      res.json({ ok: true, url: saved.url, filename: saved.filename, modo: saved.modo });
    } catch (err) {
      console.warn('[API POST /productos/:codprod/foto]', err.message);
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });
});

router.delete('/:codprod/foto', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    await removeProductoFotos(pool, empnit, codprod);
    res.json({ ok: true });
  } catch (err) {
    console.warn('[API DELETE /productos/:codprod/foto]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/:codprod', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, codprod)
      .query(`
        SELECT p.*, m.DESMARCA, c1.DESCLAUNO, pr.EMPRESA AS DESPROVEEDOR, c3.DESCLATRES
        FROM dbo.PRODUCTOS p
        LEFT JOIN dbo.Marcas m ON p.EMPNIT = m.EMPNIT AND p.CODMARCA = m.CODMARCA
        LEFT JOIN dbo.CLASIFICACIONUNO c1 ON p.EMPNIT = c1.EMPNIT AND p.CODCLAUNO = c1.CODCLAUNO
        LEFT JOIN dbo.PROVEEDORES pr ON p.EMPNIT = pr.EMPNIT AND p.CODCLADOS = pr.CODPROV
        LEFT JOIN dbo.CLASIFICACIONTRES c3 ON p.EMPNIT = c3.EMPNIT AND p.CODCLATRES = c3.CODCLATRES
        WHERE p.EMPNIT = @EMPNIT AND p.CODPROD = @CODPROD
      `);
    if (!result.recordset.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ row: result.recordset[0] });
  } catch (err) {
    console.warn('[API GET /productos/:codprod]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const data = readProductBody(req.body, { includeCodprod: true });
  if (!data.CODPROD) return res.status(400).json({ error: 'CODPROD es obligatorio' });
  if (!data.DESPROD) return res.status(400).json({ error: 'DESPROD es obligatorio' });
  data.HABILITADO = normalizeHabilitado(data.HABILITADO, 'SI');
  try {
    const pool = await req.app.locals.getDbPool();
    const dup = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, data.CODPROD)
      .query(`SELECT 1 AS ok FROM dbo.PRODUCTOS WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD`);
    if (dup.recordset.length) return res.status(409).json({ error: 'El código de producto ya existe' });

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODPROD', sql.VarChar, data.CODPROD)
        .input('CODPROD2', sql.VarChar, data.CODPROD2 || null)
        .input('DESPROD', sql.VarChar, data.DESPROD)
        .input('DESPROD2', sql.VarChar, data.DESPROD2 || null)
        .input('DESPROD3', sql.VarChar, data.DESPROD3 || null)
        .input('UXC', sql.Int, data.UXC ?? null)
        .input('CODMEDIDACOMPRA', sql.VarChar, data.CODMEDIDACOMPRA || null)
        .input('COSTO', sql.Decimal(18, 3), data.COSTO ?? 0)
        .input('CODMARCA', sql.Int, data.CODMARCA ?? null)
        .input('CODCLAUNO', sql.Int, data.CODCLAUNO ?? null)
        .input('CODCLADOS', sql.Int, data.CODCLADOS ?? null)
        .input('CODCLATRES', sql.Int, data.CODCLATRES ?? null)
        .input('HABILITADO', sql.VarChar, data.HABILITADO)
        .input('VENCIMIENTO', sql.Date, data.VENCIMIENTO || null)
        .input('SERIE', sql.Int, data.SERIE ?? 0)
        .input('PORCDESCUENTO', sql.Decimal(18, 3), data.PORCDESCUENTO ?? 0)
        .input('INVMINIMO', sql.Int, data.INVMINIMO ?? 0)
        .input('INVMAXIMO', sql.Int, data.INVMAXIMO ?? 0)
        .input('EXENTO', sql.Int, data.EXENTO ?? 0)
        .input('NF', sql.Int, data.NF ?? 0)
        .input('TIPOPROD', sql.VarChar, data.TIPOPROD || 'P')
        .input('FACTURAR', sql.VarChar, data.FACTURAR || 'SI')
        .input('BONO', sql.Float, data.BONO ?? 0)
        .query(`
          INSERT INTO dbo.PRODUCTOS (
            EMPNIT, CODPROD, CODPROD2, DESPROD, DESPROD2, DESPROD3, UXC, CODMEDIDACOMPRA, COSTO,
            CODMARCA, CODCLAUNO, CODCLADOS, CODCLATRES, HABILITADO, VENCIMIENTO, SERIE,
            PORCDESCUENTO, INVMINIMO, INVMAXIMO, EXENTO, NF, TIPOPROD, EXISTENCIA, FACTURAR, BONO,
            FISICO, COSTO_ANTERIOR, COSTO_PROMEDIO
          ) VALUES (
            @EMPNIT, @CODPROD, @CODPROD2, @DESPROD, @DESPROD2, @DESPROD3, @UXC, @CODMEDIDACOMPRA, @COSTO,
            @CODMARCA, @CODCLAUNO, @CODCLADOS, @CODCLATRES, @HABILITADO, @VENCIMIENTO, @SERIE,
            @PORCDESCUENTO, @INVMINIMO, @INVMAXIMO, @EXENTO, @NF, @TIPOPROD, 0, @FACTURAR, @BONO,
            0, 0, 0
          )
        `);
      await ensureInvSaldoForProduct(transaction, empnit, data.CODPROD, 0);
      await transaction.commit();
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
    res.status(201).json({ ok: true, CODPROD: data.CODPROD });
  } catch (err) {
    console.warn('[API POST /productos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:codprod', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  const data = readProductBody(req.body);
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  if (data.DESPROD !== undefined && !data.DESPROD) {
    return res.status(400).json({ error: 'DESPROD es obligatorio' });
  }
  try {
    const pool = await req.app.locals.getDbPool();
    const request = pool.request().input('EMPNIT', sql.VarChar, empnit).input('CODPROD', sql.VarChar, codprod);
    const setParts = [];
    for (const [key, val] of Object.entries(data)) {
      if (key === 'CODPROD') continue;
      let type = sql.VarChar;
      if (key === 'VENCIMIENTO') type = sql.Date;
      else if (['UXC', 'CODMARCA', 'CODCLAUNO', 'CODCLADOS', 'CODCLATRES', 'SERIE', 'INVMINIMO', 'INVMAXIMO', 'EXENTO', 'NF'].includes(key)) {
        type = sql.Int;
      } else if (['COSTO', 'PORCDESCUENTO', 'BONO'].includes(key)) {
        type = sql.Decimal(18, 3);
      }
      request.input(key, type, val);
      setParts.push(`${key} = @${key}`);
    }
    if (!setParts.length) return res.status(400).json({ error: 'Sin campos para actualizar' });
    const result = await request.query(`
      UPDATE dbo.PRODUCTOS SET ${setParts.join(', ')}
      WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD
    `);
    if (result.rowsAffected[0] === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true, CODPROD: codprod });
  } catch (err) {
    console.warn('[API PUT /productos/:codprod]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:codprod', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codprod = String(req.params.codprod || '').trim();
  if (!codprod) return res.status(400).json({ error: 'CODPROD inválido' });
  const pass = String(req.body?.pass ?? req.body?.PASS ?? '');
  try {
    const pool = await req.app.locals.getDbPool();
    const movCount = await countDocProductosMovimientos(pool, empnit, codprod);
    if (movCount > 0) {
      return res.status(409).json({
        error: `No se puede eliminar: el producto tiene ${movCount} movimiento(s) en documentos.`,
        count: movCount,
      });
    }
    await assertEliminacionRegistro(pool, pass);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODPROD', sql.VarChar, codprod)
        .query(`DELETE FROM dbo.PRECIOS WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD`);
      const del = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODPROD', sql.VarChar, codprod)
        .query(`DELETE FROM dbo.PRODUCTOS WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD`);
      if (del.rowsAffected[0] === 0) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Producto no encontrado' });
      }
      await transaction.commit();
      try {
        await removeProductoFotos(pool, empnit, codprod);
      } catch (_) {
        /* ignore */
      }
      res.json({ ok: true });
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({ error: err.message });
    }
    console.warn('[API DELETE /productos/:codprod]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
