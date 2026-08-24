/**
 * Facturas/compras vinculadas a retenciones:
 * - Emitidas (RTV/RTI) → compras crédito (CXP)
 * - Recibidas (RVR/RIR) → facturas crédito FEL FEF/FEC/FES (CXC)
 * vía DOCUMENTOS_FACTURAS_ABONADAS.
 */
const sql = require('mssql');
const { fechaIsoFromValue } = require('./documento-fecha');
const { STATUS_OPERADO } = require('./documento-status');
const {
  SQL_TIPODOC_CUENTAS_PAGAR_IN,
} = require('./cuentas-pagar-docs');
const { SQL_DOC_SALDO_PENDIENTE_POSITIVO } = require('./cuentas-docs');
const {
  TOLERANCIA_ABONO_RETENCION,
  abonoSuperaSaldo,
  aplicarAbonoSobreSaldo,
} = require('./cuentas-saldo-centavos');
const {
  getIvaFactor,
  getRetencionIvaPorcentaje,
  getRetencionIsrPorcentaje,
} = require('./impuestos');

/** Solo FEL al crédito en retenciones recibidas (sin FAC). */
const TIPODOC_FEL_CXC_RETENCION = ['FEF', 'FEC', 'FES'];
const SQL_TIPODOC_FEL_CXC_RETENCION_IN = TIPODOC_FEL_CXC_RETENCION.map((t) => `'${t}'`).join(', ');
const SQL_TIPODOC_FEL_TRIM_IN = `
  UPPER(LTRIM(RTRIM(ISNULL(t.TIPODOC, '')))) IN (${SQL_TIPODOC_FEL_CXC_RETENCION_IN})
`;
const SQL_CONCRE_CRE = `UPPER(LTRIM(RTRIM(ISNULL(d.CONCRE, 'CON')))) = 'CRE'`;
const SQL_STATUS_OPERADO = `UPPER(LTRIM(RTRIM(ISNULL(d.STATUS, '')))) = '${STATUS_OPERADO}'`;

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseCorrelativo(raw) {
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * Desglose de retención sobre una compra (TOTAL con IVA incluido).
 * - base = TOTALPRECIO / factorIVA  (siempre)
 * - ISR: retención = base × (pct/100)
 * - IVA: retención = (TOTALPRECIO − base) × (pct/100)  [= IVA × pct%]
 */
function calcRetencionSobreBase(totalPrecio, ivaFactor, pctRetencion, kind = 'isr') {
  const total = toNumber(totalPrecio);
  const factor = toNumber(ivaFactor) > 0 ? toNumber(ivaFactor) : 1.12;
  const pct = toNumber(pctRetencion);
  const base = roundMoney(total / factor);
  const iva = roundMoney(Math.max(0, total - base));
  const montoBase = String(kind || '').toLowerCase() === 'iva' ? iva : base;
  const retencion = roundMoney((montoBase * pct) / 100);
  return { base, iva, retencion, total, factor, pct };
}

async function loadCalcParams(pool, kind) {
  const ivaFactor = await getIvaFactor(pool);
  const pct =
    kind === 'isr'
      ? await getRetencionIsrPorcentaje(pool)
      : await getRetencionIvaPorcentaje(pool);
  return { ivaFactor: toNumber(ivaFactor) || 1.12, retencionPorcentaje: toNumber(pct) };
}

async function listComprasCreditoPendientesProveedor(
  pool,
  empnit,
  codprov,
  { q = '', limit = 200 } = {}
) {
  const cod = parseInt(codprov, 10);
  if (!Number.isFinite(cod) || cod <= 0) throw httpError('Proveedor inválido');
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const qTrim = String(q || '').trim();
  const request = pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROV', sql.Int, cod)
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
        OR ISNULL(d.SERIEFAC, '') LIKE @qLike
        OR ISNULL(d.NOFAC, '') LIKE @qLike
      )`;
  }
  const result = await request.query(`
    SELECT TOP (@LIMIT)
      d.FECHA, d.CODDOC, d.CORRELATIVO, t.DESDOC, t.TIPODOC,
      ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
      ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
      ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
      d.DOC_NOMCLIE, d.DOC_NIT,
      ISNULL(d.SERIEFAC, '') AS SERIEFAC,
      ISNULL(d.NOFAC, '') AS NOFAC
    FROM dbo.DOCUMENTOS d
    INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
    WHERE d.EMPNIT = @EMPNIT
      AND d.CODCLIENTE = @CODPROV
      AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_PAGAR_IN})
      AND d.STATUS = '${STATUS_OPERADO}'
      AND ISNULL(d.CONCRE, 'CON') = 'CRE'
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
    SERIEFAC: String(r.SERIEFAC ?? '').trim() || null,
    NOFAC: String(r.NOFAC ?? '').trim() || null,
  }));
}

/**
 * Facturas crédito FEL (FEF/FEC/FES) con saldo pendiente del cliente (CXC).
 * Mismos filtros base que recibos CXC, sin FAC.
 */
async function listFacturasCreditoPendientesCliente(
  pool,
  empnit,
  codcliente,
  { q = '', limit = 200 } = {}
) {
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
        OR ISNULL(d.DOC_NIT, '') LIKE @qLike
        OR ISNULL(d.FEL_SERIE, '') LIKE @qLike
        OR ISNULL(d.FEL_NUMERO, '') LIKE @qLike
      )`;
  }
  const result = await request.query(`
    SELECT TOP (@LIMIT)
      d.FECHA, d.CODDOC, d.CORRELATIVO, t.DESDOC, t.TIPODOC,
      ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
      ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
      ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
      d.DOC_NOMCLIE, d.DOC_NIT,
      ISNULL(d.FEL_SERIE, '') AS SERIEFAC,
      ISNULL(d.FEL_NUMERO, '') AS NOFAC
    FROM dbo.DOCUMENTOS d
    INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
    WHERE d.EMPNIT = @EMPNIT
      AND d.CODCLIENTE = @CODCLIENTE
      AND ${SQL_TIPODOC_FEL_TRIM_IN}
      AND ${SQL_STATUS_OPERADO}
      AND ${SQL_CONCRE_CRE}
      AND ${SQL_DOC_SALDO_PENDIENTE_POSITIVO}
      ${qSql}
    ORDER BY d.FECHA DESC, d.CORRELATIVO DESC
  `);
  return result.recordset.map((r) => ({
    FECHA: fechaIsoFromValue(r.FECHA) || null,
    CODDOC: r.CODDOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: String(r.TIPODOC || '').trim().toUpperCase() || null,
    TOTALPRECIO: toNumber(r.TOTALPRECIO),
    DOC_ABONO: toNumber(r.DOC_ABONO),
    DOC_SALDO: toNumber(r.DOC_SALDO),
    DOC_NOMCLIE: r.DOC_NOMCLIE ?? null,
    DOC_NIT: r.DOC_NIT ?? null,
    SERIEFAC: String(r.SERIEFAC ?? '').trim() || null,
    NOFAC: String(r.NOFAC ?? '').trim() || null,
  }));
}

/**
 * Busca factura FEL (FEF/FEC/FES) por FEL_SERIE + FEL_NUMERO exactos.
 * Devuelve datos del documento y del cliente asociado.
 */
async function findFacturaPorFel(pool, empnit, { serie, numero } = {}) {
  const felSerie = String(serie || '').trim();
  const felNumero = String(numero || '').trim();
  if (!felSerie) throw httpError('Indique FEL_SERIE');
  if (!felNumero) throw httpError('Indique FEL_NUMERO');

  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('FEL_SERIE', sql.VarChar, felSerie)
    .input('FEL_NUMERO', sql.VarChar, felNumero)
    .query(`
      SELECT TOP 20
        d.FECHA, d.CODDOC, d.CORRELATIVO, d.CODCLIENTE,
        t.DESDOC, t.TIPODOC,
        ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
        ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
        ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
        d.DOC_NOMCLIE, d.DOC_NIT,
        ISNULL(d.FEL_SERIE, '') AS FEL_SERIE,
        ISNULL(d.FEL_NUMERO, '') AS FEL_NUMERO,
        ISNULL(c.NOMBRECLIENTE, '') AS NOMBRECLIENTE,
        ISNULL(c.NEGOCIO, '') AS NEGOCIO,
        ISNULL(c.NIT, '') AS NIT_CLIENTE
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      LEFT JOIN dbo.CLIENTES c ON c.EMPNIT = d.EMPNIT AND c.CODCLIENTE = d.CODCLIENTE
      WHERE d.EMPNIT = @EMPNIT
        AND ${SQL_TIPODOC_FEL_TRIM_IN}
        AND ${SQL_STATUS_OPERADO}
        AND LTRIM(RTRIM(ISNULL(d.FEL_SERIE, ''))) = LTRIM(RTRIM(@FEL_SERIE))
        AND LTRIM(RTRIM(ISNULL(d.FEL_NUMERO, ''))) = LTRIM(RTRIM(@FEL_NUMERO))
      ORDER BY d.FECHA DESC, d.CORRELATIVO DESC
    `);

  const rows = (result.recordset || []).map((r) => ({
    FECHA: fechaIsoFromValue(r.FECHA) || null,
    CODDOC: r.CODDOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    CODCLIENTE: r.CODCLIENTE ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: String(r.TIPODOC || '').trim().toUpperCase() || null,
    TOTALPRECIO: toNumber(r.TOTALPRECIO),
    DOC_ABONO: toNumber(r.DOC_ABONO),
    DOC_SALDO: toNumber(r.DOC_SALDO),
    DOC_NOMCLIE: r.DOC_NOMCLIE ?? null,
    DOC_NIT: r.DOC_NIT ?? null,
    FEL_SERIE: String(r.FEL_SERIE || '').trim() || null,
    FEL_NUMERO: String(r.FEL_NUMERO || '').trim() || null,
    SERIEFAC: String(r.FEL_SERIE || '').trim() || null,
    NOFAC: String(r.FEL_NUMERO || '').trim() || null,
    NOMBRECLIENTE: String(r.NOMBRECLIENTE || r.DOC_NOMCLIE || '').trim() || null,
    NEGOCIO: String(r.NEGOCIO || '').trim() || null,
    NIT: String(r.NIT_CLIENTE || r.DOC_NIT || '').trim() || null,
  }));

  return rows;
}

/**
 * Busca compra a crédito por SERIEFAC + NOFAC (misma UI serie/número).
 * Devuelve datos del documento y del proveedor.
 */
async function findCompraPorSerieNumero(pool, empnit, { serie, numero } = {}) {
  const seriefac = String(serie || '').trim();
  const nofac = String(numero || '').trim();
  if (!seriefac) throw httpError('Indique la serie de factura');
  if (!nofac) throw httpError('Indique el número de factura');

  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('SERIEFAC', sql.VarChar, seriefac)
    .input('NOFAC', sql.VarChar, nofac)
    .query(`
      SELECT TOP 20
        d.FECHA, d.CODDOC, d.CORRELATIVO, d.CODCLIENTE,
        t.DESDOC, t.TIPODOC,
        ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
        ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
        ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
        d.DOC_NOMCLIE, d.DOC_NIT,
        ISNULL(d.SERIEFAC, '') AS SERIEFAC,
        ISNULL(d.NOFAC, '') AS NOFAC,
        ISNULL(p.EMPRESA, '') AS EMPRESA,
        ISNULL(p.RAZONSOCIAL, '') AS RAZONSOCIAL,
        ISNULL(p.NIT, '') AS NIT_PROV
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      LEFT JOIN dbo.PROVEEDORES p ON p.EMPNIT = d.EMPNIT AND p.CODPROV = d.CODCLIENTE
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${SQL_TIPODOC_CUENTAS_PAGAR_IN})
        AND d.STATUS = '${STATUS_OPERADO}'
        AND LTRIM(RTRIM(ISNULL(d.SERIEFAC, ''))) = LTRIM(RTRIM(@SERIEFAC))
        AND LTRIM(RTRIM(ISNULL(d.NOFAC, ''))) = LTRIM(RTRIM(@NOFAC))
      ORDER BY d.FECHA DESC, d.CORRELATIVO DESC
    `);

  const rows = (result.recordset || []).map((r) => ({
    FECHA: fechaIsoFromValue(r.FECHA) || null,
    CODDOC: r.CODDOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    CODPROV: r.CODCLIENTE ?? null,
    CODCLIENTE: r.CODCLIENTE ?? null,
    DESDOC: r.DESDOC ?? null,
    TIPODOC: String(r.TIPODOC || '').trim().toUpperCase() || null,
    TOTALPRECIO: toNumber(r.TOTALPRECIO),
    DOC_ABONO: toNumber(r.DOC_ABONO),
    DOC_SALDO: toNumber(r.DOC_SALDO),
    DOC_NOMCLIE: r.DOC_NOMCLIE ?? null,
    DOC_NIT: r.DOC_NIT ?? null,
    SERIEFAC: String(r.SERIEFAC || '').trim() || null,
    NOFAC: String(r.NOFAC || '').trim() || null,
    FEL_SERIE: String(r.SERIEFAC || '').trim() || null,
    FEL_NUMERO: String(r.NOFAC || '').trim() || null,
    EMPRESA: String(r.EMPRESA || r.DOC_NOMCLIE || '').trim() || null,
    RAZONSOCIAL: String(r.RAZONSOCIAL || '').trim() || null,
    NIT: String(r.NIT_PROV || r.DOC_NIT || '').trim() || null,
  }));

  return rows;
}

/**
 * Diagnóstico cuando no hay FEL con saldo: ayuda a ver si el cliente tiene FAC
 * u otros tipodoc a crédito con saldo.
 */
async function diagnoseFacturasClienteRetencion(pool, empnit, codcliente) {
  const cod = parseInt(codcliente, 10);
  if (!Number.isFinite(cod) || cod <= 0) return null;
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCLIENTE', sql.Int, cod)
    .query(`
      SELECT
        SUM(CASE
          WHEN ${SQL_TIPODOC_FEL_TRIM_IN}
           AND ${SQL_STATUS_OPERADO}
           AND ${SQL_CONCRE_CRE}
           AND ${SQL_DOC_SALDO_PENDIENTE_POSITIVO}
          THEN 1 ELSE 0 END) AS FEL_OK,
        SUM(CASE
          WHEN ${SQL_TIPODOC_FEL_TRIM_IN}
           AND ${SQL_STATUS_OPERADO}
           AND ${SQL_CONCRE_CRE}
          THEN 1 ELSE 0 END) AS FEL_CRE,
        SUM(CASE
          WHEN UPPER(LTRIM(RTRIM(ISNULL(t.TIPODOC, '')))) = 'FAC'
           AND ${SQL_STATUS_OPERADO}
           AND ${SQL_CONCRE_CRE}
           AND ${SQL_DOC_SALDO_PENDIENTE_POSITIVO}
          THEN 1 ELSE 0 END) AS FAC_CRE_SALDO,
        SUM(CASE
          WHEN ${SQL_STATUS_OPERADO}
           AND ${SQL_CONCRE_CRE}
           AND ${SQL_DOC_SALDO_PENDIENTE_POSITIVO}
          THEN 1 ELSE 0 END) AS ANY_CRE_SALDO
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      WHERE d.EMPNIT = @EMPNIT
        AND d.CODCLIENTE = @CODCLIENTE
    `);
  const row = result.recordset[0] || {};
  const tipodocsRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCLIENTE', sql.Int, cod)
    .query(`
      SELECT TOP 12
        UPPER(LTRIM(RTRIM(ISNULL(t.TIPODOC, '')))) AS TIPODOC,
        COUNT(*) AS CNT
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      WHERE d.EMPNIT = @EMPNIT
        AND d.CODCLIENTE = @CODCLIENTE
        AND ${SQL_STATUS_OPERADO}
        AND ${SQL_CONCRE_CRE}
        AND ${SQL_DOC_SALDO_PENDIENTE_POSITIVO}
      GROUP BY UPPER(LTRIM(RTRIM(ISNULL(t.TIPODOC, ''))))
      ORDER BY CNT DESC
    `);
  return {
    felOk: Number(row.FEL_OK) || 0,
    felCre: Number(row.FEL_CRE) || 0,
    facCreSaldo: Number(row.FAC_CRE_SALDO) || 0,
    anyCreSaldo: Number(row.ANY_CRE_SALDO) || 0,
    tipodocsConSaldo: (tipodocsRes.recordset || []).map((r) => ({
      TIPODOC: r.TIPODOC,
      CNT: Number(r.CNT) || 0,
    })),
  };
}

async function loadAbonosRetencion(pool, empnit, coddoc, correlativo) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .query(`
      SELECT
        a.CODDOC_FAC, a.CORRELATIVO_FAC, a.ABONO, a.FECHA AS ABONO_FECHA,
        f.FECHA AS FAC_FECHA,
        ISNULL(f.TOTALPRECIO, 0) AS FAC_TOTALPRECIO,
        ISNULL(f.TOTALSINIVA, 0) AS FAC_TOTALSINIVA,
        ISNULL(f.TOTALIVA, 0) AS FAC_TOTALIVA,
        ISNULL(f.DOC_SALDO, 0) AS FAC_DOC_SALDO,
        ISNULL(f.DOC_ABONO, 0) AS FAC_DOC_ABONO,
        ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(f.FEL_SERIE, ''))), ''), ISNULL(f.SERIEFAC, '')) AS FAC_SERIEFAC,
        ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(f.FEL_NUMERO, ''))), ''), ISNULL(CAST(f.NOFAC AS VARCHAR(40)), '')) AS FAC_NOFAC
      FROM dbo.DOCUMENTOS_FACTURAS_ABONADAS a
      LEFT JOIN dbo.DOCUMENTOS f
        ON f.EMPNIT = a.EMPNIT
       AND LTRIM(RTRIM(f.CODDOC)) = LTRIM(RTRIM(a.CODDOC_FAC))
       AND CAST(f.CORRELATIVO AS DECIMAL(18, 0)) = CAST(a.CORRELATIVO_FAC AS DECIMAL(18, 0))
      WHERE a.EMPNIT = @EMPNIT
        AND (
          (LTRIM(RTRIM(a.CODDOC)) = LTRIM(RTRIM(@CODDOC))
            AND CAST(a.CORRELATIVO AS DECIMAL(18, 0)) = @CORRELATIVO)
          OR (LTRIM(RTRIM(ISNULL(a.CODDOC_REC, ''))) = LTRIM(RTRIM(@CODDOC))
            AND CAST(a.CORRELATIVO_REC AS DECIMAL(18, 0)) = @CORRELATIVO)
        )
      ORDER BY a.CODDOC_FAC, a.CORRELATIVO_FAC
    `);
  return result.recordset.map((r) => ({
    CODDOC_FAC: r.CODDOC_FAC ?? null,
    CORRELATIVO_FAC: r.CORRELATIVO_FAC ?? null,
    ABONO: toNumber(r.ABONO),
    FAC_FECHA: fechaIsoFromValue(r.FAC_FECHA) || null,
    FAC_TOTALPRECIO: toNumber(r.FAC_TOTALPRECIO),
    FAC_TOTALSINIVA: toNumber(r.FAC_TOTALSINIVA),
    FAC_TOTALIVA: toNumber(r.FAC_TOTALIVA),
    FAC_DOC_SALDO: toNumber(r.FAC_DOC_SALDO),
    FAC_DOC_ABONO: toNumber(r.FAC_DOC_ABONO),
    FAC_SERIEFAC: String(r.FAC_SERIEFAC ?? '').trim() || null,
    FAC_NOFAC: String(r.FAC_NOFAC ?? '').trim() || null,
  }));
}

function normalizeAbonosInput(rawAbonos) {
  if (!Array.isArray(rawAbonos)) throw httpError('abonos debe ser un arreglo');
  const map = new Map();
  for (const item of rawAbonos) {
    const facCod = String(item?.CODDOC_FAC || item?.CODDOC || '').trim();
    const facCorr = parseCorrelativo(item?.CORRELATIVO_FAC ?? item?.CORRELATIVO);
    const abono = roundMoney(item?.ABONO ?? item?.MONTO ?? 0);
    const base = roundMoney(item?.BASE ?? item?.TOTALSINIVA ?? 0);
    if (!facCod || facCorr === null) throw httpError('Factura abonada inválida');
    if (abono < 0) throw httpError('El monto a retener no puede ser negativo');
    if (abono === 0) continue;
    const key = `${facCod}|${facCorr}`;
    const prev = map.get(key);
    map.set(key, {
      CODDOC_FAC: facCod,
      CORRELATIVO_FAC: facCorr,
      ABONO: roundMoney((prev?.ABONO || 0) + abono),
      BASE: roundMoney((prev?.BASE || 0) + base),
    });
  }
  return [...map.values()];
}

/**
 * Guarda las facturas/compras de la retención en DOCUMENTOS_FACTURAS_ABONADAS
 * sin aplicar saldo ni finalizar (CORTE). Así el listado e impresión las ven
 * desde el primer Guardar, no solo al finalizar.
 */
async function persistAbonosIfPresent(pool, empnit, coddoc, correlativo, body, fechaFallback) {
  const raw = body?.abonos ?? body?.ABONOS;
  if (!Array.isArray(raw)) return;
  const abonos = normalizeAbonosInput(raw);
  let fechaStr = String(body?.FECHA || fechaFallback || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) {
    const loaded = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        SELECT FECHA FROM dbo.DOCUMENTOS
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);
    fechaStr = fechaIsoFromValue(loaded.recordset[0]?.FECHA) || '';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) {
    const err = new Error('Fecha inválida al guardar facturas de la retención');
    err.statusCode = 400;
    throw err;
  }

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
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
    await transaction.commit();
  } catch (err) {
    try {
      await transaction.rollback();
    } catch (_) {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Persiste abonos de la retención y actualiza DOC_ABONO/DOC_SALDO de cada documento.
 * - side 'cxp' (default): compras proveedor (RTI/RTV)
 * - side 'cxc': facturas crédito FEL FEF/FEC/FES (RIR/RVR)
 * Marca la retención con CORTE='SI'.
 */
async function finalizarRetencionConAbonos(pool, {
  empnit,
  coddoc,
  correlativo,
  codprov,
  codcliente,
  fechaStr,
  concre,
  obs,
  abonosInput,
  ivaFactor,
  side = 'cxp',
}) {
  const isCxc = String(side || 'cxp').toLowerCase() === 'cxc';
  const abonos = normalizeAbonosInput(abonosInput);
  if (!abonos.length) {
    throw httpError(
      isCxc
        ? 'Agregue al menos una factura a la retención'
        : 'Agregue al menos una compra a la retención'
    );
  }

  const totalRetencion = roundMoney(abonos.reduce((s, a) => s + a.ABONO, 0));
  if (totalRetencion <= 0) throw httpError('El monto de retención debe ser mayor a cero');

  let totalBase = roundMoney(abonos.reduce((s, a) => s + toNumber(a.BASE), 0));
  if (totalBase <= 0) {
    const factor = toNumber(ivaFactor) > 0 ? toNumber(ivaFactor) : 1.12;
    totalBase = roundMoney(abonos.reduce((s, a) => s + a.ABONO * factor, 0));
  }

  const concreNorm = String(concre || 'CON').trim().toUpperCase() === 'CRE' ? 'CRE' : 'CON';
  const partyCode = parseInt(isCxc ? codcliente : codprov, 10);
  if (!Number.isFinite(partyCode) || partyCode <= 0) {
    throw httpError(isCxc ? 'Seleccione un cliente' : 'Seleccione un proveedor');
  }

  const tipodocIn = isCxc ? SQL_TIPODOC_FEL_CXC_RETENCION_IN : SQL_TIPODOC_CUENTAS_PAGAR_IN;
  const tipodocClause = isCxc
    ? SQL_TIPODOC_FEL_TRIM_IN
    : `t.TIPODOC IN (${tipodocIn})`;
  const concreClause = isCxc ? SQL_CONCRE_CRE : `ISNULL(d.CONCRE, 'CON') = 'CRE'`;
  const statusClause = isCxc ? SQL_STATUS_OPERADO : `d.STATUS = '${STATUS_OPERADO}'`;

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const docLock = await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .query(`
        SELECT STATUS, ISNULL(CORTE, 'NO') AS CORTE, CODCLIENTE
        FROM dbo.DOCUMENTOS WITH (UPDLOCK, ROWLOCK)
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);
    if (!docLock.recordset.length) throw httpError('Documento no encontrado', 404);
    const meta = docLock.recordset[0];
    if (String(meta.STATUS || '').trim().toUpperCase() !== STATUS_OPERADO) {
      throw httpError('La retención no está operada');
    }
    if (String(meta.CORTE || 'NO').trim().toUpperCase() === 'SI') {
      throw httpError('La retención ya está finalizada', 409);
    }

    for (const line of abonos) {
      const facRes = await transaction
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODDOC', sql.VarChar, line.CODDOC_FAC)
        .input('CORRELATIVO', sql.Decimal(18, 0), line.CORRELATIVO_FAC)
        .input('CODPARTY', sql.Int, Number(meta.CODCLIENTE || partyCode))
        .query(`
          SELECT
            ISNULL(d.DOC_SALDO, 0) AS DOC_SALDO,
            ISNULL(d.DOC_ABONO, 0) AS DOC_ABONO,
            ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
            d.CODCLIENTE, d.STATUS, ISNULL(d.CONCRE, 'CON') AS CONCRE, t.TIPODOC
          FROM dbo.DOCUMENTOS d WITH (UPDLOCK, ROWLOCK)
          INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
          WHERE d.EMPNIT = @EMPNIT AND d.CODDOC = @CODDOC AND d.CORRELATIVO = @CORRELATIVO
            AND d.CODCLIENTE = @CODPARTY
            AND ${tipodocClause}
            AND ${statusClause}
            AND ${concreClause}
        `);
      if (!facRes.recordset.length) {
        throw httpError(
          isCxc
            ? `Factura ${line.CODDOC_FAC} #${line.CORRELATIVO_FAC} no válida para este cliente (solo FEF/FEC/FES al crédito con saldo)`
            : `Compra ${line.CODDOC_FAC} #${line.CORRELATIVO_FAC} no válida para este proveedor`
        );
      }
      const fac = facRes.recordset[0];
      const saldo = toNumber(fac.DOC_SALDO);
      if (abonoSuperaSaldo(line.ABONO, saldo, TOLERANCIA_ABONO_RETENCION)) {
        throw httpError(
          `La retención de ${line.CODDOC_FAC} #${line.CORRELATIVO_FAC} (${line.ABONO}) supera el saldo (${saldo})`
        );
      }
      line._docSaldo = saldo;
      line._docAbono = toNumber(fac.DOC_ABONO);
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

    for (const line of abonos) {
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

      const aplicado = aplicarAbonoSobreSaldo(
        line._docAbono,
        line._docSaldo,
        line.ABONO,
        TOLERANCIA_ABONO_RETENCION
      );
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

    const primera = abonos[0];
    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODDOC', sql.VarChar, coddoc)
      .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
      .input('CONCRE', sql.VarChar, concreNorm)
      .input('TIPOPAGO', sql.VarChar, concreNorm === 'CRE' ? 'CREDITO' : 'CONTADO')
      .input('TOTALIVA', sql.Float, totalRetencion)
      .input('TOTALSINIVA', sql.Float, totalBase)
      .input('TOTALPRECIO', sql.Decimal(18, 3), totalRetencion)
      .input('TOTALCOSTO', sql.Decimal(18, 3), totalRetencion)
      .input('PAGO', sql.Decimal(18, 3), totalRetencion)
      .input('OBS', sql.VarChar, String(obs || ''))
      .input('SERIEFAC', sql.VarChar, String(primera.CODDOC_FAC))
      .input('NOFAC', sql.VarChar, String(primera.CORRELATIVO_FAC))
      .query(`
        UPDATE dbo.DOCUMENTOS SET
          CONCRE = @CONCRE,
          TIPOPAGO = @TIPOPAGO,
          TOTALIVA = @TOTALIVA,
          TOTALSINIVA = @TOTALSINIVA,
          TOTALPRECIO = @TOTALPRECIO,
          TOTALCOSTO = @TOTALCOSTO,
          PAGO = @PAGO,
          OBS = @OBS,
          SERIEFAC = @SERIEFAC,
          NOFAC = @NOFAC,
          CORTE = 'SI'
        WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
      `);

    await transaction.commit();
  } catch (err) {
    try {
      await transaction.rollback();
    } catch (_) {
      /* ignore */
    }
    throw err;
  }

  return { totalRetencion, totalBase, abonosCount: abonos.length };
}

module.exports = {
  roundMoney,
  toNumber,
  calcRetencionSobreBase,
  loadCalcParams,
  TIPODOC_FEL_CXC_RETENCION,
  SQL_TIPODOC_FEL_CXC_RETENCION_IN,
  listComprasCreditoPendientesProveedor,
  listFacturasCreditoPendientesCliente,
  findFacturaPorFel,
  findCompraPorSerieNumero,
  diagnoseFacturasClienteRetencion,
  loadAbonosRetencion,
  persistAbonosIfPresent,
  normalizeAbonosInput,
  finalizarRetencionConAbonos,
};
