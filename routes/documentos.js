const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const { assertAdminPass, assertEliminacionRegistro } = require('../lib/config-auth');
const { deleteDocumentoOperado, DocumentoDeleteError } = require('../lib/documento-delete');
const { usuarioFromReq } = require('../lib/documentos-eliminados');
const { InventarioError } = require('../lib/inventario');
const { parseFechaInput, applyDocumentoFecha, fechaIsoFromRow, fechaIsoFromValue } = require('../lib/documento-fecha');
const {
  listSeriesAlternas,
  cambiarSerieInterna,
  DocumentoSerieError,
} = require('../lib/documento-cambiar-serie');
const {
  STATUS_OPERADO,
  STATUS_BLOQUEADO,
  STATUS_ANULADO,
  normalizeStatus,
} = require('../lib/documento-status');

const router = express.Router();

const DEFAULT_LIMIT = 500;
const SEARCH_LIMIT = 500;

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

function parseMes(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || n > 12) return null;
  return n;
}

function parseAnio(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 2020 || n > 2027) return null;
  return n;
}

function parseTipodoc(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return s || null;
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

function parseListFilters(req, res) {
  const empnit = requireEmpNit(req, res);
  if (!empnit) return null;

  const mes = parseMes(req.query.mes);
  const anio = parseAnio(req.query.anio);
  if (mes === null) {
    res.status(400).json({ error: 'MES inválido (1-12)' });
    return null;
  }
  if (anio === null) {
    res.status(400).json({ error: 'ANIO inválido (2020-2027)' });
    return null;
  }

  const tipodoc = parseTipodoc(req.query.tipodoc);
  if (!tipodoc) {
    res.status(400).json({ error: 'TIPODOC es obligatorio' });
    return null;
  }

  const q = String(req.query.q || '').trim();
  return { empnit, mes, anio, tipodoc, q };
}

const LIST_FROM = `
  FROM dbo.DOCUMENTOS d
  INNER JOIN dbo.TIPODOCUMENTOS t
    ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
  LEFT OUTER JOIN dbo.Empleados emp
    ON d.CODVEN = emp.CODEMPLEADO AND d.EMPNIT = emp.EMPNIT
  LEFT OUTER JOIN dbo.CLIENTES c
    ON d.EMPNIT = c.EMPNIT AND d.CODCLIENTE = c.CODCLIENTE
  LEFT OUTER JOIN dbo.Cajas cj
    ON d.EMPNIT = cj.EMPNIT AND d.CODCAJA = cj.CODCAJA
`;

const LIST_SELECT = `
  d.FECHA,
  d.ANIO,
  d.MES,
  d.DIA,
  d.CODDOC,
  t.DESDOC,
  t.TIPODOC,
  d.CORRELATIVO,
  d.DOC_NOMCLIE,
  d.DOC_NIT,
  c.NEGOCIO,
  d.DOC_DIRCLIE,
  ISNULL(emp.NOMEMPLEADO, '') AS VENDEDOR,
  d.TOTALPRECIO,
  d.STATUS,
  d.CONCRE,
  ISNULL(d.CORTE, 'NO') AS CORTE,
  d.CODCAJA,
  ISNULL(cj.DESCAJA, '') AS DESCAJA,
  d.FEL_UUDI,
  d.FEL_SERIE,
  d.FEL_NUMERO,
  d.ID_COLA_TRABAJO
`;

const LIST_WHERE = `
  WHERE d.EMPNIT = @EMPNIT
    AND d.MES = @MES
    AND d.ANIO = @ANIO
    AND t.TIPODOC = @TIPODOC
    AND (
      @q IS NULL OR @q = ''
      OR CAST(d.CORRELATIVO AS varchar(30)) LIKE @qLike
      OR d.CODDOC LIKE @qLike
      OR t.DESDOC LIKE @qLike
      OR d.DOC_NOMCLIE LIKE @qLike
      OR c.NEGOCIO LIKE @qLike
      OR d.DOC_NIT LIKE @qLike
      OR emp.NOMEMPLEADO LIKE @qLike
      OR d.STATUS LIKE @qLike
    )
`;

function bindListFilters(request, { empnit, mes, anio, tipodoc, q }) {
  request.input('EMPNIT', sql.VarChar, empnit);
  request.input('MES', sql.Int, mes);
  request.input('ANIO', sql.Int, anio);
  request.input('TIPODOC', sql.VarChar, tipodoc);
  request.input('q', sql.NVarChar, q || null);
  request.input('qLike', sql.NVarChar, q ? `%${q}%` : null);
}

function mapDocumentoRow(r) {
  const vendedor = r.VENDEDOR ?? r.vendedor ?? '';
  return {
    FECHA: fechaIsoFromRow(r) || null,
    CODDOC: r.CODDOC ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: r.TIPODOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    DOC_NOMCLIE: r.DOC_NOMCLIE ?? null,
    NEGOCIO: r.NEGOCIO ?? null,
    DOC_DIRCLIE: r.DOC_DIRCLIE ?? null,
    VENDEDOR: String(vendedor).trim(),
    TOTALPRECIO: r.TOTALPRECIO ?? null,
    STATUS: r.STATUS ?? null,
    CONCRE: r.CONCRE ?? null,
    CORTE: r.CORTE ?? null,
    CODCAJA: r.CODCAJA ?? null,
    DESCAJA: r.DESCAJA ?? null,
    ANIO: r.ANIO ?? null,
    MES: r.MES ?? null,
    DIA: r.DIA ?? null,
    DOC_NIT: r.DOC_NIT ?? null,
    FEL_UUDI: r.FEL_UUDI ?? null,
    FEL_SERIE: r.FEL_SERIE ?? null,
    FEL_NUMERO: r.FEL_NUMERO ?? null,
    ID_COLA_TRABAJO: r.ID_COLA_TRABAJO ?? null,
  };
}

router.get('/tipos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool.request().query(`
      SELECT TIPODOC, DESCRIPCION
      FROM dbo.CONFIG_TIPODOCUMENTOS
      ORDER BY DESCRIPCION, TIPODOC
    `);
    const rows = result.recordset.map((r) => ({
      TIPODOC: String(r.TIPODOC ?? '').trim().toUpperCase(),
      DESCRIPCION: String(r.DESCRIPCION ?? r.TIPODOC ?? '').trim(),
    }));
    res.json({ rows, empnit });
  } catch (err) {
    console.warn('[API GET /documentos/tipos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/lista', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const filters = parseListFilters(req, res);
  if (!filters) return;

  const { empnit, mes, anio, tipodoc, q } = filters;
  const { limit } = parseListQuery(req);

  try {
    const pool = await req.app.locals.getDbPool();

    const countReq = pool.request();
    bindListFilters(countReq, { empnit, mes, anio, tipodoc, q });
    const countResult = await countReq.query(`
      SELECT COUNT(*) AS total
      ${LIST_FROM}
      ${LIST_WHERE}
    `);
    const total = countResult.recordset[0].total;

    const listReq = pool.request();
    bindListFilters(listReq, { empnit, mes, anio, tipodoc, q });
    listReq.input('limit', sql.Int, limit);
    const listResult = await listReq.query(`
      SELECT TOP (@limit) ${LIST_SELECT}
      ${LIST_FROM}
      ${LIST_WHERE}
      ORDER BY d.FECHA DESC, d.CORRELATIVO DESC
    `);

    const rows = listResult.recordset.map(mapDocumentoRow);

    res.json({
      rows,
      total,
      limit,
      truncated: total > rows.length,
      mes,
      anio,
      tipodoc,
      empnit,
      q: q || null,
    });
  } catch (err) {
    console.warn('[API GET /documentos/lista]', err.message);
    res.status(500).json({ error: err.message });
  }
});

function parseCorrelativo(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function loadDocumentoMeta(pool, empnit, coddoc, correlativo) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT STATUS, ISNULL(CORTE, 'NO') AS CORTE, FEL_UUDI, CODCAJA
      FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  return result.recordset[0] || null;
}

function assertDocumentoOperado(meta) {
  if (String(meta?.STATUS || '').trim().toUpperCase() !== STATUS_OPERADO) {
    const err = new Error('Solo documentos operados permiten esta operación');
    err.statusCode = 400;
    throw err;
  }
}

function assertSinCertificacionFel(meta) {
  if (String(meta?.FEL_UUDI || '').trim()) {
    const err = new Error('El documento está certificado FEL y no permite esta operación');
    err.statusCode = 400;
    throw err;
  }
}

function assertSinCorte(meta) {
  if (String(meta?.CORTE || 'NO').trim().toUpperCase() === 'SI') {
    const err = new Error('El documento está incluido en corte de caja');
    err.statusCode = 400;
    throw err;
  }
}

router.get('/resumen/:coddoc/:correlativo', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const coddoc = String(req.params.coddoc || '').trim();
  const correlativoRaw = String(req.params.correlativo || '').trim();
  const correlativo = parseCorrelativo(correlativoRaw);
  if (!coddoc || !correlativoRaw) {
    return res.status(400).json({ error: 'Indique serie (CODDOC o FEL) y número/correlativo válidos' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const request = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('FEL_SERIE', sql.VarChar, coddoc)
      .input('FEL_NUMERO', sql.VarChar, correlativoRaw)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo);
    const result = await request.query(`
        SELECT TOP 1
          d.CODDOC, d.CORRELATIVO, d.FECHA, d.STATUS,
          ISNULL(d.DOC_NIT, '') AS DOC_NIT,
          ISNULL(d.DOC_NOMCLIE, '') AS DOC_NOMCLIE,
          ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
          ISNULL(d.FEL_SERIE, '') AS FEL_SERIE,
          ISNULL(d.FEL_NUMERO, '') AS FEL_NUMERO
        FROM dbo.DOCUMENTOS d
        WHERE d.EMPNIT = @EMPNIT
          AND (
            (@CORRELATIVO IS NOT NULL AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO)
            OR (
              LTRIM(RTRIM(ISNULL(d.FEL_SERIE, ''))) = @FEL_SERIE
              AND LTRIM(RTRIM(ISNULL(d.FEL_NUMERO, ''))) = @FEL_NUMERO
            )
          )
        ORDER BY
          CASE
            WHEN @CORRELATIVO IS NOT NULL AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO THEN 0
            ELSE 1
          END,
          d.FECHA DESC
      `);
    if (!result.recordset.length) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }
    const row = result.recordset[0];
    res.json({
      CODDOC: row.CODDOC,
      CORRELATIVO: row.CORRELATIVO,
      FECHA: fechaIsoFromRow(row) || fechaIsoFromValue(row.FECHA) || null,
      DOC_NIT: String(row.DOC_NIT || '').trim() || null,
      DOC_NOMCLIE: String(row.DOC_NOMCLIE || '').trim() || null,
      TOTALPRECIO: Number(row.TOTALPRECIO) || 0,
      STATUS: row.STATUS ?? null,
      FEL_SERIE: String(row.FEL_SERIE || '').trim() || null,
      FEL_NUMERO: String(row.FEL_NUMERO || '').trim() || null,
    });
  } catch (err) {
    console.warn('[API GET /documentos/resumen]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/detalle/:coddoc/:correlativo', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const headerRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        SELECT d.*, t.DESDOC, t.TIPODOC
        FROM dbo.DOCUMENTOS d
        JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
        WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
      `);
    if (!headerRes.recordset.length) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }

    const linesRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        SELECT Id AS ID, CODPROD, DESPROD, CODMEDIDA, CANTIDAD, EQUIVALE, PRECIO, COSTO,
          TOTALPRECIO, TOTALCOSTO, TOTALUNIDADES, TIPOPRECIO
        FROM dbo.DOCPRODUCTOS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        ORDER BY Id
      `);

    res.json({
      header: headerRes.recordset[0],
      lines: linesRes.recordset,
    });
  } catch (err) {
    console.warn('[API GET /documentos/detalle]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:coddoc/:correlativo/fecha', async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }

  const parts = parseFechaInput(req.body?.FECHA ?? req.body?.fecha);
  if (!parts) {
    return res.status(400).json({ error: 'Fecha inválida (use AAAA-MM-DD)' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const meta = await loadDocumentoMeta(pool, empnit, coddoc, correlativo);
    if (!meta) return res.status(404).json({ error: 'Documento no encontrado' });
    assertSinCertificacionFel(meta);
    assertDocumentoOperado(meta);

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await applyDocumentoFecha(transaction, sql, empnit, coddoc, correlativo, parts);
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    res.json({
      ok: true,
      CODDOC: coddoc,
      CORRELATIVO: correlativo,
      FECHA: parts.fecha,
      ANIO: parts.anio,
      MES: parts.mes,
      DIA: parts.dia,
    });
  } catch (err) {
    console.warn('[API PATCH /documentos/fecha]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.patch('/:coddoc/:correlativo/caja', async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }

  const codcaja = parseInt(req.body?.CODCAJA ?? req.body?.codcaja, 10);
  if (Number.isNaN(codcaja) || codcaja <= 0) {
    return res.status(400).json({ error: 'CODCAJA inválido' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const meta = await loadDocumentoMeta(pool, empnit, coddoc, correlativo);
    if (!meta) return res.status(404).json({ error: 'Documento no encontrado' });
    assertSinCertificacionFel(meta);
    assertDocumentoOperado(meta);
    assertSinCorte(meta);

    const cajaRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODCAJA', sql.Int, codcaja)
      .query(`
        SELECT CODCAJA, DESCAJA FROM dbo.Cajas
        WHERE EMPNIT = @EMPNIT AND CODCAJA = @CODCAJA
      `);
    if (!cajaRes.recordset.length) {
      return res.status(400).json({ error: 'Caja no encontrada para esta empresa' });
    }

    await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .input('CODCAJA', sql.Int, codcaja)
      .query(`
        UPDATE dbo.DOCUMENTOS
        SET CODCAJA = @CODCAJA
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          AND STATUS = '${STATUS_OPERADO}'
          AND ISNULL(CORTE, 'NO') <> 'SI'
          AND (FEL_UUDI IS NULL OR LTRIM(RTRIM(FEL_UUDI)) = '')
      `);

    const caja = cajaRes.recordset[0];
    res.json({
      ok: true,
      CODDOC: coddoc,
      CORRELATIVO: correlativo,
      CODCAJA: caja.CODCAJA,
      DESCAJA: caja.DESCAJA,
    });
  } catch (err) {
    console.warn('[API PATCH /documentos/caja]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.patch('/:coddoc/:correlativo/status', async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }

  const nextStatus = normalizeStatus(req.body?.STATUS ?? req.body?.status);
  const allowed = [STATUS_OPERADO, STATUS_BLOQUEADO];
  if (!allowed.includes(nextStatus)) {
    return res.status(400).json({ error: 'STATUS inválido (solo O o I)' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const meta = await loadDocumentoMeta(pool, empnit, coddoc, correlativo);
    if (!meta) return res.status(404).json({ error: 'Documento no encontrado' });

    const current = normalizeStatus(meta.STATUS);
    if (current === STATUS_ANULADO) {
      return res.status(400).json({ error: 'No se puede cambiar el status de un documento anulado' });
    }
    if (!allowed.includes(current)) {
      return res.status(400).json({ error: 'Status actual no permite cambio a O/I' });
    }
    if (current === nextStatus) {
      return res.json({
        ok: true,
        CODDOC: coddoc,
        CORRELATIVO: correlativo,
        STATUS: nextStatus,
        unchanged: true,
      });
    }

    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .input('STATUS', sql.VarChar, nextStatus)
      .query(`
        UPDATE dbo.DOCUMENTOS
        SET STATUS = @STATUS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          AND UPPER(LTRIM(RTRIM(ISNULL(STATUS, '')))) IN ('${STATUS_OPERADO}', '${STATUS_BLOQUEADO}')
      `);

    if (!result.rowsAffected[0]) {
      return res.status(404).json({ error: 'Documento no encontrado o status no actualizable' });
    }

    res.json({
      ok: true,
      CODDOC: coddoc,
      CORRELATIVO: correlativo,
      STATUS: nextStatus,
    });
  } catch (err) {
    console.warn('[API PATCH /documentos/status]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/:coddoc/:correlativo/series-alternas', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const data = await listSeriesAlternas(pool, empnit, coddoc, correlativo);
    res.json(data);
  } catch (err) {
    console.warn('[API GET /documentos/series-alternas]', err.message);
    const status = err instanceof DocumentoSerieError ? err.statusCode : 500;
    res.status(status || 500).json({ error: err.message });
  }
});

router.post('/:coddoc/:correlativo/cambiar-serie', async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }

  const nuevoCoddoc = String(req.body?.CODDOC ?? req.body?.coddoc ?? '').trim();
  if (!nuevoCoddoc) {
    return res.status(400).json({ error: 'Indique la nueva serie (CODDOC)' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await cambiarSerieInterna(pool, empnit, coddoc, correlativo, nuevoCoddoc);
    res.json(result);
  } catch (err) {
    console.warn('[API POST /documentos/cambiar-serie]', err.message);
    const status = err instanceof DocumentoSerieError ? err.statusCode : err.statusCode || 500;
    res.status(status || 500).json({ error: err.message });
  }
});

router.get('/:coddoc/:correlativo/trazabilidad', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .input('NOFAC', sql.VarChar, String(correlativo))
      .query(`
        SELECT
          d.FECHA,
          d.CODDOC,
          t.DESDOC,
          t.TIPODOC,
          d.CORRELATIVO,
          d.DOC_NOMCLIE,
          ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
          d.STATUS,
          d.SERIEFAC,
          d.NOFAC,
          d.USUARIO
        FROM dbo.DOCUMENTOS d
        LEFT JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
        WHERE d.EMPNIT = @EMPNIT
          AND LTRIM(RTRIM(ISNULL(d.SERIEFAC, ''))) = @CODDOC
          AND (
            TRY_CAST(LTRIM(RTRIM(d.NOFAC)) AS DECIMAL(18,0)) = @CORRELATIVO
            OR LTRIM(RTRIM(ISNULL(d.NOFAC, ''))) = @NOFAC
          )
        ORDER BY d.FECHA DESC, d.CORRELATIVO DESC, d.ID DESC
      `);
    res.json({
      origen: { EMPNIT: empnit, CODDOC: coddoc, CORRELATIVO: correlativo },
      rows: result.recordset || [],
    });
  } catch (err) {
    console.warn('[API GET /documentos/trazabilidad]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:coddoc/:correlativo', async (req, res) => {
  if (!isDbConfigured()) {
    return res.status(503).json({ error: 'Base de datos no configurada' });
  }
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;

  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }

  const pass = String(req.body?.pass ?? req.body?.adminPass ?? req.body?.PASS ?? '');

  try {
    const pool = await req.app.locals.getDbPool();
    await assertEliminacionRegistro(pool, pass);
    const result = await deleteDocumentoOperado(pool, empnit, coddoc, correlativo, {
      usuario: usuarioFromReq(req),
      motivo: String(req.body?.motivo || req.body?.MOTIVO || '').trim() || null,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof DocumentoDeleteError || err instanceof InventarioError) {
      console.warn('[API DELETE /documentos]', err.message);
      return res.status(err.statusCode || 400).json({ error: err.message });
    }
    console.warn('[API DELETE /documentos]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
