const express = require('express');
const sql = require('mssql');
const ExcelJS = require('exceljs');
const { isDbConfigured } = require('../config/database');
const { SQL_INVSALDO_JOIN, sqlExistenciaMedidaExpr } = require('../lib/existencia-medida');

const router = express.Router();

const DEFAULT_LIMIT = 100;
const SEARCH_LIMIT = 1000;

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

function todayDateOnly() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseListQuery(req) {
  const q = String(req.query.q || '').trim();
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
  return { q, limit };
}

const LIST_FROM = `
  FROM dbo.PRECIOS pr
  INNER JOIN dbo.PRODUCTOS p
    ON pr.EMPNIT = p.EMPNIT AND pr.CODPROD = p.CODPROD
  LEFT JOIN dbo.Marcas m
    ON p.EMPNIT = m.EMPNIT AND p.CODMARCA = m.CODMARCA
  ${SQL_INVSALDO_JOIN}
`;

const LIST_SELECT = `
  p.CODPROD,
  p.DESPROD,
  p.DESPROD2,
  m.DESMARCA,
  pr.CODMEDIDA,
  pr.EQUIVALE,
  pr.COSTO,
  pr.COSTO_PROMEDIO,
  pr.PRECIO,
  pr.MAYOREOC,
  pr.MAYOREOB,
  pr.MAYOREOA,
  ${sqlExistenciaMedidaExpr('pr.EQUIVALE')}
`;

const SEARCH_WHERE = `
  WHERE pr.EMPNIT = @EMPNIT
    AND (
      @q IS NULL OR @q = ''
      OR p.CODPROD LIKE @qLike
      OR p.CODPROD2 LIKE @qLike
      OR p.DESPROD LIKE @qLike
      OR p.DESPROD2 LIKE @qLike
      OR m.DESMARCA LIKE @qLike
      OR pr.CODMEDIDA LIKE @qLike
    )
`;

function parseIncludeCosto(req) {
  const raw = String(req.query.includeCosto ?? req.query.includecosto ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'si' || raw === 'yes';
}

/** Lista precios (una fila por medida) con búsqueda opcional. */
router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const { q, limit } = parseListQuery(req);
  const includeCosto = parseIncludeCosto(req);

  try {
    const pool = await req.app.locals.getDbPool();
    const qLike = q ? `%${q}%` : null;

    const countReq = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('q', sql.NVarChar, q || null)
      .input('qLike', sql.NVarChar, qLike);
    const total = (
      await countReq.query(`
        SELECT COUNT(*) AS total
        ${LIST_FROM}
        ${SEARCH_WHERE}
      `)
    ).recordset[0].total;

    const listReq = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('q', sql.NVarChar, q || null)
      .input('qLike', sql.NVarChar, qLike)
      .input('limit', sql.Int, limit);
    const rows = (
      await listReq.query(`
        SELECT TOP (@limit)
          ${LIST_SELECT}
        ${LIST_FROM}
        ${SEARCH_WHERE}
        ORDER BY p.DESPROD, p.CODPROD, pr.EQUIVALE, pr.CODMEDIDA
      `)
    ).recordset.map((row) => {
      if (includeCosto) return row;
      const { COSTO, COSTO_PROMEDIO, ...rest } = row;
      return rest;
    });

    res.json({
      rows,
      total,
      limit,
      truncated: total > rows.length,
      empnit,
      q: q || null,
      includeCosto,
    });
  } catch (err) {
    console.warn('[API GET /lista-precios]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Exporta todos los precios a Excel (sin aplicar filtro de búsqueda). */
router.get('/export', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const includeCosto = parseIncludeCosto(req);

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .query(`
        SELECT
          ${LIST_SELECT}
        ${LIST_FROM}
        WHERE pr.EMPNIT = @EMPNIT
        ORDER BY p.DESPROD, p.CODPROD, pr.EQUIVALE, pr.CODMEDIDA
      `);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Lista precios');
    const columns = [
      { header: 'CODIGO', key: 'CODPROD', width: 14 },
      { header: 'PRODUCTO', key: 'DESPROD', width: 32 },
      { header: 'DESCRIPCION', key: 'DESPROD2', width: 28 },
      { header: 'MARCA', key: 'DESMARCA', width: 18 },
      { header: 'MEDIDA', key: 'CODMEDIDA', width: 12 },
      { header: 'EQUIVALE', key: 'EQUIVALE', width: 12 },
    ];
    if (includeCosto) {
      columns.push({ header: 'COSTO_PROMEDIO', key: 'COSTO_PROMEDIO', width: 14 });
      columns.push({ header: 'COSTO', key: 'COSTO', width: 14 });
    }
    columns.push(
      { header: 'PRECIO', key: 'PRECIO', width: 14 },
      { header: 'MAYOREOC', key: 'MAYOREOC', width: 14 },
      { header: 'MAYOREOB', key: 'MAYOREOB', width: 14 },
      { header: 'MAYOREOA', key: 'MAYOREOA', width: 14 },
      { header: 'EXISTENCIA', key: 'EXISTENCIA', width: 14 }
    );
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };

    for (const row of result.recordset) {
      const out = {
        CODPROD: row.CODPROD,
        DESPROD: row.DESPROD,
        DESPROD2: row.DESPROD2,
        DESMARCA: row.DESMARCA,
        CODMEDIDA: row.CODMEDIDA,
        EQUIVALE: Number(row.EQUIVALE) || 0,
        PRECIO: Number(row.PRECIO) || 0,
        MAYOREOC: Number(row.MAYOREOC) || 0,
        MAYOREOB: Number(row.MAYOREOB) || 0,
        MAYOREOA: Number(row.MAYOREOA) || 0,
        EXISTENCIA: Number(row.EXISTENCIA) || 0,
      };
      if (includeCosto) {
        out.COSTO_PROMEDIO = Number(row.COSTO_PROMEDIO) || 0;
        out.COSTO = Number(row.COSTO) || 0;
      }
      sheet.addRow(out);
    }

    const moneyCols = includeCosto
      ? ['EQUIVALE', 'COSTO_PROMEDIO', 'COSTO', 'PRECIO', 'MAYOREOC', 'MAYOREOB', 'MAYOREOA', 'EXISTENCIA']
      : ['EQUIVALE', 'PRECIO', 'MAYOREOC', 'MAYOREOB', 'MAYOREOA', 'EXISTENCIA'];
    for (const col of moneyCols) {
      sheet.getColumn(col).numFmt = '#,##0.00';
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const safeEmp = empnit.replace(/[^\w-]+/g, '_');
    const stamp = todayDateOnly();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="lista_precios_${safeEmp}_${stamp}.xlsx"`
    );
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.warn('[API GET /lista-precios/export]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
