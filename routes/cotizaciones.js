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
const { parseFechaInput, applyDocumentoFecha, nowParts, normalizePedidoResponse, normalizeDocumentoRows } = require('../lib/documento-fecha');
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
const { parseFinalizeEntregaBody } = require('../lib/documento-entrega-finalize');
const { getSettingSino, getSettingTipofacFinalizado, SETTING_OPCION } = require('../lib/settings');
const { normalizeTipofac, normalizePrioridad } = require('../lib/documento-tipofac-prioridad');
const {
  resolveEmpleadoCoddocPreferido,
  pickCoddocDefault,
  OPCION_SERIES,
} = require('../lib/empleado-coddoc-preferido');
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
const TIPODOC_COTIZACION = 'COT';
const DEFAULT_BODEGA = 0;
const CODTIPO_EMPLEADO_VENDEDOR = 3;

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

async function getTipoDocCot(pool, empnit, coddocPreferred) {
  const req = pool.request().input('EMPNIT', sql.VarChar, empnit);
  if (coddocPreferred) {
    req.input('CODDOC', sql.VarChar, coddocPreferred);
    const one = await req.query(`
      SELECT CODDOC, DESDOC, TIPODOC, CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND TIPODOC = '${TIPODOC_COTIZACION}' AND ACTIVO = 'SI'
    `);
    if (one.recordset.length) return one.recordset[0];
  }
  const all = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT CODDOC, DESDOC, TIPODOC, CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND TIPODOC = '${TIPODOC_COTIZACION}' AND ACTIVO = 'SI'
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

async function loadPedido(pool, empnit, coddoc, correlativo) {
  const headerRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT d.*, t.DESDOC, t.TIPODOC,
        c.NEGOCIO AS CLI_NEGOCIO, c.TIPONEGOCIO AS CLI_TIPONEGOCIO,
        c.NOMBRECLIENTE AS CLI_NOMBRE, c.DIRCLIENTE AS CLI_DIR,
        ISNULL(emp.NOMEMPLEADO, '') AS VENDEDOR,
        ISNULL(emp.TELEFONOS, '') AS VENDEDOR_TELEFONO
      FROM dbo.DOCUMENTOS d
      JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.CLIENTES c ON c.EMPNIT = d.EMPNIT AND c.CODCLIENTE = d.CODCLIENTE
      LEFT JOIN dbo.Empleados emp ON emp.EMPNIT = d.EMPNIT AND emp.CODEMPLEADO = d.CODVEN
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
        l.TOTALPRECIO, l.TOTALCOSTO, l.TOTALUNIDADES, l.TIPOPRECIO,
        ${sqlExistenciaMedidaExpr('l.EQUIVALE')}
      FROM dbo.DOCPRODUCTOS l
      ${SQL_INVSALDO_UNICO_JOIN_LINEA}
      WHERE l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC AND l.CORRELATIVO = @CORRELATIVO
      ORDER BY l.Id
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
      .input('CODTIPO', sql.Int, CODTIPO_EMPLEADO_VENDEDOR)
      .query(`
        SELECT CODEMPLEADO, NOMEMPLEADO
        FROM dbo.Empleados
        WHERE EMPNIT = @EMPNIT AND CODTIPOEMPLEADO = @CODTIPO AND ACTIVO = 'SI'
        ORDER BY NOMEMPLEADO ASC
      `);
    res.json({ rows: normalizeDocumentoRows(result.recordset) });
  } catch (err) {
    console.warn('[API GET /cotizaciones/vendedores]', err.message);
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
        SELECT CODDOC, DESDOC, CORRELATIVO
        FROM dbo.TIPODOCUMENTOS
        WHERE EMPNIT = @EMPNIT AND TIPODOC = '${TIPODOC_COTIZACION}' AND ACTIVO = 'SI'
        ORDER BY CODDOC
      `);
    const preferred = await resolveEmpleadoCoddocPreferido(
      pool,
      sql,
      empnit,
      req.query.codempleado,
      OPCION_SERIES.COTIZACIONES
    );
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
    res.json({
      empnit,
      tipodoc: TIPODOC_COTIZACION,
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
    });
  } catch (err) {
    console.warn('[API GET /cotizaciones/config]', err.message);
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
    console.warn('[API GET /cotizaciones/productos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/pedidos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddoc = String(req.query.coddoc || '').trim();
  const statusRaw = String(req.query.status || STATUS_OPERADO).trim().toUpperCase();
  const allowed = [STATUS_OPERADO, STATUS_BLOQUEADO, STATUS_ANULADO];
  const status = allowed.includes(statusRaw) ? statusRaw : STATUS_OPERADO;
  try {
    const pool = await req.app.locals.getDbPool();
    const request = pool.request().input('EMPNIT', sql.VarChar, empnit);
    let coddocFilter = '';
    if (coddoc) {
      request.input('CODDOC', sql.VarChar, coddoc);
      coddocFilter = ' AND d.CODDOC = @CODDOC';
    }
    const result = await request.query(`
      SELECT TOP 100
        d.CODDOC, d.CORRELATIVO, d.FECHA, d.HORA, d.MINUTO, d.STATUS,
        d.DOC_NOMCLIE, d.TOTALPRECIO, d.CODCLIENTE, d.OBS, d.DOC_DIRCLIE,
        d.F_ENTREGA, d.DIRENTREGA,
        c.NEGOCIO, c.TIPONEGOCIO,
        (SELECT COUNT(*) FROM dbo.DOCPRODUCTOS l
         WHERE l.EMPNIT = d.EMPNIT AND l.CODDOC = d.CODDOC AND l.CORRELATIVO = d.CORRELATIVO) AS LINEAS
      FROM dbo.DOCUMENTOS d
      JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.CLIENTES c ON c.EMPNIT = d.EMPNIT AND c.CODCLIENTE = d.CODCLIENTE
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC = '${TIPODOC_COTIZACION}'
        AND d.STATUS = '${status}'
        ${coddocFilter}
      ORDER BY d.ID DESC
    `);
    res.json({ rows: normalizeDocumentoRows(result.recordset), status });
  } catch (err) {
    console.warn('[API GET /cotizaciones/pedidos]', err.message);
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
    if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(pedido);
  } catch (err) {
    console.warn('[API GET /cotizaciones/pedidos/:coddoc/:correlativo]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pedidos', async (req, res) => {
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const coddocBody = String(req.body?.CODDOC || '').trim();
  const codcliente = parseInt(req.body?.CODCLIENTE, 10);
  const usuario = String(req.body?.USUARIO || req.body?.usuario || 'POS').trim();
  const obs = String(req.body?.OBS || '').trim();
  const codvenRaw = req.body?.CODVEN;

  try {
    const pool = await req.app.locals.getDbPool();
    const tipo = await getTipoDocCot(pool, empnit, coddocBody);
    if (!tipo) {
      return res.status(400).json({
        error: `No hay tipo de documento ${TIPODOC_COTIZACION} (cotizaciones) activo para la empresa`,
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
            'SN', @OBS, 0, 0, 'SN', 0, 1,
            'SN', 'SN', 0, 0, 'CONTADO', 'SN',
            @FECHA, 0, 0, 0, 0, 0
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
    console.warn('[API POST /cotizaciones/pedidos]', err.message);
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
    if (req.body?.TIPOFAC !== undefined || req.body?.tipofac !== undefined) {
      let tipofac;
      try {
        tipofac = normalizeTipofac(req.body?.TIPOFAC ?? req.body?.tipofac);
      } catch (parseErr) {
        return res.status(parseErr.statusCode || 400).json({ error: parseErr.message });
      }
      request.input('TIPOFAC', sql.VarChar, tipofac);
      updates.push('TIPOFAC = @TIPOFAC');
    }
    if (req.body?.PRIORIDAD !== undefined || req.body?.prioridad !== undefined) {
      let prioridad;
      try {
        prioridad = normalizePrioridad(req.body?.PRIORIDAD ?? req.body?.prioridad);
      } catch (parseErr) {
        return res.status(parseErr.statusCode || 400).json({ error: parseErr.message });
      }
      request.input('PRIORIDAD', sql.VarChar, prioridad);
      updates.push('PRIORIDAD = @PRIORIDAD');
    }

    const fechaParts = req.body?.FECHA !== undefined ? parseFechaInput(req.body.FECHA) : null;
    if (req.body?.FECHA !== undefined && !fechaParts) {
      return res.status(400).json({ error: 'Fecha inválida (use YYYY-MM-DD)' });
    }

    if (!updates.length && !fechaParts) return res.status(400).json({ error: 'Sin campos para actualizar' });

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
        if (req.body?.TIPOFAC !== undefined || req.body?.tipofac !== undefined) {
          txnReq.input(
            'TIPOFAC',
            sql.VarChar,
            normalizeTipofac(req.body?.TIPOFAC ?? req.body?.tipofac)
          );
        }
        if (req.body?.PRIORIDAD !== undefined || req.body?.prioridad !== undefined) {
          txnReq.input(
            'PRIORIDAD',
            sql.VarChar,
            normalizePrioridad(req.body?.PRIORIDAD ?? req.body?.prioridad)
          );
        }
        const result = await txnReq.query(`
          UPDATE dbo.DOCUMENTOS SET ${updates.join(', ')}
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
            AND ${SQL_STATUS_EDITABLE}
        `);
        if (result.rowsAffected[0] === 0) {
          await transaction.rollback();
          return res.status(404).json({ error: 'Pedido no encontrado o no operado' });
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
          return res.status(404).json({ error: 'Pedido no encontrado o no operado' });
        }
      }
      await transaction.commit();
      const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
      res.json(pedido);
    } catch (inner) {
      await transaction.rollback();
      throw inner;
    }
  } catch (err) {
    console.warn('[API PATCH /cotizaciones/pedidos]', err.message);
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
        SELECT STATUS FROM dbo.DOCUMENTOS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);
    if (!docCheck.recordset.length) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (!isStatusEditable(docCheck.recordset[0].STATUS)) {
      return res.status(400).json({ error: 'El pedido ya no está en edición' });
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
      const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
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
    console.warn('[API POST /cotizaciones/pedidos/lineas]', err.message);
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
          l.COSTO, l.PRECIO, l.EQUIVALE, l.PESO, l.TOTALUNIDADES,
          l.CODPROD, l.DESPROD, l.TIPOPROD, l.TIPOM, l.CODBODEGAENTRADA, l.CODBODEGASALIDA,
          d.STATUS
        FROM dbo.DOCPRODUCTOS l
        JOIN dbo.DOCUMENTOS d ON d.EMPNIT = l.EMPNIT AND d.CODDOC = l.CODDOC AND d.CORRELATIVO = l.CORRELATIVO
        WHERE l.ID = @ID AND l.EMPNIT = @EMPNIT AND l.CODDOC = @CODDOC AND l.CORRELATIVO = @CORRELATIVO
      `);
    if (!lineRes.recordset.length) return res.status(404).json({ error: 'Línea no encontrada' });
    if (!isStatusEditable(lineRes.recordset[0].STATUS)) {
      return res.status(400).json({ error: 'El pedido ya no está en edición' });
    }
    const line = lineRes.recordset[0];

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
      const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
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
    console.warn('[API PATCH /cotizaciones/pedidos/lineas]', err.message);
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
        return res.status(400).json({ error: 'El pedido ya no está en edición' });
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
    console.warn('[API DELETE /cotizaciones/pedidos/lineas]', err.message);
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
  let tipofac;
  let prioridad;
  try {
    const rawTipofac = req.body?.TIPOFAC ?? req.body?.tipofac;
    if (rawTipofac === undefined || rawTipofac === null || String(rawTipofac).trim() === '') {
      tipofac = null;
    } else {
      tipofac = normalizeTipofac(rawTipofac);
    }
    prioridad = normalizePrioridad(req.body?.PRIORIDAD ?? req.body?.prioridad);
  } catch (parseErr) {
    return res.status(parseErr.statusCode || 400).json({ error: parseErr.message });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    if (tipofac === null) {
      tipofac = await getSettingTipofacFinalizado(pool);
    }
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const setParts = [];
      if (obs !== null) setParts.push('OBS = @OBS');
      if (clienteFinalize.nomClie !== null) {
        setParts.push('DOC_NOMCLIE = @DOC_NOMCLIE', 'DOC_DIRCLIE = @DOC_DIRCLIE');
      }
      setParts.push('F_ENTREGA = @F_ENTREGA', 'DIRENTREGA = @DIRENTREGA');
      setParts.push('TIPOFAC = @TIPOFAC', 'PRIORIDAD = @PRIORIDAD');
      if (setParts.length) {
        const updReq = transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, coddoc)
          .input('CORRELATIVO', sql.Decimal(18, 0), correlativo);
        if (obs !== null) updReq.input('OBS', sql.VarChar, obs);
        if (clienteFinalize.nomClie !== null) {
          updReq.input('DOC_NOMCLIE', sql.VarChar, clienteFinalize.nomClie);
          updReq.input('DOC_DIRCLIE', sql.VarChar, clienteFinalize.dirClie);
        }
        updReq.input('F_ENTREGA', sql.VarChar, entregaFinalize.fEntrega);
        updReq.input('DIRENTREGA', sql.VarChar, entregaFinalize.dirEntrega);
        updReq.input('TIPOFAC', sql.VarChar, tipofac);
        updReq.input('PRIORIDAD', sql.VarChar, prioridad);
        await updReq.query(`
            UPDATE dbo.DOCUMENTOS SET ${setParts.join(', ')}
            WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
              AND ${SQL_STATUS_EDITABLE}
          `);
      }
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
      if (!isStatusEditable(docMeta.STATUS)) {
        await transaction.rollback();
        return res.status(400).json({ error: 'El pedido no está operado' });
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
      const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
      res.json({ ok: true, pedido, inventario: inv });
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
    console.warn('[API POST /cotizaciones/pedidos/finalizar]', err.message);
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
    const pedido = await loadPedido(pool, empnit, coddoc, correlativo);
    res.json({ ok: true, pedido });
  } catch (err) {
    console.warn('[API POST /cotizaciones/pedidos/bloquear]', err.message);
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
    console.warn('[API DELETE /cotizaciones/pedidos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
