const { nowParts, fechaIsoFromValue } = require('./documento-fecha');
const { STATUS_OPERADO, SQL_TIPODOC_REPORTES_SI } = require('./documento-status');
const {
  SQL_TIPODOC_CUENTAS_COBRAR_IN,
  SQL_DOC_SALDO_PENDIENTE,
  SQL_TIPODOC_ABONO_CXC_IN,
  SQL_TIPODOC_RETENCION_CXC_IN,
  SQL_TIPODOC_FEL_CXC_IN,
  SQL_TIPODOC_NOTA_FEL_CXC_IN,
  SQL_MATCH_FACTURA_REF,
} = require('./cuentas-docs');
const {
  TOLERANCIA_ABONO_RETENCION,
  abonoSuperaSaldo,
  saldoEfectivo,
  sqlSetDocSaldoFromAbonos,
} = require('./cuentas-saldo-centavos');

const TIPODOC_RCC = 'RCC';
const TIPODOC_RAR = 'RAR';
const TIPODOC_FAC = 'FAC';

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

function parseFpagoAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return roundMoney(n);
}

async function resolveCodcajaAbierta(transaction, sql, empnit, body) {
  const raw = body?.CODCAJA ?? body?.codcaja;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    const err = new Error('Seleccione una caja abierta para el recibo');
    err.statusCode = 400;
    throw err;
  }
  const codcaja = parseInt(raw, 10);
  if (!Number.isFinite(codcaja) || codcaja <= 0) {
    const err = new Error('CODCAJA inválido');
    err.statusCode = 400;
    throw err;
  }
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
  if (!caja) {
    const err = new Error('Caja no encontrada');
    err.statusCode = 404;
    throw err;
  }
  if (Number(caja.STATUS) !== 1) {
    const err = new Error('La caja no está abierta');
    err.statusCode = 400;
    throw err;
  }
  return codcaja;
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
  if (sum <= 0) {
    const err = new Error('Indique la forma de pago por el monto del abono');
    err.statusCode = 400;
    throw err;
  }
  if (Math.abs(sum - total) > 0.001) {
    const err = new Error(
      `La suma de formas de pago (${sum}) debe ser igual al monto del abono (${total})`
    );
    err.statusCode = 400;
    throw err;
  }
  return fpago;
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

async function listTiposDocRcc(pool, sql, empnit) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('TIPODOC', sql.VarChar, TIPODOC_RCC)
    .query(`
      SELECT CODDOC, DESDOC, TIPODOC, ISNULL(CORRELATIVO, 0) AS CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND TIPODOC = @TIPODOC AND ACTIVO = 'SI'
      ORDER BY CODDOC
    `);
  return result.recordset.map((r) => ({
    CODDOC: r.CODDOC ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: r.TIPODOC ?? TIPODOC_RCC,
    CORRELATIVO: Number(r.CORRELATIVO) || 0,
  }));
}

async function getTipoDocRcc(pool, sql, empnit) {
  const tipos = await listTiposDocRcc(pool, sql, empnit);
  return tipos[0] || null;
}

async function getTipoDocRccByCoddoc(pool, sql, empnit, coddoc) {
  const cod = String(coddoc || '').trim();
  if (!cod) return null;
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, cod)
    .input('TIPODOC', sql.VarChar, TIPODOC_RCC)
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
    TIPODOC: row.TIPODOC ?? TIPODOC_RCC,
    CORRELATIVO: Number(row.CORRELATIVO) || 0,
  };
}

async function previewSiguienteRcc(pool, sql, empnit, coddoc) {
  const cod = String(coddoc || '').trim();
  const tipoRcc = cod
    ? await getTipoDocRccByCoddoc(pool, sql, empnit, cod)
    : await getTipoDocRcc(pool, sql, empnit);
  if (!tipoRcc) return null;
  const coddocRcc = tipoRcc.CODDOC;
  const maxRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddocRcc)
    .query(`
      SELECT ISNULL(MAX(CORRELATIVO), 0) AS maxCorr
      FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC
    `);
  const tipoCorr = Number(tipoRcc.CORRELATIVO) || 0;
  const maxCorr = Number(maxRes.recordset[0]?.maxCorr) || 0;
  const correlativo = Math.max(tipoCorr, maxCorr) + 1;
  return {
    CODDOC: coddocRcc,
    DESDOC: tipoRcc.DESDOC ?? null,
    TIPODOC: tipoRcc.TIPODOC ?? TIPODOC_RCC,
    CORRELATIVO: correlativo,
  };
}

async function loadFacturaCxc(pool, sql, empnit, coddoc, correlativo) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT
        d.*,
        t.DESDOC,
        t.TIPODOC,
        c.NEGOCIO,
        ISNULL(emp.NOMEMPLEADO, '') AS VENDEDOR
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.CLIENTES c ON d.EMPNIT = c.EMPNIT AND d.CODCLIENTE = c.CODCLIENTE
      LEFT OUTER JOIN dbo.Empleados emp ON emp.EMPNIT = d.EMPNIT AND emp.CODEMPLEADO = d.CODVEN
      WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
        AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_COBRAR_IN})
        AND d.STATUS = '${STATUS_OPERADO}'
        AND ISNULL(d.CONCRE, 'CON') = 'CRE'
        AND ${SQL_TIPODOC_REPORTES_SI}
    `);
  return result.recordset[0] || null;
}

async function fetchAbonosFactura(pool, sql, empnit, facCoddoc, facCorrelativo) {
  const correlativoFac = parseCorrelativo(facCorrelativo);
  if (!facCoddoc || correlativoFac === null) return [];

  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('SERIEFAC', sql.VarChar, String(facCoddoc).trim())
    .input('NOFAC', sql.VarChar, String(correlativoFac))
    .input('FAC_CORRELATIVO', sql.Decimal(18, 0), correlativoFac)
    .query(`
      SELECT
        d.FECHA,
        d.CODDOC,
        d.CORRELATIVO,
        t.TIPODOC,
        t.DESDOC,
        ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
        ISNULL(d.FPAGO_EFECTIVO, 0) AS FPAGO_EFECTIVO,
        ISNULL(d.FPAGO_TARJETA, 0) AS FPAGO_TARJETA,
        ISNULL(d.FPAGO_DEPOSITO, 0) AS FPAGO_DEPOSITO,
        ISNULL(d.FPAGO_CHEQUE, 0) AS FPAGO_CHEQUE,
        ISNULL(d.FPAGO_DESCRIPCION, '') AS FPAGO_DESCRIPCION,
        d.SERIEFAC,
        d.NOFAC,
        d.USUARIO,
        d.OBS
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${SQL_TIPODOC_ABONO_CXC_IN})
        AND t.TIPODOC <> 'PRC'
        AND ${SQL_MATCH_FACTURA_REF}
        AND d.STATUS = '${STATUS_OPERADO}'

      UNION ALL

      SELECT
        TRY_CONVERT(date, a.FECHA) AS FECHA,
        a.CODDOC,
        a.CORRELATIVO,
        t.TIPODOC,
        t.DESDOC,
        ISNULL(a.ABONO, 0) AS TOTALPRECIO,
        ISNULL(d.FPAGO_EFECTIVO, 0) AS FPAGO_EFECTIVO,
        ISNULL(d.FPAGO_TARJETA, 0) AS FPAGO_TARJETA,
        ISNULL(d.FPAGO_DEPOSITO, 0) AS FPAGO_DEPOSITO,
        ISNULL(d.FPAGO_CHEQUE, 0) AS FPAGO_CHEQUE,
        ISNULL(d.FPAGO_DESCRIPCION, '') AS FPAGO_DESCRIPCION,
        a.CODDOC_FAC AS SERIEFAC,
        CAST(a.CORRELATIVO_FAC AS VARCHAR(30)) AS NOFAC,
        d.USUARIO,
        d.OBS
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      INNER JOIN dbo.DOCUMENTOS d
        ON d.EMPNIT = a.EMPNIT AND d.CODDOC = a.CODDOC AND d.CORRELATIVO = a.CORRELATIVO
      INNER JOIN dbo.TIPODOCUMENTOS t
        ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      WHERE a.EMPNIT = @EMPNIT
        AND LTRIM(RTRIM(a.CODDOC_FAC)) = LTRIM(RTRIM(@SERIEFAC))
        AND CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
        AND t.TIPODOC = 'PRC'
        AND d.STATUS = '${STATUS_OPERADO}'
        AND UPPER(LTRIM(RTRIM(ISNULL(d.CODEMBARQUE, '')))) = 'CXC'
        AND ISNULL(d.CODCAJA, 0) > 0

      UNION ALL

      SELECT
        TRY_CONVERT(date, a.FECHA) AS FECHA,
        a.CODDOC,
        a.CORRELATIVO,
        t.TIPODOC,
        t.DESDOC,
        ISNULL(a.ABONO, 0) AS TOTALPRECIO,
        ISNULL(d.FPAGO_EFECTIVO, 0) AS FPAGO_EFECTIVO,
        ISNULL(d.FPAGO_TARJETA, 0) AS FPAGO_TARJETA,
        ISNULL(d.FPAGO_DEPOSITO, 0) AS FPAGO_DEPOSITO,
        ISNULL(d.FPAGO_CHEQUE, 0) AS FPAGO_CHEQUE,
        ISNULL(d.FPAGO_DESCRIPCION, '') AS FPAGO_DESCRIPCION,
        a.CODDOC_FAC AS SERIEFAC,
        CAST(a.CORRELATIVO_FAC AS VARCHAR(30)) AS NOFAC,
        d.USUARIO,
        d.OBS
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      INNER JOIN dbo.DOCUMENTOS d
        ON d.EMPNIT = a.EMPNIT AND d.CODDOC = a.CODDOC AND d.CORRELATIVO = a.CORRELATIVO
      INNER JOIN dbo.TIPODOCUMENTOS t
        ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      WHERE a.EMPNIT = @EMPNIT
        AND LTRIM(RTRIM(a.CODDOC_FAC)) = LTRIM(RTRIM(@SERIEFAC))
        AND CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
        AND t.TIPODOC IN (${SQL_TIPODOC_RETENCION_CXC_IN})
        AND d.STATUS = '${STATUS_OPERADO}'
        AND UPPER(LTRIM(RTRIM(ISNULL(d.CORTE, 'NO')))) = 'SI'

      ORDER BY FECHA DESC, CORRELATIVO DESC
    `);
  return result.recordset.map((r) => ({
    FECHA: r.FECHA ?? null,
    CODDOC: r.CODDOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    TIPODOC: r.TIPODOC ?? null,
    DESDOC: r.DESDOC ?? null,
    TOTALPRECIO: toNumber(r.TOTALPRECIO),
    FPAGO_EFECTIVO: toNumber(r.FPAGO_EFECTIVO),
    FPAGO_TARJETA: toNumber(r.FPAGO_TARJETA),
    FPAGO_DEPOSITO: toNumber(r.FPAGO_DEPOSITO),
    FPAGO_CHEQUE: toNumber(r.FPAGO_CHEQUE),
    FPAGO_DESCRIPCION: String(r.FPAGO_DESCRIPCION ?? '').trim(),
    SERIEFAC: r.SERIEFAC ?? null,
    NOFAC: r.NOFAC ?? null,
    USUARIO: r.USUARIO ?? null,
    OBS: r.OBS ?? null,
  }));
}

/**
 * Aplica DOC_ABONO / DOC_SALDO de una factura desde la suma real de abonos
 * (RCC/RAR/DEV/FNC por SERIEFAC/NOFAC + PRC finalizados + retenciones RVR/RIR
 * en DOCUMENTOS_FACTURAS_ABONADAS sobre la misma factura).
 * Evita el “+=” incremental que puede dejar saldo al doble si el UPDATE corre más de una vez.
 */
async function aplicarSaldoFacturaDesdeAbonos(transaction, sql, empnit, facCoddoc, facCorrelativo) {
  const facCod = String(facCoddoc || '').trim();
  const corr = parseCorrelativo(facCorrelativo);
  if (!facCod || corr === null) {
    const err = new Error('Documento de factura inválido');
    err.statusCode = 400;
    throw err;
  }

  const sumRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('SERIEFAC', sql.VarChar, facCod)
    .input('NOFAC', sql.VarChar, String(corr))
    .input('FAC_CORRELATIVO', sql.Decimal(18, 0), corr)
    .query(`
      SELECT
        (
          SELECT ISNULL(SUM(ISNULL(a.TOTALPRECIO, 0)), 0)
          FROM dbo.DOCUMENTOS a
          INNER JOIN dbo.TIPODOCUMENTOS ta ON ta.EMPNIT = a.EMPNIT AND ta.CODDOC = a.CODDOC
          WHERE a.EMPNIT = @EMPNIT
            AND a.STATUS = '${STATUS_OPERADO}'
            AND ta.TIPODOC IN (${SQL_TIPODOC_ABONO_CXC_IN})
            AND ta.TIPODOC <> 'PRC'
            AND LTRIM(RTRIM(a.SERIEFAC)) = LTRIM(RTRIM(@SERIEFAC))
            AND (
              LTRIM(RTRIM(a.NOFAC)) = LTRIM(RTRIM(@NOFAC))
              OR TRY_CAST(LTRIM(RTRIM(a.NOFAC)) AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
            )
        )
        +
        (
          SELECT ISNULL(SUM(ISNULL(x.ABONO, 0)), 0)
          FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS x
          INNER JOIN dbo.DOCUMENTOS p
            ON p.EMPNIT = x.EMPNIT AND p.CODDOC = x.CODDOC AND p.CORRELATIVO = x.CORRELATIVO
          INNER JOIN dbo.TIPODOCUMENTOS tp
            ON tp.EMPNIT = p.EMPNIT AND tp.CODDOC = p.CODDOC
          WHERE x.EMPNIT = @EMPNIT
            AND LTRIM(RTRIM(x.CODDOC_FAC)) = LTRIM(RTRIM(@SERIEFAC))
            AND CAST(x.CORRELATIVO_FAC AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
            AND p.STATUS = '${STATUS_OPERADO}'
            AND tp.TIPODOC = 'PRC'
            AND UPPER(LTRIM(RTRIM(ISNULL(p.CODEMBARQUE, '')))) = 'CXC'
            AND ISNULL(p.CODCAJA, 0) > 0
        )
        +
        (
          SELECT ISNULL(SUM(ISNULL(x.ABONO, 0)), 0)
          FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS x
          INNER JOIN dbo.DOCUMENTOS p
            ON p.EMPNIT = x.EMPNIT AND p.CODDOC = x.CODDOC AND p.CORRELATIVO = x.CORRELATIVO
          INNER JOIN dbo.TIPODOCUMENTOS tp
            ON tp.EMPNIT = p.EMPNIT AND tp.CODDOC = p.CODDOC
          WHERE x.EMPNIT = @EMPNIT
            AND LTRIM(RTRIM(x.CODDOC_FAC)) = LTRIM(RTRIM(@SERIEFAC))
            AND CAST(x.CORRELATIVO_FAC AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
            AND p.STATUS = '${STATUS_OPERADO}'
            AND tp.TIPODOC IN (${SQL_TIPODOC_RETENCION_CXC_IN})
            AND UPPER(LTRIM(RTRIM(ISNULL(p.CORTE, 'NO')))) = 'SI'
        ) AS TOTAL_ABONOS
    `);

  const totalAbonos = roundMoney(toNumber(sumRes.recordset[0]?.TOTAL_ABONOS));

  const updRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, facCod)
    .input('CORRELATIVO', sql.Decimal(18, 0), corr)
    .input('DOC_ABONO', sql.Decimal(18, 3), totalAbonos)
    .query(`
      UPDATE dbo.DOCUMENTOS
      SET
        ${sqlSetDocSaldoFromAbonos('TOTALPRECIO', '@DOC_ABONO')}
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);

  const selRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, facCod)
    .input('CORRELATIVO', sql.Decimal(18, 0), corr)
    .query(`
      SELECT
        ISNULL(DOC_ABONO, 0) AS DOC_ABONO,
        ISNULL(DOC_SALDO, 0) AS DOC_SALDO,
        ISNULL(TOTALPRECIO, 0) AS TOTALPRECIO
      FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
    `);

  const row = selRes.recordset?.[0] || {};
  return {
    DOC_ABONO: roundMoney(toNumber(row.DOC_ABONO)),
    DOC_SALDO: roundMoney(toNumber(row.DOC_SALDO)),
    TOTALPRECIO: roundMoney(toNumber(row.TOTALPRECIO)),
  };
}

async function crearAbonoRcc(pool, sql, empnit, facCoddoc, facCorrelativo, body) {
  const correlativoFac = parseCorrelativo(facCorrelativo);
  if (!facCoddoc || correlativoFac === null) {
    const err = new Error('Documento de factura inválido');
    err.statusCode = 400;
    throw err;
  }

  const abono = roundMoney(body?.MONTO ?? body?.TOTALPRECIO ?? body?.abono);
  if (abono <= 0) {
    const err = new Error('El monto del abono debe ser mayor a cero');
    err.statusCode = 400;
    throw err;
  }

  const usuario = String(body?.USUARIO || body?.usuario || 'CXC').trim();
  const obs = String(body?.OBS || '').trim();
  const fpago = resolveFormasPago(body, abono);

  const coddocRccReq = String(body?.CODDOC_RCC ?? body?.CODDOC ?? '').trim();
  const tipoRcc = coddocRccReq
    ? await getTipoDocRccByCoddoc(pool, sql, empnit, coddocRccReq)
    : await getTipoDocRcc(pool, sql, empnit);
  if (!tipoRcc) {
    const err = new Error(
      coddocRccReq
        ? `El documento ${coddocRccReq} no es un tipo RCC activo`
        : 'No hay tipo de documento RCC activo para la empresa'
    );
    err.statusCode = 400;
    throw err;
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const facRes = await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, facCoddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativoFac)
      .query(`
        SELECT
          d.CODCLIENTE, d.DOC_NIT, d.DOC_NOMCLIE, d.DOC_DIRCLIE, d.CODVEN,
          ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
          ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
          ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
          d.STATUS,
          ISNULL(d.CONCRE, 'CON') AS CONCRE,
          t.TIPODOC
        FROM dbo.DOCUMENTOS d WITH (UPDLOCK, ROWLOCK)
        INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
        WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
          AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_COBRAR_IN})
          AND d.STATUS = '${STATUS_OPERADO}'
          AND ISNULL(d.CONCRE, 'CON') = 'CRE'
      `);
    if (!facRes.recordset.length) {
      const err = new Error('Factura al crédito no encontrada o no válida');
      err.statusCode = 404;
      throw err;
    }
    const fac = facRes.recordset[0];
    const totalFac = roundMoney(toNumber(fac.TOTALPRECIO));
    // Saldo efectivo a 2 decimales; milésimas no bloquean el abono.
    const docSaldo = saldoEfectivo(fac.DOC_SALDO, totalFac, fac.DOC_ABONO);
    if (abonoSuperaSaldo(abono, docSaldo)) {
      const err = new Error(`El abono no puede superar el saldo (${docSaldo})`);
      err.statusCode = 400;
      throw err;
    }

    const parts = nowParts();
    const coddocRcc = tipoRcc.CODDOC;
    const correlativoRcc = await allocateCorrelativo(transaction, sql, empnit, coddocRcc);
    const codcaja = await resolveCodcajaAbierta(transaction, sql, empnit, body);
    const obsRcc =
      obs ||
      `Abono a factura ${facCoddoc}-${correlativoFac}`;

    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ANIO', sql.Int, parts.anio)
      .input('MES', sql.Int, parts.mes)
      .input('DIA', sql.Int, parts.dia)
      .input('FECHA', sql.Date, parts.fecha)
      .input('HORA', sql.Int, parts.hora)
      .input('MINUTO', sql.Int, parts.minuto)
      .input('CODDOC', sql.VarChar, coddocRcc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativoRcc)
      .input('CODCLIENTE', sql.Int, fac.CODCLIENTE)
      .input('DOC_NIT', sql.VarChar, String(fac.DOC_NIT || 'CF'))
      .input('DOC_NOMCLIE', sql.VarChar, String(fac.DOC_NOMCLIE || ''))
      .input('DOC_DIRCLIE', sql.VarChar, String(fac.DOC_DIRCLIE || 'SN'))
      .input('CODVEN', sql.Int, fac.CODVEN != null ? Number(fac.CODVEN) : null)
      .input('TOTALPRECIO', sql.Decimal(18, 3), abono)
      .input('USUARIO', sql.VarChar, usuario)
      .input('OBS', sql.VarChar, obsRcc)
      .input('SERIEFAC', sql.VarChar, facCoddoc)
      .input('NOFAC', sql.VarChar, String(correlativoFac))
      .input('CODCAJA', sql.Int, codcaja)
      .input('FPAGO_EFECTIVO', sql.Decimal(18, 3), fpago.FPAGO_EFECTIVO)
      .input('FPAGO_TARJETA', sql.Decimal(18, 3), fpago.FPAGO_TARJETA)
      .input('FPAGO_DEPOSITO', sql.Decimal(18, 3), fpago.FPAGO_DEPOSITO)
      .input('FPAGO_CHEQUE', sql.Decimal(18, 3), fpago.FPAGO_CHEQUE)
      .input('FPAGO_DESCRIPCION', sql.VarChar, fpago.FPAGO_DESCRIPCION || '')
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
          @CODCLIENTE, @DOC_NIT, @DOC_NOMCLIE, @DOC_DIRCLIE, @CODVEN,
          0, @TOTALPRECIO, 'MOSTRADOR', '${STATUS_OPERADO}', @USUARIO, 'CON', 'NO',
          'SN', @OBS, 0, 0, 'SN', 0,
          'SN', 'SN', 0, 0, 'CONTADO', 'SN',
          @FECHA, 0, 0, 0, @TOTALPRECIO, 0,
          @SERIEFAC, @NOFAC, @CODCAJA,
          @FPAGO_EFECTIVO, @FPAGO_TARJETA, @FPAGO_DEPOSITO, @FPAGO_CHEQUE, @FPAGO_DESCRIPCION
        )
      `);

    // Fuente de verdad: suma de recibos/notas ligados (incluye el RCC recién insertado).
    const aplicado = await aplicarSaldoFacturaDesdeAbonos(
      transaction,
      sql,
      empnit,
      facCoddoc,
      correlativoFac
    );

    await transaction.commit();
    return {
      ok: true,
      abono: {
        CODDOC: coddocRcc,
        CORRELATIVO: correlativoRcc,
        TIPODOC: TIPODOC_RCC,
        TOTALPRECIO: abono,
        SERIEFAC: facCoddoc,
        NOFAC: String(correlativoFac),
        CODCAJA: codcaja,
      },
      factura: {
        CODDOC: facCoddoc,
        CORRELATIVO: correlativoFac,
        DOC_ABONO: aplicado.DOC_ABONO,
        DOC_SALDO: aplicado.DOC_SALDO,
        SALDO_PENDIENTE: aplicado.DOC_SALDO,
      },
    };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/**
 * Recalcula DOC_ABONO y DOC_SALDO de todas las facturas al crédito operadas,
 * sumando RCC/RAR/DEV/FNC (SERIEFAC/NOFAC), PRC finalizados (DOCUMENTOS_FACTURAS_ABONADAS),
 * retenciones recibidas RVR/RIR finalizadas (sobre FEL), y abonos bancarios solo cuando no
 * existan ya como recibo operado.
 */
async function corregirSaldosCxc(pool, sql, empnit) {
  const countRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT COUNT(*) AS cnt
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_COBRAR_IN})
        AND d.STATUS = '${STATUS_OPERADO}'
        AND ISNULL(d.CONCRE, 'CON') = 'CRE'
        AND ${SQL_TIPODOC_REPORTES_SI}
    `);
  const totalFacturas = Number(countRes.recordset[0]?.cnt) || 0;

  const updRes = await pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
    ;WITH DocAbonos AS (
      SELECT
        a.EMPNIT,
        LTRIM(RTRIM(a.SERIEFAC)) AS FAC_CODDOC,
        TRY_CAST(LTRIM(RTRIM(a.NOFAC)) AS DECIMAL(18, 0)) AS FAC_CORRELATIVO,
        ISNULL(SUM(ISNULL(a.TOTALPRECIO, 0)), 0) AS TOTAL_ABONOS
      FROM dbo.DOCUMENTOS a
      INNER JOIN dbo.TIPODOCUMENTOS ta ON ta.EMPNIT = a.EMPNIT AND ta.CODDOC = a.CODDOC
      WHERE a.EMPNIT = @EMPNIT
        AND a.STATUS = '${STATUS_OPERADO}'
        AND ta.TIPODOC IN (${SQL_TIPODOC_ABONO_CXC_IN})
        AND ta.TIPODOC <> 'PRC'
        AND LTRIM(RTRIM(ISNULL(a.SERIEFAC, ''))) <> ''
        AND TRY_CAST(LTRIM(RTRIM(a.NOFAC)) AS DECIMAL(18, 0)) IS NOT NULL
      GROUP BY
        a.EMPNIT,
        LTRIM(RTRIM(a.SERIEFAC)),
        TRY_CAST(LTRIM(RTRIM(a.NOFAC)) AS DECIMAL(18, 0))
    ),
    PrcAbonos AS (
      SELECT
        a.EMPNIT,
        LTRIM(RTRIM(a.CODDOC_FAC)) AS FAC_CODDOC,
        CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0)) AS FAC_CORRELATIVO,
        ISNULL(SUM(ISNULL(a.ABONO, 0)), 0) AS TOTAL_ABONOS
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      INNER JOIN dbo.DOCUMENTOS p
        ON p.EMPNIT = a.EMPNIT AND p.CODDOC = a.CODDOC AND p.CORRELATIVO = a.CORRELATIVO
      INNER JOIN dbo.TIPODOCUMENTOS tp
        ON tp.EMPNIT = p.EMPNIT AND tp.CODDOC = p.CODDOC
      WHERE a.EMPNIT = @EMPNIT
        AND p.STATUS = '${STATUS_OPERADO}'
        AND tp.TIPODOC = 'PRC'
        AND UPPER(LTRIM(RTRIM(ISNULL(p.CODEMBARQUE, '')))) = 'CXC'
        AND ISNULL(p.CODCAJA, 0) > 0
        AND LTRIM(RTRIM(ISNULL(a.CODDOC_FAC, ''))) <> ''
        AND a.CORRELATIVO_FAC IS NOT NULL
      GROUP BY
        a.EMPNIT,
        LTRIM(RTRIM(a.CODDOC_FAC)),
        CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0))
    ),
    RetencionesAbonos AS (
      SELECT
        a.EMPNIT,
        LTRIM(RTRIM(a.CODDOC_FAC)) AS FAC_CODDOC,
        CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0)) AS FAC_CORRELATIVO,
        ISNULL(SUM(ISNULL(a.ABONO, 0)), 0) AS TOTAL_ABONOS
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      INNER JOIN dbo.DOCUMENTOS p
        ON p.EMPNIT = a.EMPNIT AND p.CODDOC = a.CODDOC AND p.CORRELATIVO = a.CORRELATIVO
      INNER JOIN dbo.TIPODOCUMENTOS tp
        ON tp.EMPNIT = p.EMPNIT AND tp.CODDOC = p.CODDOC
      WHERE a.EMPNIT = @EMPNIT
        AND p.STATUS = '${STATUS_OPERADO}'
        AND tp.TIPODOC IN (${SQL_TIPODOC_RETENCION_CXC_IN})
        AND UPPER(LTRIM(RTRIM(ISNULL(p.CORTE, 'NO')))) = 'SI'
        AND LTRIM(RTRIM(ISNULL(a.CODDOC_FAC, ''))) <> ''
        AND a.CORRELATIVO_FAC IS NOT NULL
      GROUP BY
        a.EMPNIT,
        LTRIM(RTRIM(a.CODDOC_FAC)),
        CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0))
    ),
    BancoAbonos AS (
      SELECT
        a.EMPNIT,
        LTRIM(RTRIM(a.CODDOC_FAC)) AS FAC_CODDOC,
        CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0)) AS FAC_CORRELATIVO,
        ISNULL(SUM(ISNULL(a.ABONO, 0)), 0) AS TOTAL_ABONOS
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      WHERE a.EMPNIT = @EMPNIT
        AND LTRIM(RTRIM(ISNULL(a.CODDOC_FAC, ''))) <> ''
        AND a.CORRELATIVO_FAC IS NOT NULL
        AND NOT EXISTS (
          /* Cabecera PRC (borrador o final) — se cuenta en PrcAbonos si aplica */
          SELECT 1
          FROM dbo.DOCUMENTOS p
          INNER JOIN dbo.TIPODOCUMENTOS tp
            ON tp.EMPNIT = p.EMPNIT AND tp.CODDOC = p.CODDOC
          WHERE p.EMPNIT = a.EMPNIT
            AND p.CODDOC = a.CODDOC
            AND p.CORRELATIVO = a.CORRELATIVO
            AND tp.TIPODOC = 'PRC'
        )
        AND NOT EXISTS (
          /* Retención RVR/RIR — se cuenta en RetencionesAbonos */
          SELECT 1
          FROM dbo.DOCUMENTOS p
          INNER JOIN dbo.TIPODOCUMENTOS tp
            ON tp.EMPNIT = p.EMPNIT AND tp.CODDOC = p.CODDOC
          WHERE p.EMPNIT = a.EMPNIT
            AND p.CODDOC = a.CODDOC
            AND p.CORRELATIVO = a.CORRELATIVO
            AND tp.TIPODOC IN (${SQL_TIPODOC_RETENCION_CXC_IN})
        )
        AND NOT EXISTS (
          /* Abono por retención RAR — se cuenta en DocAbonos (SERIEFAC/NOFAC) */
          SELECT 1
          FROM dbo.DOCUMENTOS p
          INNER JOIN dbo.TIPODOCUMENTOS tp
            ON tp.EMPNIT = p.EMPNIT AND tp.CODDOC = p.CODDOC
          WHERE p.EMPNIT = a.EMPNIT
            AND p.CODDOC = a.CODDOC
            AND p.CORRELATIVO = a.CORRELATIVO
            AND tp.TIPODOC = '${TIPODOC_RAR}'
        )
        AND NOT EXISTS (
          /* Recibo bancario ya operado (enlace directo) */
          SELECT 1
          FROM dbo.DOCUMENTOS r
          WHERE r.EMPNIT = a.EMPNIT
            AND a.CODDOC_REC IS NOT NULL
            AND a.CORRELATIVO_REC IS NOT NULL
            AND r.CODDOC = a.CODDOC_REC
            AND r.CORRELATIVO = a.CORRELATIVO_REC
            AND r.STATUS = '${STATUS_OPERADO}'
        )
        AND NOT EXISTS (
          /* Cualquier RCC/DEV/FNC operado ya ligado a la misma factura */
          SELECT 1
          FROM dbo.DOCUMENTOS r
          INNER JOIN dbo.TIPODOCUMENTOS tr
            ON tr.EMPNIT = r.EMPNIT AND tr.CODDOC = r.CODDOC
          WHERE r.EMPNIT = a.EMPNIT
            AND r.STATUS = '${STATUS_OPERADO}'
            AND tr.TIPODOC IN (${SQL_TIPODOC_ABONO_CXC_IN})
            AND tr.TIPODOC <> 'PRC'
            AND LTRIM(RTRIM(ISNULL(r.SERIEFAC, ''))) = LTRIM(RTRIM(a.CODDOC_FAC))
            AND TRY_CAST(LTRIM(RTRIM(r.NOFAC)) AS DECIMAL(18, 0)) = CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0))
        )
      GROUP BY
        a.EMPNIT,
        LTRIM(RTRIM(a.CODDOC_FAC)),
        CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0))
    ),
    AbonosFactura AS (
      SELECT
        EMPNIT,
        FAC_CODDOC,
        FAC_CORRELATIVO,
        ISNULL(SUM(TOTAL_ABONOS), 0) AS TOTAL_ABONOS
      FROM (
        SELECT EMPNIT, FAC_CODDOC, FAC_CORRELATIVO, TOTAL_ABONOS FROM DocAbonos
        UNION ALL
        SELECT EMPNIT, FAC_CODDOC, FAC_CORRELATIVO, TOTAL_ABONOS FROM PrcAbonos
        UNION ALL
        SELECT EMPNIT, FAC_CODDOC, FAC_CORRELATIVO, TOTAL_ABONOS FROM RetencionesAbonos
        UNION ALL
        SELECT EMPNIT, FAC_CODDOC, FAC_CORRELATIVO, TOTAL_ABONOS FROM BancoAbonos
      ) x
      GROUP BY EMPNIT, FAC_CODDOC, FAC_CORRELATIVO
    )
    UPDATE d
    SET
      ${sqlSetDocSaldoFromAbonos('d.TOTALPRECIO', 'ab.TOTAL_ABONOS', 'd.', TOLERANCIA_ABONO_RETENCION)}
    FROM dbo.DOCUMENTOS d
    INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
    LEFT JOIN AbonosFactura ab
      ON ab.EMPNIT = d.EMPNIT
      AND ab.FAC_CODDOC = LTRIM(RTRIM(d.CODDOC))
      AND ab.FAC_CORRELATIVO = d.CORRELATIVO
    WHERE d.EMPNIT = @EMPNIT
      AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_COBRAR_IN})
      AND d.STATUS = '${STATUS_OPERADO}'
      AND ISNULL(d.CONCRE, 'CON') = 'CRE'
      AND ${SQL_TIPODOC_REPORTES_SI}
  `);

  return {
    ok: true,
    totalFacturas,
    actualizadas: Number(updRes.rowsAffected?.[updRes.rowsAffected.length - 1]) || Number(updRes.rowsAffected[0]) || 0,
  };
}

function rarLineToken(retCod, retCorr, felCod, felCorr) {
  return `[${String(retCod || '').trim()}#${Math.trunc(Number(retCorr))}|${String(felCod || '').trim()}#${Math.trunc(Number(felCorr))}]`;
}

async function listTiposDocRar(pool, sql, empnit) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('TIPODOC', sql.VarChar, TIPODOC_RAR)
    .query(`
      SELECT CODDOC, DESDOC, TIPODOC, ISNULL(CORRELATIVO, 0) AS CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND TIPODOC = @TIPODOC AND ACTIVO = 'SI'
      ORDER BY CODDOC
    `);
  return result.recordset.map((r) => ({
    CODDOC: r.CODDOC ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: r.TIPODOC ?? TIPODOC_RAR,
    CORRELATIVO: Number(r.CORRELATIVO) || 0,
  }));
}

async function getTipoDocRar(pool, sql, empnit) {
  const tipos = await listTiposDocRar(pool, sql, empnit);
  return tipos[0] || null;
}

async function getTipoDocRarByCoddoc(pool, sql, empnit, coddoc) {
  const cod = String(coddoc || '').trim();
  if (!cod) return null;
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, cod)
    .input('TIPODOC', sql.VarChar, TIPODOC_RAR)
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
    TIPODOC: row.TIPODOC ?? TIPODOC_RAR,
    CORRELATIVO: Number(row.CORRELATIVO) || 0,
  };
}

async function previewSiguienteRar(pool, sql, empnit, coddoc) {
  const cod = String(coddoc || '').trim();
  const tipoRar = cod
    ? await getTipoDocRarByCoddoc(pool, sql, empnit, cod)
    : await getTipoDocRar(pool, sql, empnit);
  if (!tipoRar) return null;
  const coddocRar = tipoRar.CODDOC;
  const maxRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddocRar)
    .query(`
      SELECT ISNULL(MAX(CORRELATIVO), 0) AS maxCorr
      FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC
    `);
  const tipoCorr = Number(tipoRar.CORRELATIVO) || 0;
  const maxCorr = Number(maxRes.recordset[0]?.maxCorr) || 0;
  return {
    CODDOC: coddocRar,
    DESDOC: tipoRar.DESDOC ?? null,
    TIPODOC: tipoRar.TIPODOC ?? TIPODOC_RAR,
    CORRELATIVO: Math.max(tipoCorr, maxCorr) + 1,
  };
}

function mapRarReferenciaRow(r) {
  const tiporet = String(r.TIPODOC_RET || '').trim().toUpperCase();
  return {
    KEY: `${String(r.CODDOC_RET).trim()}|${Math.trunc(Number(r.CORRELATIVO_RET))}|${String(r.FEL_CODDOC).trim()}|${Math.trunc(Number(r.FEL_CORRELATIVO))}`,
    CODDOC_RET: r.CODDOC_RET ?? null,
    CORRELATIVO_RET: r.CORRELATIVO_RET ?? null,
    TIPODOC_RET: tiporet,
    DESDOC_RET: r.DESDOC_RET ?? null,
    CLASE: tiporet === 'RIR' ? 'ISR' : tiporet === 'RVR' ? 'IVA' : tiporet,
    FECHA: fechaIsoFromValue(r.RET_FECHA || r.RET_LINEA_FECHA) || null,
    ABONO: roundMoney(toNumber(r.ABONO)),
    FEL_CODDOC: r.FEL_CODDOC ?? null,
    FEL_CORRELATIVO: r.FEL_CORRELATIVO ?? null,
    FEL_TIPODOC: r.FEL_TIPODOC ?? null,
    FEL_DESDOC: r.FEL_DESDOC ?? null,
    FEL_SERIE: String(r.FEL_SERIE || '').trim() || null,
    FEL_NUMERO: String(r.FEL_NUMERO || '').trim() || null,
    FEL_FECHA: fechaIsoFromValue(r.FEL_FECHA) || null,
    FEL_TOTALPRECIO: roundMoney(toNumber(r.FEL_TOTALPRECIO)),
  };
}

function rarRetencionDocKey(coddoc, correlativo) {
  return `${String(coddoc || '').trim()}|${Math.trunc(Number(correlativo))}`;
}

/** Una fila por documento de referencia; el SQL ya limitó a la FAC elegida. */
function groupRetencionesPorDocumento(rows) {
  const byDoc = new Map();
  for (const row of rows || []) {
    const k = rarRetencionDocKey(row.CODDOC_RET, row.CORRELATIVO_RET);
    const prev = byDoc.get(k);
    const linea = {
      FEL_CODDOC: row.FEL_CODDOC,
      FEL_CORRELATIVO: row.FEL_CORRELATIVO,
      ABONO: row.ABONO,
    };
    const felKey = `${String(row.FEL_CODDOC || '').trim()}|${Math.trunc(Number(row.FEL_CORRELATIVO) || 0)}`;
    if (!prev) {
      byDoc.set(k, { ...row, KEY: k, LINEAS: [linea] });
    } else {
      prev.ABONO = roundMoney(prev.ABONO + row.ABONO);
      if (
        !prev.LINEAS.some(
          (l) =>
            `${String(l.FEL_CODDOC || '').trim()}|${Math.trunc(Number(l.FEL_CORRELATIVO) || 0)}` === felKey
        )
      ) {
        prev.LINEAS.push(linea);
      }
    }
  }
  return [...byDoc.values()];
}

function sqlNotExistsRarToken(aliasDoc, aliasFel) {
  return `
        AND NOT EXISTS (
          SELECT 1
          FROM dbo.DOCUMENTOS rar
          INNER JOIN dbo.TIPODOCUMENTOS trar
            ON trar.EMPNIT = rar.EMPNIT AND trar.CODDOC = rar.CODDOC
          WHERE rar.EMPNIT = ${aliasDoc}.EMPNIT
            AND rar.STATUS = '${STATUS_OPERADO}'
            AND trar.TIPODOC = '${TIPODOC_RAR}'
            AND LTRIM(RTRIM(ISNULL(rar.SERIEFAC, ''))) = LTRIM(RTRIM(@SERIEFAC))
            AND TRY_CAST(LTRIM(RTRIM(rar.NOFAC)) AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
            AND CHARINDEX(
              '[' + LTRIM(RTRIM(${aliasDoc}.CODDOC)) + '#' + CAST(CAST(${aliasDoc}.CORRELATIVO AS BIGINT) AS VARCHAR(30))
              + '|' + LTRIM(RTRIM(${aliasFel}.CODDOC)) + '#' + CAST(CAST(${aliasFel}.CORRELATIVO AS BIGINT) AS VARCHAR(30)) + ']',
              ISNULL(rar.OBS, '')
            ) > 0
        )`;
}

/** FEL/FEC/FES emitida desde esta FAC (SERIEFAC = CODDOC FAC y NOFAC = correlativo FAC). */
function sqlFelEsDeEstaFac(aliasFel, aliasTipo) {
  return `
            ${aliasTipo}.TIPODOC IN (${SQL_TIPODOC_FEL_CXC_IN})
            AND LTRIM(RTRIM(ISNULL(${aliasFel}.SERIEFAC, ''))) = LTRIM(RTRIM(@SERIEFAC))
            AND TRY_CAST(LTRIM(RTRIM(${aliasFel}.NOFAC)) AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
  `;
}

/**
 * Referencias pendientes para RAR sobre una FAC:
 * retenciones RVR/RIR aplicadas a la FEL ligada a la FAC, y notas FNC/FNA
 * que referencian esa misma FEL. Excluye las ya usadas en un RAR.
 */
async function listRetencionesFelDeFac(pool, sql, empnit, facCoddoc, facCorrelativo) {
  const correlativoFac = parseCorrelativo(facCorrelativo);
  const facCod = String(facCoddoc || '').trim();
  if (!facCod || correlativoFac === null) {
    const err = new Error('Documento de factura inválido');
    err.statusCode = 400;
    throw err;
  }

  const fac = await loadFacturaCxc(pool, sql, empnit, facCod, correlativoFac);
  if (!fac) {
    const err = new Error('Factura al crédito no encontrada o no válida');
    err.statusCode = 404;
    throw err;
  }
  const tipodocFac = String(fac.TIPODOC || '').trim().toUpperCase();
  if (tipodocFac !== TIPODOC_FAC) {
    const err = new Error('El abono por retenciones solo aplica a facturas internas FAC');
    err.statusCode = 400;
    throw err;
  }

  const reqBase = () =>
    pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('SERIEFAC', sql.VarChar, facCod)
      .input('NOFAC', sql.VarChar, String(correlativoFac))
      .input('FAC_CORRELATIVO', sql.Decimal(18, 0), correlativoFac);

  const result = await reqBase().query(`
      SELECT
        a.ABONO,
        a.FECHA AS RET_LINEA_FECHA,
        ret.CODDOC AS CODDOC_RET,
        ret.CORRELATIVO AS CORRELATIVO_RET,
        ret.FECHA AS RET_FECHA,
        tr.TIPODOC AS TIPODOC_RET,
        tr.DESDOC AS DESDOC_RET,
        fel.CODDOC AS FEL_CODDOC,
        fel.CORRELATIVO AS FEL_CORRELATIVO,
        fel.FECHA AS FEL_FECHA,
        tf.TIPODOC AS FEL_TIPODOC,
        tf.DESDOC AS FEL_DESDOC,
        ISNULL(fel.FEL_SERIE, '') AS FEL_SERIE,
        ISNULL(fel.FEL_NUMERO, '') AS FEL_NUMERO,
        ISNULL(fel.TOTALPRECIO, 0) AS FEL_TOTALPRECIO
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      INNER JOIN dbo.DOCUMENTOS ret
        ON ret.EMPNIT = a.EMPNIT AND ret.CODDOC = a.CODDOC AND ret.CORRELATIVO = a.CORRELATIVO
      INNER JOIN dbo.TIPODOCUMENTOS tr
        ON tr.EMPNIT = ret.EMPNIT AND tr.CODDOC = ret.CODDOC
      INNER JOIN dbo.DOCUMENTOS fel
        ON fel.EMPNIT = a.EMPNIT
       AND LTRIM(RTRIM(fel.CODDOC)) = LTRIM(RTRIM(a.CODDOC_FAC))
       AND CAST(fel.CORRELATIVO AS DECIMAL(18, 0)) = CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0))
      INNER JOIN dbo.TIPODOCUMENTOS tf
        ON tf.EMPNIT = fel.EMPNIT AND tf.CODDOC = fel.CODDOC
      WHERE a.EMPNIT = @EMPNIT
        AND ret.STATUS = '${STATUS_OPERADO}'
        AND tr.TIPODOC IN (${SQL_TIPODOC_RETENCION_CXC_IN})
        AND UPPER(LTRIM(RTRIM(ISNULL(ret.CORTE, 'NO')))) = 'SI'
        AND fel.STATUS = '${STATUS_OPERADO}'
        AND ISNULL(a.ABONO, 0) > 0.005
        AND (
          (
            LTRIM(RTRIM(a.CODDOC_FAC)) = LTRIM(RTRIM(@SERIEFAC))
            AND CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
          )
          OR (
            ${sqlFelEsDeEstaFac('fel', 'tf')}
          )
        )
        ${sqlNotExistsRarToken('ret', 'fel')}
      ORDER BY tr.TIPODOC, ret.FECHA, ret.CODDOC, ret.CORRELATIVO
    `);

  const notasResult = await reqBase().query(`
      SELECT
        ISNULL(nc.TOTALPRECIO, 0) AS ABONO,
        nc.FECHA AS RET_LINEA_FECHA,
        nc.CODDOC AS CODDOC_RET,
        nc.CORRELATIVO AS CORRELATIVO_RET,
        nc.FECHA AS RET_FECHA,
        tn.TIPODOC AS TIPODOC_RET,
        tn.DESDOC AS DESDOC_RET,
        fel.CODDOC AS FEL_CODDOC,
        fel.CORRELATIVO AS FEL_CORRELATIVO,
        fel.FECHA AS FEL_FECHA,
        tf.TIPODOC AS FEL_TIPODOC,
        tf.DESDOC AS FEL_DESDOC,
        ISNULL(fel.FEL_SERIE, '') AS FEL_SERIE,
        ISNULL(fel.FEL_NUMERO, '') AS FEL_NUMERO,
        ISNULL(fel.TOTALPRECIO, 0) AS FEL_TOTALPRECIO
      FROM dbo.DOCUMENTOS nc
      INNER JOIN dbo.TIPODOCUMENTOS tn
        ON tn.EMPNIT = nc.EMPNIT AND tn.CODDOC = nc.CODDOC
      INNER JOIN dbo.DOCUMENTOS fel
        ON fel.EMPNIT = nc.EMPNIT
       AND LTRIM(RTRIM(fel.CODDOC)) = LTRIM(RTRIM(nc.SERIEFAC))
       AND CAST(fel.CORRELATIVO AS DECIMAL(18, 0)) = TRY_CAST(LTRIM(RTRIM(nc.NOFAC)) AS DECIMAL(18, 0))
      INNER JOIN dbo.TIPODOCUMENTOS tf
        ON tf.EMPNIT = fel.EMPNIT AND tf.CODDOC = fel.CODDOC
      WHERE nc.EMPNIT = @EMPNIT
        AND nc.STATUS = '${STATUS_OPERADO}'
        AND tn.TIPODOC IN (${SQL_TIPODOC_NOTA_FEL_CXC_IN})
        AND fel.STATUS = '${STATUS_OPERADO}'
        AND ISNULL(nc.TOTALPRECIO, 0) > 0.005
        AND (
          (
            LTRIM(RTRIM(nc.SERIEFAC)) = LTRIM(RTRIM(@SERIEFAC))
            AND TRY_CAST(LTRIM(RTRIM(nc.NOFAC)) AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
          )
          OR (
            ${sqlFelEsDeEstaFac('fel', 'tf')}
          )
        )
        ${sqlNotExistsRarToken('nc', 'fel')}
      ORDER BY tn.TIPODOC, nc.FECHA, nc.CODDOC, nc.CORRELATIVO
    `);

  const retenciones = groupRetencionesPorDocumento([
    ...(result.recordset || []).map(mapRarReferenciaRow),
    ...(notasResult.recordset || []).map(mapRarReferenciaRow),
  ]);

  return {
    factura: {
      CODDOC: facCod,
      CORRELATIVO: correlativoFac,
      TIPODOC: tipodocFac,
      DOC_NOMCLIE: fac.DOC_NOMCLIE ?? null,
      TOTALPRECIO: roundMoney(toNumber(fac.TOTALPRECIO)),
      DOC_ABONO: roundMoney(toNumber(fac.DOC_ABONO)),
      DOC_SALDO: roundMoney(toNumber(fac.DOC_SALDO)),
      SALDO_PENDIENTE: roundMoney(toNumber(fac.DOC_SALDO)),
    },
    retenciones,
  };
}

async function crearAbonoRar(pool, sql, empnit, facCoddoc, facCorrelativo, body) {
  const correlativoFac = parseCorrelativo(facCorrelativo);
  const facCod = String(facCoddoc || '').trim();
  if (!facCod || correlativoFac === null) {
    const err = new Error('Documento de factura inválido');
    err.statusCode = 400;
    throw err;
  }

  const rawLineas = Array.isArray(body?.lineas) ? body.lineas : Array.isArray(body?.LINEAS) ? body.LINEAS : [];
  if (!rawLineas.length) {
    const err = new Error('Seleccione al menos una retención o nota de crédito FEL (FNC/FNA) para abonar');
    err.statusCode = 400;
    throw err;
  }

  const usuario = String(body?.USUARIO || body?.usuario || 'CXC').trim();
  const obsExtra = String(body?.OBS || '').trim();
  const coddocRarReq = String(body?.CODDOC_RAR ?? body?.CODDOC ?? '').trim();
  const tipoRar = coddocRarReq
    ? await getTipoDocRarByCoddoc(pool, sql, empnit, coddocRarReq)
    : await getTipoDocRar(pool, sql, empnit);
  if (!tipoRar) {
    const err = new Error(
      coddocRarReq
        ? `El documento ${coddocRarReq} no es un tipo RAR activo`
        : 'No hay tipo de documento RAR activo. Créelo en Tipo Documentos (TIPODOC = RAR).'
    );
    err.statusCode = 400;
    throw err;
  }

  const disponibles = await listRetencionesFelDeFac(pool, sql, empnit, facCod, correlativoFac);
  const selected = [];
  const seen = new Set();
  for (const item of rawLineas) {
    const retCod = String(item?.CODDOC_RET || item?.coddoc_ret || '').trim();
    const retCorr = parseCorrelativo(item?.CORRELATIVO_RET ?? item?.correlativo_ret);
    const felCod = String(item?.FEL_CODDOC || item?.fel_coddoc || '').trim();
    const felCorr = parseCorrelativo(item?.FEL_CORRELATIVO ?? item?.fel_correlativo);
    if (!retCod || retCorr === null) {
      const err = new Error('Línea de referencia inválida');
      err.statusCode = 400;
      throw err;
    }
    const retKey = rarRetencionDocKey(retCod, retCorr);
    const fullKey =
      felCod && felCorr !== null ? `${retKey}|${felCod}|${Math.trunc(felCorr)}` : null;
    const row = (disponibles.retenciones || []).find((r) => r.KEY === fullKey || r.KEY === retKey);
    if (!row) {
      const err = new Error('Una o más referencias ya no están disponibles para abonar a esta FAC');
      err.statusCode = 400;
      throw err;
    }
    if (seen.has(row.KEY)) continue;
    seen.add(row.KEY);
    selected.push(row);
  }
  if (!selected.length) {
    const err = new Error('Seleccione al menos una retención o nota de crédito FEL (FNC/FNA) para abonar');
    err.statusCode = 400;
    throw err;
  }

  const totalAbono = roundMoney(selected.reduce((s, r) => s + r.ABONO, 0));
  if (totalAbono <= 0) {
    const err = new Error('El monto del abono debe ser mayor a cero');
    err.statusCode = 400;
    throw err;
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const facRes = await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, facCod)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativoFac)
      .query(`
        SELECT
          d.CODCLIENTE, d.DOC_NIT, d.DOC_NOMCLIE, d.DOC_DIRCLIE, d.CODVEN,
          ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
          ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
          ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
          t.TIPODOC
        FROM dbo.DOCUMENTOS d WITH (UPDLOCK, ROWLOCK)
        INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
        WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
          AND t.TIPODOC = '${TIPODOC_FAC}'
          AND d.STATUS = '${STATUS_OPERADO}'
          AND ISNULL(d.CONCRE, 'CON') = 'CRE'
      `);
    if (!facRes.recordset.length) {
      const err = new Error('Factura FAC al crédito no encontrada o no válida');
      err.statusCode = 404;
      throw err;
    }
    const fac = facRes.recordset[0];
    const totalFac = roundMoney(toNumber(fac.TOTALPRECIO));
    const docSaldo = saldoEfectivo(fac.DOC_SALDO, totalFac, fac.DOC_ABONO);
    if (abonoSuperaSaldo(totalAbono, docSaldo, TOLERANCIA_ABONO_RETENCION)) {
      const err = new Error(
        `La suma de referencias (${totalAbono}) supera el saldo de la FAC (${docSaldo})`
      );
      err.statusCode = 400;
      throw err;
    }

    const parts = nowParts();
    const fechaStr = parts.fecha;
    const tokens = [...new Set(selected.flatMap((r) => {
      const pares = Array.isArray(r.LINEAS) && r.LINEAS.length
        ? r.LINEAS
        : [{ FEL_CODDOC: r.FEL_CODDOC, FEL_CORRELATIVO: r.FEL_CORRELATIVO }];
      return pares.map((p) =>
        rarLineToken(r.CODDOC_RET, r.CORRELATIVO_RET, p.FEL_CODDOC, p.FEL_CORRELATIVO)
      );
    }))];
    const obsRar = `${tokens.join(' ')} ${obsExtra || `Abono ret./NC ${facCod}-${correlativoFac}`}`.slice(
      0,
      240
    );

    const coddocRar = tipoRar.CODDOC;
    const correlativoRar = await allocateCorrelativo(transaction, sql, empnit, coddocRar);

    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ANIO', sql.Int, parts.anio)
      .input('MES', sql.Int, parts.mes)
      .input('DIA', sql.Int, parts.dia)
      .input('FECHA', sql.Date, parts.fecha)
      .input('HORA', sql.Int, parts.hora)
      .input('MINUTO', sql.Int, parts.minuto)
      .input('CODDOC', sql.VarChar, coddocRar)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativoRar)
      .input('CODCLIENTE', sql.Int, fac.CODCLIENTE)
      .input('DOC_NIT', sql.VarChar, String(fac.DOC_NIT || 'CF'))
      .input('DOC_NOMCLIE', sql.VarChar, String(fac.DOC_NOMCLIE || ''))
      .input('DOC_DIRCLIE', sql.VarChar, String(fac.DOC_DIRCLIE || 'SN'))
      .input('CODVEN', sql.Int, fac.CODVEN != null ? Number(fac.CODVEN) : null)
      .input('TOTALPRECIO', sql.Decimal(18, 3), totalAbono)
      .input('USUARIO', sql.VarChar, usuario)
      .input('OBS', sql.VarChar, obsRar)
      .input('SERIEFAC', sql.VarChar, facCod)
      .input('NOFAC', sql.VarChar, String(correlativoFac))
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
          @CODCLIENTE, @DOC_NIT, @DOC_NOMCLIE, @DOC_DIRCLIE, @CODVEN,
          0, @TOTALPRECIO, 'RAR', '${STATUS_OPERADO}', @USUARIO, 'CON', 'NO',
          'SN', @OBS, 0, 0, 'SN', 0,
          'SN', 'SN', 0, 0, 'CONTADO', 'SN',
          @FECHA, 0, 0, 0, 0, 0,
          @SERIEFAC, @NOFAC, NULL,
          0, 0, 0, 0, 'Abono por retenciones / NC FEL'
        )
      `);

    for (const line of selected) {
      await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('FECHA', sql.NChar(10), fechaStr)
        .input('CODDOC', sql.VarChar, coddocRar)
        .input('CORRELATIVO', sql.Decimal(18, 0), correlativoRar)
        .input('ABONO', sql.Decimal(18, 4), line.ABONO)
        .input('CODDOC_FAC', sql.VarChar, facCod)
        .input('CORRELATIVO_FAC', sql.Decimal(18, 0), correlativoFac)
        .input('CODDOC_REC', sql.VarChar, line.CODDOC_RET)
        .input('CORRELATIVO_REC', sql.Decimal(18, 0), line.CORRELATIVO_RET)
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

    const aplicado = await aplicarSaldoFacturaDesdeAbonos(
      transaction,
      sql,
      empnit,
      facCod,
      correlativoFac
    );

    await transaction.commit();
    return {
      ok: true,
      abono: {
        CODDOC: coddocRar,
        CORRELATIVO: correlativoRar,
        TIPODOC: TIPODOC_RAR,
        TOTALPRECIO: totalAbono,
        SERIEFAC: facCod,
        NOFAC: String(correlativoFac),
        LINEAS: selected.length,
      },
      factura: {
        CODDOC: facCod,
        CORRELATIVO: correlativoFac,
        DOC_ABONO: aplicado.DOC_ABONO,
        DOC_SALDO: aplicado.DOC_SALDO,
        SALDO_PENDIENTE: aplicado.DOC_SALDO,
      },
    };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

module.exports = {
  TIPODOC_RCC,
  TIPODOC_RAR,
  parseCorrelativo,
  listTiposDocRcc,
  getTipoDocRcc,
  getTipoDocRccByCoddoc,
  previewSiguienteRcc,
  listTiposDocRar,
  getTipoDocRar,
  getTipoDocRarByCoddoc,
  previewSiguienteRar,
  listRetencionesFelDeFac,
  loadFacturaCxc,
  fetchAbonosFactura,
  aplicarSaldoFacturaDesdeAbonos,
  crearAbonoRcc,
  crearAbonoRar,
  corregirSaldosCxc,
  SQL_DOC_SALDO_PENDIENTE,
};
