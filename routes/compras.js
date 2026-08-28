const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const {
  InventarioError,
  getTipomDocumento,
  aplicarMovimientoInventarioLineaInsert,
  aplicarMovimientoInventarioLineaPatch,
  revertirMovimientoInventarioLinea,
} = require('../lib/inventario');
const {
  parseFechaInput,
  applyDocumentoFecha,
  nowParts,
  normalizePedidoResponse,
  normalizeDocumentoRows,
  bindDocumentoFechaDiaParams,
  sqlDocumentoFechaDiaWhere,
} = require('../lib/documento-fecha');
const { assertAdminPass, assertEliminacionRegistro } = require('../lib/config-auth');
const { DocumentoDeleteError, deleteDocumentoOperado } = require('../lib/documento-delete');
const { usuarioFromReq } = require('../lib/documentos-eliminados');
const { lineProductMeta, DEFAULT_PRECIOS_FIELD } = require('../lib/doc-producto-linea');
const {
  fetchProductoPrecioForLinea,
  pesoFromPreciosRow,
  calcLinePeso,
} = require('../lib/producto-precio-linea');
const { searchMovimientoProductos } = require('../lib/movimiento-productos-search');
const { SQL_INVSALDO_UNICO_JOIN_LINEA, sqlExistenciaMedidaExpr } = require('../lib/existencia-medida');
const { getSettingSino, SETTING_OPCION } = require('../lib/settings');
const {
  STATUS_OPERADO,
  STATUS_BLOQUEADO,
  STATUS_ANULADO,
  isStatusEditable,
  SQL_STATUS_EDITABLE,
} = require('../lib/documento-status');

const router = express.Router();

const DEFAULT_LIMIT = 40;
const SEARCH_LIMIT = 80;
/** COM = compra normal; COP = compra pequeño contribuyente (mismo flujo; difiere en contabilidad). */
const TIPODOC_COMPRAS = ['COM', 'COP'];
const SQL_TIPODOC_COMPRAS_IN = TIPODOC_COMPRAS.map((t) => `'${t}'`).join(', ');
const DEFAULT_BODEGA = 0;
const CODEMBARQUE_COMPRAS = 'COMPRAS';

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

function parseCorrelativo(raw) {
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/**
 * Evita duplicar serie+número de factura del proveedor en compras del mismo EMPNIT.
 * Si serie o número están en blanco, no valida.
 */
async function assertCompraSerieNofacUnique(
  requestable,
  empnit,
  seriefac,
  nofac,
  excludeCoddoc,
  excludeCorrelativo
) {
  const s = String(seriefac || '').trim();
  const n = String(nofac || '').trim();
  if (!s || !n) return;

  const result = await requestable
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('SERIEFAC', sql.VarChar, s)
    .input('NOFAC', sql.VarChar, n)
    .input('CODDOC', sql.VarChar, excludeCoddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), excludeCorrelativo)
    .query(`
      SELECT TOP 1 d.CODDOC, d.CORRELATIVO
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${SQL_TIPODOC_COMPRAS_IN})
        AND ISNULL(d.STATUS, '') <> '${STATUS_ANULADO}'
        AND LTRIM(RTRIM(ISNULL(d.SERIEFAC, ''))) = @SERIEFAC
        AND LTRIM(RTRIM(ISNULL(d.NOFAC, ''))) = @NOFAC
        AND NOT (d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO)
    `);
  if (!result.recordset.length) return;
  const row = result.recordset[0];
  const err = new Error(
    `Ya existe la compra ${row.CODDOC} #${row.CORRELATIVO} con serie "${s}" y número "${n}"`
  );
  err.statusCode = 409;
  throw err;
}

async function loadSerieNofacActual(requestable, empnit, coddoc, correlativo) {
  const result = await requestable
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT LTRIM(RTRIM(ISNULL(SERIEFAC, ''))) AS SERIEFAC,
             LTRIM(RTRIM(ISNULL(NOFAC, ''))) AS NOFAC
      FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  const row = result.recordset[0];
  return {
    SERIEFAC: String(row?.SERIEFAC || '').trim(),
    NOFAC: String(row?.NOFAC || '').trim(),
  };
}

function calcLineTotals(cantidad, costo, precio, equivale) {
  const qty = Number(cantidad) || 0;
  const eq = Number(equivale) || 1;
  const cost = Number(costo) || 0;
  const price = Number(precio) || 0;
  const totalUnidades = roundMoney(qty * eq);
  const totalCosto = roundMoney(qty * cost);
  const totalPrecio = roundMoney(qty * price);
  return { totalUnidades, totalCosto, totalPrecio };
}

async function getTipoDocCom(pool, empnit, coddocPreferred) {
  const req = pool.request().input('EMPNIT', sql.VarChar, empnit);
  if (coddocPreferred) {
    req.input('CODDOC', sql.VarChar, coddocPreferred);
    const one = await req.query(`
      SELECT CODDOC, DESDOC, TIPODOC, CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC
        AND TIPODOC IN (${SQL_TIPODOC_COMPRAS_IN}) AND ACTIVO = 'SI'
    `);
    if (one.recordset.length) return one.recordset[0];
  }
  const all = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT CODDOC, DESDOC, TIPODOC, CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND TIPODOC IN (${SQL_TIPODOC_COMPRAS_IN}) AND ACTIVO = 'SI'
      ORDER BY CASE TIPODOC WHEN 'COM' THEN 0 ELSE 1 END, CODDOC
    `);
  return all.recordset[0] || null;
}

async function allocateCorrelativo(transaction, empnit, coddoc) {
  const tipoRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .query(`
      SELECT CORRELATIVO FROM dbo.TIPODOCUMENTOS WITH (UPDLOCK, ROWLOCK)
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC
    `);
  const maxRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .query(`
      SELECT ISNULL(MAX(CORRELATIVO), 0) AS maxCorr FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC
    `);
  const tipoCorr = Number(tipoRes.recordset[0]?.CORRELATIVO) || 0;
  const maxCorr = Number(maxRes.recordset[0]?.maxCorr) || 0;
  const next = Math.max(tipoCorr, maxCorr) + 1;
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORR', sql.Decimal(18, 0), next)
    .query(`
      UPDATE dbo.TIPODOCUMENTOS SET CORRELATIVO = @CORR
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC
    `);
  return next;
}

async function getProveedorSnapshot(pool, empnit, codprov) {
  const r = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROV', sql.Int, codprov)
    .query(`
      SELECT CODPROV, NIT, EMPRESA, RAZONSOCIAL, DIRECCION
      FROM dbo.PROVEEDORES
      WHERE EMPNIT = @EMPNIT AND CODPROV = @CODPROV
    `);
  return r.recordset[0] || null;
}

function proveedorDisplayName(prov) {
  if (!prov) return '';
  return String(prov.EMPRESA || prov.RAZONSOCIAL || '').trim();
}

async function recalcDocumentTotals(transaction, empnit, coddoc, correlativo) {
  const sums = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT
        ISNULL(SUM(TOTALCOSTO), 0) AS TOTALCOSTO,
        ISNULL(SUM(TOTALPRECIO), 0) AS TOTALPRECIO,
        ISNULL(SUM(TOTALIVA), 0) AS TOTALIVA,
        ISNULL(SUM(TOTALSINIVA), 0) AS TOTALSINIVA
      FROM dbo.DOCPRODUCTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  const row = sums.recordset[0] || {};
  const totalCosto = roundMoney(row.TOTALCOSTO);
  const totalPrecio = roundMoney(row.TOTALPRECIO);
  const totalIva = roundMoney(row.TOTALIVA);
  const totalSinIva = roundMoney(row.TOTALSINIVA);
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .input('TOTALCOSTO', sql.Decimal(18, 3), totalCosto)
    .input('TOTALPRECIO', sql.Decimal(18, 3), totalPrecio)
    .input('TOTALIVA', sql.Float, totalIva)
    .input('TOTALSINIVA', sql.Float, totalSinIva)
    .input('PAGO', sql.Decimal(18, 3), totalCosto)
    .input('DOC_ABONO', sql.Decimal(18, 3), totalCosto)
    .query(`
      UPDATE dbo.DOCUMENTOS
      SET TOTALCOSTO = @TOTALCOSTO,
          TOTALPRECIO = @TOTALPRECIO,
          TOTALIVA = @TOTALIVA,
          TOTALSINIVA = @TOTALSINIVA,
          PAGO = @PAGO,
          DOC_ABONO = @DOC_ABONO
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  return { totalCosto, totalPrecio, totalIva, totalSinIva };
}

async function assertCompraEditable(transaction, empnit, coddoc, correlativo) {
  const docRow = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT STATUS FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  if (!docRow.recordset.length) {
    const err = new Error('Compra no encontrada');
    err.statusCode = 404;
    throw err;
  }
  if (!isStatusEditable(docRow.recordset[0].STATUS)) {
    const err = new Error('La compra no está operada');
    err.statusCode = 400;
    throw err;
  }
}

async function cargarCostosDesdeLinea(pool, empnit, coddoc, correlativo, lineId) {
  const lineRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .input('ID', sql.Int, lineId)
    .query(`
      SELECT Id AS ID, CODPROD, DESPROD, COSTO, EQUIVALE, TIPOPROD
      FROM dbo.DOCPRODUCTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO AND Id = @ID
    `);
  if (!lineRes.recordset.length) {
    const err = new Error('Línea no encontrada');
    err.statusCode = 404;
    throw err;
  }
  const line = lineRes.recordset[0];
  if (String(line.CODPROD || '').trim().toUpperCase().startsWith('PSE')) {
    const err = new Error('Producto sin existencia (PSE): no actualiza catálogo');
    err.statusCode = 400;
    throw err;
  }
  const equivale = Number(line.EQUIVALE) || 0;
  if (equivale <= 0) {
    const err = new Error('Equivalente inválido en la línea');
    err.statusCode = 400;
    throw err;
  }
  const costoLinea = Number(line.COSTO) || 0;
  const costoUnitario = roundMoney(costoLinea / equivale);

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await assertCompraEditable(transaction, empnit, coddoc, correlativo);
    const prodUpd = await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, line.CODPROD)
      .input('COSTO', sql.Decimal(18, 3), costoUnitario)
      .query(`
        UPDATE dbo.PRODUCTOS SET COSTO = @COSTO
        WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD
      `);
    if (prodUpd.rowsAffected[0] === 0) {
      const err = new Error(`Producto ${line.CODPROD} no encontrado`);
      err.statusCode = 404;
      throw err;
    }
    const precUpd = await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODPROD', sql.VarChar, line.CODPROD)
      .input('COSTO_UNIT', sql.Decimal(18, 3), costoUnitario)
      .query(`
        UPDATE dbo.PRECIOS
        SET COSTO = ROUND(@COSTO_UNIT * CAST(EQUIVALE AS decimal(18, 3)), 3)
        WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD
      `);
    await transaction.commit();
    return {
      codprod: line.CODPROD,
      desprod: line.DESPROD,
      costoUnitario,
      preciosActualizados: precUpd.rowsAffected[0] ?? 0,
    };
  } catch (inner) {
    await transaction.rollback();
    throw inner;
  }
}

async function loadCompra(pool, empnit, coddoc, correlativo) {
  const headerRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT d.*, t.DESDOC, t.TIPODOC,
        d.CODCLIENTE AS CODPROV,
        p.EMPRESA AS PROV_EMPRESA, p.RAZONSOCIAL AS PROV_RAZON, p.DIRECCION AS PROV_DIR
      FROM dbo.DOCUMENTOS d
      JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.PROVEEDORES p ON p.EMPNIT = d.EMPNIT AND p.CODPROV = d.CODCLIENTE
      WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
    `);
  if (!headerRes.recordset.length) return null;
  const linesRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT l.Id AS ID, l.CODPROD, l.DESPROD, l.CODMEDIDA, l.CANTIDAD, l.EQUIVALE, l.PRECIO, l.COSTO,
        l.TOTALPRECIO, l.TOTALCOSTO, l.TOTALUNIDADES, l.TIPOPRECIO, l.TIPOPROD,
        ${sqlExistenciaMedidaExpr('l.EQUIVALE')}
      FROM dbo.DOCPRODUCTOS l
      ${SQL_INVSALDO_UNICO_JOIN_LINEA}
      WHERE l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC AND l.CORRELATIVO = @CORRELATIVO
      ORDER BY l.Id
    `);
  return normalizePedidoResponse({ header: headerRes.recordset[0], lines: linesRes.recordset });
}

router.get('/proveedores', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), SEARCH_LIMIT);
  try {
    const pool = await req.app.locals.getDbPool();
    const request = pool.request().input('EMPNIT', sql.VarChar, empnit).input('limit', sql.Int, limit);
    let whereExtra = '';
    if (q) {
      request.input('qLike', sql.NVarChar, `%${q}%`);
      whereExtra = `
        AND (
          p.EMPRESA LIKE @qLike OR p.RAZONSOCIAL LIKE @qLike
          OR p.NIT LIKE @qLike OR CAST(p.CODPROV AS varchar(20)) LIKE @qLike
          OR p.CONTACTO LIKE @qLike
        )
      `;
    }
    const result = await request.query(`
      SELECT TOP (@limit)
        p.CODPROV, p.NIT, p.EMPRESA, p.RAZONSOCIAL, p.DIRECCION, p.CONTACTO
      FROM dbo.PROVEEDORES p
      WHERE p.EMPNIT = @EMPNIT
        ${whereExtra}
      ORDER BY p.EMPRESA ASC
    `);
    res.json({ rows: result.recordset, q: q || null });
  } catch (err) {
    console.warn('[API GET /compras/proveedores]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/config', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const tipos = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .query(`
        SELECT CODDOC, DESDOC, TIPODOC, CORRELATIVO
        FROM dbo.TIPODOCUMENTOS
        WHERE EMPNIT = @EMPNIT AND TIPODOC IN (${SQL_TIPODOC_COMPRAS_IN}) AND ACTIVO = 'SI'
        ORDER BY CASE TIPODOC WHEN 'COM' THEN 0 ELSE 1 END, CODDOC
      `);
    const def = tipos.recordset[0] || null;
    const proveedor = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .query(`
        SELECT TOP 1 CODPROV, NIT, EMPRESA, RAZONSOCIAL, DIRECCION
        FROM dbo.PROVEEDORES
        WHERE EMPNIT = @EMPNIT
        ORDER BY CODPROV
      `);
    res.json({
      empnit,
      tipodoc: 'COM',
      tipodocs: TIPODOC_COMPRAS,
      statusOperado: STATUS_OPERADO,
      statusBloqueado: STATUS_BLOQUEADO,
      statusAnulado: STATUS_ANULADO,
      coddocDefault: def?.CODDOC || null,
      tiposDocumento: tipos.recordset,
      proveedorDefault: proveedor.recordset[0] || null,
      bodegaDefault: DEFAULT_BODEGA,
      muestraDesprod2: await getSettingSino(pool, SETTING_OPCION.MUESTRA_DESPROD2_EN_DOCS_Y_PRODS),
    });
  } catch (err) {
    console.warn('[API GET /compras/config]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/productos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), SEARCH_LIMIT);
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await searchMovimientoProductos(pool, {
      empnit,
      q,
      limit,
      includeMayoreo: false,
    });
    res.json({ rows: result.rows, q: result.q });
  } catch (err) {
    console.warn('[API GET /compras/productos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/compras', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.query.coddoc || '').trim();
  const statusRaw = String(req.query.status || STATUS_OPERADO).trim().toUpperCase();
  const allowed = [STATUS_OPERADO, STATUS_BLOQUEADO, STATUS_ANULADO];
  const status = allowed.includes(statusRaw) ? statusRaw : STATUS_OPERADO;
  let fechaParts = parseFechaInput(req.query.fecha);
  if (!fechaParts) {
    const now = nowParts();
    fechaParts = { anio: now.anio, mes: now.mes, dia: now.dia, fecha: now.fecha };
  }
  try {
    const pool = await req.app.locals.getDbPool();
    const request = bindDocumentoFechaDiaParams(
      pool.request().input('EMPNIT', sql.VarChar, empnit),
      sql,
      fechaParts
    );
    let coddocFilter = '';
    if (coddoc) {
      request.input('CODDOC', sql.VarChar, coddoc);
      coddocFilter = ' AND d.CODDOC = @CODDOC';
    }
    const result = await request.query(`
      SELECT
        d.CODDOC, d.CORRELATIVO, d.FECHA, d.ANIO, d.MES, d.DIA, d.HORA, d.MINUTO, d.STATUS,
        d.DOC_NOMCLIE, d.TOTALCOSTO, d.CODCLIENTE AS CODPROV, d.OBS, d.DOC_DIRCLIE,
        d.FEL_UUDI, d.FEL_SERIE, d.FEL_NUMERO, ISNULL(d.CONCRE, 'CON') AS CONCRE,
        p.EMPRESA, p.RAZONSOCIAL,
        (SELECT COUNT(*) FROM dbo.DOCPRODUCTOS l
         WHERE l.EMPNIT = d.EMPNIT AND l.CODDOC = d.CODDOC AND l.CORRELATIVO = d.CORRELATIVO) AS LINEAS
      FROM dbo.DOCUMENTOS d
      JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.PROVEEDORES p ON p.EMPNIT = d.EMPNIT AND p.CODPROV = d.CODCLIENTE
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${SQL_TIPODOC_COMPRAS_IN})
        AND d.STATUS = '${status}'
        AND ${sqlDocumentoFechaDiaWhere('d')}
        ${coddocFilter}
      ORDER BY d.HORA DESC, d.MINUTO DESC, d.ID DESC
    `);
    const fecha =
      `${fechaParts.anio}-${String(fechaParts.mes).padStart(2, '0')}-${String(fechaParts.dia).padStart(2, '0')}`;
    res.json({ rows: normalizeDocumentoRows(result.recordset), status, fecha });
  } catch (err) {
    console.warn('[API GET /compras/compras]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/compras/:coddoc/:correlativo', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const compra = await loadCompra(pool, empnit, coddoc, correlativo);
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });
    res.json(compra);
  } catch (err) {
    console.warn('[API GET /compras/compras/:coddoc/:correlativo]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/compras', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddocBody = String(req.body?.CODDOC || '').trim();
  const codprov = parseInt(req.body?.CODPROV, 10);
  const usuario = String(req.body?.USUARIO || req.body?.usuario || 'COMPRAS').trim();
  const obs = String(req.body?.OBS || '').trim();

  try {
    const pool = await req.app.locals.getDbPool();
    const tipo = await getTipoDocCom(pool, empnit, coddocBody);
    if (!tipo) {
      return res.status(400).json({
        error: 'No hay tipo de documento COM/COP (compras) activo para la empresa',
      });
    }
    const coddoc = tipo.CODDOC;
    let proveedor = null;
    if (!Number.isNaN(codprov)) {
      proveedor = await getProveedorSnapshot(pool, empnit, codprov);
    }
    if (!proveedor) {
      proveedor = await getProveedorSnapshot(pool, empnit, 1);
    }
    if (!proveedor) {
      return res.status(400).json({ error: 'No hay proveedor disponible para la compra' });
    }

    const parts = nowParts();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const correlativo = await allocateCorrelativo(transaction, empnit, coddoc);
      const nom = proveedorDisplayName(proveedor) || 'PROVEEDOR';
      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('ANIO', sql.Int, parts.anio)
        .input('MES', sql.Int, parts.mes)
        .input('DIA', sql.Int, parts.dia)
        .input('FECHA', sql.Date, parts.fecha)
        .input('HORA', sql.Int, parts.hora)
        .input('MINUTO', sql.Int, parts.minuto)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .input('CODCLIENTE', sql.Int, proveedor.CODPROV)
        .input('DOC_NIT', sql.VarChar, String(proveedor.NIT || 'CF'))
        .input('DOC_NOMCLIE', sql.VarChar, nom)
        .input('DOC_DIRCLIE', sql.VarChar, String(proveedor.DIRECCION || 'SN'))
        .input('USUARIO', sql.VarChar, usuario)
        .input('OBS', sql.VarChar, obs)
        .query(`
          INSERT INTO dbo.DOCUMENTOS (
            EMPNIT, ANIO, MES, DIA, FECHA, HORA, MINUTO, CODDOC, CORRELATIVO,
            CODCLIENTE, DOC_NIT, DOC_NOMCLIE, DOC_DIRCLIE,
            TOTALCOSTO, TOTALPRECIO, CODEMBARQUE, STATUS, USUARIO, CONCRE, CORTE,
            MARCA, OBS, DOC_SALDO, DOC_ABONO, OBSMARCA, TOTALDESCUENTO, CODCAJA,
            DIRENTREGA, NOGUIA, VALORENTREGA, TOTALEXENTO, TIPOPAGO, NODOCPAGO,
            VENCIMIENTO, DIASCREDITO, TOTALIVA, TOTALSINIVA, PAGO, VUELTO
          ) VALUES (
            @EMPNIT, @ANIO, @MES, @DIA, @FECHA, @HORA, @MINUTO, @CODDOC, @CORRELATIVO,
            @CODCLIENTE, @DOC_NIT, @DOC_NOMCLIE, @DOC_DIRCLIE,
            0, 0, '${CODEMBARQUE_COMPRAS}', '${STATUS_OPERADO}', @USUARIO, 'CON', 'NO',
            'SN', @OBS, 0, 0, 'SN', 0, 1,
            'SN', 'SN', 0, 0, 'CONTADO', 'SN',
            @FECHA, 0, 0, 0, 0, 0
          )
        `);
      await transaction.commit();
      const compra = await loadCompra(pool, empnit, coddoc, correlativo);
      res.status(201).json(compra);
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
  } catch (err) {
    console.warn('[API POST /compras/compras]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/compras/:coddoc/:correlativo', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });

  try {
    const pool = await req.app.locals.getDbPool();
    const updates = [];
    const request = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo);

    if (req.body?.CODPROV !== undefined) {
      const codprov = parseInt(req.body.CODPROV, 10);
      if (Number.isNaN(codprov)) return res.status(400).json({ error: 'CODPROV inválido' });
      const proveedor = await getProveedorSnapshot(pool, empnit, codprov);
      if (!proveedor) return res.status(404).json({ error: 'Proveedor no encontrado' });
      request.input('CODCLIENTE', sql.Int, proveedor.CODPROV);
      request.input('DOC_NIT', sql.VarChar, String(proveedor.NIT || 'CF'));
      request.input('DOC_NOMCLIE', sql.VarChar, proveedorDisplayName(proveedor));
      request.input('DOC_DIRCLIE', sql.VarChar, String(proveedor.DIRECCION || 'SN'));
      updates.push(
        'CODCLIENTE = @CODCLIENTE',
        'DOC_NIT = @DOC_NIT',
        'DOC_NOMCLIE = @DOC_NOMCLIE',
        'DOC_DIRCLIE = @DOC_DIRCLIE'
      );
    }
    if (req.body?.OBS !== undefined) {
      request.input('OBS', sql.VarChar, String(req.body.OBS || ''));
      updates.push('OBS = @OBS');
    }
    if (req.body?.CONCRE !== undefined) {
      const concre = String(req.body.CONCRE || 'CON').trim().toUpperCase();
      if (concre !== 'CON' && concre !== 'CRE') {
        return res.status(400).json({ error: 'CONCRE debe ser CON o CRE' });
      }
      request.input('CONCRE', sql.VarChar, concre);
      updates.push('CONCRE = @CONCRE', `TIPOPAGO = '${concre === 'CRE' ? 'CREDITO' : 'CONTADO'}'`);
    }
    if (req.body?.SERIEFAC !== undefined) {
      request.input('SERIEFAC', sql.VarChar, String(req.body.SERIEFAC || '').trim());
      updates.push('SERIEFAC = @SERIEFAC');
    }
    if (req.body?.NOFAC !== undefined) {
      request.input('NOFAC', sql.VarChar, String(req.body.NOFAC || '').trim());
      updates.push('NOFAC = @NOFAC');
    }

    const fechaParts = req.body?.FECHA !== undefined ? parseFechaInput(req.body.FECHA) : null;
    if (req.body?.FECHA !== undefined && !fechaParts) {
      return res.status(400).json({ error: 'Fecha inválida (use YYYY-MM-DD)' });
    }

    if (!updates.length && !fechaParts) return res.status(400).json({ error: 'Sin campos para actualizar' });

    if (req.body?.SERIEFAC !== undefined || req.body?.NOFAC !== undefined) {
      const actual = await loadSerieNofacActual(pool, empnit, coddoc, correlativo);
      const seriefac =
        req.body?.SERIEFAC !== undefined ? String(req.body.SERIEFAC || '').trim() : actual.SERIEFAC;
      const nofac = req.body?.NOFAC !== undefined ? String(req.body.NOFAC || '').trim() : actual.NOFAC;
      try {
        await assertCompraSerieNofacUnique(pool, empnit, seriefac, nofac, coddoc, correlativo);
      } catch (dupErr) {
        if (dupErr.statusCode) return res.status(dupErr.statusCode).json({ error: dupErr.message });
        throw dupErr;
      }
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      if (updates.length) {
        const txnReq = transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, coddoc)
          .input('CORRELATIVO', sql.Decimal(18, 0), correlativo);
        if (req.body?.CODPROV !== undefined) {
          const codprov = parseInt(req.body.CODPROV, 10);
          const proveedor = await getProveedorSnapshot(pool, empnit, codprov);
          txnReq
            .input('CODCLIENTE', sql.Int, proveedor.CODPROV)
            .input('DOC_NIT', sql.VarChar, String(proveedor.NIT || 'CF'))
            .input('DOC_NOMCLIE', sql.VarChar, proveedorDisplayName(proveedor))
            .input('DOC_DIRCLIE', sql.VarChar, String(proveedor.DIRECCION || 'SN'));
        }
        if (req.body?.OBS !== undefined) {
          txnReq.input('OBS', sql.VarChar, String(req.body.OBS || ''));
        }
        if (req.body?.CONCRE !== undefined) {
          txnReq.input('CONCRE', sql.VarChar, String(req.body.CONCRE || 'CON').trim().toUpperCase());
        }
        if (req.body?.SERIEFAC !== undefined) {
          txnReq.input('SERIEFAC', sql.VarChar, String(req.body.SERIEFAC || '').trim());
        }
        if (req.body?.NOFAC !== undefined) {
          txnReq.input('NOFAC', sql.VarChar, String(req.body.NOFAC || '').trim());
        }
        const result = await txnReq.query(`
          UPDATE dbo.DOCUMENTOS SET ${updates.join(', ')}
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
            AND ${SQL_STATUS_EDITABLE}
        `);
        if (result.rowsAffected[0] === 0) {
          await transaction.rollback();
          return res.status(404).json({ error: 'Compra no encontrada o no operada' });
        }
      }
      if (fechaParts) {
        await applyDocumentoFecha(transaction, sql, empnit, coddoc, correlativo, fechaParts);
        const chk = await transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, coddoc)
          .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
          .query(`
            SELECT STATUS FROM dbo.DOCUMENTOS
            WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
              AND ${SQL_STATUS_EDITABLE}
          `);
        if (!chk.recordset.length) {
          await transaction.rollback();
          return res.status(404).json({ error: 'Compra no encontrada o no operada' });
        }
      }
      await transaction.commit();
      const compra = await loadCompra(pool, empnit, coddoc, correlativo);
      res.json(compra);
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.warn('[API PATCH /compras/compras]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/compras/:coddoc/:correlativo/lineas', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  const isPse = String(req.body?.tipo || '').trim().toLowerCase() === 'pse';
  const desprodPse = String(req.body?.DESPROD || '').trim();
  const importePse = roundMoney(req.body?.IMPORTE ?? req.body?.COSTO ?? req.body?.PRECIO);
  const codprod = isPse ? `PSE${Date.now()}` : String(req.body?.CODPROD || '').trim();
  const codmedida = isPse ? 'UNIDAD' : String(req.body?.CODMEDIDA || '').trim();
  const cantidad = Number(req.body?.CANTIDAD ?? 1);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }
  if (isPse) {
    if (!desprodPse) return res.status(400).json({ error: 'La descripción es obligatoria' });
    if (!Number.isFinite(importePse) || importePse < 0) {
      return res.status(400).json({ error: 'Importe inválido' });
    }
  } else if (!codprod || !codmedida) {
    return res.status(400).json({ error: 'CODPROD y CODMEDIDA son obligatorios' });
  }
  if (cantidad <= 0) return res.status(400).json({ error: 'Cantidad debe ser mayor a cero' });

  try {
    const pool = await req.app.locals.getDbPool();
    const docCheck = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        SELECT STATUS FROM dbo.DOCUMENTOS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);
    if (!docCheck.recordset.length) return res.status(404).json({ error: 'Compra no encontrada' });
    if (!isStatusEditable(docCheck.recordset[0].STATUS)) {
      return res.status(400).json({ error: 'La compra ya no está en edición' });
    }

    let desprod;
    let medidaLinea;
    let tipoprod;
    let tipoprecio;
    let costo;
    let precio;
    let equivale;
    let exento;
    let peso;

    if (isPse) {
      desprod = desprodPse;
      medidaLinea = 'UNIDAD';
      tipoprod = 'P';
      tipoprecio = 'P';
      costo = importePse;
      precio = importePse;
      equivale = 1;
      exento = 0;
      peso = 0;
    } else {
      const found = await fetchProductoPrecioForLinea(pool, sql, {
        empnit,
        codprod,
        codmedida,
      });
      if (!found) return res.status(404).json({ error: 'Producto o precio no encontrado' });
      const prod = found.row;
      medidaLinea = found.codmedida;
      ({ tipoprod, tipoprecio } = lineProductMeta(prod, DEFAULT_PRECIOS_FIELD));
      const costoDefault = Number(prod.COSTO ?? prod.COSTO_PROD) || 0;
      const costoBody = req.body?.COSTO;
      costo =
        costoBody !== undefined && costoBody !== null && costoBody !== ''
          ? Number(costoBody)
          : costoDefault;
      if (Number.isNaN(costo) || costo < 0) {
        return res.status(400).json({ error: 'Costo inválido' });
      }
      precio = costo;
      equivale = Number(prod.EQUIVALE) || 1;
      desprod = prod.DESPROD;
      exento = Number(prod.EXENTO) ? Number(prod.EXENTO) : 0;
      peso = pesoFromPreciosRow(prod);
    }

    const { totalUnidades, totalCosto, totalPrecio } = calcLineTotals(
      cantidad,
      costo,
      precio,
      equivale
    );
    const parts = nowParts();
    const totalPeso = calcLinePeso(cantidad, peso);

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const tipom = await getTipomDocumento(transaction, empnit, coddoc);
      const ins = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('ANIO', sql.Int, parts.anio)
        .input('MES', sql.Int, parts.mes)
        .input('DIA', sql.Int, parts.dia)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .input('CODPROD', sql.VarChar, codprod)
        .input('DESPROD', sql.VarChar, desprod)
        .input('CODMEDIDA', sql.VarChar, medidaLinea)
        .input('CANTIDAD', sql.Float, cantidad)
        .input('EQUIVALE', sql.Int, equivale)
        .input('TOTALUNIDADES', sql.Float, totalUnidades)
        .input('COSTO', sql.Decimal(18, 3), costo)
        .input('PRECIO', sql.Decimal(18, 3), precio)
        .input('TOTALCOSTO', sql.Decimal(18, 3), totalCosto)
        .input('TOTALPRECIO', sql.Decimal(18, 3), totalPrecio)
        .input('EXENTO', sql.Decimal(18, 3), exento)
        .input('TIPOPROD', sql.VarChar, tipoprod)
        .input('TIPOPRECIO', sql.VarChar, tipoprecio)
        .input('PESO', sql.Decimal(18, 3), peso)
        .input('TOTALPESO', sql.Decimal(18, 3), totalPeso)
        .input('TIPOM', sql.Int, tipom)
        .query(`
          INSERT INTO dbo.DOCPRODUCTOS (
            EMPNIT, ANIO, MES, DIA, CODDOC, CORRELATIVO, CODPROD, DESPROD, CODMEDIDA,
            CANTIDAD, CANTIDADBONIF, EQUIVALE, TOTALUNIDADES, TOTALBONIF,
            COSTO, PRECIO, TOTALCOSTO, TOTALPRECIO,
            ENTREGADOS_TOTALUNIDADES, ENTREGADOS_TOTALCOSTO, ENTREGADOS_TOTALPRECIO,
            COSTOANTERIOR, COSTOPROMEDIO, CODBODEGAENTRADA, CODBODEGASALIDA,
            DESCUENTO, PORCDESCUENTO, NOSERIE, EXENTO, OBS,
            TIPOPROD, TIPOPRECIO, PESO, TOTALPESO, TIPOM, LASTUPDATE
          ) VALUES (
            @EMPNIT, @ANIO, @MES, @DIA, @CODDOC, @CORRELATIVO, @CODPROD, @DESPROD, @CODMEDIDA,
            @CANTIDAD, 0, @EQUIVALE, @TOTALUNIDADES, 0,
            @COSTO, @PRECIO, @TOTALCOSTO, @TOTALPRECIO,
            @TOTALUNIDADES, @TOTALCOSTO, @TOTALPRECIO,
            0, 0, ${DEFAULT_BODEGA}, ${DEFAULT_BODEGA},
            0, 0, 'SN', @EXENTO, 'SN',
            @TIPOPROD, @TIPOPRECIO, @PESO, @TOTALPESO, @TIPOM, CAST(GETDATE() AS DATE)
          );
          SELECT SCOPE_IDENTITY() AS ID;
        `);
      const lineId = ins.recordset[0]?.ID;
      await aplicarMovimientoInventarioLineaInsert(transaction, {
        empnit,
        coddoc,
        correlativo,
        codprod,
        desprod,
        totalUnidades,
        tipoprod,
        tipom,
        codbodegaEntrada: DEFAULT_BODEGA,
        codbodegaSalida: DEFAULT_BODEGA,
      });
      const totals = await recalcDocumentTotals(transaction, empnit, coddoc, correlativo);
      await transaction.commit();
      const compra = await loadCompra(pool, empnit, coddoc, correlativo);
      res.status(201).json({ lineId, totals, compra });
    } catch (inner) {
      await transaction.rollback();
      if (inner instanceof InventarioError) {
        return res.status(inner.statusCode).json({ error: inner.message, code: inner.code });
      }
      throw inner;
    }
  } catch (err) {
    if (err instanceof InventarioError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.warn('[API POST /compras/compras/lineas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/compras/:coddoc/:correlativo/lineas/:lineId', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  const lineId = parseInt(req.params.lineId, 10);
  const cantidad = Number(req.body?.CANTIDAD);
  if (!coddoc || correlativo === null || Number.isNaN(lineId)) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }
  if (cantidad <= 0) return res.status(400).json({ error: 'Cantidad debe ser mayor a cero' });

  try {
    const pool = await req.app.locals.getDbPool();
    const lineRes = await pool
      .request()
      .input('ID', sql.Int, lineId)
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        SELECT
          l.COSTO, l.PRECIO, l.EQUIVALE, l.PESO, l.TOTALUNIDADES,
          l.CODPROD, l.DESPROD, l.TIPOPROD, l.TIPOM, l.CODBODEGAENTRADA, l.CODBODEGASALIDA,
          d.STATUS
        FROM dbo.DOCPRODUCTOS l
        JOIN dbo.DOCUMENTOS d ON d.EMPNIT = l.EMPNIT AND d.CODDOC = l.CODDOC AND d.CORRELATIVO = l.CORRELATIVO
        WHERE l.ID = @ID AND l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC AND l.CORRELATIVO = @CORRELATIVO
      `);
    if (!lineRes.recordset.length) return res.status(404).json({ error: 'Línea no encontrada' });
    if (!isStatusEditable(lineRes.recordset[0].STATUS)) {
      return res.status(400).json({ error: 'La compra ya no está en edición' });
    }
    const line = lineRes.recordset[0];
    const totals = calcLineTotals(cantidad, line.COSTO, line.PRECIO, line.EQUIVALE);
    const totalPeso = calcLinePeso(cantidad, line.PESO);

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await aplicarMovimientoInventarioLineaPatch(transaction, {
        empnit,
        coddoc,
        correlativo,
        codprod: line.CODPROD,
        desprod: line.DESPROD,
        anteriorTotalUnidades: line.TOTALUNIDADES,
        nuevoTotalUnidades: totals.totalUnidades,
        tipoprod: line.TIPOPROD,
        tipom: line.TIPOM,
        codbodegaEntrada: line.CODBODEGAENTRADA ?? DEFAULT_BODEGA,
        codbodegaSalida: line.CODBODEGASALIDA ?? DEFAULT_BODEGA,
      });
      await transaction
        .request()
        .input('ID', sql.Int, lineId)
        .input('CANTIDAD', sql.Float, cantidad)
        .input('TOTALUNIDADES', sql.Float, totals.totalUnidades)
        .input('TOTALCOSTO', sql.Decimal(18, 3), totals.totalCosto)
        .input('TOTALPRECIO', sql.Decimal(18, 3), totals.totalPrecio)
        .input('TOTALPESO', sql.Decimal(18, 3), totalPeso)
        .query(`
          UPDATE dbo.DOCPRODUCTOS SET
            CANTIDAD = @CANTIDAD,
            TOTALUNIDADES = @TOTALUNIDADES,
            TOTALCOSTO = @TOTALCOSTO,
            TOTALPRECIO = @TOTALPRECIO,
            TOTALPESO = @TOTALPESO,
            ENTREGADOS_TOTALUNIDADES = @TOTALUNIDADES,
            ENTREGADOS_TOTALCOSTO = @TOTALCOSTO,
            ENTREGADOS_TOTALPRECIO = @TOTALPRECIO,
            LASTUPDATE = CAST(GETDATE() AS DATE)
          WHERE ID = @ID
        `);
      const docTotals = await recalcDocumentTotals(transaction, empnit, coddoc, correlativo);
      await transaction.commit();
      const compra = await loadCompra(pool, empnit, coddoc, correlativo);
      res.json({ totals: docTotals, compra });
    } catch (inner) {
      await transaction.rollback();
      if (inner instanceof InventarioError) {
        return res.status(inner.statusCode).json({ error: inner.message, code: inner.code });
      }
      throw inner;
    }
  } catch (err) {
    if (err instanceof InventarioError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.warn('[API PATCH /compras/compras/lineas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/compras/:coddoc/:correlativo/lineas/:lineId', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  const lineId = parseInt(req.params.lineId, 10);
  if (!coddoc || correlativo === null || Number.isNaN(lineId)) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const lineRes = await transaction
        .request()
        .input('ID', sql.Int, lineId)
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          SELECT
            l.CODPROD, l.DESPROD, l.TOTALUNIDADES, l.TIPOPROD, l.TIPOM,
            l.CODBODEGAENTRADA, l.CODBODEGASALIDA, d.STATUS
          FROM dbo.DOCPRODUCTOS l
          JOIN dbo.DOCUMENTOS d
            ON d.EMPNIT = l.EMPNIT AND d.CODDOC = l.CODDOC AND d.CORRELATIVO = l.CORRELATIVO
          WHERE l.ID = @ID AND l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC AND l.CORRELATIVO = @CORRELATIVO
        `);
      if (!lineRes.recordset.length) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Línea no encontrada' });
      }
      const line = lineRes.recordset[0];
      if (!isStatusEditable(line.STATUS)) {
        await transaction.rollback();
        return res.status(400).json({ error: 'La compra ya no está en edición' });
      }
      await revertirMovimientoInventarioLinea(transaction, {
        empnit,
        coddoc,
        correlativo,
        codprod: line.CODPROD,
        desprod: line.DESPROD,
        totalUnidades: line.TOTALUNIDADES,
        tipoprod: line.TIPOPROD,
        tipom: line.TIPOM,
        codbodegaEntrada: line.CODBODEGAENTRADA ?? DEFAULT_BODEGA,
        codbodegaSalida: line.CODBODEGASALIDA ?? DEFAULT_BODEGA,
      });
      const del = await transaction
        .request()
        .input('ID', sql.Int, lineId)
        .query(`DELETE FROM dbo.DOCPRODUCTOS WHERE ID = @ID`);
      if (del.rowsAffected[0] === 0) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Línea no encontrada' });
      }
      const totals = await recalcDocumentTotals(transaction, empnit, coddoc, correlativo);
      await transaction.commit();
      const compra = await loadCompra(pool, empnit, coddoc, correlativo);
      res.json({ totals, compra });
    } catch (inner) {
      await transaction.rollback();
      if (inner instanceof InventarioError) {
        return res.status(inner.statusCode).json({ error: inner.message, code: inner.code });
      }
      throw inner;
    }
  } catch (err) {
    if (err instanceof InventarioError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.warn('[API DELETE /compras/compras/lineas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/compras/:coddoc/:correlativo/cargar-costos', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  const lineId = parseInt(req.body?.lineId ?? req.body?.line_id, 10);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  if (Number.isNaN(lineId)) return res.status(400).json({ error: 'lineId requerido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await cargarCostosDesdeLinea(pool, empnit, coddoc, correlativo, lineId);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.warn('[API POST /compras/compras/cargar-costos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Productos de la compra + todas sus medidas en PRECIOS,
 * con costo actual (catálogo) vs costo nuevo (según línea de compra).
 */
async function loadRevisarPrecios(pool, empnit, coddoc, correlativo) {
  const exists = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT 1 AS ok FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  if (!exists.recordset.length) {
    const err = new Error('Compra no encontrada');
    err.statusCode = 404;
    throw err;
  }

  const linesRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT l.Id AS ID, l.CODPROD, l.DESPROD, l.CODMEDIDA, l.COSTO, l.EQUIVALE, l.TIPOPROD
      FROM dbo.DOCPRODUCTOS l
      WHERE l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC AND l.CORRELATIVO = @CORRELATIVO
        AND ISNULL(l.TIPOPROD, '') <> 'S'
        AND LEFT(UPPER(LTRIM(RTRIM(ISNULL(l.CODPROD, '')))), 3) <> 'PSE'
      ORDER BY l.Id
    `);

  const byProd = new Map();
  for (const ln of linesRes.recordset) {
    const codprod = String(ln.CODPROD || '').trim();
    if (!codprod) continue;
    const equivale = Number(ln.EQUIVALE) || 0;
    if (equivale <= 0) continue;
    const costoUnitario = roundMoney(Number(ln.COSTO) / equivale);
    if (!byProd.has(codprod)) {
      byProd.set(codprod, {
        CODPROD: codprod,
        DESPROD: ln.DESPROD,
        lineId: ln.ID,
        lineCODMEDIDA: ln.CODMEDIDA,
        lineCOSTO: Number(ln.COSTO) || 0,
        lineEQUIVALE: equivale,
        costoUnitario,
        medidas: [],
      });
    }
  }

  const codprods = [...byProd.keys()];
  if (!codprods.length) return { rows: [] };

  const precReq = pool.request().input('EMPNIT', sql.VarChar, empnit);
  const inParams = codprods.map((c, i) => {
    const name = `P${i}`;
    precReq.input(name, sql.VarChar, c);
    return `@${name}`;
  });
  const precRes = await precReq.query(`
    SELECT ID, CODPROD, CODMEDIDA, EQUIVALE, COSTO, PRECIO, MAYOREOA, MAYOREOB, MAYOREOC, HABILITADO
    FROM dbo.PRECIOS
    WHERE EMPNIT = @EMPNIT AND CODPROD IN (${inParams.join(', ')})
    ORDER BY CODPROD, EQUIVALE, CODMEDIDA
  `);

  for (const pr of precRes.recordset) {
    const codprod = String(pr.CODPROD || '').trim();
    const group = byProd.get(codprod);
    if (!group) continue;
    const eq = Number(pr.EQUIVALE) || 0;
    const costoActual = Number(pr.COSTO) || 0;
    const costoNuevo = eq > 0 ? roundMoney(group.costoUnitario * eq) : 0;
    group.medidas.push({
      ID: pr.ID,
      CODMEDIDA: pr.CODMEDIDA,
      EQUIVALE: eq,
      COSTO: costoActual,
      costoNuevo,
      deltaCosto: roundMoney(costoNuevo - costoActual),
      PRECIO: Number(pr.PRECIO) || 0,
      MAYOREOA: Number(pr.MAYOREOA) || 0,
      MAYOREOB: Number(pr.MAYOREOB) || 0,
      MAYOREOC: Number(pr.MAYOREOC) || 0,
      HABILITADO: pr.HABILITADO,
    });
  }

  return { rows: [...byProd.values()] };
}

function parsePrecioMoney(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) return NaN;
  return roundMoney(n);
}

router.get('/compras/:coddoc/:correlativo/revisar-precios', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await loadRevisarPrecios(pool, empnit, coddoc, correlativo);
    res.json({ ok: true, empnit, coddoc, correlativo, ...data });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.warn('[API GET /compras/compras/revisar-precios]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/compras/:coddoc/:correlativo/revisar-precios', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });

  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  if (!updates.length) return res.status(400).json({ error: 'Sin actualizaciones' });

  try {
    const pool = await req.app.locals.getDbPool();
    const exists = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        SELECT 1 AS ok FROM dbo.DOCUMENTOS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);
    if (!exists.recordset.length) return res.status(404).json({ error: 'Compra no encontrada' });

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    const saved = [];
    try {
      for (const item of updates) {
        const precioId = parseInt(item?.ID ?? item?.id, 10);
        const codprod = String(item?.CODPROD || '').trim();
        if (Number.isNaN(precioId) || !codprod) {
          const err = new Error('Cada actualización requiere ID y CODPROD');
          err.statusCode = 400;
          throw err;
        }
        const precio = parsePrecioMoney(item.PRECIO);
        const mayoreoA = parsePrecioMoney(item.MAYOREOA);
        const mayoreoB = parsePrecioMoney(item.MAYOREOB);
        const mayoreoC = parsePrecioMoney(item.MAYOREOC);
        if ([precio, mayoreoA, mayoreoB, mayoreoC].some((v) => Number.isNaN(v))) {
          const err = new Error(`Valores inválidos en ${codprod}`);
          err.statusCode = 400;
          throw err;
        }
        if (precio === null && mayoreoA === null && mayoreoB === null && mayoreoC === null) {
          const err = new Error(`Sin campos de precio en ${codprod}`);
          err.statusCode = 400;
          throw err;
        }

        const fields = [];
        const reqUpd = transaction
          .request()
          .input('ID', sql.Int, precioId)
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODPROD', sql.VarChar, codprod);
        if (precio !== null) {
          reqUpd.input('PRECIO', sql.Decimal(18, 3), precio);
          fields.push('PRECIO = @PRECIO');
        }
        if (mayoreoA !== null) {
          reqUpd.input('MAYOREOA', sql.Decimal(18, 3), mayoreoA);
          fields.push('MAYOREOA = @MAYOREOA');
        }
        if (mayoreoB !== null) {
          reqUpd.input('MAYOREOB', sql.Decimal(18, 3), mayoreoB);
          fields.push('MAYOREOB = @MAYOREOB');
        }
        if (mayoreoC !== null) {
          reqUpd.input('MAYOREOC', sql.Decimal(18, 3), mayoreoC);
          fields.push('MAYOREOC = @MAYOREOC');
        }

        const result = await reqUpd.query(`
          UPDATE dbo.PRECIOS SET ${fields.join(', ')}
          WHERE ID = @ID AND EMPNIT = @EMPNIT AND CODPROD = @CODPROD
        `);
        if (result.rowsAffected[0] === 0) {
          const err = new Error(`Precio no encontrado: ${codprod} #${precioId}`);
          err.statusCode = 404;
          throw err;
        }
        saved.push({ ID: precioId, CODPROD: codprod });
      }
      await transaction.commit();
      res.json({ ok: true, updated: saved.length, rows: saved });
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.warn('[API PATCH /compras/compras/revisar-precios]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/compras/:coddoc/:correlativo/finalizar', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  const obs = req.body?.OBS !== undefined ? String(req.body.OBS || '').trim() : null;
  const felUudi = req.body?.FEL_UUDI !== undefined ? String(req.body.FEL_UUDI || '').trim() : null;
  let seriefac = String(req.body?.SERIEFAC || '').trim();
  let nofac = String(req.body?.NOFAC || '').trim();
  if (!seriefac) seriefac = coddoc;
  if (!nofac) nofac = String(correlativo);
  const concre = String(req.body?.CONCRE || 'CON').trim().toUpperCase();
  if (concre !== 'CON' && concre !== 'CRE') {
    return res.status(400).json({ error: 'CONCRE debe ser CON o CRE' });
  }
  const vencParts = concre === 'CRE' ? parseFechaInput(req.body?.VENCIMIENTO) : null;
  if (concre === 'CRE' && !vencParts) {
    return res.status(400).json({ error: 'Vencimiento requerido para crédito (YYYY-MM-DD)' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    try {
      await assertCompraSerieNofacUnique(pool, empnit, seriefac, nofac, coddoc, correlativo);
    } catch (dupErr) {
      if (dupErr.statusCode) return res.status(dupErr.statusCode).json({ error: dupErr.message });
      throw dupErr;
    }
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const txnUpd = transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .input('SERIEFAC', sql.VarChar, seriefac)
        .input('NOFAC', sql.VarChar, nofac)
        .input('CONCRE', sql.VarChar, concre)
        .input('TIPOPAGO', sql.VarChar, concre === 'CRE' ? 'CREDITO' : 'CONTADO');
      let vencSql = '';
      if (concre === 'CRE') {
        txnUpd.input('VENCIMIENTO', sql.Date, vencParts.fecha);
        vencSql = ', VENCIMIENTO = @VENCIMIENTO';
      }
      if (obs !== null) {
        txnUpd.input('OBS', sql.VarChar, obs);
      }
      if (felUudi !== null) {
        txnUpd.input('FEL_UUDI', sql.VarChar, felUudi);
      }
      const obsSql = obs !== null ? ', OBS = @OBS' : '';
      const felSql = felUudi !== null ? ', FEL_UUDI = @FEL_UUDI' : '';
      await txnUpd.query(`
        UPDATE dbo.DOCUMENTOS
        SET SERIEFAC = @SERIEFAC, NOFAC = @NOFAC, CONCRE = @CONCRE, TIPOPAGO = @TIPOPAGO
          ${vencSql}${obsSql}${felSql}
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          AND ${SQL_STATUS_EDITABLE}
      `);
      const docRow = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          SELECT STATUS, ISNULL(CORTE, 'NO') AS CORTE FROM dbo.DOCUMENTOS
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);
      if (!docRow.recordset.length) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Compra no encontrada' });
      }
      const docMeta = docRow.recordset[0];
      if (!isStatusEditable(docMeta.STATUS)) {
        await transaction.rollback();
        return res.status(400).json({ error: 'La compra no está operada' });
      }
      const lineCount = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          SELECT COUNT(*) AS cnt FROM dbo.DOCPRODUCTOS
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);
      if (lineCount.recordset[0].cnt < 1) {
        await transaction.rollback();
        return res.status(400).json({ error: 'Agregue al menos un producto a la compra' });
      }
      await recalcDocumentTotals(transaction, empnit, coddoc, correlativo);
      if (concre === 'CRE') {
        await transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, coddoc)
          .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
          .query(`
            UPDATE dbo.DOCUMENTOS
            SET DOC_SALDO = ISNULL(TOTALPRECIO, 0), DOC_ABONO = 0
            WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          `);
      }
      let inv = { tipom: 0, lineas: 0, productos: 0 };
      const corteAplicado = String(docMeta.CORTE || 'NO').trim().toUpperCase() === 'SI';
      if (!corteAplicado) {
        const tipom = await getTipomDocumento(transaction, empnit, coddoc);
        inv = { tipom, lineas: 0, productos: 0 };
        const corteUpd = await transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, coddoc)
          .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
          .query(`
            UPDATE dbo.DOCUMENTOS SET CORTE = 'SI'
            WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
              AND ${SQL_STATUS_EDITABLE}
          `);
        if (corteUpd.rowsAffected[0] === 0) {
          await transaction.rollback();
          return res.status(404).json({ error: 'Pedido no encontrado' });
        }
      }
      await transaction.commit();
      const compra = await loadCompra(pool, empnit, coddoc, correlativo);
      res.json({ ok: true, compra, inventario: inv });
    } catch (inner) {
      await transaction.rollback();
      if (inner instanceof InventarioError) {
        return res.status(inner.statusCode).json({ error: inner.message, code: inner.code });
      }
      throw inner;
    }
  } catch (err) {
    if (err instanceof InventarioError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.warn('[API POST /compras/compras/finalizar]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/compras/:coddoc/:correlativo/bloquear', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        UPDATE dbo.DOCUMENTOS SET STATUS = '${STATUS_BLOQUEADO}'
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          AND STATUS = '${STATUS_OPERADO}'
      `);
    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: 'Compra no encontrada o no se puede bloquear' });
    }
    const compra = await loadCompra(pool, empnit, coddoc, correlativo);
    res.json({ ok: true, compra });
  } catch (err) {
    console.warn('[API POST /compras/compras/bloquear]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/compras/:coddoc/:correlativo', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  const pass = String(req.body?.pass ?? req.body?.PASS ?? '');

  try {
    const pool = await req.app.locals.getDbPool();
    await assertEliminacionRegistro(pool, pass);
    const result = await deleteDocumentoOperado(pool, empnit, coddoc, correlativo, {
      usuario: usuarioFromReq(req),
      motivo: String(req.body?.motivo || req.body?.MOTIVO || '').trim() || null,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof DocumentoDeleteError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    if (err instanceof InventarioError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    if (err.statusCode === 401) {
      return res.status(401).json({ error: err.message });
    }
    console.warn('[API DELETE /compras/compras]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
