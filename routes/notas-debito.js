const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const {
  InventarioError,
  getTipomDocumento,
  aplicarMovimientoInventarioLineaInsert,
  aplicarMovimientoInventarioLineaPatch,
  revertirMovimientoInventarioLinea,
  revertirMovimientoInventarioDocumento,
} = require('../lib/inventario');
const { parseFechaInput, applyDocumentoFecha, nowParts, normalizePedidoResponse, normalizeDocumentoRows } = require('../lib/documento-fecha');
const { assertAdminPass, assertEliminacionRegistro } = require('../lib/config-auth');
const { DocumentoDeleteError } = require('../lib/documento-delete');
const { calcLinePeso } = require('../lib/producto-precio-linea');
const { abonoSuperaSaldo, aplicarAbonoSobreSaldo } = require('../lib/cuentas-saldo-centavos');
const {
  isLineaDescuentoCodprod,
  parseDescuentoLineaBody,
  insertDescuentoLinea,
} = require('../lib/doc-linea-descuento');
const {
  TIPODOC_NOTAS_DEBITO,
  fetchComprasReferencia,
  fetchProductosDisponibles,
  loadCompraReferencia,
  assertCantidadDisponible,
  tiposCompraReferenciaParaNota,
  assertCompraReferenciaPermitida,
} = require('../lib/notas-debito-disponible');
const {
  SQL_TIPODOC_CUENTAS_PAGAR_IN,
} = require('../lib/cuentas-pagar-docs');
const {
  STATUS_OPERADO,
  STATUS_BLOQUEADO,
  STATUS_ANULADO,
  isStatusEditable,
  SQL_STATUS_EDITABLE,
  sqlPedidosListStatusFilter,
  resolvePedidosListStatusLabel,
} = require('../lib/documento-status');
const { listCajasAbiertasConDefault } = require('../lib/empleado-coddoc-preferido');

const router = express.Router();

const TIPODOC_NOTAS = [...TIPODOC_NOTAS_DEBITO];
const TIPODOC_SQL_IN = TIPODOC_NOTAS.map((t) => `'${t}'`).join(', ');
const DEFAULT_BODEGA = 0;
const CODTIPO_EMPLEADO_VENDEDOR = 3;
const CODTIPO_EMPLEADO_ADMIN = 1;

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

function mensajeDocumentoNoEditable(status) {
  if (!isStatusEditable(status)) {
    return 'El pedido ya no está en edición';
  }
  return 'El documento no se puede editar';
}

async function loadDocumentoMeta(db, empnit, coddoc, correlativo) {
  const result = await db
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT STATUS, ISNULL(CORTE, 'NO') AS CORTE, SERIEFAC, NOFAC
      FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  return result.recordset[0] || null;
}

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function parseFpagoAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return roundMoney(n);
}

function resolveFormasPago(concre, body, totalPrecio) {
  if (concre === 'CRE') {
    return {
      FPAGO_EFECTIVO: 0,
      FPAGO_TARJETA: 0,
      FPAGO_DEPOSITO: 0,
      FPAGO_CHEQUE: 0,
      FPAGO_DESCRIPCION: '',
    };
  }
  const fpago = {
    FPAGO_EFECTIVO: parseFpagoAmount(body?.FPAGO_EFECTIVO),
    FPAGO_TARJETA: parseFpagoAmount(body?.FPAGO_TARJETA),
    FPAGO_DEPOSITO: parseFpagoAmount(body?.FPAGO_DEPOSITO),
    FPAGO_CHEQUE: parseFpagoAmount(body?.FPAGO_CHEQUE),
    FPAGO_DESCRIPCION: String(body?.FPAGO_DESCRIPCION || '').trim(),
  };
  const sum = roundMoney(
    fpago.FPAGO_EFECTIVO + fpago.FPAGO_TARJETA + fpago.FPAGO_DEPOSITO + fpago.FPAGO_CHEQUE
  );
  const total = roundMoney(totalPrecio);
  if (sum <= 0) {
    const err = new Error('Indique la forma de pago por el monto total de la nota');
    err.statusCode = 400;
    throw err;
  }
  if (Math.abs(sum - total) > 0.001) {
    const err = new Error(`La suma de formas de pago (${sum}) debe ser igual al total de la nota (${total})`);
    err.statusCode = 400;
    throw err;
  }
  return fpago;
}

async function applyFormasPagoDocumento(transaction, empnit, coddoc, correlativo, fpago) {
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .input('FPAGO_EFECTIVO', sql.Decimal(18, 3), fpago.FPAGO_EFECTIVO)
    .input('FPAGO_TARJETA', sql.Decimal(18, 3), fpago.FPAGO_TARJETA)
    .input('FPAGO_DEPOSITO', sql.Decimal(18, 3), fpago.FPAGO_DEPOSITO)
    .input('FPAGO_CHEQUE', sql.Decimal(18, 3), fpago.FPAGO_CHEQUE)
    .input('FPAGO_DESCRIPCION', sql.VarChar, fpago.FPAGO_DESCRIPCION || '')
    .query(`
      UPDATE dbo.DOCUMENTOS
      SET FPAGO_EFECTIVO = @FPAGO_EFECTIVO,
          FPAGO_TARJETA = @FPAGO_TARJETA,
          FPAGO_DEPOSITO = @FPAGO_DEPOSITO,
          FPAGO_CHEQUE = @FPAGO_CHEQUE,
          FPAGO_DESCRIPCION = @FPAGO_DESCRIPCION
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
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

async function resolveTipodocNota(pool, empnit, { tipodocNota, coddocNota }) {
  const direct = String(tipodocNota || '').trim().toUpperCase();
  if (direct === 'DVP') return direct;
  const cod = String(coddocNota || '').trim();
  if (!cod) return null;
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, cod)
    .query(`
      SELECT TIPODOC FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND TIPODOC IN (${TIPODOC_SQL_IN}) AND ACTIVO = 'SI'
    `);
  return String(result.recordset[0]?.TIPODOC || '').trim().toUpperCase() || null;
}

async function getTipoDocNotasDebito(pool, empnit, coddocPreferred) {
  const req = pool.request().input('EMPNIT', sql.VarChar, empnit);
  if (coddocPreferred) {
    req.input('CODDOC', sql.VarChar, coddocPreferred);
    const one = await req.query(`
      SELECT CODDOC, DESDOC, TIPODOC, CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND TIPODOC IN (${TIPODOC_SQL_IN}) AND ACTIVO = 'SI'
    `);
    if (one.recordset.length) return one.recordset[0];
  }
  const all = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT CODDOC, DESDOC, TIPODOC, CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND TIPODOC IN (${TIPODOC_SQL_IN}) AND ACTIVO = 'SI'
      ORDER BY CODDOC
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
  const cod = parseInt(codprov, 10);
  if (Number.isNaN(cod)) return null;
  const r = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROV', sql.Int, cod)
    .query(`
      SELECT CODPROV, NIT, EMPRESA, RAZONSOCIAL, DIRECCION
      FROM dbo.PROVEEDORES
      WHERE EMPNIT = @EMPNIT AND CODPROV = @CODPROV
    `);
  return r.recordset[0] || null;
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
    .query(`
      UPDATE dbo.DOCUMENTOS
      SET TOTALCOSTO = @TOTALCOSTO,
          TOTALPRECIO = @TOTALPRECIO,
          TOTALIVA = @TOTALIVA,
          TOTALSINIVA = @TOTALSINIVA
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  return { totalCosto, totalPrecio, totalIva, totalSinIva };
}

function sumFpago(fpago) {
  return roundMoney(
    fpago.FPAGO_EFECTIVO + fpago.FPAGO_TARJETA + fpago.FPAGO_DEPOSITO + fpago.FPAGO_CHEQUE
  );
}

async function applyTotalesContadoFinal(transaction, sql, empnit, coddoc, correlativo, fpago) {
  const totalAbonado = sumFpago(fpago);
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .input('TOTALPRECIO', sql.Decimal(18, 3), totalAbonado)
    .input('PAGO', sql.Decimal(18, 3), totalAbonado)
    .input('DOC_ABONO', sql.Decimal(18, 3), totalAbonado)
    .query(`
      UPDATE dbo.DOCUMENTOS
      SET CONCRE = 'CON',
          TIPOPAGO = 'CONTADO',
          DOC_SALDO = 0,
          TOTALPRECIO = @TOTALPRECIO,
          PAGO = @PAGO,
          DOC_ABONO = @DOC_ABONO
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  return totalAbonado;
}

async function loadCompraCreditoParaPago(transaction, empnit, comCoddoc, comCorrelativo) {
  const facRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, comCoddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), comCorrelativo)
    .query(`
      SELECT
        ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
        ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
        ISNULL(d.CONCRE, 'CON') AS CONCRE
      FROM dbo.DOCUMENTOS d WITH (UPDLOCK, ROWLOCK)
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
        AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_PAGAR_IN})
        AND d.STATUS = '${STATUS_OPERADO}'
    `);
  return facRes.recordset[0] || null;
}

async function aplicarNotaDebitoACompraCredito(transaction, empnit, comCoddoc, comCorrelativo, monto) {
  const abono = roundMoney(monto);
  if (abono <= 0) return null;
  const fac = await loadCompraCreditoParaPago(transaction, empnit, comCoddoc, comCorrelativo);
  if (!fac) {
    const err = new Error('Compra de referencia no encontrada o no operada');
    err.statusCode = 404;
    throw err;
  }
  if (String(fac.CONCRE || 'CON').trim().toUpperCase() !== 'CRE') {
    return null;
  }
  const docSaldo = roundMoney(fac.DOC_SALDO);
  const docAbono = roundMoney(fac.DOC_ABONO);
  if (abonoSuperaSaldo(abono, docSaldo)) {
    const err = new Error(
      `El monto de la nota (${abono}) no puede superar el saldo de la compra (${docSaldo})`
    );
    err.statusCode = 400;
    throw err;
  }
  const aplicado = aplicarAbonoSobreSaldo(docAbono, docSaldo, abono);
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, comCoddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), comCorrelativo)
    .input('DOC_ABONO', sql.Decimal(18, 3), aplicado.DOC_ABONO)
    .input('DOC_SALDO', sql.Decimal(18, 3), aplicado.DOC_SALDO)
    .query(`
      UPDATE dbo.DOCUMENTOS
      SET DOC_ABONO = @DOC_ABONO, DOC_SALDO = @DOC_SALDO
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  return { DOC_ABONO: aplicado.DOC_ABONO, DOC_SALDO: aplicado.DOC_SALDO };
}

async function revertirNotaDebitoEnCompraCredito(transaction, empnit, comCoddoc, comCorrelativo, monto) {
  const abono = roundMoney(monto);
  if (abono <= 0) return null;
  const fac = await loadCompraCreditoParaPago(transaction, empnit, comCoddoc, comCorrelativo);
  if (!fac || String(fac.CONCRE || 'CON').trim().toUpperCase() !== 'CRE') {
    return null;
  }
  const docSaldo = roundMoney(fac.DOC_SALDO);
  const docAbono = roundMoney(fac.DOC_ABONO);
  const nuevoAbono = roundMoney(Math.max(0, docAbono - abono));
  const nuevoSaldo = roundMoney(docSaldo + abono);
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, comCoddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), comCorrelativo)
    .input('DOC_ABONO', sql.Decimal(18, 3), nuevoAbono)
    .input('DOC_SALDO', sql.Decimal(18, 3), nuevoSaldo)
    .query(`
      UPDATE dbo.DOCUMENTOS
      SET DOC_ABONO = @DOC_ABONO, DOC_SALDO = @DOC_SALDO
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  return { DOC_ABONO: nuevoAbono, DOC_SALDO: nuevoSaldo };
}

async function loadPedido(pool, empnit, coddoc, correlativo) {
  const headerRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT d.*, t.DESDOC, t.TIPODOC,
        p.EMPRESA AS PROV_EMPRESA, p.RAZONSOCIAL AS PROV_RAZON, p.DIRECCION AS PROV_DIR,
        d.CODCLIENTE AS CODPROV
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
      SELECT Id AS ID, CODPROD, DESPROD, CODMEDIDA, CANTIDAD, EQUIVALE, PRECIO, COSTO,
        TOTALPRECIO, TOTALCOSTO, TOTALUNIDADES, TIPOPRECIO, TIPOPROD
      FROM dbo.DOCPRODUCTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      ORDER BY Id
    `);
  return normalizePedidoResponse({ header: headerRes.recordset[0], lines: linesRes.recordset });
}

async function getVendedorActivo(pool, empnit, codempleado) {
  const cod = parseInt(codempleado, 10);
  if (Number.isNaN(cod)) return null;
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODEMPLEADO', sql.Int, cod)
    .input('CODTIPO', sql.Int, CODTIPO_EMPLEADO_VENDEDOR)
    .query(`
      SELECT CODEMPLEADO, NOMEMPLEADO
      FROM dbo.Empleados
      WHERE EMPNIT = @EMPNIT AND CODEMPLEADO = @CODEMPLEADO
        AND CODTIPOEMPLEADO = @CODTIPO AND ACTIVO = 'SI'
    `);
  return result.recordset[0] || null;
}

function pickDisponibleLine(disponibles, codprod, codmedida, equivaleMaybe, precioMaybe) {
  const cod = String(codprod || '').trim();
  const med = String(codmedida || '').trim();
  const eqReq = equivaleMaybe === undefined || equivaleMaybe === null || equivaleMaybe === '' ? null : Number(equivaleMaybe);
  const prReq = precioMaybe === undefined || precioMaybe === null || precioMaybe === '' ? null : Number(precioMaybe);
  const filtered = disponibles.filter(
    (l) => String(l.CODPROD || '').trim() === cod && String(l.CODMEDIDA || '').trim() === med
  );
  if (!filtered.length) return null;
  const exact = filtered.find((l) => {
    if (eqReq !== null && Number(l.EQUIVALE) !== eqReq) return false;
    if (prReq !== null && Math.abs(Number(l.PRECIO) - prReq) > 0.001) return false;
    return true;
  });
  if (exact) return exact;
  if (eqReq !== null || prReq !== null) return null;
  if (filtered.length === 1) return filtered[0];
  return null;
}

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
        WHERE EMPNIT = @EMPNIT AND TIPODOC IN (${TIPODOC_SQL_IN}) AND ACTIVO = 'SI'
        ORDER BY CODDOC
      `);
    const def = tipos.recordset[0] || null;
    res.json({
      empnit,
      tipodocs: TIPODOC_NOTAS_DEBITO,
      statusOperado: STATUS_OPERADO,
      statusBloqueado: STATUS_BLOQUEADO,
      statusAnulado: STATUS_ANULADO,
      coddocDefault: def?.CODDOC || null,
      tiposDocumento: tipos.recordset,
      bodegaDefault: DEFAULT_BODEGA,
    });
  } catch (err) {
    console.warn('[API GET /notas-debito/config]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/vendedores', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODTIPO_V', sql.Int, CODTIPO_EMPLEADO_VENDEDOR)
      .input('CODTIPO_A', sql.Int, CODTIPO_EMPLEADO_ADMIN)
      .query(`
        SELECT CODEMPLEADO, NOMEMPLEADO
        FROM dbo.Empleados
        WHERE EMPNIT = @EMPNIT
          AND CODTIPOEMPLEADO IN (@CODTIPO_V, @CODTIPO_A)
          AND ACTIVO = 'SI'
        ORDER BY CASE WHEN CODTIPOEMPLEADO = @CODTIPO_V THEN 0 ELSE 1 END, NOMEMPLEADO ASC
      `);
    res.json({ rows: normalizeDocumentoRows(result.recordset) });
  } catch (err) {
    console.warn('[API GET /notas-debito/vendedores]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/cajas-abiertas', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const data = await listCajasAbiertasConDefault(pool, sql, empnit, req.query.codempleado);
    res.json({
      rows: normalizeDocumentoRows(data.rows),
      cajaDefault: data.cajaDefault,
      preferredCaja: data.preferredCaja,
    });
  } catch (err) {
    console.warn('[API GET /notas-debito/cajas-abiertas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/pedidos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.query.coddoc || '').trim();
  const statusFilter = sqlPedidosListStatusFilter(req.query.status, { defaultAll: true });
  const statusLabel = resolvePedidosListStatusLabel(req.query.status, { defaultAll: true });
  let fechaParts = parseFechaInput(req.query.fecha);
  if (!fechaParts) {
    const now = nowParts();
    fechaParts = { anio: now.anio, mes: now.mes, dia: now.dia, fecha: now.fecha };
  }
  try {
    const pool = await req.app.locals.getDbPool();
    const request = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('FECHA', sql.Date, fechaParts.fecha);
    let coddocFilter = '';
    if (coddoc) {
      request.input('CODDOC', sql.VarChar, coddoc);
      coddocFilter = ' AND d.CODDOC = @CODDOC';
    }
    const result = await request.query(`
      SELECT
        d.CODDOC, d.CORRELATIVO, d.FECHA, d.ANIO, d.MES, d.DIA, d.HORA, d.MINUTO, d.STATUS,
        d.DOC_NOMCLIE, d.TOTALPRECIO, d.CODCLIENTE, d.OBS, d.DOC_DIRCLIE, d.USUARIO,
        d.CODVEN, d.CODCAJA, ISNULL(d.CONCRE, 'CON') AS CONCRE,
        d.SERIEFAC, d.NOFAC,
        d.FEL_UUDI, d.FEL_SERIE, d.FEL_NUMERO,
        t.TIPODOC, t.DESDOC,
        p.EMPRESA AS NEGOCIO, p.RAZONSOCIAL,
        ISNULL(emp.NOMEMPLEADO, '') AS VENDEDOR,
        ISNULL(cj.DESCAJA, '') AS DESCAJA,
        (SELECT COUNT(*) FROM dbo.DOCPRODUCTOS l
         WHERE l.EMPNIT = d.EMPNIT AND l.CODDOC = d.CODDOC AND l.CORRELATIVO = d.CORRELATIVO) AS LINEAS
      FROM dbo.DOCUMENTOS d
      JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.PROVEEDORES p ON p.EMPNIT = d.EMPNIT AND p.CODPROV = d.CODCLIENTE
      LEFT JOIN dbo.Empleados emp ON d.CODVEN = emp.CODEMPLEADO AND d.EMPNIT = emp.EMPNIT
      LEFT JOIN dbo.Cajas cj ON cj.EMPNIT = d.EMPNIT AND cj.CODCAJA = d.CODCAJA
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${TIPODOC_SQL_IN})
        ${statusFilter}
        AND CAST(d.FECHA AS DATE) = CAST(@FECHA AS DATE)
        ${coddocFilter}
      ORDER BY d.HORA DESC, d.MINUTO DESC, d.ID DESC
    `);
    const fecha = `${fechaParts.anio}-${String(fechaParts.mes).padStart(2, '0')}-${String(fechaParts.dia).padStart(2, '0')}`;
    res.json({ rows: normalizeDocumentoRows(result.recordset), status: statusLabel, fecha });
  } catch (err) {
    console.warn('[API GET /notas-debito/pedidos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/compras-referencia', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const q = String(req.query.q || '').trim();
  try {
    const pool = await req.app.locals.getDbPool();
    const tiposRef = tiposCompraReferenciaParaNota();
    const rows = await fetchComprasReferencia(pool, empnit, q, 80, tiposRef);
    res.json({ rows, q: q || null, tipodocNota: 'DVP', tiposReferencia: tiposRef });
  } catch (err) {
    console.warn('[API GET /notas-debito/compras-referencia]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/compras-referencia/:coddoc/:correlativo/disponibles', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento de referencia inválido' });
  const excludeCoddoc = String(req.query.exclude_coddoc || '').trim();
  const excludeCorrelativo = parseCorrelativo(req.query.exclude_correlativo);
  const excludeNc = excludeCoddoc && excludeCorrelativo !== null ? { coddoc: excludeCoddoc, correlativo: excludeCorrelativo } : null;
  try {
    const pool = await req.app.locals.getDbPool();
    const compra = await loadCompraReferencia(pool, empnit, coddoc, correlativo);
    if (!compra) {
      return res.status(404).json({ error: 'Compra de referencia no encontrada o no operada' });
    }
    const rows = await fetchProductosDisponibles(pool, empnit, coddoc, correlativo, excludeNc);
    res.json({ compra, rows });
  } catch (err) {
    console.warn('[API GET /notas-debito/compras-referencia/disponibles]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/pedidos/:coddoc/:correlativo', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
    if (!pedido) return res.status(404).json({ error: 'Documento no encontrado' });
    res.json(pedido);
  } catch (err) {
    console.warn('[API GET /notas-debito/pedidos/:coddoc/:correlativo]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pedidos', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddocBody = String(req.body?.CODDOC || '').trim();
  const serieFac = String(req.body?.SERIEFAC || '').trim();
  const noFac = String(req.body?.NOFAC || '').trim();
  const comCorrelativo = parseCorrelativo(noFac);
  const usuario = String(req.body?.USUARIO || req.body?.usuario || 'NDP').trim();
  const obs = String(req.body?.OBS || '').trim();
  if (!serieFac || comCorrelativo === null) {
    return res.status(400).json({ error: 'SERIEFAC y NOFAC son obligatorios' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const tipo = await getTipoDocNotasDebito(pool, empnit, coddocBody);
    if (!tipo) {
      return res.status(400).json({
        error: `No hay tipo de documento de nota de crédito proveedor (${TIPODOC_NOTAS.join(', ')}) activo para la empresa`,
      });
    }
    const tiposRef = tiposCompraReferenciaParaNota();
    const compraRef = await loadCompraReferencia(pool, empnit, serieFac, comCorrelativo, tiposRef);
    if (!compraRef) {
      return res.status(404).json({ error: 'Compra de referencia no encontrada, no operada o no permitida para esta serie' });
    }
    assertCompraReferenciaPermitida(compraRef.TIPODOC);
    const coddoc = tipo.CODDOC;
    const parts = nowParts();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const correlativo = await allocateCorrelativo(transaction, empnit, coddoc);
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
        .input('CODCLIENTE', sql.Int, compraRef.CODCLIENTE)
        .input('DOC_NIT', sql.VarChar, String(compraRef.DOC_NIT || 'CF'))
        .input('DOC_NOMCLIE', sql.VarChar, String(compraRef.DOC_NOMCLIE || compraRef.PROV_EMPRESA || compraRef.PROV_RAZON || 'PROVEEDOR'))
        .input('DOC_DIRCLIE', sql.VarChar, String(compraRef.DOC_DIRCLIE || 'SN'))
        .input('CODVEN', sql.Int, compraRef.CODVEN ?? null)
        .input('CONCRE', sql.VarChar, 'CON')
        .input('USUARIO', sql.VarChar, usuario || 'NDP')
        .input('OBS', sql.VarChar, obs)
        .input(
          'CODCAJA',
          sql.Int,
          compraRef.CODCAJA != null && Number(compraRef.CODCAJA) > 0 ? Number(compraRef.CODCAJA) : null
        )
        .input('SERIEFAC', sql.VarChar, serieFac)
        .input('NOFAC', sql.VarChar, String(comCorrelativo))
        .query(`
          INSERT INTO dbo.DOCUMENTOS (
            EMPNIT, ANIO, MES, DIA, FECHA, HORA, MINUTO, CODDOC, CORRELATIVO,
            CODCLIENTE, DOC_NIT, DOC_NOMCLIE, DOC_DIRCLIE, CODVEN,
            TOTALCOSTO, TOTALPRECIO, CODEMBARQUE, STATUS, USUARIO, CONCRE, CORTE,
            MARCA, OBS, DOC_SALDO, DOC_ABONO, OBSMARCA, TOTALDESCUENTO, CODCAJA,
            DIRENTREGA, NOGUIA, VALORENTREGA, TOTALEXENTO, TIPOPAGO, NODOCPAGO,
            VENCIMIENTO, DIASCREDITO, TOTALIVA, TOTALSINIVA, PAGO, VUELTO,
            SERIEFAC, NOFAC
          ) VALUES (
            @EMPNIT, @ANIO, @MES, @DIA, @FECHA, @HORA, @MINUTO, @CODDOC, @CORRELATIVO,
            @CODCLIENTE, @DOC_NIT, @DOC_NOMCLIE, @DOC_DIRCLIE, @CODVEN,
            0, 0, 'MOSTRADOR', '${STATUS_OPERADO}', @USUARIO, @CONCRE, 'NO',
            'SN', @OBS, 0, 0, 'SN', 0, @CODCAJA,
            'SN', 'SN', 0, 0,
            CASE WHEN @CONCRE = 'CRE' THEN 'CREDITO' ELSE 'CONTADO' END, 'SN',
            @FECHA, 0, 0, 0, 0, 0,
            @SERIEFAC, @NOFAC
          )
        `);
      await transaction.commit();
      const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
      res.status(201).json(pedido);
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
  } catch (err) {
    console.warn('[API POST /notas-debito/pedidos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/pedidos/:coddoc/:correlativo', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });

  try {
    const pool = await req.app.locals.getDbPool();
    const updates = [];

    if (req.body?.CODCLIENTE !== undefined) {
      const codcliente = parseInt(req.body.CODCLIENTE, 10);
      if (Number.isNaN(codcliente)) return res.status(400).json({ error: 'CODCLIENTE inválido' });
      const proveedor = await getProveedorSnapshot(pool, empnit, codcliente);
      if (!proveedor) return res.status(404).json({ error: 'Proveedor no encontrado' });
      updates.push({
        name: 'CODCLIENTE',
        codcliente: proveedor.CODPROV,
        nit: String(proveedor.NIT || 'CF'),
        nombre: proveedor.EMPRESA || proveedor.RAZONSOCIAL || '',
        dir: String(proveedor.DIRECCION || 'SN'),
      });
    }
    const updateObs = req.body?.OBS !== undefined ? String(req.body.OBS || '') : null;
    const updateCodven = req.body?.CODVEN !== undefined ? req.body.CODVEN : undefined;

    const fechaParts = req.body?.FECHA !== undefined ? parseFechaInput(req.body.FECHA) : null;
    if (req.body?.FECHA !== undefined && !fechaParts) {
      return res.status(400).json({ error: 'Fecha inválida (use YYYY-MM-DD)' });
    }
    if (!updates.length && updateObs === null && updateCodven === undefined && !fechaParts) {
      return res.status(400).json({ error: 'Sin campos para actualizar' });
    }

    const docMetaPre = await loadDocumentoMeta(pool, empnit, coddoc, correlativo);
    if (!docMetaPre) return res.status(404).json({ error: 'Documento no encontrado' });
    if (!isStatusEditable(docMetaPre.STATUS)) {
      return res.status(400).json({
        error: mensajeDocumentoNoEditable(docMetaPre.STATUS),
      });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const setSql = [];
      const txReq = transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo);

      if (updates.length) {
        const cliente = updates[0];
        txReq
          .input('CODCLIENTE', sql.Int, cliente.codcliente)
          .input('DOC_NIT', sql.VarChar, cliente.nit)
          .input('DOC_NOMCLIE', sql.VarChar, cliente.nombre)
          .input('DOC_DIRCLIE', sql.VarChar, cliente.dir);
        setSql.push(
          'CODCLIENTE = @CODCLIENTE',
          'DOC_NIT = @DOC_NIT',
          'DOC_NOMCLIE = @DOC_NOMCLIE',
          'DOC_DIRCLIE = @DOC_DIRCLIE'
        );
      }
      if (updateObs !== null) {
        txReq.input('OBS', sql.VarChar, updateObs);
        setSql.push('OBS = @OBS');
      }
      if (updateCodven !== undefined) {
        if (updateCodven === null || updateCodven === '' || updateCodven === 0 || updateCodven === '0') {
          txReq.input('CODVEN', sql.Int, null);
          setSql.push('CODVEN = @CODVEN');
        } else {
          const codven = parseInt(updateCodven, 10);
          if (Number.isNaN(codven)) {
            await transaction.rollback();
            return res.status(400).json({ error: 'CODVEN inválido' });
          }
          const vendedor = await getVendedorActivo(pool, empnit, codven);
          if (!vendedor) {
            await transaction.rollback();
            return res.status(404).json({ error: 'Vendedor no encontrado o inactivo' });
          }
          txReq.input('CODVEN', sql.Int, vendedor.CODEMPLEADO);
          setSql.push('CODVEN = @CODVEN');
        }
      }

      if (setSql.length) {
        const result = await txReq.query(`
          UPDATE dbo.DOCUMENTOS SET ${setSql.join(', ')}
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
            AND ${SQL_STATUS_EDITABLE}
        `);
        if (result.rowsAffected[0] === 0) {
          await transaction.rollback();
          return res.status(404).json({ error: 'Documento no encontrado, no operado o incluido en corte de caja' });
        }
      }
      if (fechaParts) {
        await applyDocumentoFecha(transaction, sql, empnit, coddoc, correlativo, fechaParts);
      }
      await transaction.commit();
      const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
      res.json(pedido);
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
  } catch (err) {
    console.warn('[API PATCH /notas-debito/pedidos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pedidos/:coddoc/:correlativo/lineas', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }

  let descuentoBody = null;
  try {
    descuentoBody = parseDescuentoLineaBody(req.body);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  if (descuentoBody) {
    try {
      const pool = await req.app.locals.getDbPool();
      const docMeta = await loadDocumentoMeta(pool, empnit, coddoc, correlativo);
      if (!docMeta) return res.status(404).json({ error: 'Documento no encontrado' });
      if (!isStatusEditable(docMeta.STATUS)) {
        return res.status(400).json({ error: mensajeDocumentoNoEditable(docMeta.STATUS) });
      }

      const parts = nowParts();
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        const lineId = await insertDescuentoLinea(transaction, sql, {
          empnit,
          coddoc,
          correlativo,
          desprod: descuentoBody.desprod,
          monto: descuentoBody.monto,
          parts,
        });
        const totals = await recalcDocumentTotals(transaction, empnit, coddoc, correlativo);
        await transaction.commit();
        const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
        return res.status(201).json({ lineId, totals, pedido });
      } catch (inner) {
        await transaction.rollback();
        throw inner;
      }
    } catch (err) {
      console.warn('[API POST /notas-debito/pedidos/lineas descuento]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  const codprod = String(req.body?.CODPROD || '').trim();
  const codmedida = String(req.body?.CODMEDIDA || '').trim();
  const cantidad = Number(req.body?.CANTIDAD ?? 1);
  const equivaleReq = req.body?.EQUIVALE;
  const precioReq = req.body?.PRECIO;
  if (!codprod || !codmedida) {
    return res.status(400).json({ error: 'CODPROD y CODMEDIDA son obligatorios' });
  }
  if (cantidad <= 0) return res.status(400).json({ error: 'Cantidad debe ser mayor a cero' });

  try {
    const pool = await req.app.locals.getDbPool();
    const docMeta = await loadDocumentoMeta(pool, empnit, coddoc, correlativo);
    if (!docMeta) return res.status(404).json({ error: 'Documento no encontrado' });
    if (!isStatusEditable(docMeta.STATUS)) {
      return res.status(400).json({ error: mensajeDocumentoNoEditable(docMeta.STATUS) });
    }
    const comCoddoc = String(docMeta.SERIEFAC || '').trim();
    const comCorrelativo = parseCorrelativo(docMeta.NOFAC);
    if (!comCoddoc || comCorrelativo === null) {
      return res.status(400).json({ error: 'La nota no tiene compra de referencia (SERIEFAC/NOFAC)' });
    }

    const disponibles = await fetchProductosDisponibles(pool, empnit, comCoddoc, comCorrelativo, {
      coddoc,
      correlativo,
    });
    const selected = pickDisponibleLine(disponibles, codprod, codmedida, equivaleReq, precioReq);
    if (!selected) {
      return res.status(404).json({
        error: 'Producto/medida no disponible en la compra de referencia (si hay varias coincidencias, envíe EQUIVALE y PRECIO)',
      });
    }
    await assertCantidadDisponible(pool, empnit, comCoddoc, comCorrelativo, coddoc, correlativo, selected, cantidad);

    const lineTotals = calcLineTotals(cantidad, selected.COSTO, selected.PRECIO, selected.EQUIVALE);
    const parts = nowParts();
    const totalPeso = calcLinePeso(cantidad, selected.PESO);

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
        .input('CODPROD', sql.VarChar, selected.CODPROD)
        .input('DESPROD', sql.VarChar, selected.DESPROD)
        .input('CODMEDIDA', sql.VarChar, selected.CODMEDIDA)
        .input('CANTIDAD', sql.Float, cantidad)
        .input('EQUIVALE', sql.Int, Number(selected.EQUIVALE) || 1)
        .input('TOTALUNIDADES', sql.Float, lineTotals.totalUnidades)
        .input('COSTO', sql.Decimal(18, 3), Number(selected.COSTO) || 0)
        .input('PRECIO', sql.Decimal(18, 3), Number(selected.PRECIO) || 0)
        .input('TOTALCOSTO', sql.Decimal(18, 3), lineTotals.totalCosto)
        .input('TOTALPRECIO', sql.Decimal(18, 3), lineTotals.totalPrecio)
        .input('EXENTO', sql.Decimal(18, 3), Number(selected.EXENTO) || 0)
        .input('TIPOPROD', sql.VarChar, String(selected.TIPOPROD || 'P'))
        .input('TIPOPRECIO', sql.VarChar, String(selected.TIPOPRECIO || 'P'))
        .input('PESO', sql.Decimal(18, 3), Number(selected.PESO) || 0)
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
        codprod: selected.CODPROD,
        desprod: selected.DESPROD,
        totalUnidades: lineTotals.totalUnidades,
        tipoprod: selected.TIPOPROD,
        tipom,
        codbodegaEntrada: DEFAULT_BODEGA,
        codbodegaSalida: DEFAULT_BODEGA,
      });
      const totals = await recalcDocumentTotals(transaction, empnit, coddoc, correlativo);
      await transaction.commit();
      const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
      res.status(201).json({ lineId, totals, pedido });
    } catch (inner) {
      await transaction.rollback();
      if (inner instanceof InventarioError) {
        return res.status(inner.statusCode).json({ error: inner.message, code: inner.code });
      }
      if (inner.statusCode === 400) return res.status(400).json({ error: inner.message });
      throw inner;
    }
  } catch (err) {
    if (err instanceof InventarioError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    console.warn('[API POST /notas-debito/pedidos/lineas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/pedidos/:coddoc/:correlativo/lineas/:lineId', async (req, res) => {
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
          l.CANTIDAD, l.COSTO, l.PRECIO, l.EQUIVALE, l.PESO, l.TOTALUNIDADES, l.CODMEDIDA,
          l.CODPROD, l.DESPROD, l.TIPOPROD, l.TIPOM, l.CODBODEGAENTRADA, l.CODBODEGASALIDA,
          d.STATUS, ISNULL(d.CORTE, 'NO') AS CORTE, d.SERIEFAC, d.NOFAC
        FROM dbo.DOCPRODUCTOS l
        JOIN dbo.DOCUMENTOS d ON d.EMPNIT = l.EMPNIT AND d.CODDOC = l.CODDOC AND d.CORRELATIVO = l.CORRELATIVO
        WHERE l.ID = @ID AND l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC AND l.CORRELATIVO = @CORRELATIVO
      `);
    if (!lineRes.recordset.length) return res.status(404).json({ error: 'Línea no encontrada' });
    const lineMeta = lineRes.recordset[0];
    if (!isStatusEditable(lineMeta.STATUS)) {
      return res.status(400).json({ error: mensajeDocumentoNoEditable(lineMeta.STATUS) });
    }
    if (isLineaDescuentoCodprod(lineMeta.CODPROD)) {
      return res.status(400).json({ error: 'Las líneas de descuento no permiten cambiar la cantidad' });
    }
    const comCoddoc = String(lineMeta.SERIEFAC || '').trim();
    const comCorrelativo = parseCorrelativo(lineMeta.NOFAC);
    if (!comCoddoc || comCorrelativo === null) {
      return res.status(400).json({ error: 'La nota no tiene compra de referencia (SERIEFAC/NOFAC)' });
    }
    await assertCantidadDisponible(
      pool,
      empnit,
      comCoddoc,
      comCorrelativo,
      coddoc,
      correlativo,
      {
        CODPROD: lineMeta.CODPROD,
        CODMEDIDA: lineMeta.CODMEDIDA,
        EQUIVALE: lineMeta.EQUIVALE,
        PRECIO: lineMeta.PRECIO,
      },
      cantidad,
      { mode: 'set', cantidadAnterior: lineMeta.CANTIDAD }
    );

    const totals = calcLineTotals(cantidad, lineMeta.COSTO, lineMeta.PRECIO, lineMeta.EQUIVALE);
    const totalPeso = calcLinePeso(cantidad, lineMeta.PESO);
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await aplicarMovimientoInventarioLineaPatch(transaction, {
        empnit,
        coddoc,
        correlativo,
        codprod: lineMeta.CODPROD,
        desprod: lineMeta.DESPROD,
        anteriorTotalUnidades: lineMeta.TOTALUNIDADES,
        nuevoTotalUnidades: totals.totalUnidades,
        tipoprod: lineMeta.TIPOPROD,
        tipom: lineMeta.TIPOM,
        codbodegaEntrada: lineMeta.CODBODEGAENTRADA ?? DEFAULT_BODEGA,
        codbodegaSalida: lineMeta.CODBODEGASALIDA ?? DEFAULT_BODEGA,
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
      const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
      res.json({ totals: docTotals, pedido });
    } catch (inner) {
      await transaction.rollback();
      if (inner instanceof InventarioError) {
        return res.status(inner.statusCode).json({ error: inner.message, code: inner.code });
      }
      if (inner.statusCode === 400) return res.status(400).json({ error: inner.message });
      throw inner;
    }
  } catch (err) {
    if (err instanceof InventarioError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    console.warn('[API PATCH /notas-debito/pedidos/lineas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/pedidos/:coddoc/:correlativo/lineas/:lineId', async (req, res) => {
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
            l.CODBODEGAENTRADA, l.CODBODEGASALIDA, d.STATUS, ISNULL(d.CORTE, 'NO') AS CORTE
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
        return res.status(400).json({ error: mensajeDocumentoNoEditable(line.STATUS) });
      }
      if (!isLineaDescuentoCodprod(line.CODPROD)) {
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
      }
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
      const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
      res.json({ totals, pedido });
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
    console.warn('[API DELETE /notas-debito/pedidos/lineas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pedidos/:coddoc/:correlativo/finalizar', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });
  const obs = req.body?.OBS !== undefined ? String(req.body.OBS || '').trim() : null;
  const felUudi = req.body?.FEL_UUDI !== undefined ? String(req.body.FEL_UUDI || '').trim() : null;
  const hasFelFields =
    req.body?.FEL_SERIE !== undefined ||
    req.body?.FEL_NUMERO !== undefined ||
    req.body?.FEL_FECHA !== undefined;
  const felSerie =
    req.body?.FEL_SERIE !== undefined ? String(req.body.FEL_SERIE || '').trim() : null;
  const felNumero =
    req.body?.FEL_NUMERO !== undefined ? String(req.body.FEL_NUMERO || '').trim() : null;
  const felFecha =
    req.body?.FEL_FECHA !== undefined ? String(req.body.FEL_FECHA || '').trim().slice(0, 10) : null;
  let codcaja = null;
  if (req.body?.CODCAJA !== undefined && req.body?.CODCAJA !== null && req.body?.CODCAJA !== '') {
    const parsed = parseInt(req.body.CODCAJA, 10);
    if (Number.isNaN(parsed)) {
      return res.status(400).json({ error: 'CODCAJA inválido' });
    }
    codcaja = parsed;
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const meta = await loadDocumentoMeta(transaction, empnit, coddoc, correlativo);
      if (!meta) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Documento no encontrado' });
      }
      if (!isStatusEditable(meta.STATUS)) {
        await transaction.rollback();
        return res.status(400).json({ error: mensajeDocumentoNoEditable(meta.STATUS) });
      }
      const serieFac = String(meta.SERIEFAC || '').trim();
      const noFac = String(meta.NOFAC || '').trim();
      if (!serieFac || !noFac) {
        await transaction.rollback();
        return res.status(400).json({ error: 'La nota debe tener SERIEFAC y NOFAC para finalizar' });
      }

      if (obs !== null || hasFelFields) {
        const upd = transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, coddoc)
          .input('CORRELATIVO', sql.Decimal(18, 0), correlativo);
        const sets = [];
        if (obs !== null) {
          upd.input('OBS', sql.VarChar, obs);
          sets.push('OBS = @OBS');
        }
        if (felSerie !== null) {
          upd.input('FEL_SERIE', sql.VarChar, felSerie);
          sets.push('FEL_SERIE = @FEL_SERIE');
        }
        if (felNumero !== null) {
          upd.input('FEL_NUMERO', sql.VarChar, felNumero);
          sets.push('FEL_NUMERO = @FEL_NUMERO');
        }
        if (felFecha !== null) {
          if (felFecha && !/^\d{4}-\d{2}-\d{2}$/.test(felFecha)) {
            await transaction.rollback();
            return res.status(400).json({ error: 'Fecha FEL inválida' });
          }
          upd.input('FEL_FECHA', sql.VarChar, felFecha || null);
          sets.push('FEL_FECHA = @FEL_FECHA');
        }
        if (sets.length) {
          await upd.query(`
            UPDATE dbo.DOCUMENTOS
            SET ${sets.join(', ')}
            WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
              AND ${SQL_STATUS_EDITABLE}
          `);
        }
      }
      if (felUudi !== null) {
        await transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, coddoc)
          .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
          .input('FEL_UUDI', sql.VarChar, felUudi)
          .query(`
            UPDATE dbo.DOCUMENTOS
            SET FEL_UUDI = @FEL_UUDI
            WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
              AND ${SQL_STATUS_EDITABLE}
          `);
      }
      if (codcaja !== null) {
        await transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, coddoc)
          .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
          .input('CODCAJA', sql.Int, codcaja)
          .query(`
            UPDATE dbo.DOCUMENTOS
            SET CODCAJA = @CODCAJA
            WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
              AND ${SQL_STATUS_EDITABLE}
          `);
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
        return res.status(400).json({ error: 'Agregue al menos un producto a la nota' });
      }
      await recalcDocumentTotals(transaction, empnit, coddoc, correlativo);
      const totalRow = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          SELECT ISNULL(TOTALPRECIO, 0) AS TOTALPRECIO
          FROM dbo.DOCUMENTOS
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);
      const totalPrecio = Number(totalRow.recordset[0]?.TOTALPRECIO) || 0;
      const fpago = resolveFormasPago('CON', req.body, totalPrecio);
      await applyFormasPagoDocumento(transaction, empnit, coddoc, correlativo, fpago);
      const totalAbonado = await applyTotalesContadoFinal(transaction, sql, empnit, coddoc, correlativo, fpago);
      const comCorrelativo = parseCorrelativo(noFac);
      if (comCorrelativo !== null) {
        await aplicarNotaDebitoACompraCredito(transaction, empnit, serieFac, comCorrelativo, totalAbonado);
      }
      await transaction.commit();
      const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
      res.json({ ok: true, pedido, inventario: { tipom: 0, lineas: 0, productos: 0 } });
    } catch (inner) {
      await transaction.rollback();
      if (inner instanceof InventarioError) {
        return res.status(inner.statusCode).json({ error: inner.message, code: inner.code });
      }
      if (inner.statusCode === 400) {
        return res.status(400).json({ error: inner.message });
      }
      throw inner;
    }
  } catch (err) {
    if (err instanceof InventarioError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    if (err.statusCode === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.warn('[API POST /notas-debito/pedidos/finalizar]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/pedidos/:coddoc/:correlativo', async (req, res) => {
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

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const check = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          SELECT STATUS, ISNULL(CORTE, 'NO') AS CORTE, SERIEFAC, NOFAC,
            ISNULL(TOTALPRECIO, 0) AS TOTALPRECIO,
            ISNULL(DOC_ABONO, 0) AS DOC_ABONO
          FROM dbo.DOCUMENTOS
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);

      if (!check.recordset.length) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Documento no encontrado' });
      }

      const meta = check.recordset[0];
      if (!isStatusEditable(meta.STATUS)) {
        await transaction.rollback();
        return res.status(400).json({ error: 'El documento no está operado y no se puede eliminar' });
      }

      const serieFac = String(meta.SERIEFAC || '').trim();
      const comCorrelativo = parseCorrelativo(meta.NOFAC);
      const montoAplicado = roundMoney(meta.DOC_ABONO);
      if (serieFac && comCorrelativo !== null && montoAplicado > 0) {
        await revertirNotaDebitoEnCompraCredito(transaction, empnit, serieFac, comCorrelativo, montoAplicado);
      }

      await revertirMovimientoInventarioDocumento(transaction, { empnit, coddoc, correlativo });

      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          DELETE FROM dbo.DOCPRODUCTOS
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);

      const del = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          DELETE FROM dbo.DOCUMENTOS
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);

      if (del.rowsAffected[0] === 0) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Documento no encontrado' });
      }

      await transaction.commit();
      res.json({ ok: true, CODDOC: coddoc, CORRELATIVO: correlativo });
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
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
    console.warn('[API DELETE /notas-debito/pedidos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
