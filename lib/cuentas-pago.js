const { nowParts } = require('./documento-fecha');
const { STATUS_OPERADO } = require('./documento-status');
const {
  SQL_TIPODOC_CUENTAS_PAGAR_IN,
  SQL_DOC_SALDO_PENDIENTE,
  SQL_TIPODOC_ABONO_CXP_IN,
  SQL_TIPODOC_RETENCION_CXP_IN,
  SQL_MATCH_COMPRA_REF,
} = require('./cuentas-pagar-docs');
const {
  TOLERANCIA_ABONO_RETENCION,
  abonoSuperaSaldo,
  saldoEfectivo,
  sqlSetDocSaldoFromAbonos,
} = require('./cuentas-saldo-centavos');

const TIPODOC_RCP = 'RCP';

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

async function listTiposDocRcp(pool, sql, empnit) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('TIPODOC', sql.VarChar, TIPODOC_RCP)
    .query(`
      SELECT CODDOC, DESDOC, TIPODOC, ISNULL(CORRELATIVO, 0) AS CORRELATIVO
      FROM dbo.TIPODOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND TIPODOC = @TIPODOC AND ACTIVO = 'SI'
      ORDER BY CODDOC
    `);
  return result.recordset.map((r) => ({
    CODDOC: r.CODDOC ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: r.TIPODOC ?? TIPODOC_RCP,
    CORRELATIVO: Number(r.CORRELATIVO) || 0,
  }));
}

async function getTipoDocRcp(pool, sql, empnit) {
  const tipos = await listTiposDocRcp(pool, sql, empnit);
  return tipos[0] || null;
}

async function getTipoDocRcpByCoddoc(pool, sql, empnit, coddoc) {
  const cod = String(coddoc || '').trim();
  if (!cod) return null;
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, cod)
    .input('TIPODOC', sql.VarChar, TIPODOC_RCP)
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
    TIPODOC: row.TIPODOC ?? TIPODOC_RCP,
    CORRELATIVO: Number(row.CORRELATIVO) || 0,
  };
}

async function previewSiguienteRcp(pool, sql, empnit, coddoc) {
  const cod = String(coddoc || '').trim();
  const tipoRcp = cod
    ? await getTipoDocRcpByCoddoc(pool, sql, empnit, cod)
    : await getTipoDocRcp(pool, sql, empnit);
  if (!tipoRcp) return null;
  const coddocRcp = tipoRcp.CODDOC;
  const maxRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddocRcp)
    .query(`
      SELECT ISNULL(MAX(CORRELATIVO), 0) AS maxCorr
      FROM dbo.DOCUMENTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC
    `);
  const tipoCorr = Number(tipoRcp.CORRELATIVO) || 0;
  const maxCorr = Number(maxRes.recordset[0]?.maxCorr) || 0;
  const correlativo = Math.max(tipoCorr, maxCorr) + 1;
  return {
    CODDOC: coddocRcp,
    DESDOC: tipoRcp.DESDOC ?? null,
    TIPODOC: tipoRcp.TIPODOC ?? TIPODOC_RCP,
    CORRELATIVO: correlativo,
  };
}

async function loadCompraCxp(pool, sql, empnit, coddoc, correlativo) {
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
        ISNULL(p.EMPRESA, p.RAZONSOCIAL) AS NEGOCIO,
        ISNULL(emp.NOMEMPLEADO, '') AS VENDEDOR
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      LEFT JOIN dbo.PROVEEDORES p ON d.EMPNIT = p.EMPNIT AND d.CODCLIENTE = p.CODPROV
      LEFT OUTER JOIN dbo.Empleados emp ON emp.EMPNIT = d.EMPNIT AND emp.CODEMPLEADO = d.CODVEN
      WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
        AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_PAGAR_IN})
        AND d.STATUS = '${STATUS_OPERADO}'
        AND ISNULL(d.CONCRE, 'CON') = 'CRE'
    `);
  return result.recordset[0] || null;
}

async function fetchPagosCompra(pool, sql, empnit, facCoddoc, facCorrelativo) {
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
        AND t.TIPODOC IN (${SQL_TIPODOC_ABONO_CXP_IN})
        AND ${SQL_MATCH_COMPRA_REF}
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
        AND t.TIPODOC IN (${SQL_TIPODOC_RETENCION_CXP_IN})
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
 * Aplica DOC_ABONO / DOC_SALDO de una compra desde la suma real de pagos:
 * RCP/DVP (SERIEFAC/NOFAC) + retenciones RTV/RTI finalizadas (DOCUMENTOS_FACTURAS_ABONADAS).
 */
async function aplicarSaldoCompraDesdeAbonos(transaction, sql, empnit, comCoddoc, comCorrelativo) {
  const comCod = String(comCoddoc || '').trim();
  const corr = parseCorrelativo(comCorrelativo);
  if (!comCod || corr === null) {
    const err = new Error('Documento de compra inválido');
    err.statusCode = 400;
    throw err;
  }

  const sumRes = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('SERIEFAC', sql.VarChar, comCod)
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
            AND ta.TIPODOC IN (${SQL_TIPODOC_ABONO_CXP_IN})
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
            AND tp.TIPODOC IN (${SQL_TIPODOC_RETENCION_CXP_IN})
            AND UPPER(LTRIM(RTRIM(ISNULL(p.CORTE, 'NO')))) = 'SI'
        ) AS TOTAL_ABONOS
    `);

  const totalAbonos = roundMoney(toNumber(sumRes.recordset[0]?.TOTAL_ABONOS));

  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, comCod)
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
    .input('CODDOC', sql.VarChar, comCod)
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

async function crearPagoRcp(pool, sql, empnit, comCoddoc, comCorrelativo, body) {
  const correlativoCom = parseCorrelativo(comCorrelativo);
  if (!comCoddoc || correlativoCom === null) {
    const err = new Error('Documento de compra inválido');
    err.statusCode = 400;
    throw err;
  }

  const abono = roundMoney(body?.MONTO ?? body?.TOTALPRECIO ?? body?.abono);
  if (abono <= 0) {
    const err = new Error('El monto del abono debe ser mayor a cero');
    err.statusCode = 400;
    throw err;
  }

  const usuario = String(body?.USUARIO || body?.usuario || 'CXP').trim();
  const obs = String(body?.OBS || '').trim();
  const fpago = resolveFormasPago(body, abono);

  const coddocRcpReq = String(body?.CODDOC_RCP ?? body?.CODDOC ?? '').trim();
  const tipoRcp = coddocRcpReq
    ? await getTipoDocRcpByCoddoc(pool, sql, empnit, coddocRcpReq)
    : await getTipoDocRcp(pool, sql, empnit);
  if (!tipoRcp) {
    const err = new Error(
      coddocRcpReq
        ? `El documento ${coddocRcpReq} no es un tipo RCP activo`
        : 'No hay tipo de documento RCP activo para la empresa'
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
      .input('CODDOC', sql.VarChar, comCoddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativoCom)
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
          AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_PAGAR_IN})
          AND d.STATUS = '${STATUS_OPERADO}'
          AND ISNULL(d.CONCRE, 'CON') = 'CRE'
      `);
    if (!facRes.recordset.length) {
      const err = new Error('Compra al crédito no encontrada o no válida');
      err.statusCode = 404;
      throw err;
    }
    const com = facRes.recordset[0];
    const totalCom = roundMoney(toNumber(com.TOTALPRECIO));
    const docSaldo = saldoEfectivo(com.DOC_SALDO, totalCom, com.DOC_ABONO);
    if (abonoSuperaSaldo(abono, docSaldo)) {
      const err = new Error(`El abono no puede superar el saldo (${docSaldo})`);
      err.statusCode = 400;
      throw err;
    }

    const parts = nowParts();
    const coddocRcp = tipoRcp.CODDOC;
    const correlativoRcp = await allocateCorrelativo(transaction, sql, empnit, coddocRcp);
    const obsRcp =
      obs ||
      `Pago a compra ${comCoddoc}-${correlativoCom}`;

    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ANIO', sql.Int, parts.anio)
      .input('MES', sql.Int, parts.mes)
      .input('DIA', sql.Int, parts.dia)
      .input('FECHA', sql.Date, parts.fecha)
      .input('HORA', sql.Int, parts.hora)
      .input('MINUTO', sql.Int, parts.minuto)
      .input('CODDOC', sql.VarChar, coddocRcp)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativoRcp)
      .input('CODCLIENTE', sql.Int, com.CODCLIENTE)
      .input('DOC_NIT', sql.VarChar, String(com.DOC_NIT || 'CF'))
      .input('DOC_NOMCLIE', sql.VarChar, String(com.DOC_NOMCLIE || ''))
      .input('DOC_DIRCLIE', sql.VarChar, String(com.DOC_DIRCLIE || 'SN'))
      .input('CODVEN', sql.Int, com.CODVEN != null ? Number(com.CODVEN) : null)
      .input('TOTALPRECIO', sql.Decimal(18, 3), abono)
      .input('USUARIO', sql.VarChar, usuario)
      .input('OBS', sql.VarChar, obsRcp)
      .input('SERIEFAC', sql.VarChar, comCoddoc)
      .input('NOFAC', sql.VarChar, String(correlativoCom))
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
          @FPAGO_EFECTIVO, @FPAGO_TARJETA, @FPAGO_DEPOSITO, @FPAGO_CHEQUE, @FPAGO_DESCRIPCION
        )
      `);

    const aplicado = await aplicarSaldoCompraDesdeAbonos(
      transaction,
      sql,
      empnit,
      comCoddoc,
      correlativoCom
    );

    await transaction.commit();
    return {
      ok: true,
      pago: {
        CODDOC: coddocRcp,
        CORRELATIVO: correlativoRcp,
        TIPODOC: TIPODOC_RCP,
        TOTALPRECIO: abono,
        SERIEFAC: comCoddoc,
        NOFAC: String(correlativoCom),
      },
      compra: {
        CODDOC: comCoddoc,
        CORRELATIVO: correlativoCom,
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
 * Recalcula DOC_ABONO y DOC_SALDO de todas las compras al crédito operadas,
 * sumando pagos a proveedor (RCP) y devoluciones (DVP) vinculados por SERIEFAC/NOFAC,
 * retenciones emitidas RTV/RTI finalizadas (DOCUMENTOS_FACTURAS_ABONADAS),
 * y abonos bancarios solo cuando no exista ya un documento de pago operado
 * para esa misma compra (evita doble conteo).
 */
async function corregirSaldosCxp(pool, sql, empnit) {
  const countRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT COUNT(*) AS cnt
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_PAGAR_IN})
        AND d.STATUS = '${STATUS_OPERADO}'
        AND ISNULL(d.CONCRE, 'CON') = 'CRE'
    `);
  const totalCompras = Number(countRes.recordset[0]?.cnt) || 0;

  const updRes = await pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
    ;WITH DocAbonos AS (
      SELECT
        a.EMPNIT,
        LTRIM(RTRIM(a.SERIEFAC)) AS COM_CODDOC,
        TRY_CAST(LTRIM(RTRIM(a.NOFAC)) AS DECIMAL(18, 0)) AS COM_CORRELATIVO,
        ISNULL(SUM(ISNULL(a.TOTALPRECIO, 0)), 0) AS TOTAL_ABONOS
      FROM dbo.DOCUMENTOS a
      INNER JOIN dbo.TIPODOCUMENTOS ta ON ta.EMPNIT = a.EMPNIT AND ta.CODDOC = a.CODDOC
      WHERE a.EMPNIT = @EMPNIT
        AND a.STATUS = '${STATUS_OPERADO}'
        AND ta.TIPODOC IN (${SQL_TIPODOC_ABONO_CXP_IN})
        AND LTRIM(RTRIM(ISNULL(a.SERIEFAC, ''))) <> ''
        AND TRY_CAST(LTRIM(RTRIM(a.NOFAC)) AS DECIMAL(18, 0)) IS NOT NULL
      GROUP BY
        a.EMPNIT,
        LTRIM(RTRIM(a.SERIEFAC)),
        TRY_CAST(LTRIM(RTRIM(a.NOFAC)) AS DECIMAL(18, 0))
    ),
    RetencionesAbonos AS (
      SELECT
        a.EMPNIT,
        LTRIM(RTRIM(a.CODDOC_FAC)) AS COM_CODDOC,
        CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0)) AS COM_CORRELATIVO,
        ISNULL(SUM(ISNULL(a.ABONO, 0)), 0) AS TOTAL_ABONOS
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      INNER JOIN dbo.DOCUMENTOS p
        ON p.EMPNIT = a.EMPNIT AND p.CODDOC = a.CODDOC AND p.CORRELATIVO = a.CORRELATIVO
      INNER JOIN dbo.TIPODOCUMENTOS tp
        ON tp.EMPNIT = p.EMPNIT AND tp.CODDOC = p.CODDOC
      WHERE a.EMPNIT = @EMPNIT
        AND p.STATUS = '${STATUS_OPERADO}'
        AND tp.TIPODOC IN (${SQL_TIPODOC_RETENCION_CXP_IN})
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
        LTRIM(RTRIM(a.CODDOC_FAC)) AS COM_CODDOC,
        CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0)) AS COM_CORRELATIVO,
        ISNULL(SUM(ISNULL(a.ABONO, 0)), 0) AS TOTAL_ABONOS
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      WHERE a.EMPNIT = @EMPNIT
        AND LTRIM(RTRIM(ISNULL(a.CODDOC_FAC, ''))) <> ''
        AND a.CORRELATIVO_FAC IS NOT NULL
        AND NOT EXISTS (
          /* Retención RTV/RTI — se cuenta en RetencionesAbonos */
          SELECT 1
          FROM dbo.DOCUMENTOS p
          INNER JOIN dbo.TIPODOCUMENTOS tp
            ON tp.EMPNIT = p.EMPNIT AND tp.CODDOC = p.CODDOC
          WHERE p.EMPNIT = a.EMPNIT
            AND p.CODDOC = a.CODDOC
            AND p.CORRELATIVO = a.CORRELATIVO
            AND tp.TIPODOC IN (${SQL_TIPODOC_RETENCION_CXP_IN})
        )
        AND NOT EXISTS (
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
          SELECT 1
          FROM dbo.DOCUMENTOS r
          INNER JOIN dbo.TIPODOCUMENTOS tr
            ON tr.EMPNIT = r.EMPNIT AND tr.CODDOC = r.CODDOC
          WHERE r.EMPNIT = a.EMPNIT
            AND r.STATUS = '${STATUS_OPERADO}'
            AND tr.TIPODOC IN (${SQL_TIPODOC_ABONO_CXP_IN})
            AND LTRIM(RTRIM(ISNULL(r.SERIEFAC, ''))) = LTRIM(RTRIM(a.CODDOC_FAC))
            AND TRY_CAST(LTRIM(RTRIM(r.NOFAC)) AS DECIMAL(18, 0)) = CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0))
        )
      GROUP BY
        a.EMPNIT,
        LTRIM(RTRIM(a.CODDOC_FAC)),
        CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0))
    ),
    AbonosCompra AS (
      SELECT
        EMPNIT,
        COM_CODDOC,
        COM_CORRELATIVO,
        ISNULL(SUM(TOTAL_ABONOS), 0) AS TOTAL_ABONOS
      FROM (
        SELECT EMPNIT, COM_CODDOC, COM_CORRELATIVO, TOTAL_ABONOS FROM DocAbonos
        UNION ALL
        SELECT EMPNIT, COM_CODDOC, COM_CORRELATIVO, TOTAL_ABONOS FROM RetencionesAbonos
        UNION ALL
        SELECT EMPNIT, COM_CODDOC, COM_CORRELATIVO, TOTAL_ABONOS FROM BancoAbonos
      ) x
      GROUP BY EMPNIT, COM_CODDOC, COM_CORRELATIVO
    )
    UPDATE d
    SET
      ${sqlSetDocSaldoFromAbonos('d.TOTALPRECIO', 'ab.TOTAL_ABONOS', 'd.', TOLERANCIA_ABONO_RETENCION)}
    FROM dbo.DOCUMENTOS d
        INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
    LEFT JOIN AbonosCompra ab
      ON ab.EMPNIT = d.EMPNIT
      AND ab.COM_CODDOC = LTRIM(RTRIM(d.CODDOC))
      AND ab.COM_CORRELATIVO = d.CORRELATIVO
    WHERE d.EMPNIT = @EMPNIT
      AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_PAGAR_IN})
      AND d.STATUS = '${STATUS_OPERADO}'
      AND ISNULL(d.CONCRE, 'CON') = 'CRE'
  `);

  return {
    ok: true,
    totalCompras,
    actualizadas: Number(updRes.rowsAffected?.[updRes.rowsAffected.length - 1]) || Number(updRes.rowsAffected[0]) || 0,
  };
}

module.exports = {
  TIPODOC_RCP,
  parseCorrelativo,
  listTiposDocRcp,
  getTipoDocRcp,
  getTipoDocRcpByCoddoc,
  previewSiguienteRcp,
  loadCompraCxp,
  fetchPagosCompra,
  aplicarSaldoCompraDesdeAbonos,
  crearPagoRcp,
  corregirSaldosCxp,
  SQL_DOC_SALDO_PENDIENTE,
};
