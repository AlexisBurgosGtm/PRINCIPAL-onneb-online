const sql = require('mssql');
const { SETTING_OPCION, getSettingSino } = require('./settings');

const INVENTARIO_NEGATIVO_CONFIG_ID = 3;

class InventarioError extends Error {
  constructor(message, code = 'INVENTARIO_INSUFICIENTE') {
    super(message);
    this.name = 'InventarioError';
    this.statusCode = 400;
    this.code = code;
  }
}

function roundQty(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/** Movimiento de inventario = TOTALUNIDADES × TIPOM */
function calcMovimientoInventario(totalUnidades, tipom) {
  const unidades = roundQty(totalUnidades);
  const t = Number(tipom) || 0;
  if (!unidades || !t) return 0;
  return roundQty(unidades * t);
}

async function resolveTipom(transaction, empnit, coddoc, tipomOpt) {
  if (tipomOpt !== undefined && tipomOpt !== null) return Number(tipomOpt) || 0;
  return getTipomDocumento(transaction, empnit, coddoc);
}

async function resolvePermiteNegativo(transaction, permiteNegativoOpt) {
  if (permiteNegativoOpt !== undefined) return Boolean(permiteNegativoOpt);
  return getPermiteInventarioNegativo(transaction);
}

/**
 * Aplica un delta (+/-) a INVSALDO.SALDO y PRODUCTOS.EXISTENCIA para una línea.
 * @param {import('mssql').Transaction} transaction
 */
async function aplicarDeltaInventarioLinea(transaction, opts) {
  const tipoprod = String(opts.tipoprod ?? 'P').trim().toUpperCase();
  if (tipoprod === 'S') return { applied: false, delta: 0 };

  const delta = roundQty(opts.delta);
  if (!delta) return { applied: false, delta: 0 };

  const empnit = String(opts.empnit || '').trim();
  const codprod = String(opts.codprod || '').trim();
  // PSE: tipoprod=P (bien) pero no mueve existencia de catálogo.
  if (codprod.toUpperCase().startsWith('PSE')) return { applied: false, delta: 0 };
  if (!empnit || !codprod) {
    throw new InventarioError('Parámetros de inventario inválidos', 'INVENTARIO_PARAMS');
  }

  const permiteNegativo = await resolvePermiteNegativo(transaction, opts.permiteNegativo);

  const invRow = await lockInvSaldoRow(transaction, empnit, codprod);
  const saldoActual = roundQty(invRow?.SALDO ?? 0);
  const nuevoSaldo = roundQty(saldoActual + delta);

  if (nuevoSaldo < 0 && !permiteNegativo) {
    const nombre = String(opts.desprod || codprod).trim() || codprod;
    throw new InventarioError(
      `Stock insuficiente para "${nombre}". Disponible: ${saldoActual}, requerido: ${Math.abs(delta)}.`,
    );
  }

  if (invRow) {
    await updateInvSaldoSaldo(transaction, invRow.ID, nuevoSaldo);
  } else if (delta > 0) {
    await insertInvSaldoRow(transaction, empnit, codprod, nuevoSaldo);
  } else {
    throw new InventarioError(
      `No hay registro de inventario para el producto ${codprod}.`,
      'INVENTARIO_SIN_REGISTRO',
    );
  }

  await updateProductoExistencia(transaction, empnit, codprod, delta);
  return { applied: true, delta };
}

/**
 * Stock al insertar línea: TOTALUNIDADES × TIPOM.
 */
async function aplicarMovimientoInventarioLineaInsert(transaction, opts) {
  const tipom = await resolveTipom(transaction, opts.empnit, opts.coddoc, opts.tipom);
  if (!tipom) return { applied: false, tipom: 0, delta: 0 };

  const delta = calcMovimientoInventario(opts.totalUnidades, tipom);
  const result = await aplicarDeltaInventarioLinea(transaction, { ...opts, delta });
  return { ...result, tipom };
}

/**
 * Stock al editar línea: (nuevo − anterior) × TIPOM.
 */
async function aplicarMovimientoInventarioLineaPatch(transaction, opts) {
  const tipom = await resolveTipom(transaction, opts.empnit, opts.coddoc, opts.tipom);
  if (!tipom) return { applied: false, tipom: 0, delta: 0 };

  const delta = roundQty(
    calcMovimientoInventario(opts.nuevoTotalUnidades, tipom) -
      calcMovimientoInventario(opts.anteriorTotalUnidades, tipom),
  );
  const result = await aplicarDeltaInventarioLinea(transaction, { ...opts, delta });
  return { ...result, tipom };
}

/**
 * Revierte el movimiento de una línea (eliminar línea o borrar documento).
 */
async function revertirMovimientoInventarioLinea(transaction, opts) {
  const tipom = await resolveTipom(transaction, opts.empnit, opts.coddoc, opts.tipom);
  if (!tipom) return { applied: false, tipom: 0, delta: 0 };

  const delta = -calcMovimientoInventario(opts.totalUnidades, tipom);
  const result = await aplicarDeltaInventarioLinea(transaction, { ...opts, delta });
  return { ...result, tipom };
}

/**
 * TIPOM de la línea DOCPRODUCTOS; si es NULL, usa tipom del tipo de documento (fallback).
 */
function tipomFromLine(line, fallbackTipom = 0) {
  if (line && line.TIPOM !== null && line.TIPOM !== undefined && line.TIPOM !== '') {
    const n = Number(line.TIPOM);
    if (Number.isFinite(n)) return n;
  }
  return Number(fallbackTipom) || 0;
}

/**
 * Revierte inventario de todas las líneas de un documento (antes de DELETE masivo).
 * Usa DOCPRODUCTOS.TIPOM por línea.
 */
async function revertirMovimientoInventarioDocumento(transaction, opts) {
  const empnit = String(opts.empnit || '').trim();
  const coddoc = String(opts.coddoc || '').trim();
  const correlativo = Number(opts.correlativo);
  if (!empnit || !coddoc || !Number.isFinite(correlativo)) {
    throw new InventarioError('Parámetros de inventario inválidos', 'INVENTARIO_PARAMS');
  }

  const fallbackTipom = await resolveTipom(transaction, empnit, coddoc, opts.tipom);
  const permiteNegativo = await resolvePermiteNegativo(transaction, opts.permiteNegativo);
  const linesRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT
        CODPROD,
        DESPROD,
        TOTALUNIDADES,
        TIPOPROD,
        TIPOM,
        CODBODEGAENTRADA,
        CODBODEGASALIDA
      FROM dbo.DOCPRODUCTOS
      WHERE EMPNIT = @EMPNIT
        AND CODDOC = @CODDOC
        AND CORRELATIVO = @CORRELATIVO
        AND ISNULL(TIPOPROD, 'P') <> 'S'
    `);

  let lineas = 0;
  let productos = 0;
  let lastTipom = 0;
  for (const line of linesRes.recordset) {
    const tipom = tipomFromLine(line, fallbackTipom);
    if (!tipom) continue;
    lastTipom = tipom;
    const unidades = roundQty(line.TOTALUNIDADES);
    if (!unidades) continue;
    const delta = -calcMovimientoInventario(unidades, tipom);
    if (!delta) continue;
    await aplicarDeltaInventarioLinea(transaction, {
      empnit,
      codprod: line.CODPROD,
      desprod: line.DESPROD,
      delta,
      codbodegaEntrada: line.CODBODEGAENTRADA,
      codbodegaSalida: line.CODBODEGASALIDA,
      tipoprod: line.TIPOPROD,
      permiteNegativo,
    });
    lineas += 1;
    productos += 1;
  }
  return { tipom: lastTipom, lineas, productos };
}

/**
 * SETTINGS — INVENTARIO NEGATIVO (permite vender en negativo).
 * @param {import('mssql').ConnectionPool|import('mssql').Transaction} db
 */
async function getPermiteInventarioNegativo(db) {
  const sino = await getSettingSino(db, SETTING_OPCION.INVENTARIO_NEGATIVO);
  return sino === 'SI';
}

/**
 * TIPOM del tipo de documento: cantidad * TIPOM = movimiento (+ entrada, - salida).
 * @param {import('mssql').Transaction} transaction
 */
async function getTipomDocumento(transaction, empnit, coddoc) {
  const result = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .query(`
      SELECT TIPOM
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC
    `);
  const raw = result.recordset[0]?.TIPOM;
  if (raw === null || raw === undefined || raw === '') return 0;
  const tipom = Number(raw);
  return Number.isFinite(tipom) ? tipom : 0;
}

/**
 * Busca la única fila INVSALDO del producto (bodega irrelevante).
 * @param {import('mssql').Transaction} transaction
 */
async function lockInvSaldoRow(transaction, empnit, codprod) {
  const cod = String(codprod || '').trim();
  const anyRow = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROD', sql.VarChar, cod)
    .query(`
      SELECT TOP 1 ID, SALDO, CODBODEGA
      FROM dbo.INVSALDO WITH (UPDLOCK, ROWLOCK)
      WHERE EMPNIT = @EMPNIT AND LTRIM(RTRIM(CODPROD)) = @CODPROD
      ORDER BY ID
    `);
  return anyRow.recordset[0] || null;
}

async function insertInvSaldoRow(transaction, empnit, codprod, saldo) {
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROD', sql.VarChar, String(codprod || '').trim())
    .input('SALDO', sql.Float, saldo)
    .query(`
      INSERT INTO dbo.INVSALDO (EMPNIT, CODPROD, CODBODEGA, SALDO)
      VALUES (@EMPNIT, @CODPROD, 0, @SALDO)
    `);
}

async function updateInvSaldoSaldo(transaction, id, saldo) {
  await transaction
    .request()
    .input('ID', sql.Int, id)
    .input('SALDO', sql.Float, saldo)
    .query(`
      UPDATE dbo.INVSALDO
      SET SALDO = @SALDO
      WHERE ID = @ID
    `);
}

async function updateProductoExistencia(transaction, empnit, codprod, delta) {
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROD', sql.VarChar, codprod)
    .input('DELTA', sql.Float, delta)
    .query(`
      UPDATE dbo.PRODUCTOS
      SET EXISTENCIA = ISNULL(EXISTENCIA, 0) + @DELTA
      WHERE EMPNIT = @EMPNIT AND CODPROD = @CODPROD
    `);
}

/**
 * Aplica movimiento de inventario para un documento (líneas DOCPRODUCTOS).
 * Movimiento por línea = TOTALUNIDADES × DOCPRODUCTOS.TIPOM.
 * Solo actualiza INVSALDO.SALDO y PRODUCTOS.EXISTENCIA.
 *
 * @param {import('mssql').Transaction} transaction
 * @param {{ empnit: string, coddoc: string, correlativo: number, tipom?: number, permiteNegativo?: boolean }} opts
 */
async function aplicarMovimientoInventarioDocumento(transaction, opts) {
  const empnit = String(opts.empnit || '').trim();
  const coddoc = String(opts.coddoc || '').trim();
  const correlativo = Number(opts.correlativo);
  if (!empnit || !coddoc || !Number.isFinite(correlativo)) {
    throw new InventarioError('Parámetros de inventario inválidos', 'INVENTARIO_PARAMS');
  }

  const fallbackTipom = await resolveTipom(transaction, empnit, coddoc, opts.tipom);

  const permiteNegativo =
    opts.permiteNegativo !== undefined
      ? Boolean(opts.permiteNegativo)
      : await getPermiteInventarioNegativo(transaction);

  const docStatus = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT STATUS FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);
  const st = String(docStatus.recordset[0]?.STATUS || '').trim().toUpperCase();
  if (st !== 'O') {
    throw new InventarioError('El documento no está operado', 'INVENTARIO_STATUS');
  }

  const linesRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT
        CODPROD,
        DESPROD,
        TOTALUNIDADES,
        TIPOPROD,
        TIPOM,
        CODBODEGAENTRADA,
        CODBODEGASALIDA
      FROM dbo.DOCPRODUCTOS
      WHERE EMPNIT = @EMPNIT
        AND CODDOC = @CODDOC
        AND CORRELATIVO = @CORRELATIVO
        AND ISNULL(TIPOPROD, 'P') <> 'S'
    `);

  let lineas = 0;
  let productos = 0;
  let lastTipom = 0;

  for (const line of linesRes.recordset) {
    const tipom = tipomFromLine(line, fallbackTipom);
    if (!tipom) continue;
    lastTipom = tipom;

    const unidades = roundQty(line.TOTALUNIDADES);
    if (!unidades) continue;

    const delta = calcMovimientoInventario(unidades, tipom);
    if (!delta) continue;

    await aplicarDeltaInventarioLinea(transaction, {
      empnit,
      codprod: line.CODPROD,
      desprod: line.DESPROD,
      delta,
      codbodegaEntrada: line.CODBODEGAENTRADA,
      codbodegaSalida: line.CODBODEGASALIDA,
      tipoprod: line.TIPOPROD,
      permiteNegativo,
    });
    lineas += 1;
    productos += 1;
  }

  return { tipom: lastTipom, lineas, productos };
}

module.exports = {
  INVENTARIO_NEGATIVO_CONFIG_ID,
  InventarioError,
  calcMovimientoInventario,
  getPermiteInventarioNegativo,
  getTipomDocumento,
  aplicarDeltaInventarioLinea,
  aplicarMovimientoInventarioLineaInsert,
  aplicarMovimientoInventarioLineaPatch,
  revertirMovimientoInventarioLinea,
  revertirMovimientoInventarioDocumento,
  aplicarMovimientoInventarioDocumento,
};
