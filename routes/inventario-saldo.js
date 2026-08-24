const express = require('express');
const sql = require('mssql');
const ExcelJS = require('exceljs');
const { isDbConfigured } = require('../config/database');
const { countMissingInvSaldo, syncMissingInvSaldo, deduplicateInvSaldo, countDuplicateInvSaldo } = require('../lib/invsaldo');
const {
  previewRecalcInventario,
  ejecutarRecalcInventario,
  corregirTipomNulos,
} = require('../lib/inventario-recalc');
const {
  listInventarioRetroactivo,
  listInventarioRetroactivoExport,
} = require('../lib/inventario-retroactivo');

const router = express.Router();

const INITIAL_LIMIT = 100;
const SEARCH_LIMIT = 500;
const MAX_LIMIT = 2000;

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
  const codmarcaRaw = parseInt(req.query.codmarca, 10);
  const codmarca = Number.isNaN(codmarcaRaw) ? null : codmarcaRaw;
  const habilitadoRaw = String(req.query.habilitado || '').trim().toUpperCase();
  const habilitado = habilitadoRaw === 'SI' || habilitadoRaw === 'NO' ? habilitadoRaw : null;
  let limit = INITIAL_LIMIT;
  const requested = parseInt(req.query.limit, 10);
  if (!Number.isNaN(requested)) {
    if (requested === 0) limit = 0;
    else limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
  }
  if (q) {
    limit = limit === 0 ? SEARCH_LIMIT : Math.min(Math.max(limit, SEARCH_LIMIT), MAX_LIMIT);
  }
  return { q, codmarca, habilitado, limit };
}

function hasListFilters(q, codmarca, habilitado) {
  return Boolean(q) || codmarca != null || habilitado != null;
}

function isPreviewLoad(q, codmarca, habilitado, limit) {
  return !hasListFilters(q, codmarca, habilitado) && limit === INITIAL_LIMIT;
}

function createSaldoRequest(pool) {
  const request = pool.request();
  request.timeout = 120000;
  return request;
}

function totalsFromRows(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.SALDO += Number(row.SALDO) || 0;
      acc.TOTALCOSTO += Number(row.TOTALCOSTO) || 0;
      return acc;
    },
    { SALDO: 0, TOTALCOSTO: 0 },
  );
}

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function bindSaldoFilters(request, empnit, q, qLike, codmarca, habilitado) {
  request.input('EMPNIT', sql.VarChar, empnit);
  request.input('q', sql.NVarChar, q || null);
  request.input('qLike', sql.NVarChar, qLike);
  request.input('codmarca', sql.Int, codmarca);
  request.input('habilitado', sql.VarChar, habilitado);
}

const LIST_SELECT_INVSALDO = `
  i.CODPROD,
  p.DESPROD,
  i.SALDO,
  p.EXISTENCIA,
  m.DESMARCA,
  p.TIPOPROD,
  p.COSTO,
  p.HABILITADO,
  CAST(ISNULL(p.COSTO, 0) * ISNULL(i.SALDO, 0) AS DECIMAL(18, 4)) AS TOTALCOSTO
`;

const LIST_FROM_PREVIEW = `
  FROM (
    SELECT MIN(i2.ID) AS ID
    FROM dbo.INVSALDO i2
    WHERE i2.EMPNIT = @EMPNIT
    GROUP BY LTRIM(RTRIM(i2.CODPROD))
  ) pick
  INNER JOIN dbo.INVSALDO i ON i.ID = pick.ID
  LEFT JOIN dbo.PRODUCTOS p ON i.EMPNIT = p.EMPNIT AND LTRIM(RTRIM(i.CODPROD)) = LTRIM(RTRIM(p.CODPROD))
  LEFT JOIN dbo.Marcas m ON p.EMPNIT = m.EMPNIT AND p.CODMARCA = m.CODMARCA
`;

const LIST_WHERE_PREVIEW = `
  WHERE i.EMPNIT = @EMPNIT
`;

const LIST_SELECT_PRODUCT = `
  p.CODPROD,
  p.DESPROD,
  ISNULL(inv.SALDO, 0) AS SALDO,
  p.EXISTENCIA,
  m.DESMARCA,
  p.TIPOPROD,
  p.COSTO,
  p.HABILITADO,
  CAST(ISNULL(p.COSTO, 0) * ISNULL(inv.SALDO, 0) AS DECIMAL(18, 4)) AS TOTALCOSTO
`;

const LIST_FROM_PRODUCT = `
  FROM dbo.PRODUCTOS p
  LEFT JOIN dbo.Marcas m ON p.EMPNIT = m.EMPNIT AND p.CODMARCA = m.CODMARCA
  OUTER APPLY (
    SELECT TOP 1 i.SALDO
    FROM dbo.INVSALDO i
    WHERE i.EMPNIT = p.EMPNIT
      AND LTRIM(RTRIM(i.CODPROD)) = LTRIM(RTRIM(p.CODPROD))
    ORDER BY CASE WHEN ISNULL(i.CODBODEGA, 0) = 0 THEN 0 ELSE 1 END, i.ID
  ) inv
`;

const LIST_WHERE_PRODUCT = `
  WHERE p.EMPNIT = @EMPNIT
    AND (@codmarca IS NULL OR p.CODMARCA = @codmarca)
    AND (@habilitado IS NULL OR UPPER(LTRIM(RTRIM(ISNULL(p.HABILITADO, '')))) = @habilitado)
    AND (
      @q IS NULL OR @q = ''
      OR p.CODPROD LIKE @qLike
      OR p.DESPROD LIKE @qLike
    )
`;

function getListSqlParts(q, codmarca, habilitado) {
  if (hasListFilters(q, codmarca, habilitado)) {
    return {
      select: LIST_SELECT_PRODUCT,
      from: LIST_FROM_PRODUCT,
      where: LIST_WHERE_PRODUCT,
      orderBy: 'p.CODPROD',
      totalsSelect: `
        SUM(ISNULL(inv.SALDO, 0)) AS SUM_SALDO,
        SUM(CAST(ISNULL(p.COSTO, 0) * ISNULL(inv.SALDO, 0) AS DECIMAL(18, 4))) AS SUM_TOTALCOSTO
      `,
    };
  }
  return {
    select: LIST_SELECT_INVSALDO,
    from: LIST_FROM_PREVIEW,
    where: LIST_WHERE_PREVIEW,
    orderBy: 'i.CODPROD',
    totalsSelect: `
      SUM(ISNULL(i.SALDO, 0)) AS SUM_SALDO,
      SUM(CAST(ISNULL(p.COSTO, 0) * ISNULL(i.SALDO, 0) AS DECIMAL(18, 4))) AS SUM_TOTALCOSTO
    `,
  };
}

router.get('/saldo', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  const { q, codmarca, habilitado, limit } = parseListQuery(req);
  const qLike = q ? `%${q}%` : null;
  const preview = isPreviewLoad(q, codmarca, habilitado, limit);
  const skipExactMeta = preview || Boolean(q);
  const sqlParts = getListSqlParts(q, codmarca, habilitado);

  try {
    const pool = await req.app.locals.getDbPool();

    let total = 0;
    if (!skipExactMeta) {
      const countReq = createSaldoRequest(pool);
      bindSaldoFilters(countReq, empnit, q, qLike, codmarca, habilitado);
      const countResult = await countReq.query(`
        SELECT COUNT(*) AS total
        ${sqlParts.from}
        ${sqlParts.where}
      `);
      total = countResult.recordset[0]?.total ?? 0;
    }

    const listReq = createSaldoRequest(pool);
    bindSaldoFilters(listReq, empnit, q, qLike, codmarca, habilitado);
    if (limit > 0) listReq.input('limit', sql.Int, limit);
    const topClause = limit > 0 ? 'TOP (@limit)' : '';
    const listResult = await listReq.query(`
      SELECT ${topClause} ${sqlParts.select}
      ${sqlParts.from}
      ${sqlParts.where}
      ORDER BY ${sqlParts.orderBy}
    `);

    const rows = listResult.recordset;
    if (skipExactMeta) {
      total = rows.length;
    }

    let totals = { SALDO: 0, TOTALCOSTO: 0 };
    if (skipExactMeta) {
      totals = totalsFromRows(rows);
    } else {
      const totalsReq = createSaldoRequest(pool);
      bindSaldoFilters(totalsReq, empnit, q, qLike, codmarca, habilitado);
      const totalsResult = await totalsReq.query(`
        SELECT
          ${sqlParts.totalsSelect}
        ${sqlParts.from}
        ${sqlParts.where}
      `);
      const totalsRow = totalsResult.recordset[0] || {};
      totals = {
        SALDO: totalsRow.SUM_SALDO ?? 0,
        TOTALCOSTO: totalsRow.SUM_TOTALCOSTO ?? 0,
      };
    }

    const truncated = skipExactMeta
      ? limit > 0 && rows.length >= limit
      : total > rows.length;

    res.json({
      rows,
      total,
      limit,
      truncated,
      empnit,
      codmarca,
      habilitado,
      totals,
    });
  } catch (err) {
    console.error('[API GET /inventario/saldo]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

router.get('/saldo/export', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  const { q, codmarca, habilitado } = parseListQuery(req);
  const qLike = q ? `%${q}%` : null;
  const sqlParts = getListSqlParts(q, codmarca, habilitado);

  try {
    const pool = await req.app.locals.getDbPool();
    const listReq = createSaldoRequest(pool);
    bindSaldoFilters(listReq, empnit, q, qLike, codmarca, habilitado);
    const listResult = await listReq.query(`
      SELECT ${sqlParts.select}
      ${sqlParts.from}
      ${sqlParts.where}
      ORDER BY ${sqlParts.orderBy}
    `);

    const totalsReq = createSaldoRequest(pool);
    bindSaldoFilters(totalsReq, empnit, q, qLike, codmarca, habilitado);
    const totalsResult = await totalsReq.query(`
      SELECT
        ${sqlParts.totalsSelect}
      ${sqlParts.from}
      ${sqlParts.where}
    `);
    const totalsRow = totalsResult.recordset[0] || {};

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Inventario');
    sheet.columns = [
      { header: 'Código', key: 'CODPROD', width: 14 },
      { header: 'Descripción', key: 'DESPROD', width: 32 },
      { header: 'Marca', key: 'DESMARCA', width: 18 },
      { header: 'Tipo', key: 'TIPOPROD', width: 10 },
      { header: 'Saldo', key: 'SALDO', width: 12 },
      { header: 'Existencia', key: 'EXISTENCIA', width: 12 },
      { header: 'Costo', key: 'COSTO', width: 12 },
      { header: 'Total costo', key: 'TOTALCOSTO', width: 14 },
      { header: 'Habilitado', key: 'HABILITADO', width: 12 },
    ];
    sheet.getRow(1).font = { bold: true };

    for (const row of listResult.recordset) {
      sheet.addRow(row);
    }

    if (listResult.recordset.length) {
      const totalRow = sheet.addRow({
        CODPROD: '',
        DESPROD: '',
        DESMARCA: '',
        TIPOPROD: 'Totales',
        SALDO: totalsRow.SUM_SALDO ?? 0,
        EXISTENCIA: '',
        COSTO: '',
        TOTALCOSTO: totalsRow.SUM_TOTALCOSTO ?? 0,
        HABILITADO: '',
      });
      totalRow.font = { bold: true };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const safeEmp = empnit.replace(/[^\w-]+/g, '_');
    const stamp = todayDateOnly();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="inventario_${safeEmp}_${stamp}.xlsx"`,
    );
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[API GET /inventario/saldo/export]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

router.get('/retroactivo', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  const { q, codmarca, habilitado, limit } = parseListQuery(req);
  const mes = parseInt(req.query.mes, 10);
  const anio = parseInt(req.query.anio, 10);

  try {
    const pool = await req.app.locals.getDbPool();
    const data = await listInventarioRetroactivo(pool, {
      empnit,
      mes,
      anio,
      q,
      codmarca,
      habilitado,
      limit,
    });
    res.json(data);
  } catch (err) {
    console.error('[API GET /inventario/retroactivo]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
  return undefined;
});

router.get('/retroactivo/export', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  const { q, codmarca, habilitado } = parseListQuery(req);
  const mes = parseInt(req.query.mes, 10);
  const anio = parseInt(req.query.anio, 10);

  try {
    const pool = await req.app.locals.getDbPool();
    const data = await listInventarioRetroactivoExport(pool, {
      empnit,
      mes,
      anio,
      q,
      codmarca,
      habilitado,
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Inventario Retroactivo');
    sheet.columns = [
      { header: 'Código', key: 'CODPROD', width: 14 },
      { header: 'Descripción', key: 'DESPROD', width: 32 },
      { header: 'Marca', key: 'DESMARCA', width: 18 },
      { header: 'Tipo', key: 'TIPOPROD', width: 10 },
      { header: 'Saldo', key: 'SALDO', width: 12 },
      { header: 'Existencia', key: 'EXISTENCIA', width: 12 },
      { header: 'Costo', key: 'COSTO', width: 12 },
      { header: 'Total costo', key: 'TOTALCOSTO', width: 14 },
      { header: 'Habilitado', key: 'HABILITADO', width: 12 },
    ];
    sheet.getRow(1).font = { bold: true };

    for (const row of data.rows) {
      sheet.addRow(row);
    }

    if (data.rows.length) {
      const totalRow = sheet.addRow({
        CODPROD: '',
        DESPROD: '',
        DESMARCA: '',
        TIPOPROD: 'Totales',
        SALDO: data.totals.SUM_SALDO ?? 0,
        EXISTENCIA: '',
        COSTO: '',
        TOTALCOSTO: data.totals.SUM_TOTALCOSTO ?? 0,
        HABILITADO: '',
      });
      totalRow.font = { bold: true };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const safeEmp = empnit.replace(/[^\w-]+/g, '_');
    const stamp = `${data.anio}-${String(data.mes).padStart(2, '0')}`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="inventario_retroactivo_${safeEmp}_${stamp}.xlsx"`,
    );
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[API GET /inventario/retroactivo/export]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
  return undefined;
});

router.get('/saldo/pendientes', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  try {
    const pool = await req.app.locals.getDbPool();
    const pendientes = await countMissingInvSaldo(pool, empnit);
    res.json({ empnit, pendientes });
  } catch (err) {
    console.error('[API GET /inventario/saldo/pendientes]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

router.post('/saldo/sincronizar', async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  try {
    const pool = await req.app.locals.getDbPool();
    const creados = await syncMissingInvSaldo(pool, empnit);
    const pendientes = await countMissingInvSaldo(pool, empnit);
    res.json({ ok: true, empnit, creados, pendientes });
  } catch (err) {
    console.error('[API POST /inventario/saldo/sincronizar]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

router.post('/saldo/deduplicar', async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await deduplicateInvSaldo(pool, empnit);
    const duplicados = await countDuplicateInvSaldo(pool, empnit);
    res.json({ ok: true, empnit, ...result, duplicadosRestantes: duplicados });
  } catch (err) {
    console.error('[API POST /inventario/saldo/deduplicar]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

router.get('/recalcular/preview', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  try {
    const pool = await req.app.locals.getDbPool();
    const preview = await previewRecalcInventario(pool, empnit);
    res.json(preview);
  } catch (err) {
    console.error('[API GET /inventario/recalcular/preview]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

router.post('/recalcular', async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await ejecutarRecalcInventario(pool, empnit);
    res.json(result);
  } catch (err) {
    console.error('[API POST /inventario/recalcular]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

router.post('/recalcular/corregir-tipom', async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await corregirTipomNulos(pool, empnit);
    res.json(result);
  } catch (err) {
    console.error('[API POST /inventario/recalcular/corregir-tipom]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

/** Existencia operativa para relleno (INVSALDO; fallback PRODUCTOS.EXISTENCIA). */
const RELLENO_EXISTENCIA_EXPR = `ISNULL(inv.SALDO, ISNULL(p.EXISTENCIA, 0))`;

const LIST_SELECT_RELLENO = `
  p.CODPROD,
  p.DESPROD,
  ISNULL(inv.SALDO, 0) AS SALDO,
  p.EXISTENCIA,
  m.DESMARCA,
  p.TIPOPROD,
  p.COSTO,
  p.HABILITADO,
  CAST(ISNULL(p.COSTO, 0) * ISNULL(inv.SALDO, 0) AS DECIMAL(18, 4)) AS TOTALCOSTO,
  ISNULL(p.INVMINIMO, 0) AS INVMINIMO,
  ISNULL(p.INVMAXIMO, 0) AS INVMAXIMO,
  CAST(ISNULL(p.INVMAXIMO, 0) - (${RELLENO_EXISTENCIA_EXPR}) AS DECIMAL(18, 4)) AS ABASTECER
`;

const LIST_FROM_RELLENO = `
  FROM dbo.PRODUCTOS p
  LEFT JOIN dbo.Marcas m ON p.EMPNIT = m.EMPNIT AND p.CODMARCA = m.CODMARCA
  OUTER APPLY (
    SELECT TOP 1 i.SALDO
    FROM dbo.INVSALDO i
    WHERE i.EMPNIT = p.EMPNIT
      AND LTRIM(RTRIM(i.CODPROD)) = LTRIM(RTRIM(p.CODPROD))
    ORDER BY CASE WHEN ISNULL(i.CODBODEGA, 0) = 0 THEN 0 ELSE 1 END, i.ID
  ) inv
`;

const LIST_WHERE_RELLENO = `
  WHERE p.EMPNIT = @EMPNIT
    AND (${RELLENO_EXISTENCIA_EXPR}) <= ISNULL(p.INVMINIMO, 0)
    AND (@codmarca IS NULL OR p.CODMARCA = @codmarca)
    AND (@habilitado IS NULL OR UPPER(LTRIM(RTRIM(ISNULL(p.HABILITADO, '')))) = @habilitado)
    AND (
      @q IS NULL OR @q = ''
      OR p.CODPROD LIKE @qLike
      OR p.DESPROD LIKE @qLike
    )
`;

function totalsRellenoFromRows(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.SALDO += Number(row.SALDO) || 0;
      acc.TOTALCOSTO += Number(row.TOTALCOSTO) || 0;
      acc.ABASTECER += Number(row.ABASTECER) || 0;
      return acc;
    },
    { SALDO: 0, TOTALCOSTO: 0, ABASTECER: 0 },
  );
}

router.get('/relleno', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  const { q, codmarca, habilitado, limit } = parseListQuery(req);
  const qLike = q ? `%${q}%` : null;
  const preview = isPreviewLoad(q, codmarca, habilitado, limit);
  const skipExactMeta = preview || Boolean(q);

  try {
    const pool = await req.app.locals.getDbPool();

    let total = 0;
    if (!skipExactMeta) {
      const countReq = createSaldoRequest(pool);
      bindSaldoFilters(countReq, empnit, q, qLike, codmarca, habilitado);
      const countResult = await countReq.query(`
        SELECT COUNT(*) AS total
        ${LIST_FROM_RELLENO}
        ${LIST_WHERE_RELLENO}
      `);
      total = countResult.recordset[0]?.total ?? 0;
    }

    const listReq = createSaldoRequest(pool);
    bindSaldoFilters(listReq, empnit, q, qLike, codmarca, habilitado);
    if (limit > 0) listReq.input('limit', sql.Int, limit);
    const topClause = limit > 0 ? 'TOP (@limit)' : '';
    const listResult = await listReq.query(`
      SELECT ${topClause} ${LIST_SELECT_RELLENO}
      ${LIST_FROM_RELLENO}
      ${LIST_WHERE_RELLENO}
      ORDER BY p.CODPROD
    `);

    const rows = listResult.recordset;
    if (skipExactMeta) {
      total = rows.length;
    }

    let totals;
    if (skipExactMeta || limit === 0 || rows.length >= total) {
      totals = totalsRellenoFromRows(rows);
    } else {
      const totalsReq = createSaldoRequest(pool);
      bindSaldoFilters(totalsReq, empnit, q, qLike, codmarca, habilitado);
      const totalsResult = await totalsReq.query(`
        SELECT
          SUM(ISNULL(inv.SALDO, 0)) AS SUM_SALDO,
          SUM(CAST(ISNULL(p.COSTO, 0) * ISNULL(inv.SALDO, 0) AS DECIMAL(18, 4))) AS SUM_TOTALCOSTO,
          SUM(CAST(ISNULL(p.INVMAXIMO, 0) - (${RELLENO_EXISTENCIA_EXPR}) AS DECIMAL(18, 4))) AS SUM_ABASTECER
        ${LIST_FROM_RELLENO}
        ${LIST_WHERE_RELLENO}
      `);
      const t = totalsResult.recordset[0] || {};
      totals = {
        SALDO: Number(t.SUM_SALDO) || 0,
        TOTALCOSTO: Number(t.SUM_TOTALCOSTO) || 0,
        ABASTECER: Number(t.SUM_ABASTECER) || 0,
      };
    }

    const truncated = limit > 0 && !skipExactMeta && total > rows.length;
    res.json({
      rows,
      total,
      truncated,
      empnit,
      codmarca,
      habilitado,
      totals,
    });
  } catch (err) {
    console.error('[API GET /inventario/relleno]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

router.get('/relleno/export', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  const { q, codmarca, habilitado } = parseListQuery(req);
  const qLike = q ? `%${q}%` : null;

  try {
    const pool = await req.app.locals.getDbPool();
    const listReq = createSaldoRequest(pool);
    bindSaldoFilters(listReq, empnit, q, qLike, codmarca, habilitado);
    const listResult = await listReq.query(`
      SELECT ${LIST_SELECT_RELLENO}
      ${LIST_FROM_RELLENO}
      ${LIST_WHERE_RELLENO}
      ORDER BY p.CODPROD
    `);

    const totalsReq = createSaldoRequest(pool);
    bindSaldoFilters(totalsReq, empnit, q, qLike, codmarca, habilitado);
    const totalsResult = await totalsReq.query(`
      SELECT
        SUM(ISNULL(inv.SALDO, 0)) AS SUM_SALDO,
        SUM(CAST(ISNULL(p.COSTO, 0) * ISNULL(inv.SALDO, 0) AS DECIMAL(18, 4))) AS SUM_TOTALCOSTO,
        SUM(CAST(ISNULL(p.INVMAXIMO, 0) - (${RELLENO_EXISTENCIA_EXPR}) AS DECIMAL(18, 4))) AS SUM_ABASTECER
      ${LIST_FROM_RELLENO}
      ${LIST_WHERE_RELLENO}
    `);
    const totalsRow = totalsResult.recordset[0] || {};

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Relleno inventario');
    sheet.columns = [
      { header: 'Código', key: 'CODPROD', width: 14 },
      { header: 'Descripción', key: 'DESPROD', width: 32 },
      { header: 'Marca', key: 'DESMARCA', width: 18 },
      { header: 'Tipo', key: 'TIPOPROD', width: 10 },
      { header: 'Saldo', key: 'SALDO', width: 12 },
      { header: 'Existencia', key: 'EXISTENCIA', width: 12 },
      { header: 'Costo', key: 'COSTO', width: 12 },
      { header: 'Total costo', key: 'TOTALCOSTO', width: 14 },
      { header: 'Mínimo', key: 'INVMINIMO', width: 12 },
      { header: 'Máximo', key: 'INVMAXIMO', width: 12 },
      { header: 'Abastecer', key: 'ABASTECER', width: 12 },
      { header: 'Habilitado', key: 'HABILITADO', width: 12 },
    ];
    sheet.getRow(1).font = { bold: true };

    for (const row of listResult.recordset) {
      sheet.addRow(row);
    }

    if (listResult.recordset.length) {
      const totalRow = sheet.addRow({
        CODPROD: '',
        DESPROD: '',
        DESMARCA: '',
        TIPOPROD: 'Totales',
        SALDO: totalsRow.SUM_SALDO ?? 0,
        EXISTENCIA: '',
        COSTO: '',
        TOTALCOSTO: totalsRow.SUM_TOTALCOSTO ?? 0,
        INVMINIMO: '',
        INVMAXIMO: '',
        ABASTECER: totalsRow.SUM_ABASTECER ?? 0,
        HABILITADO: '',
      });
      totalRow.font = { bold: true };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const safeEmp = empnit.replace(/[^\w-]+/g, '_');
    const stamp = todayDateOnly();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="relleno_inventario_${safeEmp}_${stamp}.xlsx"`,
    );
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[API GET /inventario/relleno/export]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

/** Facturas de venta (FAC + FEL: FEF/FES/FEC). */
const TIPODOC_VENTA_RELLENO = ['FAC', 'FEF', 'FES', 'FEC'];
const SQL_TIPODOC_VENTA_RELLENO_IN = TIPODOC_VENTA_RELLENO.map((t) => `'${t}'`).join(', ');

/**
 * Calcula INVMAXIMO (promedio mensual de TOTALUNIDADES vendidas) e INVMINIMO
 * (promedio / días) para todos los productos de la empresa.
 * Solo documentos FAC/FEL no anulados con TIPOM = SALIDA (-1).
 */
router.post('/relleno/calcular-min-max', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return undefined;

  const body = req.body || {};
  const mesInicial = parseInt(body.mesInicial ?? body.mes_inicial, 10);
  const mesFinal = parseInt(body.mesFinal ?? body.mes_final, 10);
  const anio = parseInt(body.anio, 10);
  const dias = parseInt(body.dias, 10);

  if (!Number.isInteger(mesInicial) || mesInicial < 1 || mesInicial > 12) {
    return res.status(400).json({ error: 'Mes inicial inválido (1–12)' });
  }
  if (!Number.isInteger(mesFinal) || mesFinal < 1 || mesFinal > 12) {
    return res.status(400).json({ error: 'Mes final inválido (1–12)' });
  }
  if (mesInicial > mesFinal) {
    return res.status(400).json({ error: 'El mes inicial no puede ser mayor que el mes final' });
  }
  if (!Number.isInteger(anio) || anio < 2020 || anio > 2060) {
    return res.status(400).json({ error: 'Año inválido (2020–2060)' });
  }
  if (!Number.isInteger(dias) || dias < 1 || dias > 30) {
    return res.status(400).json({ error: 'Días de mínimo inválidos (1–30)' });
  }

  const meses = mesFinal - mesInicial + 1;

  try {
    const pool = await req.app.locals.getDbPool();
    const request = pool.request();
    request.timeout = 300000;
    request.input('EMPNIT', sql.VarChar, empnit);
    request.input('ANIO', sql.Int, anio);
    request.input('MES_INI', sql.Int, mesInicial);
    request.input('MES_FIN', sql.Int, mesFinal);
    request.input('MESES', sql.Int, meses);
    request.input('DIAS', sql.Int, dias);

    const result = await request.query(`
      IF OBJECT_ID('tempdb..#relleno_ventas') IS NOT NULL DROP TABLE #relleno_ventas;

      SELECT
        LTRIM(RTRIM(CAST(dp.CODPROD AS VARCHAR(50)))) AS CODPROD,
        SUM(CAST(ISNULL(dp.TOTALUNIDADES, 0) AS DECIMAL(18, 4))) AS TOTAL_UNIDADES
      INTO #relleno_ventas
      FROM dbo.DOCPRODUCTOS dp
      INNER JOIN dbo.DOCUMENTOS d
        ON dp.EMPNIT = d.EMPNIT
        AND dp.CODDOC = d.CODDOC
        AND dp.CORRELATIVO = d.CORRELATIVO
      INNER JOIN dbo.TIPODOCUMENTOS t
        ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      WHERE d.EMPNIT = @EMPNIT
        AND d.ANIO = @ANIO
        AND d.MES BETWEEN @MES_INI AND @MES_FIN
        AND ISNULL(d.STATUS, '') <> 'A'
        AND UPPER(LTRIM(RTRIM(ISNULL(t.TIPODOC, '')))) IN (${SQL_TIPODOC_VENTA_RELLENO_IN})
        AND ISNULL(t.TIPOM, 0) = -1
      GROUP BY LTRIM(RTRIM(CAST(dp.CODPROD AS VARCHAR(50))));

      UPDATE p
      SET
        INVMAXIMO = CAST(ROUND(ISNULL(v.TOTAL_UNIDADES, 0) / NULLIF(@MESES, 0), 4) AS DECIMAL(18, 4)),
        INVMINIMO = CAST(ROUND(
          (ISNULL(v.TOTAL_UNIDADES, 0) / NULLIF(@MESES, 0)) / NULLIF(@DIAS, 0),
          4
        ) AS DECIMAL(18, 4))
      FROM dbo.PRODUCTOS p
      LEFT JOIN #relleno_ventas v
        ON LTRIM(RTRIM(CAST(p.CODPROD AS VARCHAR(50)))) = v.CODPROD
      WHERE p.EMPNIT = @EMPNIT;

      SELECT
        (SELECT COUNT(*) FROM dbo.PRODUCTOS WHERE EMPNIT = @EMPNIT) AS productosActualizados,
        (SELECT COUNT(*) FROM #relleno_ventas WHERE TOTAL_UNIDADES > 0) AS productosConVentas;
    `);

    const sets = result.recordsets || [];
    const meta = (sets.length ? sets[sets.length - 1]?.[0] : null) || result.recordset?.[0] || {};
    res.json({
      ok: true,
      empnit,
      anio,
      mesInicial,
      mesFinal,
      meses,
      dias,
      productosActualizados: Number(meta.productosActualizados) || 0,
      productosConVentas: Number(meta.productosConVentas) || 0,
    });
  } catch (err) {
    console.error('[API POST /inventario/relleno/calcular-min-max]', err.message);
    res.status(500).json({ error: err.message });
  }
  return undefined;
});

module.exports = router;
