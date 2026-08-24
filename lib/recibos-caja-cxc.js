/**
 * Recibos de Caja CXC (tipodoc PRC): abonos a múltiples facturas
 * con formas de pago e impacto en caja al finalizar.
 *
 * Borrador: STATUS=O + CODEMBARQUE='EDICION' (sin CODCAJA; no afecta saldos).
 * Finalizado: CODEMBARQUE='CXC' + CODCAJA + FPAGO_* (aplica DOC_ABONO/DOC_SALDO).
 */
const { nowParts, parseFechaInput, fechaIsoFromValue } = require('./documento-fecha');
const {
  STATUS_OPERADO,
  STATUS_ANULADO,
  SQL_TIPODOC_REPORTES_SI,
  isCorteCajaCerrado,
} = require('./documento-status');
const {
  SQL_TIPODOC_CUENTAS_COBRAR_IN,
  SQL_DOC_SALDO_PENDIENTE_POSITIVO,
} = require('./cuentas-docs');
const { abonoSuperaSaldo, aplicarAbonoSobreSaldo } = require('./cuentas-saldo-centavos');

const TIPODOC_PRC = 'PRC';
const CODEMBARQUE_EDICION = 'EDICION';
const CODEMBARQUE_FINAL = 'CXC';

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
  if (!Number.isFinite(n)) return null;
  return n;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function parseFpagoAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return roundMoney(n);
}

function resolveFormasPago(body, totalPrecio) {
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
  if (sum <= 0) throw httpError('Indique la forma de pago por el monto del recibo');
  if (Math.abs(sum - total) > 0.001) {
    throw httpError(
      `La suma de formas de pago (${sum}) debe ser igual al monto del recibo (${total})`
    );
  }
  return fpago;
}

async function resolveCodcajaAbierta(transaction, sql, empnit, body) {
  const raw = body?.CODCAJA ?? body?.codcaja;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw httpError('Seleccione una caja abierta para el recibo');
  }
  const codcaja = parseInt(raw, 10);
  if (!Number.isFinite(codcaja) || codcaja <= 0) throw httpError('CODCAJA inválido');
  const cajaRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCAJA', sql.Int, codcaja)
    .query(`
      SELECT CODCAJA, STATUS
      FROM dbo.Cajas
      WHERE EMPNIT = @EMPNIT AND CODCAJA = @CODCAJA
    `);
  const caja = cajaRes.recordset[0];
  if (!caja) throw httpError('Caja no encontrada', 404);
  if (Number(caja.STATUS) !== 1) throw httpError('La caja no está abierta');
  return codcaja;
}

async function allocateCorrelativo(transaction, sql, empnit, coddoc) {
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
      SELECT ISNULL(MAX(CORRELATIVO), 0) AS maxCorr FROM dbo.DOCUMENTOS WITH (UPDLOCK, HOLDLOCK)
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

async function listTiposDocPrc(pool, sql, empnit) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('TIPODOC', sql.VarChar, TIPODOC_PRC)
    .query(`
      SELECT CODDOC, DESDOC, TIPODOC, ISNULL(CORRELATIVO, 0) AS CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND TIPODOC = @TIPODOC AND ACTIVO = 'SI'
      ORDER BY CODDOC
    `);
  return result.recordset.map((r) => ({
    CODDOC: r.CODDOC ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: r.TIPODOC ?? TIPODOC_PRC,
    CORRELATIVO: Number(r.CORRELATIVO) || 0,
  }));
}

async function getTipoDocPrcByCoddoc(pool, sql, empnit, coddoc) {
  const cod = String(coddoc || '').trim();
  if (!cod) return null;
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, cod)
    .input('TIPODOC', sql.VarChar, TIPODOC_PRC)
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
    TIPODOC: row.TIPODOC ?? TIPODOC_PRC,
    CORRELATIVO: Number(row.CORRELATIVO) || 0,
  };
}

async function previewSiguientePrc(pool, sql, empnit, coddoc) {
  const tipos = await listTiposDocPrc(pool, sql, empnit);
  const tipo = coddoc
    ? tipos.find((t) => String(t.CODDOC) === String(coddoc))
    : tipos[0];
  if (!tipo) return null;
  const maxRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, tipo.CODDOC)
    .query(`
      SELECT ISNULL(MAX(CORRELATIVO), 0) AS maxCorr
      FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC
    `);
  const tipoCorr = Number(tipo.CORRELATIVO) || 0;
  const maxCorr = Number(maxRes.recordset[0]?.maxCorr) || 0;
  return {
    CODDOC: tipo.CODDOC,
    DESDOC: tipo.DESDOC ?? null,
    TIPODOC: TIPODOC_PRC,
    CORRELATIVO: Math.max(tipoCorr, maxCorr) + 1,
  };
}

function isReciboEditable(header) {
  if (!header) return false;
  if (String(header.STATUS || '').trim().toUpperCase() !== STATUS_OPERADO) return false;
  if (isCorteCajaCerrado(header.CORTE)) return false;
  return String(header.CODEMBARQUE || '').trim().toUpperCase() === CODEMBARQUE_EDICION;
}

function isReciboFinalizado(header) {
  if (!header) return false;
  if (String(header.STATUS || '').trim().toUpperCase() !== STATUS_OPERADO) return false;
  return String(header.CODEMBARQUE || '').trim().toUpperCase() === CODEMBARQUE_FINAL;
}

function mapHeader(r) {
  return {
    FECHA: fechaIsoFromValue(r.FECHA) || null,
    CODDOC: r.CODDOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: r.TIPODOC ?? TIPODOC_PRC,
    CODCLIENTE: r.CODCLIENTE ?? null,
    DOC_NIT: r.DOC_NIT ?? null,
    DOC_NOMCLIE: r.DOC_NOMCLIE ?? null,
    DOC_DIRCLIE: r.DOC_DIRCLIE ?? null,
    NEGOCIO: r.NEGOCIO ?? null,
    CODVEN: r.CODVEN ?? null,
    TOTALPRECIO: toNumber(r.TOTALPRECIO),
    STATUS: r.STATUS ?? null,
    CORTE: r.CORTE ?? null,
    CODEMBARQUE: r.CODEMBARQUE ?? null,
    CODCAJA: r.CODCAJA ?? null,
    USUARIO: r.USUARIO ?? null,
    OBS: r.OBS ?? null,
    FPAGO_EFECTIVO: toNumber(r.FPAGO_EFECTIVO),
    FPAGO_TARJETA: toNumber(r.FPAGO_TARJETA),
    FPAGO_DEPOSITO: toNumber(r.FPAGO_DEPOSITO),
    FPAGO_CHEQUE: toNumber(r.FPAGO_CHEQUE),
    FPAGO_DESCRIPCION: String(r.FPAGO_DESCRIPCION ?? '').trim(),
    EDITABLE: false,
    FINALIZADO: false,
  };
}

async function loadAbonos(poolOrTx, sql, empnit, coddoc, correlativo) {
  const result = await poolOrTx
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT
        a.ID,
        a.FECHA,
        a.ABONO,
        a.CODDOC_FAC,
        a.CORRELATIVO_FAC,
        a.CODDOC_REC,
        a.CORRELATIVO_REC,
        ISNULL(f.DOC_NOMCLIE, '') AS DOC_NOMCLIE,
        ISNULL(f.TOTALPRECIO, 0) AS FAC_TOTALPRECIO,
        ISNULL(f.DOC_SALDO, 0) AS FAC_DOC_SALDO,
        ISNULL(f.DOC_ABONO, 0) AS FAC_DOC_ABONO,
        f.FECHA AS FAC_FECHA
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      LEFT JOIN dbo.DOCUMENTOS f
        ON f.EMPNIT = a.EMPNIT
        AND f.CODDOC = a.CODDOC_FAC
        AND f.CORRELATIVO = a.CORRELATIVO_FAC
      WHERE a.EMPNIT = @EMPNIT
        AND a.CODDOC = @CODDOC
        AND a.CORRELATIVO = @CORRELATIVO
      ORDER BY a.ID ASC
    `);
  return result.recordset.map((r) => ({
    ID: r.ID ?? null,
    FECHA: r.FECHA ?? null,
    ABONO: toNumber(r.ABONO),
    CODDOC_FAC: r.CODDOC_FAC ?? null,
    CORRELATIVO_FAC: r.CORRELATIVO_FAC ?? null,
    CODDOC_REC: r.CODDOC_REC ?? null,
    CORRELATIVO_REC: r.CORRELATIVO_REC ?? null,
    DOC_NOMCLIE: r.DOC_NOMCLIE ?? null,
    FAC_TOTALPRECIO: toNumber(r.FAC_TOTALPRECIO),
    FAC_DOC_SALDO: toNumber(r.FAC_DOC_SALDO),
    FAC_DOC_ABONO: toNumber(r.FAC_DOC_ABONO),
    FAC_FECHA: fechaIsoFromValue(r.FAC_FECHA) || null,
  }));
}

async function loadRecibo(pool, sql, empnit, coddoc, correlativo) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .input('TIPODOC', sql.VarChar, TIPODOC_PRC)
    .query(`
      SELECT
        d.*,
        t.DESDOC,
        t.TIPODOC,
        c.NEGOCIO
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      LEFT JOIN dbo.CLIENTES c ON c.EMPNIT = d.EMPNIT AND c.CODCLIENTE = d.CODCLIENTE
      WHERE d.EMPNIT = @EMPNIT
        AND d.CODDOC = @CODDOC
        AND d.CORRELATIVO = @CORRELATIVO
        AND t.TIPODOC = @TIPODOC
    `);
  const row = result.recordset[0];
  if (!row) return null;
  const header = mapHeader(row);
  header.EDITABLE = isReciboEditable(header);
  header.FINALIZADO = isReciboFinalizado(header);
  const abonos = await loadAbonos(pool, sql, empnit, coddoc, correlativo);
  return { header, abonos };
}

async function listRecibos(pool, sql, empnit, { fecha, q = '', limit = 200 } = {}) {
  const fechaParts = parseFechaInput(fecha);
  if (!fechaParts) throw httpError('Fecha inválida');
  const qTrim = String(q || '').trim();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const request = pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ANIO', sql.Int, fechaParts.anio)
    .input('MES', sql.Int, fechaParts.mes)
    .input('DIA', sql.Int, fechaParts.dia)
    .input('TIPODOC', sql.VarChar, TIPODOC_PRC)
    .input('LIMIT', sql.Int, lim);
  let qSql = '';
  if (qTrim) {
    request.input('qLike', sql.VarChar, `%${qTrim}%`);
    qSql = `
      AND (
        d.CODDOC LIKE @qLike
        OR CAST(d.CORRELATIVO AS VARCHAR(30)) LIKE @qLike
        OR ISNULL(d.DOC_NOMCLIE, '') LIKE @qLike
        OR ISNULL(d.DOC_NIT, '') LIKE @qLike
        OR ISNULL(c.NEGOCIO, '') LIKE @qLike
        OR ISNULL(d.USUARIO, '') LIKE @qLike
      )`;
  }
  const result = await request.query(`
    SELECT TOP (@LIMIT)
      d.FECHA, d.CODDOC, d.CORRELATIVO, t.DESDOC, t.TIPODOC,
      d.CODCLIENTE, d.DOC_NIT, d.DOC_NOMCLIE, d.DOC_DIRCLIE,
      c.NEGOCIO, ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
      d.STATUS, ISNULL(d.CORTE, 'NO') AS CORTE, d.CODEMBARQUE, d.CODCAJA,
      d.USUARIO, d.OBS,
      ISNULL(d.FPAGO_EFECTIVO, 0) AS FPAGO_EFECTIVO,
      ISNULL(d.FPAGO_TARJETA, 0) AS FPAGO_TARJETA,
      ISNULL(d.FPAGO_DEPOSITO, 0) AS FPAGO_DEPOSITO,
      ISNULL(d.FPAGO_CHEQUE, 0) AS FPAGO_CHEQUE,
      ISNULL(d.FPAGO_DESCRIPCION, '') AS FPAGO_DESCRIPCION
    FROM dbo.DOCUMENTOS d
    INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
    LEFT JOIN dbo.CLIENTES c ON c.EMPNIT = d.EMPNIT AND c.CODCLIENTE = d.CODCLIENTE
    WHERE d.EMPNIT = @EMPNIT
      AND t.TIPODOC = @TIPODOC
      AND d.STATUS <> '${STATUS_ANULADO}'
      AND d.ANIO = @ANIO AND d.MES = @MES AND d.DIA = @DIA
      ${qSql}
    ORDER BY d.CORRELATIVO DESC
  `);
  return result.recordset.map((r) => {
    const header = mapHeader(r);
    header.EDITABLE = isReciboEditable(header);
    header.FINALIZADO = isReciboFinalizado(header);
    return header;
  });
}

async function listFacturasPendientesCliente(pool, sql, empnit, codcliente, { q = '', limit = 200 } = {}) {
  const cod = parseInt(codcliente, 10);
  if (!Number.isFinite(cod) || cod <= 0) throw httpError('Cliente inválido');
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const qTrim = String(q || '').trim();
  const request = pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCLIENTE', sql.Int, cod)
    .input('LIMIT', sql.Int, lim);
  let qSql = '';
  if (qTrim) {
    request.input('qLike', sql.VarChar, `%${qTrim}%`);
    qSql = `
      AND (
        d.CODDOC LIKE @qLike
        OR CAST(d.CORRELATIVO AS VARCHAR(30)) LIKE @qLike
        OR ISNULL(d.DOC_NOMCLIE, '') LIKE @qLike
      )`;
  }
  const result = await request.query(`
    SELECT TOP (@LIMIT)
      d.FECHA, d.CODDOC, d.CORRELATIVO, t.DESDOC, t.TIPODOC,
      ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
      ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
      ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
      d.DOC_NOMCLIE, d.DOC_NIT
    FROM dbo.DOCUMENTOS d
    INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
    WHERE d.EMPNIT = @EMPNIT
      AND d.CODCLIENTE = @CODCLIENTE
      AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_COBRAR_IN})
      AND d.STATUS = '${STATUS_OPERADO}'
      AND ISNULL(d.CONCRE, 'CON') = 'CRE'
      AND ${SQL_TIPODOC_REPORTES_SI}
      AND ${SQL_DOC_SALDO_PENDIENTE_POSITIVO}
      ${qSql}
    ORDER BY d.FECHA DESC, d.CORRELATIVO DESC
  `);
  return result.recordset.map((r) => ({
    FECHA: fechaIsoFromValue(r.FECHA) || null,
    CODDOC: r.CODDOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: r.TIPODOC ?? null,
    TOTALPRECIO: toNumber(r.TOTALPRECIO),
    DOC_ABONO: toNumber(r.DOC_ABONO),
    DOC_SALDO: toNumber(r.DOC_SALDO),
    DOC_NOMCLIE: r.DOC_NOMCLIE ?? null,
    DOC_NIT: r.DOC_NIT ?? null,
  }));
}

async function loadCliente(pool, sql, empnit, codcliente) {
  const cod = parseInt(codcliente, 10);
  if (!Number.isFinite(cod) || cod <= 0) return null;
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCLIENTE', sql.Int, cod)
    .query(`
      SELECT CODCLIENTE, NIT, NOMBRECLIENTE, DIRCLIENTE, NEGOCIO
      FROM dbo.CLIENTES
      WHERE EMPNIT = @EMPNIT AND CODCLIENTE = @CODCLIENTE
    `);
  return result.recordset[0] || null;
}

async function crearRecibo(pool, sql, empnit, body = {}) {
  const coddocReq = String(body.CODDOC || '').trim();
  const tipos = await listTiposDocPrc(pool, sql, empnit);
  const tipo = coddocReq
    ? tipos.find((t) => String(t.CODDOC) === coddocReq)
    : tipos[0];
  if (!tipo) {
    throw httpError(
      coddocReq
        ? `El documento ${coddocReq} no es un tipo PRC activo`
        : 'No hay tipo de documento PRC activo para la empresa. Créelo en Tipos de documento.'
    );
  }
  const usuario = String(body.USUARIO || body.usuario || 'CXC').trim() || 'CXC';
  const now = nowParts();
  const fechaParts = parseFechaInput(body.FECHA) || now;
  const cliente = body.CODCLIENTE != null ? await loadCliente(pool, sql, empnit, body.CODCLIENTE) : null;
  let correlativo = null;

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const codcaja = await resolveCodcajaAbierta(transaction, sql, empnit, body);
    correlativo = await allocateCorrelativo(transaction, sql, empnit, tipo.CODDOC);
    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ANIO', sql.Int, fechaParts.anio)
      .input('MES', sql.Int, fechaParts.mes)
      .input('DIA', sql.Int, fechaParts.dia)
      .input('FECHA', sql.Date, fechaParts.fecha)
      .input('HORA', sql.Int, now.hora)
      .input('MINUTO', sql.Int, now.minuto)
      .input('CODDOC', sql.VarChar, tipo.CODDOC)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .input('CODCLIENTE', sql.Int, cliente?.CODCLIENTE ?? null)
      .input('DOC_NIT', sql.VarChar, String(cliente?.NIT || 'CF'))
      .input('DOC_NOMCLIE', sql.VarChar, String(cliente?.NOMBRECLIENTE || cliente?.NEGOCIO || ''))
      .input('DOC_DIRCLIE', sql.VarChar, String(cliente?.DIRCLIENTE || 'SN'))
      .input('USUARIO', sql.VarChar, usuario)
      .input('OBS', sql.VarChar, String(body.OBS || '').trim())
      .input('CODEMBARQUE', sql.VarChar, CODEMBARQUE_EDICION)
      .input('CODCAJA', sql.Int, codcaja)
      .query(`
        INSERT INTO dbo.DOCUMENTOS (
          EMPNIT, ANIO, MES, DIA, FECHA, HORA, MINUTO, CODDOC, CORRELATIVO,
          CODCLIENTE, DOC_NIT, DOC_NOMCLIE, DOC_DIRCLIE, CODVEN,
          TOTALCOSTO, TOTALPRECIO, CODEMBARQUE, STATUS, USUARIO, CONCRE, CORTE,
          MARCA, OBS, DOC_SALDO, DOC_ABONO, OBSMARCA, TOTALDESCUENTO,
          DIRENTREGA, NOGUIA, VALORENTREGA, TOTALEXENTO, TIPOPAGO, NODOCPAGO,
          VENCIMIENTO, DIASCREDITO, TOTALIVA, TOTALSINIVA, PAGO, VUELTO,
          SERIEFAC, NOFAC, CODCAJA,
          FPAGO_EFECTIVO, FPAGO_TARJETA, FPAGO_DEPOSITO, FPAGO_CHEQUE, FPAGO_DESCRIPCION
        ) VALUES (
          @EMPNIT, @ANIO, @MES, @DIA, @FECHA, @HORA, @MINUTO, @CODDOC, @CORRELATIVO,
          @CODCLIENTE, @DOC_NIT, @DOC_NOMCLIE, @DOC_DIRCLIE, NULL,
          0, 0, @CODEMBARQUE, '${STATUS_OPERADO}', @USUARIO, 'CON', 'NO',
          'SN', @OBS, 0, 0, 'SN', 0,
          'SN', 'SN', 0, 0, 'CONTADO', 'SN',
          @FECHA, 0, 0, 0, 0, 0,
          '', '', @CODCAJA,
          0, 0, 0, 0, ''
        )
      `);
    await transaction.commit();
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  }
  return loadRecibo(pool, sql, empnit, tipo.CODDOC, correlativo);
}

async function assertEditableRecibo(pool, sql, empnit, coddoc, correlativo) {
  const recibo = await loadRecibo(pool, sql, empnit, coddoc, correlativo);
  if (!recibo) throw httpError('Recibo no encontrado', 404);
  if (!recibo.header.EDITABLE) {
    throw httpError('El recibo no está en edición (ya finalizado, anulado o en corte)');
  }
  return recibo;
}

async function actualizarRecibo(pool, sql, empnit, coddoc, correlativo, body = {}) {
  const recibo = await assertEditableRecibo(pool, sql, empnit, coddoc, correlativo);
  const updates = [];
  let clearAbonos = false;
  let cliente = null;

  if (body.OBS !== undefined) updates.push('OBS = @OBS');
  if (body.FECHA !== undefined) {
    if (!parseFechaInput(body.FECHA)) throw httpError('Fecha inválida');
    updates.push('ANIO = @ANIO', 'MES = @MES', 'DIA = @DIA', 'FECHA = @FECHA');
  }
  if (body.CODCLIENTE !== undefined) {
    cliente = await loadCliente(pool, sql, empnit, body.CODCLIENTE);
    if (!cliente) throw httpError('Cliente no encontrado', 404);
    const prev = Number(recibo.header.CODCLIENTE);
    const next = Number(cliente.CODCLIENTE);
    if (prev && prev !== next && recibo.abonos.length) clearAbonos = true;
    updates.push(
      'CODCLIENTE = @CODCLIENTE',
      'DOC_NIT = @DOC_NIT',
      'DOC_NOMCLIE = @DOC_NOMCLIE',
      'DOC_DIRCLIE = @DOC_DIRCLIE'
    );
  }

  if (!updates.length && !clearAbonos) return recibo;

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    if (updates.length) {
      const updReq = transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo);
      if (body.OBS !== undefined) updReq.input('OBS', sql.VarChar, String(body.OBS || '').trim());
      if (body.FECHA !== undefined) {
        const fechaParts = parseFechaInput(body.FECHA);
        updReq.input('ANIO', sql.Int, fechaParts.anio);
        updReq.input('MES', sql.Int, fechaParts.mes);
        updReq.input('DIA', sql.Int, fechaParts.dia);
        updReq.input('FECHA', sql.Date, fechaParts.fecha);
      }
      if (cliente) {
        updReq.input('CODCLIENTE', sql.Int, cliente.CODCLIENTE);
        updReq.input('DOC_NIT', sql.VarChar, String(cliente.NIT || 'CF'));
        updReq.input(
          'DOC_NOMCLIE',
          sql.VarChar,
          String(cliente.NOMBRECLIENTE || cliente.NEGOCIO || '')
        );
        updReq.input('DOC_DIRCLIE', sql.VarChar, String(cliente.DIRCLIENTE || 'SN'));
      }
      await updReq.query(`
        UPDATE dbo.DOCUMENTOS SET ${updates.join(', ')}
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          AND STATUS = '${STATUS_OPERADO}' AND CODEMBARQUE = '${CODEMBARQUE_EDICION}'
      `);
    }
    if (clearAbonos) {
      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          DELETE FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);
      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .query(`
          UPDATE dbo.DOCUMENTOS SET TOTALPRECIO = 0, PAGO = 0
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);
    }
    await transaction.commit();
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  }
  return loadRecibo(pool, sql, empnit, coddoc, correlativo);
}

function normalizeAbonosInput(rawAbonos) {
  if (!Array.isArray(rawAbonos)) throw httpError('abonos debe ser un arreglo');
  const map = new Map();
  for (const item of rawAbonos) {
    const facCod = String(item?.CODDOC_FAC || item?.CODDOC || '').trim();
    const facCorr = parseCorrelativo(item?.CORRELATIVO_FAC ?? item?.CORRELATIVO);
    const abono = roundMoney(item?.ABONO ?? item?.MONTO ?? 0);
    if (!facCod || facCorr === null) throw httpError('Factura abonada inválida');
    if (abono < 0) throw httpError('El abono no puede ser negativo');
    if (abono === 0) continue;
    const key = `${facCod}|${facCorr}`;
    const prev = map.get(key);
    map.set(key, {
      CODDOC_FAC: facCod,
      CORRELATIVO_FAC: facCorr,
      ABONO: roundMoney((prev?.ABONO || 0) + abono),
    });
  }
  return [...map.values()];
}

async function guardarAbonos(pool, sql, empnit, coddoc, correlativo, body = {}) {
  const recibo = await assertEditableRecibo(pool, sql, empnit, coddoc, correlativo);
  if (!recibo.header.CODCLIENTE) throw httpError('Seleccione un cliente antes de abonar facturas');
  const abonos = normalizeAbonosInput(body.abonos ?? body.ABONOS ?? []);
  const fechaStr =
    fechaIsoFromValue(recibo.header.FECHA) ||
    `${nowParts().anio}-${String(nowParts().mes).padStart(2, '0')}-${String(nowParts().dia).padStart(2, '0')}`;

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    for (const line of abonos) {
      const facRes = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, line.CODDOC_FAC)
        .input('CORRELATIVO', sql.Decimal(18, 0), line.CORRELATIVO_FAC)
        .input('CODCLIENTE', sql.Int, Number(recibo.header.CODCLIENTE))
        .query(`
          SELECT
            ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
            d.CODCLIENTE,
            d.STATUS,
            ISNULL(d.CONCRE, 'CON') AS CONCRE,
            t.TIPODOC
          FROM dbo.DOCUMENTOS d WITH (UPDLOCK, ROWLOCK)
          INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
          WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
            AND d.CODCLIENTE = @CODCLIENTE
            AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_COBRAR_IN})
            AND d.STATUS = '${STATUS_OPERADO}'
            AND ISNULL(d.CONCRE, 'CON') = 'CRE'
            AND ${SQL_TIPODOC_REPORTES_SI}
        `);
      if (!facRes.recordset.length) {
        throw httpError(
          `Factura ${line.CODDOC_FAC}-${line.CORRELATIVO_FAC} no válida para este cliente`
        );
      }
      const saldo = toNumber(facRes.recordset[0].DOC_SALDO);
      if (abonoSuperaSaldo(line.ABONO, saldo)) {
        throw httpError(
          `El abono a ${line.CODDOC_FAC}-${line.CORRELATIVO_FAC} (${line.ABONO}) supera el saldo (${saldo})`
        );
      }
    }

    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        DELETE FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);

    let total = 0;
    for (const line of abonos) {
      total = roundMoney(total + line.ABONO);
      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('FECHA', sql.NChar(10), fechaStr)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .input('ABONO', sql.Decimal(18, 4), line.ABONO)
        .input('CODDOC_FAC', sql.VarChar, line.CODDOC_FAC)
        .input('CORRELATIVO_FAC', sql.Decimal(18, 0), line.CORRELATIVO_FAC)
        .input('CODDOC_REC', sql.VarChar, coddoc)
        .input('CORRELATIVO_REC', sql.Decimal(18, 0), correlativo)
        .query(`
          INSERT INTO dbo.DOCUMENTOS_FACTURAS_ABONADAS (
            EMPNIT, FECHA, CODDOC, CORRELATIVO, ABONO,
            CODDOC_FAC, CORRELATIVO_FAC, CODDOC_REC, CORRELATIVO_REC
          ) VALUES (
            @EMPNIT, @FECHA, @CODDOC, @CORRELATIVO, @ABONO,
            @CODDOC_FAC, @CORRELATIVO_FAC, @CODDOC_REC, @CORRELATIVO_REC
          )
        `);
    }

    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .input('TOTALPRECIO', sql.Decimal(18, 3), total)
      .query(`
        UPDATE dbo.DOCUMENTOS
        SET TOTALPRECIO = @TOTALPRECIO, PAGO = @TOTALPRECIO
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          AND STATUS = '${STATUS_OPERADO}' AND CODEMBARQUE = '${CODEMBARQUE_EDICION}'
      `);

    await transaction.commit();
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  }
  return loadRecibo(pool, sql, empnit, coddoc, correlativo);
}

async function finalizarRecibo(pool, sql, empnit, coddoc, correlativo, body = {}) {
  const recibo = await assertEditableRecibo(pool, sql, empnit, coddoc, correlativo);
  if (!recibo.header.CODCLIENTE) throw httpError('Seleccione un cliente');

  const abonos = normalizeAbonosInput(body.abonos ?? body.ABONOS ?? []);
  if (!abonos.length) throw httpError('Agregue al menos un abono a facturas');

  const total = roundMoney(abonos.reduce((s, a) => s + toNumber(a.ABONO), 0));
  if (total <= 0) throw httpError('El total del recibo debe ser mayor a cero');
  const fpago = resolveFormasPago(body, total);
  const fechaStr =
    fechaIsoFromValue(recibo.header.FECHA) ||
    `${nowParts().anio}-${String(nowParts().mes).padStart(2, '0')}-${String(nowParts().dia).padStart(2, '0')}`;

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const codcaja = await resolveCodcajaAbierta(transaction, sql, empnit, body);

    // Sustituye vínculos previos del borrador y recalcula abonos desde el payload.
    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        DELETE FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);

    for (const line of abonos) {
      const abono = toNumber(line.ABONO);
      const facRes = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, line.CODDOC_FAC)
        .input('CORRELATIVO', sql.Decimal(18, 0), line.CORRELATIVO_FAC)
        .input('CODCLIENTE', sql.Int, Number(recibo.header.CODCLIENTE))
        .query(`
          SELECT
            ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
            ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO
          FROM dbo.DOCUMENTOS d WITH (UPDLOCK, ROWLOCK)
          INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
          WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
            AND d.CODCLIENTE = @CODCLIENTE
            AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_COBRAR_IN})
            AND d.STATUS = '${STATUS_OPERADO}'
            AND ISNULL(d.CONCRE, 'CON') = 'CRE'
            AND ${SQL_TIPODOC_REPORTES_SI}
        `);
      if (!facRes.recordset.length) {
        throw httpError(`Factura ${line.CODDOC_FAC}-${line.CORRELATIVO_FAC} no válida para este cliente`);
      }
      const fac = facRes.recordset[0];
      const docSaldo = toNumber(fac.DOC_SALDO);
      const docAbono = toNumber(fac.DOC_ABONO);
      if (abonoSuperaSaldo(abono, docSaldo)) {
        throw httpError(
          `El abono a ${line.CODDOC_FAC}-${line.CORRELATIVO_FAC} supera el saldo actual (${docSaldo})`
        );
      }

      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('FECHA', sql.NChar(10), fechaStr)
        .input('CODDOC', sql.VarChar, coddoc)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
        .input('ABONO', sql.Decimal(18, 4), abono)
        .input('CODDOC_FAC', sql.VarChar, line.CODDOC_FAC)
        .input('CORRELATIVO_FAC', sql.Decimal(18, 0), line.CORRELATIVO_FAC)
        .input('CODDOC_REC', sql.VarChar, coddoc)
        .input('CORRELATIVO_REC', sql.Decimal(18, 0), correlativo)
        .query(`
          INSERT INTO dbo.DOCUMENTOS_FACTURAS_ABONADAS (
            EMPNIT, FECHA, CODDOC, CORRELATIVO, ABONO,
            CODDOC_FAC, CORRELATIVO_FAC, CODDOC_REC, CORRELATIVO_REC
          ) VALUES (
            @EMPNIT, @FECHA, @CODDOC, @CORRELATIVO, @ABONO,
            @CODDOC_FAC, @CORRELATIVO_FAC, @CODDOC_REC, @CORRELATIVO_REC
          )
        `);

      const aplicado = aplicarAbonoSobreSaldo(docAbono, docSaldo, abono);
      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, line.CODDOC_FAC)
        .input('CORRELATIVO', sql.Decimal(18, 0), line.CORRELATIVO_FAC)
        .input('DOC_ABONO', sql.Decimal(18, 3), aplicado.DOC_ABONO)
        .input('DOC_SALDO', sql.Decimal(18, 3), aplicado.DOC_SALDO)
        .query(`
          UPDATE dbo.DOCUMENTOS
          SET DOC_ABONO = @DOC_ABONO, DOC_SALDO = @DOC_SALDO
          WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        `);
    }

    const obs =
      String(body.OBS ?? recibo.header.OBS ?? '').trim() ||
      `Recibo de caja CXC — ${abonos.length} factura(s)`;

    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .input('TOTALPRECIO', sql.Decimal(18, 3), total)
      .input('CODCAJA', sql.Int, codcaja)
      .input('OBS', sql.VarChar, obs)
      .input('CODEMBARQUE', sql.VarChar, CODEMBARQUE_FINAL)
      .input('FPAGO_EFECTIVO', sql.Decimal(18, 3), fpago.FPAGO_EFECTIVO)
      .input('FPAGO_TARJETA', sql.Decimal(18, 3), fpago.FPAGO_TARJETA)
      .input('FPAGO_DEPOSITO', sql.Decimal(18, 3), fpago.FPAGO_DEPOSITO)
      .input('FPAGO_CHEQUE', sql.Decimal(18, 3), fpago.FPAGO_CHEQUE)
      .input('FPAGO_DESCRIPCION', sql.VarChar, fpago.FPAGO_DESCRIPCION || '')
      .query(`
        UPDATE dbo.DOCUMENTOS SET
          TOTALPRECIO = @TOTALPRECIO,
          PAGO = @TOTALPRECIO,
          CODCAJA = @CODCAJA,
          OBS = @OBS,
          CODEMBARQUE = @CODEMBARQUE,
          FPAGO_EFECTIVO = @FPAGO_EFECTIVO,
          FPAGO_TARJETA = @FPAGO_TARJETA,
          FPAGO_DEPOSITO = @FPAGO_DEPOSITO,
          FPAGO_CHEQUE = @FPAGO_CHEQUE,
          FPAGO_DESCRIPCION = @FPAGO_DESCRIPCION
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
          AND STATUS = '${STATUS_OPERADO}' AND CODEMBARQUE = '${CODEMBARQUE_EDICION}'
      `);

    await transaction.commit();
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  }
  return loadRecibo(pool, sql, empnit, coddoc, correlativo);
}

async function eliminarRecibo(pool, sql, empnit, coddoc, correlativo, { pass } = {}) {
  const recibo = await loadRecibo(pool, sql, empnit, coddoc, correlativo);
  if (!recibo) throw httpError('Recibo no encontrado', 404);
  if (isCorteCajaCerrado(recibo.header.CORTE)) {
    throw httpError('No se puede eliminar: el recibo ya está en un corte de caja');
  }

  const finalizado = isReciboFinalizado(recibo.header);
  if (!finalizado && !isReciboEditable(recibo.header)) {
    throw httpError('El recibo no se puede eliminar');
  }

  const { assertAdminPass, assertEliminacionRegistro } = require('./config-auth');
  await assertEliminacionRegistro(pool, String(pass ?? ''));

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    if (finalizado) {
      for (const line of recibo.abonos) {
        const monto = toNumber(line.ABONO);
        const facRes = await transaction
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('CODDOC', sql.VarChar, line.CODDOC_FAC)
          .input('CORRELATIVO', sql.Decimal(18, 0), line.CORRELATIVO_FAC)
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
            .input('CODDOC', sql.VarChar, line.CODDOC_FAC)
            .input('CORRELATIVO', sql.Decimal(18, 0), line.CORRELATIVO_FAC)
            .input('DOC_ABONO', sql.Decimal(18, 3), Math.max(0, roundMoney(toNumber(fac.DOC_ABONO) - monto)))
            .input('DOC_SALDO', sql.Decimal(18, 3), roundMoney(toNumber(fac.DOC_SALDO) + monto))
            .query(`
              UPDATE dbo.DOCUMENTOS
              SET DOC_ABONO = @DOC_ABONO, DOC_SALDO = @DOC_SALDO
              WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
            `);
        }
      }
    }

    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        DELETE FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);

    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        DELETE FROM dbo.DOCUMENTOS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);

    await transaction.commit();
    return { ok: true, CODDOC: coddoc, CORRELATIVO: correlativo };
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  }
}

module.exports = {
  TIPODOC_PRC,
  CODEMBARQUE_EDICION,
  CODEMBARQUE_FINAL,
  parseCorrelativo,
  listTiposDocPrc,
  previewSiguientePrc,
  listRecibos,
  loadRecibo,
  listFacturasPendientesCliente,
  crearRecibo,
  actualizarRecibo,
  guardarAbonos,
  finalizarRecibo,
  eliminarRecibo,
  isReciboEditable,
  isReciboFinalizado,
};
