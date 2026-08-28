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
const { parseFechaInput, applyDocumentoFecha, nowParts, normalizePedidoResponse, normalizeDocumentoRows, bindDocumentoFechaDiaParams, sqlDocumentoFechaDiaWhere } = require('../lib/documento-fecha');
const { assertAdminPass, assertEliminacionRegistro } = require('../lib/config-auth');
const { DocumentoDeleteError, deleteDocumentoOperado } = require('../lib/documento-delete');
const { usuarioFromReq } = require('../lib/documentos-eliminados');
const { lineProductMeta, getPrecioFromPreciosRow, normalizePreciosField } = require('../lib/doc-producto-linea');
const {
  fetchProductoPrecioForLinea,
  pesoFromPreciosRow,
  calcLinePeso,
} = require('../lib/producto-precio-linea');
const { searchMovimientoProductos } = require('../lib/movimiento-productos-search');
const { SQL_INVSALDO_UNICO_JOIN_LINEA, sqlExistenciaMedidaExpr } = require('../lib/existencia-medida');
const { parseFinalizeClienteBody } = require('../lib/documento-cliente-finalize');
const {
  parseFinalizeEntregaBody,
  normalizeFEntrega,
  F_ENTREGA_DOMICILIO,
} = require('../lib/documento-entrega-finalize');
const { findVendedorByClave } = require('../lib/vendedor-clave');
const { getSettingSino, getSettingPermiteFraccionamientoFacturas, SETTING_OPCION } = require('../lib/settings');
const {
  normalizeTipofac,
  normalizePrioridad,
  tipodocsForTipofac,
  TIPOFAC_DEFAULT,
} = require('../lib/documento-tipofac-prioridad');
const {
  resolveEmpleadoCoddocPreferido,
  pickCoddocDefault,
  listCajasAbiertasConDefault,
  OPCION_SERIES,
} = require('../lib/empleado-coddoc-preferido');
const {
  STATUS_OPERADO,
  STATUS_BLOQUEADO,
  STATUS_ANULADO,
  isStatusEditable,
  isCorteCajaCerrado,
  isDocumentoEditable,
  canEditFacturaConCorte,
  SQL_STATUS_EDITABLE,
  SQL_DOCUMENTO_EDITABLE,
  sqlPedidosListStatusFilter,
  resolvePedidosListStatusLabel,
} = require('../lib/documento-status');

const router = express.Router();

router.use((req, _res, next) => {
  req.facturacionGrupo = resolveFacturacionGrupo(req);
  next();
});

const DEFAULT_LIMIT = 40;
const SEARCH_LIMIT = 80;
const TIPODOC_GRUPO_FAC = ['FAC'];
const TIPODOC_GRUPO_FEL = ['FEF', 'FES', 'FEC'];
const TIPODOC_FACTURACION_ALL = [...TIPODOC_GRUPO_FAC, ...TIPODOC_GRUPO_FEL];
const TIPODOC_MOSTRADOR = 'ENV';
const TIPODOC_COTIZACION = 'COT';
const TIPODOC_COMANDA = 'CRS';
const TIPODOC_TOMAR_DATOS = [TIPODOC_MOSTRADOR, TIPODOC_COTIZACION, TIPODOC_COMANDA];
const TIPODOC_TOMAR_DATOS_SQL_IN = TIPODOC_TOMAR_DATOS.map((t) => `'${t}'`).join(', ');

function tipodocSqlIn(tipodocs) {
  return tipodocs.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(', ');
}

/** grupo=fac → FAC; grupo=fel → FEF/FES/FEC; grupo=mixto → FAC+FEL */
function resolveFacturacionGrupo(req) {
  const raw = String(req.query?.grupo || req.body?.grupo || 'fac').trim().toLowerCase();
  if (raw === 'fel' || raw === 'electronicas' || raw === 'electronica') {
    return { id: 'fel', tipodocs: TIPODOC_GRUPO_FEL };
  }
  if (raw === 'mixto' || raw === 'completa' || raw === 'all' || raw === 'facturacion') {
    return { id: 'mixto', tipodocs: TIPODOC_FACTURACION_ALL };
  }
  return { id: 'fac', tipodocs: TIPODOC_GRUPO_FAC };
}

/** Factura que referencia pedido/cotización (SERIEFAC + NOFAC), excluyendo anuladas */
const SQL_FACTURA_VINCULADA_PEDIDO = `
  f.EMPNIT = d.EMPNIT
  AND f.SERIEFAC = d.CODDOC
  AND TRY_CAST(LTRIM(RTRIM(f.NOFAC)) AS DECIMAL(18, 0)) = d.CORRELATIVO
  AND f.STATUS <> '${STATUS_ANULADO}'
`;

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

function mensajeDocumentoNoEditable(status, corte) {
  if (isCorteCajaCerrado(corte)) {
    return 'El documento está incluido en corte de caja y no se puede editar';
  }
  if (!isStatusEditable(status)) {
    return 'El pedido ya no está en edición';
  }
  return 'El documento no se puede editar';
}

async function resolveReqIsAdmin(pool, empnit, req) {
  const cod = parseInt(
    req.query.codempleado || req.body?.codempleado || req.headers['x-cod-empleado'],
    10
  );
  if (Number.isFinite(cod) && cod > 0) {
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODEMPLEADO', sql.Int, cod)
      .query(`
        SELECT TOP 1 CODTIPOEMPLEADO
        FROM dbo.Empleados
        WHERE EMPNIT = @EMPNIT AND CODEMPLEADO = @CODEMPLEADO
      `);
    return Number(result.recordset[0]?.CODTIPOEMPLEADO) === CODTIPO_EMPLEADO_ADMIN;
  }
  return String(req.query.superUser || req.headers['x-super-user'] || '').trim() === '1';
}

async function loadDocumentoMeta(pool, empnit, coddoc, correlativo) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT d.STATUS, ISNULL(d.CORTE, 'NO') AS CORTE, t.TIPODOC, d.FEL_UUDI
      FROM dbo.DOCUMENTOS d
      LEFT JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
    `);
  return result.recordset[0] || null;
}

/** Edición de cabecera/líneas: documento editable, o FAC/FEL con corte si es administrador. */
async function isFacturacionContenidoEditable(pool, empnit, req, meta) {
  if (!meta) return false;
  if (String(meta.FEL_UUDI || '').trim()) return false;
  if (isDocumentoEditable(meta.STATUS, meta.CORTE)) return true;
  const isAdmin = await resolveReqIsAdmin(pool, empnit, req);
  return canEditFacturaConCorte(meta.STATUS, meta.CORTE, meta.TIPODOC, { isAdmin });
}

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function parseFpagoAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return roundMoney(n);
}

/** Formas de pago al finalizar: contado exige suma = total; crédito todo en cero. */
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
    const err = new Error('Indique la forma de pago por el monto total de la factura');
    err.statusCode = 400;
    throw err;
  }
  if (Math.abs(sum - total) > 0.001) {
    const err = new Error(
      `La suma de formas de pago (${sum}) debe ser igual al total de la factura (${total})`
    );
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

async function getTipoDocFacturacion(
  pool,
  empnit,
  coddocPreferred,
  tipodocs = TIPODOC_FACTURACION_ALL,
  { requireStockMovement = false } = {}
) {
  const tipodocIn = tipodocSqlIn(tipodocs);
  const tipomFilter = requireStockMovement ? ' AND ISNULL(TIPOM, 0) <> 0' : '';
  const req = pool.request().input('EMPNIT', sql.VarChar, empnit);
  if (coddocPreferred) {
    req.input('CODDOC', sql.VarChar, coddocPreferred);
    const one = await req.query(`
      SELECT CODDOC, DESDOC, TIPODOC, CORRELATIVO, ISNULL(TIPOM, 0) AS TIPOM
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND TIPODOC IN (${tipodocIn}) AND ACTIVO = 'SI'${tipomFilter}
    `);
    if (one.recordset.length) return one.recordset[0];
  }
  const all = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT CODDOC, DESDOC, TIPODOC, CORRELATIVO, ISNULL(TIPOM, 0) AS TIPOM
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND TIPODOC IN (${tipodocIn}) AND ACTIVO = 'SI'${tipomFilter}
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

async function getClienteSnapshot(pool, empnit, codcliente) {
  const r = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCLIENTE', sql.Int, codcliente)
    .query(`
      SELECT CODCLIENTE, NIT, NOMBRECLIENTE, DIRCLIENTE, NEGOCIO, TIPONEGOCIO
      FROM dbo.CLIENTES
      WHERE EMPNIT = @EMPNIT AND CODCLIENTE = @CODCLIENTE
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
    .input('PAGO', sql.Decimal(18, 3), totalPrecio)
    .input('DOC_ABONO', sql.Decimal(18, 3), totalPrecio)
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

async function loadPedido(pool, empnit, coddoc, correlativo, tipodocs = null) {
  const headerRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT d.*, t.DESDOC, t.TIPODOC,
        c.NEGOCIO AS CLI_NEGOCIO, c.TIPONEGOCIO AS CLI_TIPONEGOCIO,
        c.NOMBRECLIENTE AS CLI_NOMBRE, c.DIRCLIENTE AS CLI_DIR,
        ISNULL(emp.NOMEMPLEADO, '') AS VENDEDOR
      FROM dbo.DOCUMENTOS d
      JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.CLIENTES c ON c.EMPNIT = d.EMPNIT AND c.CODCLIENTE = d.CODCLIENTE
      LEFT JOIN dbo.Empleados emp ON emp.EMPNIT = d.EMPNIT AND emp.CODEMPLEADO = d.CODVEN
      WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
    `);
  if (!headerRes.recordset.length) return null;
  const header = headerRes.recordset[0];
  if (Array.isArray(tipodocs) && tipodocs.length) {
    const td = String(header.TIPODOC || '').trim().toUpperCase();
    if (!tipodocs.map((t) => String(t).toUpperCase()).includes(td)) return null;
  }
  const linesRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT l.Id AS ID, l.CODPROD, l.DESPROD, l.CODMEDIDA, l.CANTIDAD, l.EQUIVALE, l.PRECIO, l.COSTO,
        l.TOTALPRECIO, l.TOTALCOSTO, l.TOTALUNIDADES, l.TIPOPRECIO,
        ${sqlExistenciaMedidaExpr('l.EQUIVALE')}
      FROM dbo.DOCPRODUCTOS l
      ${SQL_INVSALDO_UNICO_JOIN_LINEA}
      WHERE l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC AND l.CORRELATIVO = @CORRELATIVO
      ORDER BY l.Id
    `);
  return normalizePedidoResponse({ header, lines: linesRes.recordset });
}

async function loadPedidoEnvOperado(db, empnit, coddoc, correlativo) {
  const result = await db
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT d.*, t.TIPODOC
      FROM dbo.DOCUMENTOS d
      JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
        AND t.TIPODOC IN (${TIPODOC_TOMAR_DATOS_SQL_IN}) AND d.STATUS = '${STATUS_OPERADO}'
    `);
  return result.recordset[0] || null;
}

async function copyDocProductosFromPedido(transaction, empnit, srcCoddoc, srcCorrelativo, dstCoddoc, dstCorrelativo, parts) {
  const tipom = await getTipomDocumento(transaction, empnit, dstCoddoc);
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ANIO', sql.Int, parts.anio)
    .input('MES', sql.Int, parts.mes)
    .input('DIA', sql.Int, parts.dia)
    .input('CODDOC_SRC', sql.VarChar, srcCoddoc)
    .input('CORR_SRC', sql.Decimal(18, 0), srcCorrelativo)
    .input('CODDOC_DST', sql.VarChar, dstCoddoc)
    .input('CORR_DST', sql.Decimal(18, 0), dstCorrelativo)
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
      )
      SELECT
        l.EMPNIT, @ANIO, @MES, @DIA, @CODDOC_DST, @CORR_DST,
        l.CODPROD, l.DESPROD, l.CODMEDIDA,
        l.CANTIDAD, ISNULL(l.CANTIDADBONIF, 0), l.EQUIVALE, l.TOTALUNIDADES, ISNULL(l.TOTALBONIF, 0),
        l.COSTO, l.PRECIO, l.TOTALCOSTO, l.TOTALPRECIO,
        l.TOTALUNIDADES, l.TOTALCOSTO, l.TOTALPRECIO,
        ISNULL(l.COSTOANTERIOR, 0), ISNULL(l.COSTOPROMEDIO, 0),
        ISNULL(l.CODBODEGAENTRADA, ${DEFAULT_BODEGA}), ISNULL(l.CODBODEGASALIDA, ${DEFAULT_BODEGA}),
        ISNULL(l.DESCUENTO, 0), ISNULL(l.PORCDESCUENTO, 0), ISNULL(l.NOSERIE, 'SN'), ISNULL(l.EXENTO, 0), ISNULL(l.OBS, 'SN'),
        ISNULL(l.TIPOPROD, 'P'), ISNULL(l.TIPOPRECIO, 'P'), ISNULL(l.PESO, 0), ISNULL(l.TOTALPESO, 0),
        @TIPOM, CAST(GETDATE() AS DATE)
      FROM dbo.DOCPRODUCTOS l
      WHERE l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC_SRC AND l.CORRELATIVO = @CORR_SRC
    `);
  return tipom;
}

async function cerrarPedidoReferenciaFactura(transaction, empnit, facCoddoc, facCorrelativo, pedCoddoc, pedCorrelativo) {
  await revertirMovimientoInventarioDocumento(transaction, {
    empnit,
    coddoc: pedCoddoc,
    correlativo: pedCorrelativo,
  });
  const upd = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC_PED', sql.VarChar, pedCoddoc)
    .input('CORR_PED', sql.Decimal(18, 0), pedCorrelativo)
    .input('SERIEFAC', sql.VarChar, facCoddoc)
    .input('NOFAC', sql.VarChar, String(facCorrelativo))
    .query(`
      UPDATE dbo.DOCUMENTOS
      SET STATUS = '${STATUS_BLOQUEADO}',
          SERIEFAC = @SERIEFAC,
          NOFAC = @NOFAC
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC_PED AND CORRELATIVO = @CORR_PED
        AND STATUS = '${STATUS_OPERADO}'
    `);
  if (upd.rowsAffected[0] === 0) {
    throw new InventarioError('No se pudo cerrar el pedido de referencia', 'PEDIDO_REF');
  }
}

async function getVendedorActivo(pool, empnit, codempleado) {
  const cod = parseInt(codempleado, 10);
  if (Number.isNaN(cod)) return null;
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODEMPLEADO', sql.Int, cod)
    .query(`
      SELECT CODEMPLEADO, NOMEMPLEADO
      FROM dbo.Empleados
      WHERE EMPNIT = @EMPNIT AND CODEMPLEADO = @CODEMPLEADO
        AND ACTIVO = 'SI'
    `);
  return result.recordset[0] || null;
}

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
    console.warn('[API GET /facturacion/vendedores]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/vendedores/por-clave', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const clave = String(req.body?.clave ?? '').trim();
  if (!clave) return res.status(400).json({ error: 'Clave requerida' });
  try {
    const pool = await req.app.locals.getDbPool();
    const vendedor = await findVendedorByClave(pool, empnit, clave);
    if (!vendedor) {
      return res.status(404).json({ error: 'No se encontró un vendedor activo con esa clave' });
    }
    res.json(vendedor);
  } catch (err) {
    console.warn('[API POST /facturacion/vendedores/por-clave]', err.message);
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
    console.warn('[API GET /facturacion/cajas-abiertas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/config', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const { id: grupoId, tipodocs } = resolveFacturacionGrupo(req);
  const tipodocIn = tipodocSqlIn(tipodocs);
  // Mixto y FEL: ocultar series con TIPOM = 0 (no mueven inventario / no certificar).
  const tipomFilter =
    grupoId === 'mixto' || grupoId === 'fel' ? ' AND ISNULL(TIPOM, 0) <> 0' : '';
  try {
    const pool = await req.app.locals.getDbPool();
    const tipos = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .query(`
        SELECT CODDOC, DESDOC, CORRELATIVO, TIPODOC, ISNULL(TIPOM, 0) AS TIPOM
        FROM dbo.TIPODOCUMENTOS
        WHERE EMPNIT = @EMPNIT AND TIPODOC IN (${tipodocIn}) AND ACTIVO = 'SI'${tipomFilter}
        ORDER BY CODDOC
      `);
    const preferredOpcion =
      grupoId === 'fel'
        ? OPCION_SERIES.FACTURAS_ELECTRONICAS
        : grupoId === 'fac'
          ? OPCION_SERIES.FACTURAS_NORMALES
          : null;
    let preferred = preferredOpcion
      ? await resolveEmpleadoCoddocPreferido(
          pool,
          sql,
          empnit,
          req.query.codempleado,
          preferredOpcion
        )
      : null;
    // Mixto: prioriza serie FEL del empleado; si no, FAC.
    if (!preferred && grupoId === 'mixto') {
      preferred =
        (await resolveEmpleadoCoddocPreferido(
          pool,
          sql,
          empnit,
          req.query.codempleado,
          OPCION_SERIES.FACTURAS_ELECTRONICAS
        )) ||
        (await resolveEmpleadoCoddocPreferido(
          pool,
          sql,
          empnit,
          req.query.codempleado,
          OPCION_SERIES.FACTURAS_NORMALES
        ));
    }
    const coddocDefault = pickCoddocDefault(tipos.recordset, preferred);
    const cliente = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .query(`
        SELECT TOP 1 CODCLIENTE, NIT, NOMBRECLIENTE, DIRCLIENTE, NEGOCIO
        FROM dbo.CLIENTES
        WHERE EMPNIT = @EMPNIT AND HABILITADO = 'SI'
        ORDER BY CODCLIENTE
      `);
    const permiteCambiarPrecio = await getSettingSino(
      pool,
      SETTING_OPCION.PERMITE_CAMBIAR_PRECIO_PEDIDOS
    );
    const solicitaAutorizaciones = await getSettingSino(
      pool,
      SETTING_OPCION.SOLICITA_AUTORIZACIONES
    );
    const muestraDesprod2 = await getSettingSino(
      pool,
      SETTING_OPCION.MUESTRA_DESPROD2_EN_DOCS_Y_PRODS
    );
    const permiteFraccionamientoFacturas = await getSettingPermiteFraccionamientoFacturas(pool);
    res.json({
      empnit,
      grupo: grupoId,
      tipodocs,
      statusOperado: STATUS_OPERADO,
      statusBloqueado: STATUS_BLOQUEADO,
      statusAnulado: STATUS_ANULADO,
      coddocDefault,
      tiposDocumento: tipos.recordset,
      clienteDefault: cliente.recordset[0] || null,
      bodegaDefault: DEFAULT_BODEGA,
      permiteCambiarPrecio,
      solicitaAutorizaciones,
      muestraDesprod2,
      permiteFraccionamientoFacturas,
    });
  } catch (err) {
    console.warn('[API GET /facturacion/config]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/productos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const q = String(req.query.q || '').trim();
  const campoPrecio = normalizePreciosField(req.query.campoPrecio);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), SEARCH_LIMIT);
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await searchMovimientoProductos(pool, {
      empnit,
      q,
      limit,
      campoPrecio,
      includeMayoreo: true,
    });
    res.json(result);
  } catch (err) {
    console.warn('[API GET /facturacion/productos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/pedidos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const grupo = resolveFacturacionGrupo(req);
  const { tipodocs } = grupo;
  const tipodocIn = tipodocSqlIn(tipodocs);
  const tipomFilter =
    grupo.id === 'mixto' || grupo.id === 'fel' ? ' AND ISNULL(t.TIPOM, 0) <> 0' : '';
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
        d.DOC_NOMCLIE, d.TOTALPRECIO, d.CODCLIENTE, d.OBS, d.DOC_DIRCLIE,
        d.F_ENTREGA, d.DIRENTREGA,
        d.FEL_UUDI, d.FEL_SERIE, d.FEL_NUMERO, d.CODCAJA, ISNULL(d.CONCRE, 'CON') AS CONCRE,
        d.ID_COLA_TRABAJO, LTRIM(RTRIM(ISNULL(d.CODEMBARQUE, ''))) AS CODEMBARQUE,
        t.TIPODOC, ISNULL(t.TIPOM, 0) AS TIPOM,
        c.NEGOCIO, c.TIPONEGOCIO,
        ISNULL(emp.NOMEMPLEADO, '') AS VENDEDOR,
        ISNULL(cj.DESCAJA, '') AS DESCAJA,
        (SELECT COUNT(*) FROM dbo.DOCPRODUCTOS l
         WHERE l.EMPNIT = d.EMPNIT AND l.CODDOC = d.CODDOC AND l.CORRELATIVO = d.CORRELATIVO) AS LINEAS
      FROM dbo.DOCUMENTOS d
      JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.CLIENTES c ON c.EMPNIT = d.EMPNIT AND c.CODCLIENTE = d.CODCLIENTE
      LEFT JOIN dbo.Empleados emp ON d.CODVEN = emp.CODEMPLEADO AND d.EMPNIT = emp.EMPNIT
      LEFT JOIN dbo.Cajas cj ON cj.EMPNIT = d.EMPNIT AND cj.CODCAJA = d.CODCAJA
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${tipodocIn})
        ${tipomFilter}
        ${statusFilter}
        AND ${sqlDocumentoFechaDiaWhere('d')}
        ${coddocFilter}
      ORDER BY d.HORA DESC, d.MINUTO DESC, d.ID DESC
    `);
    const fecha =
      `${fechaParts.anio}-${String(fechaParts.mes).padStart(2, '0')}-${String(fechaParts.dia).padStart(2, '0')}`;
    res.json({ rows: normalizeDocumentoRows(result.recordset), status: statusLabel, fecha });
  } catch (err) {
    console.warn('[API GET /facturacion/pedidos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/pedidos-env', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const { tipodocs } = resolveFacturacionGrupo(req);
  const tipodocIn = tipodocSqlIn(tipodocs);
  const q = String(req.query.q || '').trim();
  const qLike = q ? `%${q}%` : null;
  try {
    const pool = await req.app.locals.getDbPool();
    const request = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('q', sql.NVarChar, q || null)
      .input('qLike', sql.NVarChar, qLike);
    const result = await request.query(`
      SELECT
        d.CODDOC,
        d.CORRELATIVO,
        t.TIPODOC,
        ISNULL(NULLIF(LTRIM(RTRIM(d.TIPOFAC)), ''), '${TIPOFAC_DEFAULT}') AS TIPOFAC,
        ISNULL(NULLIF(LTRIM(RTRIM(d.PRIORIDAD)), ''), '') AS PRIORIDAD,
        d.FECHA,
        d.HORA,
        d.MINUTO,
        d.DOC_NOMCLIE,
        ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
        d.CODCLIENTE,
        c.NEGOCIO,
        (SELECT COUNT(*) FROM dbo.DOCPRODUCTOS l
         WHERE l.EMPNIT = d.EMPNIT AND l.CODDOC = d.CODDOC AND l.CORRELATIVO = d.CORRELATIVO) AS LINEAS
      FROM dbo.DOCUMENTOS d
      JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.CLIENTES c ON c.EMPNIT = d.EMPNIT AND c.CODCLIENTE = d.CODCLIENTE
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${TIPODOC_TOMAR_DATOS_SQL_IN})
        AND d.STATUS = '${STATUS_OPERADO}'
        AND (
          @q IS NULL OR @q = ''
          OR CAST(d.CORRELATIVO AS VARCHAR(30)) LIKE @qLike
          OR d.CODDOC LIKE @qLike
          OR d.DOC_NOMCLIE LIKE @qLike
          OR c.NEGOCIO LIKE @qLike
        )
        AND EXISTS (
          SELECT 1 FROM dbo.DOCPRODUCTOS l
          WHERE l.EMPNIT = d.EMPNIT AND l.CODDOC = d.CODDOC AND l.CORRELATIVO = d.CORRELATIVO
        )
        AND NOT EXISTS (
          SELECT 1 FROM dbo.DOCUMENTOS f
          JOIN dbo.TIPODOCUMENTOS tf ON f.CODDOC = tf.CODDOC AND f.EMPNIT = tf.EMPNIT
          WHERE tf.TIPODOC IN (${tipodocIn})
            AND ${SQL_FACTURA_VINCULADA_PEDIDO}
        )
        AND (d.SERIEFAC IS NULL OR LTRIM(RTRIM(d.SERIEFAC)) = '')
      ORDER BY d.FECHA DESC, d.HORA DESC, d.MINUTO DESC, d.ID DESC
    `);
    res.json({ rows: normalizeDocumentoRows(result.recordset) });
  } catch (err) {
    console.warn('[API GET /facturacion/pedidos-env]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pedidos/desde-pedido', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const grupo = req.facturacionGrupo || resolveFacturacionGrupo(req);
  const { tipodocs } = grupo;
  const tipodocIn = tipodocSqlIn(tipodocs);
  const pedCoddoc = String(req.body?.CODDOC_PEDIDO || req.body?.CODDOC || '').trim();
  const pedCorrelativo = parseCorrelativo(req.body?.CORRELATIVO_PEDIDO ?? req.body?.CORRELATIVO);
  const coddocFacPref = String(req.body?.CODDOC_FAC || req.body?.CODDOC_FACTURA || '').trim();
  const usuario = String(req.body?.USUARIO || req.body?.usuario || 'FAC').trim();
  if (!pedCoddoc || pedCorrelativo === null) {
    return res.status(400).json({ error: 'CODDOC_PEDIDO y CORRELATIVO_PEDIDO son obligatorios' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const pedido = await loadPedidoEnvOperado(pool, empnit, pedCoddoc, pedCorrelativo);
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido, cotización o comanda no encontrado o no está operado' });
    }

    let tipofac = TIPOFAC_DEFAULT;
    try {
      tipofac = normalizeTipofac(req.body?.TIPOFAC ?? pedido.TIPOFAC);
    } catch (parseErr) {
      return res.status(parseErr.statusCode || 400).json({ error: parseErr.message });
    }

    // En vista mixta, el tipodoc destino se deriva de TIPOFAC del origen.
    let tipodocsCreate = tipodocs;
    if (grupo.id === 'mixto') {
      tipodocsCreate = tipodocsForTipofac(tipofac).filter((t) => tipodocs.includes(t));
      if (!tipodocsCreate.length) {
        return res.status(400).json({
          error: `TIPOFAC ${tipofac} no está permitido en este módulo de facturación`,
        });
      }
    }

    const dupCheck = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('SERIEFAC', sql.VarChar, pedCoddoc)
      .input('CORR_PED', sql.Decimal(18, 0), pedCorrelativo)
      .query(`
        SELECT TOP 1 d.CODDOC, d.CORRELATIVO
        FROM dbo.DOCUMENTOS d
        JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
        WHERE d.EMPNIT = @EMPNIT
          AND t.TIPODOC IN (${tipodocIn})
          AND d.SERIEFAC = @SERIEFAC
          AND TRY_CAST(LTRIM(RTRIM(d.NOFAC)) AS DECIMAL(18, 0)) = @CORR_PED
          AND d.STATUS <> '${STATUS_ANULADO}'
      `);
    if (dupCheck.recordset.length) {
      const dup = dupCheck.recordset[0];
      return res.status(409).json({
        error: `Ya existe una factura (${dup.CODDOC}-${dup.CORRELATIVO}) para este documento`,
      });
    }

    const tipo = await getTipoDocFacturacion(pool, empnit, coddocFacPref, tipodocsCreate, {
      requireStockMovement: grupo.id === 'mixto',
    });
    if (!tipo) {
      return res.status(400).json({
        error: `No hay tipo de documento de facturación (${tipodocsCreate.join(', ')}) activo`,
      });
    }
    const coddocFac = tipo.CODDOC;
    const parts = nowParts();
    const codvenPedidoRaw = Number(pedido.CODVEN);
    const codvenPedido =
      Number.isFinite(codvenPedidoRaw) && codvenPedidoRaw > 0 ? Math.trunc(codvenPedidoRaw) : null;
    const fEntrega = normalizeFEntrega(pedido.F_ENTREGA);
    let dirEntrega = 'SN';
    if (fEntrega === F_ENTREGA_DOMICILIO) {
      const dirRaw = String(pedido.DIRENTREGA || '').trim();
      dirEntrega = dirRaw && dirRaw.toUpperCase() !== 'SN' ? dirRaw : String(pedido.DOC_DIRCLIE || 'SN').trim() || 'SN';
    } else if (fEntrega) {
      dirEntrega = 'SN';
    } else {
      const dirRaw = String(pedido.DIRENTREGA || '').trim();
      if (dirRaw && dirRaw.toUpperCase() !== 'SN') dirEntrega = dirRaw;
    }
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const correlativoFac = await allocateCorrelativo(transaction, empnit, coddocFac);
      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('ANIO', sql.Int, parts.anio)
        .input('MES', sql.Int, parts.mes)
        .input('DIA', sql.Int, parts.dia)
        .input('FECHA', sql.Date, parts.fecha)
        .input('HORA', sql.Int, parts.hora)
        .input('MINUTO', sql.Int, parts.minuto)
        .input('CODDOC', sql.VarChar, coddocFac)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativoFac)
        .input('CODCLIENTE', sql.Int, pedido.CODCLIENTE)
        .input('DOC_NIT', sql.VarChar, String(pedido.DOC_NIT || 'CF'))
        .input('DOC_NOMCLIE', sql.VarChar, String(pedido.DOC_NOMCLIE || ''))
        .input('DOC_DIRCLIE', sql.VarChar, String(pedido.DOC_DIRCLIE || 'SN'))
        .input('CODVEN', sql.Int, codvenPedido)
        .input('CONCRE', sql.VarChar, String(pedido.CONCRE || 'CON').trim().toUpperCase() || 'CON')
        .input('USUARIO', sql.VarChar, usuario)
        .input('OBS', sql.VarChar, String(pedido.OBS || ''))
        .input('SERIEFAC', sql.VarChar, pedCoddoc)
        .input('NOFAC', sql.VarChar, String(pedCorrelativo))
        .input('F_ENTREGA', sql.VarChar, fEntrega)
        .input('DIRENTREGA', sql.VarChar, dirEntrega)
        .input(
          'CODCAJA',
          sql.Int,
          pedido.CODCAJA != null && Number(pedido.CODCAJA) > 0 ? Number(pedido.CODCAJA) : null
        )
        .input('TIPOFAC', sql.VarChar, tipofac)
        .input(
          'PRIORIDAD',
          sql.VarChar,
          (() => {
            try {
              return normalizePrioridad(pedido.PRIORIDAD, { required: false }) || 'BAJA';
            } catch (_) {
              return 'BAJA';
            }
          })()
        )
        .query(`
          INSERT INTO dbo.DOCUMENTOS (
            EMPNIT, ANIO, MES, DIA, FECHA, HORA, MINUTO, CODDOC, CORRELATIVO,
            CODCLIENTE, DOC_NIT, DOC_NOMCLIE, DOC_DIRCLIE, CODVEN,
            TOTALCOSTO, TOTALPRECIO, CODEMBARQUE, STATUS, USUARIO, CONCRE, CORTE,
            MARCA, OBS, DOC_SALDO, DOC_ABONO, OBSMARCA, TOTALDESCUENTO, CODCAJA,
            DIRENTREGA, NOGUIA, VALORENTREGA, TOTALEXENTO, TIPOPAGO, NODOCPAGO,
            VENCIMIENTO, DIASCREDITO, TOTALIVA, TOTALSINIVA, PAGO, VUELTO,
            SERIEFAC, NOFAC, F_ENTREGA, TIPOFAC, PRIORIDAD
          ) VALUES (
            @EMPNIT, @ANIO, @MES, @DIA, @FECHA, @HORA, @MINUTO, @CODDOC, @CORRELATIVO,
            @CODCLIENTE, @DOC_NIT, @DOC_NOMCLIE, @DOC_DIRCLIE, @CODVEN,
            0, 0, 'MOSTRADOR', '${STATUS_OPERADO}', @USUARIO, @CONCRE, 'NO',
            'SN', @OBS, 0, 0, 'SN', 0, @CODCAJA,
            @DIRENTREGA, 'SN', 0, 0,
            CASE WHEN @CONCRE = 'CRE' THEN 'CREDITO' ELSE 'CONTADO' END, 'SN',
            @FECHA, 0, 0, 0, 0, 0,
            @SERIEFAC, @NOFAC, @F_ENTREGA, @TIPOFAC, @PRIORIDAD
          )
        `);
      const tipom = await copyDocProductosFromPedido(
        transaction,
        empnit,
        pedCoddoc,
        pedCorrelativo,
        coddocFac,
        correlativoFac,
        parts,
      );
      const linesRes = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddocFac)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativoFac)
        .query(`
          SELECT CODPROD, DESPROD, TOTALUNIDADES, TIPOPROD
          FROM dbo.DOCPRODUCTOS
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);
      for (const line of linesRes.recordset) {
        await aplicarMovimientoInventarioLineaInsert(transaction, {
          empnit,
          coddoc: coddocFac,
          correlativo: correlativoFac,
          codprod: line.CODPROD,
          desprod: line.DESPROD,
          totalUnidades: line.TOTALUNIDADES,
          tipoprod: line.TIPOPROD,
          tipom,
          codbodegaEntrada: DEFAULT_BODEGA,
          codbodegaSalida: DEFAULT_BODEGA,
        });
      }
      await recalcDocumentTotals(transaction, empnit, coddocFac, correlativoFac);
      await transaction.commit();
      const factura = await loadPedido(
        pool,
        empnit,
        coddocFac,
        correlativoFac,
        (req.facturacionGrupo || resolveFacturacionGrupo(req)).tipodocs
      );
      res.status(201).json({
        ok: true,
        pedidoRef: { CODDOC: pedCoddoc, CORRELATIVO: pedCorrelativo },
        factura,
      });
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
    console.warn('[API POST /facturacion/pedidos/desde-pedido]', err.message);
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
    const pedido = await loadPedido(
        pool,
        empnit,
        coddoc,
        correlativo,
        (req.facturacionGrupo || resolveFacturacionGrupo(req)).tipodocs
      );
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(pedido);
  } catch (err) {
    console.warn('[API GET /facturacion/pedidos/:coddoc/:correlativo]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pedidos', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const grupo = resolveFacturacionGrupo(req);
  const { tipodocs } = grupo;
  const coddocBody = String(req.body?.CODDOC || '').trim();
  const codcliente = parseInt(req.body?.CODCLIENTE, 10);
  const usuario = String(req.body?.USUARIO || req.body?.usuario || 'FAC').trim();
  const obs = String(req.body?.OBS || '').trim();
  const codvenRaw = req.body?.CODVEN;

  try {
    const pool = await req.app.locals.getDbPool();
    const tipo = await getTipoDocFacturacion(pool, empnit, coddocBody, tipodocs, {
      requireStockMovement: grupo.id === 'mixto',
    });
    if (!tipo) {
      return res.status(400).json({
        error: `No hay tipo de documento de facturación (${tipodocs.join(', ')}) activo para la empresa`,
      });
    }
    const coddoc = tipo.CODDOC;
    let cliente = null;
    if (!Number.isNaN(codcliente)) {
      cliente = await getClienteSnapshot(pool, empnit, codcliente);
    }
    if (!cliente) {
      cliente = await getClienteSnapshot(pool, empnit, 1);
    }
    if (!cliente) {
      return res.status(400).json({ error: 'No hay cliente disponible para el pedido' });
    }
    let codven = null;
    if (codvenRaw !== undefined && codvenRaw !== null && String(codvenRaw).trim() !== '') {
      const vendedor = await getVendedorActivo(pool, empnit, codvenRaw);
      if (vendedor) codven = vendedor.CODEMPLEADO;
    }

    const parts = nowParts();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const correlativo = await allocateCorrelativo(transaction, empnit, coddoc);
      const nom = cliente.NOMBRECLIENTE || cliente.NEGOCIO || 'CLIENTE';
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
        .input('CODCLIENTE', sql.Int, cliente.CODCLIENTE)
        .input('DOC_NIT', sql.VarChar, String(cliente.NIT || 'CF'))
        .input('DOC_NOMCLIE', sql.VarChar, nom)
        .input('DOC_DIRCLIE', sql.VarChar, String(cliente.DIRCLIENTE || 'SN'))
        .input('USUARIO', sql.VarChar, usuario)
        .input('OBS', sql.VarChar, obs)
        .input('CODCAJA', sql.Int, null)
        .input('CODVEN', sql.Int, codven)
        .query(`
          INSERT INTO dbo.DOCUMENTOS (
            EMPNIT, ANIO, MES, DIA, FECHA, HORA, MINUTO, CODDOC, CORRELATIVO,
            CODCLIENTE, DOC_NIT, DOC_NOMCLIE, DOC_DIRCLIE, CODVEN,
            TOTALCOSTO, TOTALPRECIO, CODEMBARQUE, STATUS, USUARIO, CONCRE, CORTE,
            MARCA, OBS, DOC_SALDO, DOC_ABONO, OBSMARCA, TOTALDESCUENTO, CODCAJA,
            DIRENTREGA, NOGUIA, VALORENTREGA, TOTALEXENTO, TIPOPAGO, NODOCPAGO,
            VENCIMIENTO, DIASCREDITO, TOTALIVA, TOTALSINIVA, PAGO, VUELTO
          ) VALUES (
            @EMPNIT, @ANIO, @MES, @DIA, @FECHA, @HORA, @MINUTO, @CODDOC, @CORRELATIVO,
            @CODCLIENTE, @DOC_NIT, @DOC_NOMCLIE, @DOC_DIRCLIE, @CODVEN,
            0, 0, 'MOSTRADOR', '${STATUS_OPERADO}', @USUARIO, 'CON', 'NO',
            'SN', @OBS, 0, 0, 'SN', 0, @CODCAJA,
            'SN', 'SN', 0, 0, 'CONTADO', 'SN',
            @FECHA, 0, 0, 0, 0, 0
          )
        `);
      await transaction.commit();
      const pedido = await loadPedido(
        pool,
        empnit,
        coddoc,
        correlativo,
        (req.facturacionGrupo || resolveFacturacionGrupo(req)).tipodocs
      );
      res.status(201).json(pedido);
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
  } catch (err) {
    console.warn('[API POST /facturacion/pedidos]', err.message);
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
    const request = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo);

    if (req.body?.CODCLIENTE !== undefined) {
      const codcliente = parseInt(req.body.CODCLIENTE, 10);
      if (Number.isNaN(codcliente)) return res.status(400).json({ error: 'CODCLIENTE inválido' });
      const cliente = await getClienteSnapshot(pool, empnit, codcliente);
      if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });
      request.input('CODCLIENTE', sql.Int, cliente.CODCLIENTE);
      request.input('DOC_NIT', sql.VarChar, String(cliente.NIT || 'CF'));
      request.input('DOC_NOMCLIE', sql.VarChar, cliente.NOMBRECLIENTE || cliente.NEGOCIO || '');
      request.input('DOC_DIRCLIE', sql.VarChar, String(cliente.DIRCLIENTE || 'SN'));
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
    if (req.body?.CODVEN !== undefined) {
      const raw = req.body.CODVEN;
      if (raw === null || raw === '' || raw === 0 || raw === '0') {
        request.input('CODVEN', sql.Int, null);
        updates.push('CODVEN = @CODVEN');
      } else {
        const codven = parseInt(raw, 10);
        if (Number.isNaN(codven)) return res.status(400).json({ error: 'CODVEN inválido' });
        const vendedor = await getVendedorActivo(pool, empnit, codven);
        if (!vendedor) {
          return res.status(404).json({ error: 'Vendedor no encontrado o inactivo' });
        }
        request.input('CODVEN', sql.Int, vendedor.CODEMPLEADO);
        updates.push('CODVEN = @CODVEN');
      }
    }

    const fechaParts = req.body?.FECHA !== undefined ? parseFechaInput(req.body.FECHA) : null;
    if (req.body?.FECHA !== undefined && !fechaParts) {
      return res.status(400).json({ error: 'Fecha inválida (use YYYY-MM-DD)' });
    }

    if (!updates.length && !fechaParts) return res.status(400).json({ error: 'Sin campos para actualizar' });

    const docMetaPre = await loadDocumentoMeta(pool, empnit, coddoc, correlativo);
    if (!docMetaPre) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!(await isFacturacionContenidoEditable(pool, empnit, req, docMetaPre))) {
      return res.status(400).json({
        error: mensajeDocumentoNoEditable(docMetaPre.STATUS, docMetaPre.CORTE),
      });
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
        if (req.body?.CODCLIENTE !== undefined) {
          const codcliente = parseInt(req.body.CODCLIENTE, 10);
          const cliente = await getClienteSnapshot(pool, empnit, codcliente);
          txnReq
            .input('CODCLIENTE', sql.Int, cliente.CODCLIENTE)
            .input('DOC_NIT', sql.VarChar, String(cliente.NIT || 'CF'))
            .input('DOC_NOMCLIE', sql.VarChar, cliente.NOMBRECLIENTE || cliente.NEGOCIO || '')
            .input('DOC_DIRCLIE', sql.VarChar, String(cliente.DIRCLIENTE || 'SN'));
        }
        if (req.body?.OBS !== undefined) {
          txnReq.input('OBS', sql.VarChar, String(req.body.OBS || ''));
        }
        if (req.body?.CONCRE !== undefined) {
          txnReq.input('CONCRE', sql.VarChar, String(req.body.CONCRE || 'CON').trim().toUpperCase());
        }
        if (req.body?.CODVEN !== undefined) {
          const raw = req.body.CODVEN;
          if (raw === null || raw === '' || raw === 0 || raw === '0') {
            txnReq.input('CODVEN', sql.Int, null);
          } else {
            const codven = parseInt(raw, 10);
            const vendedor = await getVendedorActivo(pool, empnit, codven);
            txnReq.input('CODVEN', sql.Int, vendedor.CODEMPLEADO);
          }
        }
        const result = await txnReq.query(`
          UPDATE dbo.DOCUMENTOS SET ${updates.join(', ')}
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
            AND ${SQL_DOCUMENTO_EDITABLE}
        `);
        if (result.rowsAffected[0] === 0) {
          await transaction.rollback();
          return res.status(404).json({ error: 'Pedido no encontrado, no operado o incluido en corte de caja' });
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
              AND ${SQL_DOCUMENTO_EDITABLE}
          `);
        if (!chk.recordset.length) {
          await transaction.rollback();
          return res.status(404).json({ error: 'Pedido no encontrado o no operado' });
        }
      }
      await transaction.commit();
      const pedido = await loadPedido(
        pool,
        empnit,
        coddoc,
        correlativo,
        (req.facturacionGrupo || resolveFacturacionGrupo(req)).tipodocs
      );
      res.json(pedido);
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
  } catch (err) {
    console.warn('[API PATCH /facturacion/pedidos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pedidos/:coddoc/:correlativo/lineas', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  const isPse = String(req.body?.tipo || '').trim().toLowerCase() === 'pse';
  const desprodPse = String(req.body?.DESPROD || '').trim();
  const codprod = isPse ? `PSE${Date.now()}` : String(req.body?.CODPROD || '').trim();
  const codmedida = isPse ? 'UNIDAD' : String(req.body?.CODMEDIDA || '').trim();
  const cantidad = Number(req.body?.CANTIDAD ?? 1);
  if (!coddoc || correlativo === null) {
    return res.status(400).json({ error: 'Documento inválido' });
  }
  if (isPse) {
    if (!desprodPse) return res.status(400).json({ error: 'La descripción es obligatoria' });
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
        SELECT d.STATUS, ISNULL(d.CORTE, 'NO') AS CORTE, t.TIPODOC, d.FEL_UUDI
        FROM dbo.DOCUMENTOS d
        LEFT JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
      `);
    if (!docCheck.recordset.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    const docMetaLine = docCheck.recordset[0];
    if (!(await isFacturacionContenidoEditable(pool, empnit, req, docMetaLine))) {
      return res.status(400).json({ error: mensajeDocumentoNoEditable(docMetaLine.STATUS, docMetaLine.CORTE) });
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
      const customCosto = Number(req.body?.COSTO);
      const customPrecio = Number(req.body?.PRECIO);
      if (!Number.isFinite(customCosto) || customCosto < 0) {
        return res.status(400).json({ error: 'Costo inválido' });
      }
      if (!Number.isFinite(customPrecio) || customPrecio < 0) {
        return res.status(400).json({ error: 'Precio inválido' });
      }
      desprod = desprodPse;
      medidaLinea = 'UNIDAD';
      tipoprod = 'P';
      tipoprecio = 'P';
      costo = roundMoney(customCosto);
      precio = roundMoney(customPrecio);
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
      const campoPrecio = normalizePreciosField(req.body?.CAMPO_PRECIO);
      ({ tipoprod, tipoprecio } = lineProductMeta(prod, campoPrecio));
      costo = Number(prod.COSTO ?? prod.COSTO_PROD) || 0;
      precio = getPrecioFromPreciosRow(prod, campoPrecio);
      const permiteCambiarPrecio = await getSettingSino(
        pool,
        SETTING_OPCION.PERMITE_CAMBIAR_PRECIO_PEDIDOS
      );
      if (permiteCambiarPrecio === 'SI' && req.body?.PRECIO !== undefined && req.body?.PRECIO !== null) {
        const customPrecio = Number(req.body.PRECIO);
        if (!Number.isFinite(customPrecio) || customPrecio < 0) {
          return res.status(400).json({ error: 'Precio inválido' });
        }
        precio = roundMoney(customPrecio);
      }
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
      const pedido = await loadPedido(
        pool,
        empnit,
        coddoc,
        correlativo,
        (req.facturacionGrupo || resolveFacturacionGrupo(req)).tipodocs
      );
      res.status(201).json({ lineId, totals, pedido });
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
    console.warn('[API POST /facturacion/pedidos/lineas]', err.message);
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
          l.CANTIDAD, l.COSTO, l.PRECIO, l.EQUIVALE, l.PESO, l.TOTALUNIDADES,
          l.CODPROD, l.DESPROD, l.TIPOPROD, l.TIPOM, l.CODBODEGAENTRADA, l.CODBODEGASALIDA,
          d.STATUS, ISNULL(d.CORTE, 'NO') AS CORTE, t.TIPODOC, d.FEL_UUDI
        FROM dbo.DOCPRODUCTOS l
        JOIN dbo.DOCUMENTOS d ON d.EMPNIT = l.EMPNIT AND d.CODDOC = l.CODDOC AND d.CORRELATIVO = l.CORRELATIVO
        JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        WHERE l.ID = @ID AND l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC AND l.CORRELATIVO = @CORRELATIVO
      `);
    if (!lineRes.recordset.length) return res.status(404).json({ error: 'Línea no encontrada' });
    const lineMeta = lineRes.recordset[0];
    if (!(await isFacturacionContenidoEditable(pool, empnit, req, lineMeta))) {
      return res.status(400).json({ error: mensajeDocumentoNoEditable(lineMeta.STATUS, lineMeta.CORTE) });
    }
    const line = lineMeta;

    let precio = Number(line.PRECIO) || 0;
    if (req.body?.PRECIO !== undefined && req.body?.PRECIO !== null) {
      const permiteCambiarPrecio = await getSettingSino(
        pool,
        SETTING_OPCION.PERMITE_CAMBIAR_PRECIO_PEDIDOS
      );
      if (permiteCambiarPrecio !== 'SI') {
        return res.status(400).json({ error: 'No está permitido cambiar el precio' });
      }
      const customPrecio = Number(req.body.PRECIO);
      if (!Number.isFinite(customPrecio) || customPrecio < 0) {
        return res.status(400).json({ error: 'Precio inválido' });
      }
      precio = roundMoney(customPrecio);
    }

    const totals = calcLineTotals(cantidad, line.COSTO, precio, line.EQUIVALE);
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
        .input('PRECIO', sql.Decimal(18, 3), precio)
        .input('TOTALUNIDADES', sql.Float, totals.totalUnidades)
        .input('TOTALCOSTO', sql.Decimal(18, 3), totals.totalCosto)
        .input('TOTALPRECIO', sql.Decimal(18, 3), totals.totalPrecio)
        .input('TOTALPESO', sql.Decimal(18, 3), totalPeso)
        .query(`
          UPDATE dbo.DOCPRODUCTOS SET
            CANTIDAD = @CANTIDAD,
            PRECIO = @PRECIO,
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
      const pedido = await loadPedido(
        pool,
        empnit,
        coddoc,
        correlativo,
        (req.facturacionGrupo || resolveFacturacionGrupo(req)).tipodocs
      );
      res.json({ totals: docTotals, pedido });
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
    console.warn('[API PATCH /facturacion/pedidos/lineas]', err.message);
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
            l.CODBODEGAENTRADA, l.CODBODEGASALIDA, d.STATUS, ISNULL(d.CORTE, 'NO') AS CORTE,
            t.TIPODOC, d.FEL_UUDI
          FROM dbo.DOCPRODUCTOS l
          JOIN dbo.DOCUMENTOS d
            ON d.EMPNIT = l.EMPNIT AND d.CODDOC = l.CODDOC AND d.CORRELATIVO = l.CORRELATIVO
          LEFT JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
          WHERE l.ID = @ID AND l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC AND l.CORRELATIVO = @CORRELATIVO
        `);
      if (!lineRes.recordset.length) {
        await transaction.rollback();
        return res.status(404).json({ error: 'Línea no encontrada' });
      }
      const line = lineRes.recordset[0];
      if (!(await isFacturacionContenidoEditable(pool, empnit, req, line))) {
        await transaction.rollback();
        return res.status(400).json({ error: mensajeDocumentoNoEditable(line.STATUS, line.CORTE) });
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
      const pedido = await loadPedido(
        pool,
        empnit,
        coddoc,
        correlativo,
        (req.facturacionGrupo || resolveFacturacionGrupo(req)).tipodocs
      );
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
    console.warn('[API DELETE /facturacion/pedidos/lineas]', err.message);
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
  const clienteFinalize = parseFinalizeClienteBody(req.body);
  if (clienteFinalize.error) {
    return res.status(400).json({ error: clienteFinalize.error });
  }
  const entregaFinalize = parseFinalizeEntregaBody(req.body);
  if (entregaFinalize.error) {
    return res.status(400).json({ error: entregaFinalize.error });
  }
  const concre = String(req.body?.CONCRE || 'CON').trim().toUpperCase();
  if (concre !== 'CON' && concre !== 'CRE') {
    return res.status(400).json({ error: 'CONCRE debe ser CON o CRE' });
  }
  const vencParts = concre === 'CRE' ? parseFechaInput(req.body?.VENCIMIENTO) : null;
  if (concre === 'CRE' && !vencParts) {
    return res.status(400).json({ error: 'Vencimiento requerido para crédito (YYYY-MM-DD)' });
  }
  let codcaja = null;
  if (req.body?.CODCAJA !== undefined && req.body?.CODCAJA !== null && req.body?.CODCAJA !== '') {
    const parsed = parseInt(req.body.CODCAJA, 10);
    if (Number.isNaN(parsed)) {
      return res.status(400).json({ error: 'CODCAJA inválido' });
    }
    codcaja = parsed;
  }
  let prioridad;
  try {
    prioridad = normalizePrioridad(req.body?.PRIORIDAD ?? req.body?.prioridad);
  } catch (parseErr) {
    return res.status(parseErr.statusCode || 400).json({ error: parseErr.message });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const txnUpd = transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .input('CONCRE', sql.VarChar, concre)
        .input('TIPOPAGO', sql.VarChar, concre === 'CRE' ? 'CREDITO' : 'CONTADO')
        .input('F_ENTREGA', sql.VarChar, entregaFinalize.fEntrega)
        .input('DIRENTREGA', sql.VarChar, entregaFinalize.dirEntrega)
        .input('PRIORIDAD', sql.VarChar, prioridad);
      let vencSql = '';
      if (concre === 'CRE') {
        txnUpd.input('VENCIMIENTO', sql.Date, vencParts.fecha);
        vencSql = ', VENCIMIENTO = @VENCIMIENTO';
      }
      if (obs !== null) {
        txnUpd.input('OBS', sql.VarChar, obs);
      }
      const obsSql = obs !== null ? ', OBS = @OBS' : '';
      let clienteSql = '';
      if (clienteFinalize.nomClie !== null) {
        txnUpd.input('DOC_NOMCLIE', sql.VarChar, clienteFinalize.nomClie);
        txnUpd.input('DOC_DIRCLIE', sql.VarChar, clienteFinalize.dirClie);
        clienteSql = ', DOC_NOMCLIE = @DOC_NOMCLIE, DOC_DIRCLIE = @DOC_DIRCLIE';
      }
      let cajaSql = ', CODCAJA = NULL';
      if (codcaja !== null) {
        txnUpd.input('CODCAJA', sql.Int, codcaja);
        cajaSql = ', CODCAJA = @CODCAJA';
      }
      await txnUpd.query(`
        UPDATE dbo.DOCUMENTOS
        SET CONCRE = @CONCRE, TIPOPAGO = @TIPOPAGO,
            F_ENTREGA = @F_ENTREGA, DIRENTREGA = @DIRENTREGA,
            PRIORIDAD = @PRIORIDAD${vencSql}${obsSql}${clienteSql}${cajaSql}
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          AND ${SQL_DOCUMENTO_EDITABLE}
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
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }
      const docMeta = docRow.recordset[0];
      if (!isDocumentoEditable(docMeta.STATUS, docMeta.CORTE)) {
        await transaction.rollback();
        return res.status(400).json({ error: mensajeDocumentoNoEditable(docMeta.STATUS, docMeta.CORTE) });
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
        return res.status(400).json({ error: 'Agregue al menos un producto al pedido' });
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
      const fpago = resolveFormasPago(concre, req.body, totalPrecio);
      await applyFormasPagoDocumento(transaction, empnit, coddoc, correlativo, fpago);
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

      const refRow = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          SELECT SERIEFAC, NOFAC FROM dbo.DOCUMENTOS
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);
      const refMeta = refRow.recordset[0] || {};
      const pedCoddoc = String(refMeta.SERIEFAC || '').trim();
      const pedCorrelativo = parseCorrelativo(refMeta.NOFAC);
      if (pedCoddoc && pedCorrelativo !== null) {
        const pedOk = await loadPedidoEnvOperado(transaction, empnit, pedCoddoc, pedCorrelativo);
        if (pedOk) {
          await cerrarPedidoReferenciaFactura(
            transaction,
            empnit,
            coddoc,
            correlativo,
            pedCoddoc,
            pedCorrelativo,
          );
        }
      }

      await transaction.commit();
      const pedido = await loadPedido(
        pool,
        empnit,
        coddoc,
        correlativo,
        (req.facturacionGrupo || resolveFacturacionGrupo(req)).tipodocs
      );
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
    console.warn('[API POST /facturacion/pedidos/finalizar]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pedidos/:coddoc/:correlativo/bloquear', async (req, res) => {
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
      return res.status(404).json({ error: 'Pedido no encontrado o no se puede bloquear' });
    }
    const pedido = await loadPedido(
        pool,
        empnit,
        coddoc,
        correlativo,
        (req.facturacionGrupo || resolveFacturacionGrupo(req)).tipodocs
      );
    res.json({ ok: true, pedido });
  } catch (err) {
    console.warn('[API POST /facturacion/pedidos/bloquear]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Encola la factura para fraccionamiento: crea el registro en
 * DOCUMENTOS_COLA_TRABAJO (TIPO = FRACCIONAR) y guarda el ID generado
 * en DOCUMENTOS.ID_COLA_TRABAJO.
 */
router.post('/pedidos/:coddoc/:correlativo/fraccionar', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.params.coddoc || '').trim();
  const correlativo = parseCorrelativo(req.params.correlativo);
  if (!coddoc || correlativo === null) return res.status(400).json({ error: 'Documento inválido' });

  try {
    const pool = await req.app.locals.getDbPool();
    const permite = await getSettingPermiteFraccionamientoFacturas(pool);
    if (permite !== 'SI') {
      return res.status(403).json({
        error: 'El fraccionamiento de facturas está desactivado en Configuraciones',
      });
    }
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const docRes = await new sql.Request(tx)
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          SELECT ID_COLA_TRABAJO, LTRIM(RTRIM(ISNULL(CODEMBARQUE, ''))) AS CODEMBARQUE
          FROM dbo.DOCUMENTOS WITH (UPDLOCK, ROWLOCK)
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);
      if (!docRes.recordset.length) {
        await tx.rollback();
        return res.status(404).json({ error: 'Documento no encontrado' });
      }
      const docRow = docRes.recordset[0];
      const idActual = docRow.ID_COLA_TRABAJO;
      const codEmbarque = String(docRow.CODEMBARQUE || '').trim().toUpperCase();
      if (codEmbarque === 'FRACCIONADA') {
        await tx.rollback();
        return res.status(409).json({
          error: 'La factura ya fue fraccionada/certificada y no puede enviarse de nuevo',
        });
      }
      if (idActual !== null && idActual !== undefined && Number(idActual) > 0) {
        await tx.rollback();
        return res
          .status(409)
          .json({ error: `El documento ya está en cola de trabajo (ID ${idActual})` });
      }

      const insRes = await new sql.Request(tx)
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          INSERT INTO dbo.DOCUMENTOS_COLA_TRABAJO
            (EMPNIT, TIPO, CODDOC, CORRELATIVO, FECHA_INICIO, HORA_INICIO)
          VALUES
            (@EMPNIT, 'FRACCIONAR', @CODDOC, @CORRELATIVO,
             CAST(GETDATE() AS date), FORMAT(GETDATE(), 'HH:mm'));
          SELECT SCOPE_IDENTITY() AS ID;
        `);
      const idCola = Number(insRes.recordset?.[0]?.ID);
      if (!Number.isFinite(idCola) || idCola <= 0) {
        throw new Error('No se pudo obtener el ID de la cola de trabajo');
      }

      await new sql.Request(tx)
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .input('ID_COLA', sql.Int, idCola)
        .query(`
          UPDATE dbo.DOCUMENTOS SET ID_COLA_TRABAJO = @ID_COLA
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);

      await tx.commit();
      res.json({ ok: true, ID: idCola });
    } catch (err) {
      try {
        await tx.rollback();
      } catch (_) {
        /* transacción ya revertida */
      }
      throw err;
    }
  } catch (err) {
    console.warn('[API POST /facturacion/pedidos/fraccionar]', err.message);
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
    console.warn('[API DELETE /facturacion/pedidos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
