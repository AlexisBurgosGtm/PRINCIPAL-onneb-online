const sql = require('mssql');
const { nowParts, parseFechaInput } = require('./documento-fecha');
const { STATUS_OPERADO } = require('./documento-status');
const {
  SQL_TIPODOC_CUENTAS_COBRAR_IN,
} = require('./cuentas-docs');
const {
  SQL_TIPODOC_CUENTAS_PAGAR_IN,
} = require('./cuentas-pagar-docs');
const { abonoSuperaSaldo, aplicarAbonoSobreSaldo, roundCentavos } = require('./cuentas-saldo-centavos');

const TIPODOC_ENTRADA = 'DPE';
const TIPODOC_SALIDA = 'DPS';
const CATEGORIA_OPTIONS = ['DEPOSITO', 'TRANSFERENCIA', 'CHEQUE'];
const CATEGORIA_DEFAULT = 'DEPOSITO';

/** Saldo pendiente a 2 decimales (milésimas se ignoran). */
const SQL_SALDO_PENDIENTE_POSITIVO = 'ROUND(ISNULL(d.DOC_SALDO, 0), 2) > 0';

function normalizeCategoria(raw) {
  const c = String(raw || '').trim().toUpperCase();
  if (CATEGORIA_OPTIONS.includes(c)) return c;
  return CATEGORIA_DEFAULT;
}

function tipodocForTipo(tipo) {
  return tipo === 'S' ? TIPODOC_SALIDA : TIPODOC_ENTRADA;
}

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseCorrelativo(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeTipo(raw) {
  const t = String(raw || '').trim().toUpperCase();
  if (t === 'E' || t === 'ENTRADA') return 'E';
  if (t === 'S' || t === 'SALIDA') return 'S';
  return null;
}

function signedImporte(tipo, absAmount) {
  const abs = Math.abs(roundMoney(absAmount));
  return tipo === 'S' ? -abs : abs;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function mapMovimientoRow(r) {
  return {
    ID: r.ID ?? null,
    EMPNIT: r.EMPNIT ?? null,
    ANIO: r.ANIO ?? null,
    MES: r.MES ?? null,
    DIA: r.DIA ?? null,
    FECHA: r.FECHA ?? null,
    CODDOC: r.CODDOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    TIPO: r.TIPO ?? null,
    CODCUENTA: r.CODCUENTA ?? null,
    NOCUENTA: r.NOCUENTA ?? null,
    DESBANCO: r.DESBANCO ?? null,
    NODOCUMENTO: r.NODOCUMENTO ?? null,
    ENCARGADO: r.ENCARGADO ?? null,
    DESCRIPCION: r.DESCRIPCION ?? null,
    OBS: r.OBS ?? null,
    CODEMBARQUE: r.CODEMBARQUE ?? null,
    IMPORTE: toNumber(r.IMPORTE),
    CATEGORIA: r.CATEGORIA ?? null,
    REF_CODDOC: r.REF_CODDOC ?? null,
    REF_CORRELATIVO: r.REF_CORRELATIVO ?? null,
    FECHA_DOCUMENTO: r.FECHA_DOCUMENTO ?? null,
    CODCAJA: r.CODCAJA ?? null,
    CORTE: r.CORTE ?? null,
    NOCORTE: r.NOCORTE ?? null,
  };
}

function mapAbonoRow(r) {
  return {
    ID: r.ID ?? null,
    FECHA: r.FECHA ?? null,
    CODDOC: r.CODDOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    ABONO: toNumber(r.ABONO),
    CODDOC_FAC: r.CODDOC_FAC ?? null,
    CORRELATIVO_FAC: r.CORRELATIVO_FAC ?? null,
    CODDOC_REC: r.CODDOC_REC ?? null,
    CORRELATIVO_REC: r.CORRELATIVO_REC ?? null,
    DOC_NOMCLIE: r.DOC_NOMCLIE ?? null,
    TOTALPRECIO: toNumber(r.TOTALPRECIO),
    DOC_SALDO: toNumber(r.DOC_SALDO),
  };
}

async function listTiposDocBanco(pool, sql, empnit, tipodoc) {
  const td = String(tipodoc || '').trim().toUpperCase();
  if (td !== TIPODOC_ENTRADA && td !== TIPODOC_SALIDA) {
    throw httpError('TIPODOC inválido (DPE o DPS)');
  }
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('TIPODOC', sql.VarChar, td)
    .query(`
      SELECT CODDOC, DESDOC, TIPODOC, ISNULL(CORRELATIVO, 0) AS CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND TIPODOC = @TIPODOC AND ACTIVO = 'SI'
      ORDER BY CODDOC
    `);
  return result.recordset.map((r) => ({
    CODDOC: r.CODDOC ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: r.TIPODOC ?? td,
    CORRELATIVO: Number(r.CORRELATIVO) || 0,
  }));
}

async function getTipoDocBancoByCoddoc(poolOrTx, sql, empnit, tipodoc, coddoc) {
  const td = String(tipodoc || '').trim().toUpperCase();
  const cod = String(coddoc || '').trim();
  if (!cod) return null;
  const result = await poolOrTx
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, cod)
    .input('TIPODOC', sql.VarChar, td)
    .query(`
      SELECT CODDOC, DESDOC, TIPODOC, ISNULL(CORRELATIVO, 0) AS CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND TIPODOC = @TIPODOC AND ACTIVO = 'SI'
    `);
  const row = result.recordset[0];
  if (!row) return null;
  return {
    CODDOC: row.CODDOC ?? null,
    DESDOC: row.DESDOC ?? null,
    TIPODOC: row.TIPODOC ?? td,
    CORRELATIVO: Number(row.CORRELATIVO) || 0,
  };
}

async function previewSiguienteBanco(pool, sql, empnit, tipodoc, coddoc) {
  const tipos = await listTiposDocBanco(pool, sql, empnit, tipodoc);
  if (!tipos.length) {
    throw httpError(`No hay documentos ${tipodoc} activos en TIPODOCUMENTOS`, 400);
  }
  const cod = String(coddoc || '').trim() || tipos[0].CODDOC;
  const tipoRow = tipos.find((t) => String(t.CODDOC) === String(cod));
  if (!tipoRow) {
    throw httpError(`La serie ${cod} no es un ${tipodoc} activo`);
  }
  const maxRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, tipoRow.CODDOC)
    .query(`
      SELECT ISNULL(MAX(CORRELATIVO), 0) AS maxCorr
      FROM dbo.DOCUMENTOS_BANCO
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC
    `);
  const tipoCorr = Number(tipoRow.CORRELATIVO) || 0;
  const maxCorr = Number(maxRes.recordset[0]?.maxCorr) || 0;
  return {
    CODDOC: tipoRow.CODDOC,
    DESDOC: tipoRow.DESDOC,
    TIPODOC: tipoRow.TIPODOC,
    CORRELATIVO: Math.max(tipoCorr, maxCorr) + 1,
  };
}

/** Correlativo siguiente para DOCUMENTOS_BANCO y actualiza TIPODOCUMENTOS. */
async function allocateCorrelativoBanco(transaction, sql, empnit, coddoc) {
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
      SELECT ISNULL(MAX(CORRELATIVO), 0) AS maxCorr
      FROM dbo.DOCUMENTOS_BANCO WITH (UPDLOCK, HOLDLOCK)
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

async function allocateTipodocCorrelativo(transaction, sql, empnit, coddoc) {
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
      SELECT ISNULL(MAX(CORRELATIVO), 0) AS maxCorr
      FROM dbo.DOCUMENTOS WITH (UPDLOCK, HOLDLOCK)
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

async function listMovimientosBanco(pool, sql, empnit, { q = '', limit = 200, codcuenta = null, mes = null, anio = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const qLike = q ? `%${q}%` : null;
  const codcuentaNum = parseInt(codcuenta, 10);
  const mesNum = parseInt(mes, 10);
  const anioNum = parseInt(anio, 10);
  const request = pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('TOPN', sql.Int, lim);
  let whereExtra = '';
  if (qLike) {
    request.input('Q', sql.VarChar, qLike);
    whereExtra += ` AND (
      ISNULL(d.NODOCUMENTO, '') LIKE @Q
      OR ISNULL(d.ENCARGADO, '') LIKE @Q
      OR ISNULL(d.DESCRIPCION, '') LIKE @Q
      OR ISNULL(d.OBS, '') LIKE @Q
      OR ISNULL(d.CATEGORIA, '') LIKE @Q
      OR ISNULL(d.CODDOC, '') LIKE @Q
      OR ISNULL(c.NOCUENTA, '') LIKE @Q
      OR ISNULL(b.DESBANCO, '') LIKE @Q
      OR CAST(d.CORRELATIVO AS VARCHAR(30)) LIKE @Q
    )`;
  }
  if (Number.isFinite(codcuentaNum) && codcuentaNum > 0) {
    request.input('CODCUENTA', sql.Int, codcuentaNum);
    whereExtra += ' AND d.CODCUENTA = @CODCUENTA';
  }
  if (Number.isFinite(mesNum) && mesNum >= 1 && mesNum <= 12) {
    request.input('MES', sql.Int, mesNum);
    whereExtra += ' AND d.MES = @MES';
  }
  if (Number.isFinite(anioNum) && anioNum >= 2000 && anioNum <= 2100) {
    request.input('ANIO', sql.Int, anioNum);
    whereExtra += ' AND d.ANIO = @ANIO';
  }
  const result = await request.query(`
    SELECT TOP (@TOPN)
      d.ID, d.EMPNIT, d.ANIO, d.MES, d.DIA, d.FECHA, d.CODDOC, d.CORRELATIVO,
      d.TIPO, d.CODCUENTA, d.NODOCUMENTO, d.ENCARGADO, d.DESCRIPCION, d.OBS,
      d.CODEMBARQUE, d.IMPORTE, d.CATEGORIA, d.REF_CODDOC, d.REF_CORRELATIVO, d.FECHA_DOCUMENTO,
      c.NOCUENTA, b.DESBANCO
    FROM dbo.DOCUMENTOS_BANCO d
    LEFT JOIN dbo.CUENTAS c ON c.EMPNIT = d.EMPNIT AND c.CODCUENTA = d.CODCUENTA
    LEFT JOIN dbo.BANCOS b ON b.CODBANCO = c.CODBANCO
    WHERE d.EMPNIT = @EMPNIT
    ${whereExtra}
    ORDER BY d.FECHA DESC, d.ID DESC
  `);
  const countReq = pool.request().input('EMPNIT', sql.VarChar, empnit);
  let countWhere = 'WHERE EMPNIT = @EMPNIT';
  if (Number.isFinite(codcuentaNum) && codcuentaNum > 0) {
    countReq.input('CODCUENTA', sql.Int, codcuentaNum);
    countWhere += ' AND CODCUENTA = @CODCUENTA';
  }
  if (Number.isFinite(mesNum) && mesNum >= 1 && mesNum <= 12) {
    countReq.input('MES', sql.Int, mesNum);
    countWhere += ' AND MES = @MES';
  }
  if (Number.isFinite(anioNum) && anioNum >= 2000 && anioNum <= 2100) {
    countReq.input('ANIO', sql.Int, anioNum);
    countWhere += ' AND ANIO = @ANIO';
  }
  const countRes = await countReq.query(`SELECT COUNT(1) AS total FROM dbo.DOCUMENTOS_BANCO ${countWhere}`);
  const rows = result.recordset.map(mapMovimientoRow);
  return {
    rows,
    total: Number(countRes.recordset[0]?.total) || rows.length,
    truncated: rows.length >= lim,
    sumEntradas: roundMoney(rows.filter((r) => r.TIPO === 'E').reduce((s, r) => s + Math.abs(r.IMPORTE), 0)),
    sumSalidas: roundMoney(rows.filter((r) => r.TIPO === 'S').reduce((s, r) => s + Math.abs(r.IMPORTE), 0)),
  };
}

async function getMovimientoBanco(pool, sql, empnit, id) {
  const idNum = parseInt(id, 10);
  if (Number.isNaN(idNum) || idNum <= 0) throw httpError('ID inválido');
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ID', sql.Int, idNum)
    .query(`
      SELECT
        d.ID, d.EMPNIT, d.ANIO, d.MES, d.DIA, d.FECHA, d.CODDOC, d.CORRELATIVO,
        d.TIPO, d.CODCUENTA, d.NODOCUMENTO, d.ENCARGADO, d.DESCRIPCION, d.OBS,
        d.CODEMBARQUE, d.IMPORTE, d.CATEGORIA, d.REF_CODDOC, d.REF_CORRELATIVO, d.FECHA_DOCUMENTO,
        c.NOCUENTA, b.DESBANCO
      FROM dbo.DOCUMENTOS_BANCO d
      LEFT JOIN dbo.CUENTAS c ON c.EMPNIT = d.EMPNIT AND c.CODCUENTA = d.CODCUENTA
      LEFT JOIN dbo.BANCOS b ON b.CODBANCO = c.CODBANCO
      WHERE d.EMPNIT = @EMPNIT AND d.ID = @ID
    `);
  const row = result.recordset[0];
  if (!row) throw httpError('Movimiento no encontrado', 404);
  const movimiento = mapMovimientoRow(row);
  const abonosRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, movimiento.CODDOC)
    .input('CORRELATIVO', sql.Decimal(18, 0), movimiento.CORRELATIVO)
    .query(`
      SELECT
        a.ID, a.FECHA, a.CODDOC, a.CORRELATIVO, a.ABONO,
        a.CODDOC_FAC, a.CORRELATIVO_FAC, a.CODDOC_REC, a.CORRELATIVO_REC,
        f.DOC_NOMCLIE, ISNULL(f.TOTALPRECIO, 0) AS TOTALPRECIO, ISNULL(f.DOC_SALDO, 0) AS DOC_SALDO
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      LEFT JOIN dbo.DOCUMENTOS f
        ON f.EMPNIT = a.EMPNIT AND f.CODDOC = a.CODDOC_FAC AND f.CORRELATIVO = a.CORRELATIVO_FAC
      WHERE a.EMPNIT = @EMPNIT AND a.CODDOC = @CODDOC AND a.CORRELATIVO = @CORRELATIVO
      ORDER BY a.ID
    `);
  return {
    movimiento,
    abonos: abonosRes.recordset.map(mapAbonoRow),
  };
}

async function listDocumentosPendientes(pool, sql, empnit, { tipo, q = '', limit = 100 } = {}) {
  const t = normalizeTipo(tipo);
  if (!t) throw httpError('Tipo requerido (E o S)');
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const qLike = q ? `%${q}%` : null;
  const tipodocIn = t === 'E' ? SQL_TIPODOC_CUENTAS_COBRAR_IN : SQL_TIPODOC_CUENTAS_PAGAR_IN;
  const saldoPos = SQL_SALDO_PENDIENTE_POSITIVO;
  const request = pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('TOPN', sql.Int, lim);
  let whereQ = '';
  if (qLike) {
    request.input('Q', sql.VarChar, qLike);
    whereQ = ` AND (
      ISNULL(d.DOC_NOMCLIE, '') LIKE @Q
      OR ISNULL(d.DOC_NIT, '') LIKE @Q
      OR ISNULL(d.CODDOC, '') LIKE @Q
      OR ISNULL(c.NEGOCIO, '') LIKE @Q
      OR CAST(d.CORRELATIVO AS VARCHAR(30)) LIKE @Q
      OR ISNULL(d.FEL_SERIE, '') LIKE @Q
      OR ISNULL(d.FEL_NUMERO, '') LIKE @Q
      OR (ISNULL(d.FEL_SERIE, '') + '-' + ISNULL(d.FEL_NUMERO, '')) LIKE @Q
      OR ISNULL(d.SERIEFAC, '') LIKE @Q
      OR ISNULL(d.NOFAC, '') LIKE @Q
      OR (ISNULL(d.SERIEFAC, '') + '-' + ISNULL(d.NOFAC, '')) LIKE @Q
    )`;
  }
  const result = await request.query(`
    SELECT TOP (@TOPN)
      d.FECHA, d.VENCIMIENTO, d.CODDOC, d.CORRELATIVO, t.TIPODOC, t.DESDOC,
      d.CODCLIENTE, d.DOC_NOMCLIE, d.DOC_NIT,
      ISNULL(c.NEGOCIO, '') AS NEGOCIO,
      ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
      ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
      ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
      ISNULL(d.FEL_SERIE, '') AS FEL_SERIE,
      ISNULL(d.FEL_NUMERO, '') AS FEL_NUMERO,
      ISNULL(d.SERIEFAC, '') AS SERIEFAC,
      ISNULL(d.NOFAC, '') AS NOFAC
    FROM dbo.DOCUMENTOS d
    INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
    LEFT JOIN dbo.CLIENTES c ON c.EMPNIT = d.EMPNIT AND c.CODCLIENTE = d.CODCLIENTE
    WHERE d.EMPNIT = @EMPNIT
      AND t.TIPODOC IN (${tipodocIn})
      AND d.STATUS = '${STATUS_OPERADO}'
      AND ISNULL(d.CONCRE, 'CON') = 'CRE'
      AND ${saldoPos}
      ${whereQ}
    ORDER BY d.FECHA DESC, d.CORRELATIVO DESC
  `);
  return {
    tipo: t,
    rows: result.recordset.map((r) => {
      const tipodoc = String(r.TIPODOC || '').trim().toUpperCase();
      const felSerie = String(r.FEL_SERIE || '').trim() || null;
      const felNumero = String(r.FEL_NUMERO || '').trim() || null;
      const serieFac = String(r.SERIEFAC || '').trim() || null;
      const noFac = String(r.NOFAC || '').trim() || null;
      const esCompra = tipodoc === 'COM' || tipodoc === 'COP';
      return {
        FECHA: r.FECHA ?? null,
        VENCIMIENTO: r.VENCIMIENTO ?? null,
        CODDOC: r.CODDOC ?? null,
        CORRELATIVO: r.CORRELATIVO ?? null,
        TIPODOC: r.TIPODOC ?? null,
        DESDOC: r.DESDOC ?? null,
        CODCLIENTE: r.CODCLIENTE ?? null,
        DOC_NOMCLIE: r.DOC_NOMCLIE ?? null,
        DOC_NIT: r.DOC_NIT ?? null,
        NEGOCIO: r.NEGOCIO || null,
        TOTALPRECIO: toNumber(r.TOTALPRECIO),
        DOC_SALDO: toNumber(r.DOC_SALDO),
        DOC_ABONO: toNumber(r.DOC_ABONO),
        FEL_SERIE: felSerie,
        FEL_NUMERO: felNumero,
        SERIEFAC: serieFac,
        NOFAC: noFac,
        // COM/COP: SAT = factura del proveedor (SERIEFAC/NOFAC). Resto: FEL.
        SAT_SERIE: esCompra ? serieFac : felSerie,
        SAT_NUMERO: esCompra ? noFac : felNumero,
      };
    }),
  };
}

async function loadFacCreTx(transaction, sql, empnit, coddoc, correlativo, tipodocIn) {
  const result = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT
        d.CODCLIENTE, d.DOC_NIT, d.DOC_NOMCLIE, d.DOC_DIRCLIE, d.CODVEN,
        ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
        ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
        ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
        d.STATUS, ISNULL(d.CONCRE, 'CON') AS CONCRE, t.TIPODOC
      FROM dbo.DOCUMENTOS d WITH (UPDLOCK, ROWLOCK)
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
        AND t.TIPODOC IN (${tipodocIn})
        AND d.STATUS = '${STATUS_OPERADO}'
        AND ISNULL(d.CONCRE, 'CON') = 'CRE'
    `);
  return result.recordset[0] || null;
}

async function insertReciboYActualizar(
  transaction,
  sql,
  {
    empnit,
    tipoRecibo,
    tipodocIn,
    facCoddoc,
    facCorrelativo,
    abono,
    usuario,
    obs,
    parts,
    nodocumento,
  }
) {
  const tipodocCode = tipoRecibo === 'RCC' ? 'RCC' : 'RCP';
  const tipoRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('TIPODOC', sql.VarChar, tipodocCode)
    .query(`
      SELECT TOP 1 CODDOC, DESDOC, TIPODOC, ISNULL(CORRELATIVO, 0) AS CORRELATIVO
      FROM dbo.TIPODOCUMENTOS WITH (UPDLOCK, ROWLOCK)
      WHERE EMPNIT = @EMPNIT AND TIPODOC = @TIPODOC AND ACTIVO = 'SI'
      ORDER BY CODDOC
    `);
  const tipoRow = tipoRes.recordset[0];
  if (!tipoRow) {
    throw httpError(`No hay tipo de documento ${tipodocCode} activo para la empresa`);
  }

  const fac = await loadFacCreTx(transaction, sql, empnit, facCoddoc, facCorrelativo, tipodocIn);
  if (!fac) {
    throw httpError(
      `Documento ${facCoddoc} #${facCorrelativo} no encontrado o sin saldo al crédito`,
      404
    );
  }
  const docSaldo = toNumber(fac.DOC_SALDO);
  if (abonoSuperaSaldo(abono, docSaldo)) {
    throw httpError(
      `El abono de ${facCoddoc} #${facCorrelativo} (${abono}) supera el saldo (${docSaldo})`
    );
  }

  const coddocRec = tipoRow.CODDOC;
  const correlativoRec = await allocateTipodocCorrelativo(transaction, sql, empnit, coddocRec);
  const obsRec =
    obs ||
    `Abono bancario a ${facCoddoc}-${facCorrelativo}` +
      (nodocumento ? ` (doc. banco ${nodocumento})` : '');

  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ANIO', sql.Int, parts.anio)
    .input('MES', sql.Int, parts.mes)
    .input('DIA', sql.Int, parts.dia)
    .input('FECHA', sql.Date, parts.fecha)
    .input('HORA', sql.Int, parts.hora ?? 0)
    .input('MINUTO', sql.Int, parts.minuto ?? 0)
    .input('CODDOC', sql.VarChar, coddocRec)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativoRec)
    .input('CODCLIENTE', sql.Int, fac.CODCLIENTE)
    .input('DOC_NIT', sql.VarChar, String(fac.DOC_NIT || 'CF'))
    .input('DOC_NOMCLIE', sql.VarChar, String(fac.DOC_NOMCLIE || ''))
    .input('DOC_DIRCLIE', sql.VarChar, String(fac.DOC_DIRCLIE || 'SN'))
    .input('CODVEN', sql.Int, fac.CODVEN != null ? Number(fac.CODVEN) : null)
    .input('TOTALPRECIO', sql.Decimal(18, 3), abono)
    .input('USUARIO', sql.VarChar, usuario)
    .input('OBS', sql.VarChar, obsRec)
    .input('SERIEFAC', sql.VarChar, facCoddoc)
    .input('NOFAC', sql.VarChar, String(facCorrelativo))
    .input('FPAGO_DEPOSITO', sql.Decimal(18, 3), abono)
    .input('FPAGO_DESCRIPCION', sql.VarChar, nodocumento || '')
    .query(`
      INSERT INTO dbo.DOCUMENTOS (
        EMPNIT, ANIO, MES, DIA, FECHA, HORA, MINUTO, CODDOC, CORRELATIVO,
        CODCLIENTE, DOC_NIT, DOC_NOMCLIE, DOC_DIRCLIE, CODVEN,
        TOTALCOSTO, TOTALPRECIO, CODEMBARQUE, STATUS, USUARIO, CONCRE, CORTE,
        MARCA, OBS, DOC_SALDO, DOC_ABONO, OBSMARCA, TOTALDESCUENTO,
        DIRENTREGA, NOGUIA, VALORENTREGA, TOTALEXENTO, TIPOPAGO, NODOCPAGO,
        VENCIMIENTO, DIASCREDITO, TOTALIVA, TOTALSINIVA, PAGO, VUELTO,
        SERIEFAC, NOFAC,
        FPAGO_EFECTIVO, FPAGO_TARJETA, FPAGO_DEPOSITO, FPAGO_CHEQUE, FPAGO_DESCRIPCION
      ) VALUES (
        @EMPNIT, @ANIO, @MES, @DIA, @FECHA, @HORA, @MINUTO, @CODDOC, @CORRELATIVO,
        @CODCLIENTE, @DOC_NIT, @DOC_NOMCLIE, @DOC_DIRCLIE, @CODVEN,
        0, @TOTALPRECIO, 'MOSTRADOR', '${STATUS_OPERADO}', @USUARIO, 'CON', 'NO',
        'SN', @OBS, 0, 0, 'SN', 0,
        'SN', 'SN', 0, 0, 'CONTADO', 'SN',
        @FECHA, 0, 0, 0, @TOTALPRECIO, 0,
        @SERIEFAC, @NOFAC,
        0, 0, @FPAGO_DEPOSITO, 0, @FPAGO_DESCRIPCION
      )
    `);

  const aplicado = aplicarAbonoSobreSaldo(toNumber(fac.DOC_ABONO), docSaldo, abono);
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, facCoddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), facCorrelativo)
    .input('DOC_ABONO', sql.Decimal(18, 3), aplicado.DOC_ABONO)
    .input('DOC_SALDO', sql.Decimal(18, 3), aplicado.DOC_SALDO)
    .query(`
      UPDATE dbo.DOCUMENTOS
      SET DOC_ABONO = @DOC_ABONO, DOC_SALDO = @DOC_SALDO
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);

  return { CODDOC: coddocRec, CORRELATIVO: correlativoRec, TIPODOC: tipodocCode };
}

async function crearMovimientoBanco(pool, sql, empnit, body = {}) {
  const tipo = normalizeTipo(body.TIPO);
  if (!tipo) throw httpError('Tipo inválido (E=Entrada, S=Salida)');

  const codcuenta = parseInt(body.CODCUENTA, 10);
  if (Number.isNaN(codcuenta) || codcuenta <= 0) throw httpError('Cuenta bancaria requerida');

  const cuentaRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCUENTA', sql.Int, codcuenta)
    .query(`
      SELECT CODCUENTA FROM dbo.CUENTAS
      WHERE EMPNIT = @EMPNIT AND CODCUENTA = @CODCUENTA
    `);
  if (!cuentaRes.recordset.length) throw httpError('Cuenta bancaria no encontrada', 404);

  const fechaParts = parseFechaInput(body.FECHA) || nowParts();
  const clock = nowParts();
  const parts = { ...fechaParts, hora: clock.hora, minuto: clock.minuto };

  const abonosRaw = Array.isArray(body.abonos) ? body.abonos : [];
  const abonos = abonosRaw
    .map((a) => ({
      CODDOC_FAC: String(a.CODDOC_FAC || a.CODDOC || '').trim(),
      CORRELATIVO_FAC: parseCorrelativo(a.CORRELATIVO_FAC ?? a.CORRELATIVO),
      ABONO: roundMoney(a.ABONO ?? a.MONTO ?? a.importe),
    }))
    .filter((a) => a.CODDOC_FAC && a.CORRELATIVO_FAC != null && a.ABONO > 0);

  let importeAbs = roundMoney(body.IMPORTE);
  if (abonos.length) {
    importeAbs = roundMoney(abonos.reduce((s, a) => s + a.ABONO, 0));
  }
  if (importeAbs <= 0) throw httpError('El importe debe ser mayor a cero');

  const tipodocEsperado = tipodocForTipo(tipo);
  let coddocReq = String(body.CODDOC || '').trim();
  if (!coddocReq && body.autoCoddoc) {
    const tipos = await listTiposDocBanco(pool, sql, empnit, tipodocEsperado);
    if (!tipos.length) {
      throw httpError(`No hay documentos ${tipodocEsperado} activos en TIPODOCUMENTOS`);
    }
    coddocReq = tipos[0].CODDOC;
  }
  if (!coddocReq) {
    throw httpError(`Seleccione la serie (${tipodocEsperado}) del documento bancario`);
  }
  const tipoDocRow = await getTipoDocBancoByCoddoc(pool, sql, empnit, tipodocEsperado, coddocReq);
  if (!tipoDocRow) {
    throw httpError(
      `La serie ${coddocReq} no es un documento ${tipodocEsperado} activo en TIPODOCUMENTOS`
    );
  }
  const coddoc = tipoDocRow.CODDOC;
  const nodocumento = String(body.NODOCUMENTO || '').trim();
  const encargado = String(body.ENCARGADO || '').trim();
  const descripcion = String(body.DESCRIPCION || '').trim();
  const obs = String(body.OBS || '').trim();
  const codembarque = String(body.CODEMBARQUE || '').trim() || null;
  const categoria = normalizeCategoria(body.CATEGORIA);
  const usuario = String(body.USUARIO || body.usuario || 'BANCOS').trim();
  const importe = signedImporte(tipo, importeAbs);
  const fechaDocParts = parseFechaInput(body.FECHA_DOCUMENTO);
  const fechaDocumento = fechaDocParts ? fechaDocParts.fecha : null;
  const codcajaRaw = body.CODCAJA != null && body.CODCAJA !== '' ? parseInt(body.CODCAJA, 10) : null;
  const codcaja = Number.isFinite(codcajaRaw) && codcajaRaw > 0 ? codcajaRaw : null;
  const corte = String(body.CORTE || (codcaja ? 'NO' : '') || '').trim().toUpperCase() === 'SI' ? 'SI' : (codcaja ? 'NO' : null);
  const nocorteRaw = body.NOCORTE != null && body.NOCORTE !== '' ? parseInt(body.NOCORTE, 10) : null;
  const nocorte = Number.isFinite(nocorteRaw) ? nocorteRaw : null;

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const correlativo = await allocateCorrelativoBanco(transaction, sql, empnit, coddoc);

    const ins = await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ANIO', sql.SmallInt, parts.anio)
      .input('MES', sql.SmallInt, parts.mes)
      .input('DIA', sql.SmallInt, parts.dia)
      .input('FECHA', sql.Date, parts.fecha)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .input('TIPO', sql.VarChar, tipo)
      .input('CODCUENTA', sql.Int, codcuenta)
      .input('NODOCUMENTO', sql.VarChar, nodocumento || null)
      .input('ENCARGADO', sql.VarChar, encargado || null)
      .input('DESCRIPCION', sql.VarChar, descripcion || null)
      .input('OBS', sql.VarChar, obs || null)
      .input('CODEMBARQUE', sql.VarChar, codembarque)
      .input('IMPORTE', sql.Float, importe)
      .input('CATEGORIA', sql.VarChar, categoria)
      .input('FECHA_DOCUMENTO', sql.Date, fechaDocumento)
      .input('CODCAJA', sql.Int, codcaja)
      .input('CORTE', sql.VarChar, corte)
      .input('NOCORTE', sql.Int, nocorte)
      .query(`
        INSERT INTO dbo.DOCUMENTOS_BANCO (
          EMPNIT, ANIO, MES, DIA, FECHA, CODDOC, CORRELATIVO, TIPO, CODCUENTA,
          NODOCUMENTO, ENCARGADO, DESCRIPCION, OBS, CODEMBARQUE, IMPORTE, CATEGORIA,
          FECHA_DOCUMENTO, CODCAJA, CORTE, NOCORTE
        )
        OUTPUT INSERTED.ID
        VALUES (
          @EMPNIT, @ANIO, @MES, @DIA, @FECHA, @CODDOC, @CORRELATIVO, @TIPO, @CODCUENTA,
          @NODOCUMENTO, @ENCARGADO, @DESCRIPCION, @OBS, @CODEMBARQUE, @IMPORTE, @CATEGORIA,
          @FECHA_DOCUMENTO, @CODCAJA, @CORTE, @NOCORTE
        )
      `);
    const id = ins.recordset[0]?.ID;

    const tipodocIn = tipo === 'E' ? SQL_TIPODOC_CUENTAS_COBRAR_IN : SQL_TIPODOC_CUENTAS_PAGAR_IN;
    const tipoRecibo = tipo === 'E' ? 'RCC' : 'RCP';
    const fechaAbonoStr = parts.fecha; // YYYY-MM-DD for nchar(10)
    const abonosCreados = [];

    for (const line of abonos) {
      const recibo = await insertReciboYActualizar(transaction, sql, {
        empnit,
        tipoRecibo,
        tipodocIn,
        facCoddoc: line.CODDOC_FAC,
        facCorrelativo: line.CORRELATIVO_FAC,
        abono: line.ABONO,
        usuario,
        obs,
        parts,
        nodocumento,
      });

      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('FECHA', sql.NChar(10), fechaAbonoStr)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .input('ABONO', sql.Decimal(18, 4), line.ABONO)
        .input('CODDOC_FAC', sql.VarChar, line.CODDOC_FAC)
        .input('CORRELATIVO_FAC', sql.Decimal(18, 0), line.CORRELATIVO_FAC)
        .input('CODDOC_REC', sql.VarChar, recibo.CODDOC)
        .input('CORRELATIVO_REC', sql.Decimal(18, 0), recibo.CORRELATIVO)
        .query(`
          INSERT INTO dbo.DOCUMENTOS_FACTURAS_ABONADAS (
            EMPNIT, FECHA, CODDOC, CORRELATIVO, ABONO,
            CODDOC_FAC, CORRELATIVO_FAC, CODDOC_REC, CORRELATIVO_REC
          ) VALUES (
            @EMPNIT, @FECHA, @CODDOC, @CORRELATIVO, @ABONO,
            @CODDOC_FAC, @CORRELATIVO_FAC, @CODDOC_REC, @CORRELATIVO_REC
          )
        `);

      abonosCreados.push({
        CODDOC_FAC: line.CODDOC_FAC,
        CORRELATIVO_FAC: line.CORRELATIVO_FAC,
        ABONO: line.ABONO,
        CODDOC_REC: recibo.CODDOC,
        CORRELATIVO_REC: recibo.CORRELATIVO,
      });
    }

    await transaction.commit();
    return {
      ok: true,
      movimiento: {
        ID: id,
        CODDOC: coddoc,
        CORRELATIVO: correlativo,
        TIPO: tipo,
        IMPORTE: importe,
        CATEGORIA: categoria,
      },
      abonos: abonosCreados,
    };
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function actualizarMovimientoBanco(pool, sql, empnit, id, body = {}) {
  const idNum = parseInt(id, 10);
  if (Number.isNaN(idNum) || idNum <= 0) throw httpError('ID inválido');

  const detalle = await getMovimientoBanco(pool, sql, empnit, idNum);
  if (detalle.abonos.length && (body.IMPORTE != null || body.TIPO != null || body.abonos)) {
    throw httpError(
      'No se puede cambiar importe/tipo/abonos de un movimiento con facturas vinculadas. Elimínelo y cree uno nuevo.'
    );
  }

  const fechaParts = parseFechaInput(body.FECHA);
  const nodocumento =
    body.NODOCUMENTO !== undefined ? String(body.NODOCUMENTO || '').trim() : detalle.movimiento.NODOCUMENTO;
  const encargado =
    body.ENCARGADO !== undefined ? String(body.ENCARGADO || '').trim() : detalle.movimiento.ENCARGADO;
  const descripcion =
    body.DESCRIPCION !== undefined ? String(body.DESCRIPCION || '').trim() : detalle.movimiento.DESCRIPCION;
  const obs = body.OBS !== undefined ? String(body.OBS || '').trim() : detalle.movimiento.OBS;
  const categoria =
    body.CATEGORIA !== undefined
      ? normalizeCategoria(body.CATEGORIA)
      : detalle.movimiento.CATEGORIA;
  const codembarque =
    body.CODEMBARQUE !== undefined
      ? String(body.CODEMBARQUE || '').trim() || null
      : detalle.movimiento.CODEMBARQUE;
  let codcuenta = detalle.movimiento.CODCUENTA;
  if (body.CODCUENTA != null && body.CODCUENTA !== '') {
    codcuenta = parseInt(body.CODCUENTA, 10);
    if (Number.isNaN(codcuenta) || codcuenta <= 0) throw httpError('Cuenta bancaria inválida');
  }

  let importe = detalle.movimiento.IMPORTE;
  if (body.IMPORTE != null && body.IMPORTE !== '' && !detalle.abonos.length) {
    const tipo = detalle.movimiento.TIPO;
    importe = signedImporte(tipo, body.IMPORTE);
  }

  const anio = fechaParts ? fechaParts.anio : detalle.movimiento.ANIO;
  const mes = fechaParts ? fechaParts.mes : detalle.movimiento.MES;
  const dia = fechaParts ? fechaParts.dia : detalle.movimiento.DIA;
  const fecha = fechaParts ? fechaParts.fecha : detalle.movimiento.FECHA;

  await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ID', sql.Int, idNum)
    .input('ANIO', sql.SmallInt, anio)
    .input('MES', sql.SmallInt, mes)
    .input('DIA', sql.SmallInt, dia)
    .input('FECHA', sql.Date, fecha)
    .input('CODCUENTA', sql.Int, codcuenta)
    .input('NODOCUMENTO', sql.VarChar, nodocumento || null)
    .input('ENCARGADO', sql.VarChar, encargado || null)
    .input('DESCRIPCION', sql.VarChar, descripcion || null)
    .input('OBS', sql.VarChar, obs || null)
    .input('CODEMBARQUE', sql.VarChar, codembarque)
    .input('IMPORTE', sql.Float, importe)
    .input('CATEGORIA', sql.VarChar, categoria || null)
    .query(`
      UPDATE dbo.DOCUMENTOS_BANCO
      SET ANIO = @ANIO, MES = @MES, DIA = @DIA, FECHA = @FECHA,
          CODCUENTA = @CODCUENTA, NODOCUMENTO = @NODOCUMENTO, ENCARGADO = @ENCARGADO,
          DESCRIPCION = @DESCRIPCION, OBS = @OBS, CODEMBARQUE = @CODEMBARQUE,
          IMPORTE = @IMPORTE, CATEGORIA = @CATEGORIA
      WHERE EMPNIT = @EMPNIT AND ID = @ID
    `);

  return getMovimientoBanco(pool, sql, empnit, idNum);
}

async function eliminarMovimientoBanco(pool, sql, empnit, id, { pass } = {}) {
  const { assertAdminPass, assertEliminacionRegistro } = require('./config-auth');
  await assertEliminacionRegistro(pool, String(pass ?? ''));

  const detalle = await getMovimientoBanco(pool, sql, empnit, id);
  const movimiento = detalle.movimiento;
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    for (const ab of detalle.abonos) {
      const monto = toNumber(ab.ABONO);
      if (ab.CODDOC_FAC && ab.CORRELATIVO_FAC != null) {
        const facRes = await transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, ab.CODDOC_FAC)
          .input('CORRELATIVO', sql.Decimal(18, 0), ab.CORRELATIVO_FAC)
          .query(`
            SELECT ISNULL(DOC_SALDO, 0) AS DOC_SALDO, ISNULL(DOC_ABONO, 0) AS DOC_ABONO
            FROM dbo.DOCUMENTOS WITH (UPDLOCK, ROWLOCK)
            WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          `);
        const fac = facRes.recordset[0];
        if (fac) {
          await transaction
            .request()
            .input('EMPNIT', sql.VarChar, empnit)
            .input('CODDOC', sql.VarChar, ab.CODDOC_FAC)
            .input('CORRELATIVO', sql.Decimal(18, 0), ab.CORRELATIVO_FAC)
            .input('DOC_ABONO', sql.Decimal(18, 3), Math.max(0, roundCentavos(toNumber(fac.DOC_ABONO) - monto)))
            .input('DOC_SALDO', sql.Decimal(18, 3), roundCentavos(toNumber(fac.DOC_SALDO) + monto))
            .query(`
              UPDATE dbo.DOCUMENTOS
              SET DOC_ABONO = @DOC_ABONO, DOC_SALDO = @DOC_SALDO
              WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
            `);
        }
      }
      if (ab.CODDOC_REC && ab.CORRELATIVO_REC != null) {
        await transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, ab.CODDOC_REC)
          .input('CORRELATIVO', sql.Decimal(18, 0), ab.CORRELATIVO_REC)
          .query(`
            DELETE FROM dbo.DOCUMENTOS
            WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          `);
      }
    }

    // Eliminar todos los abonos vinculados al documento bancario
    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, movimiento.CODDOC)
      .input('CORRELATIVO', sql.Decimal(18, 0), movimiento.CORRELATIVO)
      .query(`
        DELETE FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);

    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ID', sql.Int, movimiento.ID)
      .query(`DELETE FROM dbo.DOCUMENTOS_BANCO WHERE EMPNIT = @EMPNIT AND ID = @ID`);

    await transaction.commit();
    return { ok: true, id: movimiento.ID };
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Retiros de efectivo a banco pendientes de corte (salen del efectivo esperado).
 * DOCUMENTOS_BANCO con CODCAJA de la sesión, CORTE=NO, entrada DEPOSITO.
 */
async function sumRetirosEfectivoSesionCaja(requestable, empnit, codcaja, apertura) {
  const result = await requestable
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCAJA', sql.Int, codcaja)
    .input('APERTURA', sql.DateTime, apertura)
    .query(`
      SELECT ISNULL(SUM(ABS(IMPORTE)), 0) AS TOTAL,
             COUNT(1) AS CANTIDAD
      FROM dbo.DOCUMENTOS_BANCO
      WHERE EMPNIT = @EMPNIT
        AND CODCAJA = @CODCAJA
        AND ISNULL(CORTE, 'NO') = 'NO'
        AND TIPO = 'E'
        AND UPPER(LTRIM(RTRIM(ISNULL(CATEGORIA, '')))) = 'DEPOSITO'
        AND FECHA >= CAST(@APERTURA AS DATE)
    `);
  const row = result.recordset[0] || {};
  return {
    totalRetiros: roundMoney(row.TOTAL),
    cantidadRetiros: Number(row.CANTIDAD) || 0,
  };
}

async function listRetirosEfectivoSesionCaja(requestable, empnit, codcaja, apertura) {
  const result = await requestable
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCAJA', sql.Int, codcaja)
    .input('APERTURA', sql.DateTime, apertura)
    .query(`
      SELECT b.ID, b.FECHA, b.CODDOC, b.CORRELATIVO, b.CODCUENTA, b.NODOCUMENTO,
             b.DESCRIPCION, b.IMPORTE, b.CATEGORIA, b.CODCAJA,
             c.NOCUENTA, bn.DESBANCO
      FROM dbo.DOCUMENTOS_BANCO b
      LEFT JOIN dbo.CUENTAS c ON c.EMPNIT = b.EMPNIT AND c.CODCUENTA = b.CODCUENTA
      LEFT JOIN dbo.BANCOS bn ON bn.CODBANCO = c.CODBANCO
      WHERE b.EMPNIT = @EMPNIT
        AND b.CODCAJA = @CODCAJA
        AND ISNULL(b.CORTE, 'NO') = 'NO'
        AND b.TIPO = 'E'
        AND UPPER(LTRIM(RTRIM(ISNULL(b.CATEGORIA, '')))) = 'DEPOSITO'
        AND b.FECHA >= CAST(@APERTURA AS DATE)
      ORDER BY b.ID DESC
    `);
  return result.recordset.map((r) => ({
    ...mapMovimientoRow(r),
    NOCUENTA: r.NOCUENTA ?? null,
    DESBANCO: r.DESBANCO ?? null,
  }));
}

async function marcarRetirosEfectivoCorte(transaction, empnit, codcaja, nocorte, apertura) {
  const result = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCAJA', sql.Int, codcaja)
    .input('NOCORTE', sql.Int, nocorte)
    .input('APERTURA', sql.DateTime, apertura)
    .query(`
      UPDATE dbo.DOCUMENTOS_BANCO
      SET CORTE = 'SI', NOCORTE = @NOCORTE
      WHERE EMPNIT = @EMPNIT
        AND CODCAJA = @CODCAJA
        AND ISNULL(CORTE, 'NO') = 'NO'
        AND TIPO = 'E'
        AND UPPER(LTRIM(RTRIM(ISNULL(CATEGORIA, '')))) = 'DEPOSITO'
        AND FECHA >= CAST(@APERTURA AS DATE)
    `);
  return result.rowsAffected[0] || 0;
}

module.exports = {
  TIPODOC_ENTRADA,
  TIPODOC_SALIDA,
  tipodocForTipo,
  listTiposDocBanco,
  previewSiguienteBanco,
  listMovimientosBanco,
  getMovimientoBanco,
  listDocumentosPendientes,
  crearMovimientoBanco,
  actualizarMovimientoBanco,
  eliminarMovimientoBanco,
  sumRetirosEfectivoSesionCaja,
  listRetirosEfectivoSesionCaja,
  marcarRetirosEfectivoCorte,
};
