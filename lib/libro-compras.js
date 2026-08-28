const { getIvaFactor, splitIvaFromTotal } = require('./impuestos');

/** Compras con IVA recuperable (desglose 12%). */
const TIPODOC_COMPRAS_IVA = ['COM'];
/** Compras a pequeño contribuyente: total sin desglose de IVA (va a Exentas). */
const TIPODOC_COMPRAS_PEQ = ['COP'];
const TIPODOC_COMPRAS = [...TIPODOC_COMPRAS_IVA, ...TIPODOC_COMPRAS_PEQ];
const TIPODOC_RETENCIONES = ['RTV', 'RTI'];
/** Notas de crédito a proveedor: restan con desglose IVA normal. */
const TIPODOC_NOTAS_CREDITO = ['DVP'];
const TIPODOC_LIBRO_COMPRAS = [...TIPODOC_COMPRAS, ...TIPODOC_RETENCIONES, ...TIPODOC_NOTAS_CREDITO];
const SQL_TIPODOC_LIBRO_COMPRAS_IN = TIPODOC_LIBRO_COMPRAS.map((t) => `'${t}'`).join(', ');

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function strVal(value) {
  const s = String(value ?? '').trim();
  return s || null;
}

function tipodocOf(row) {
  return String(row?.TIPODOC ?? '').trim().toUpperCase();
}

function isAnulado(row) {
  return String(row?.STATUS ?? '').trim().toUpperCase() === 'A';
}

function isNotaCredito(row) {
  return tipodocOf(row) === 'DVP';
}

function isCompraPeq(row) {
  return tipodocOf(row) === 'COP';
}

function isRetencion(row) {
  const t = tipodocOf(row);
  return t === 'RTV' || t === 'RTI';
}

function signForRow(row) {
  if (isAnulado(row)) return 0;
  return isNotaCredito(row) ? -1 : 1;
}

/**
 * Serie/número del documento del proveedor.
 * En DVP, SERIEFAC/NOFAC apuntan a la compra referenciada (no a la NC);
 * para el libro preferimos FEL_* y, si faltan, CODDOC/CORRELATIVO.
 */
function resolveSerie(row) {
  if (isNotaCredito(row)) {
    return strVal(row.FEL_SERIE) || strVal(row.CODDOC);
  }
  return strVal(row.FEL_SERIE) || strVal(row.SERIEFAC) || strVal(row.CODDOC);
}

function resolveNumero(row) {
  if (isNotaCredito(row)) {
    return strVal(row.FEL_NUMERO) || (row.CORRELATIVO != null ? String(row.CORRELATIVO) : null);
  }
  return strVal(row.FEL_NUMERO) || strVal(row.NOFAC) || (row.CORRELATIVO != null ? String(row.CORRELATIVO) : null);
}

function resolveTotalHeader(row) {
  const costo = toNumber(row.TOTALCOSTO);
  const precio = toNumber(row.TOTALPRECIO);
  return costo !== 0 ? costo : precio;
}

/**
 * Totales por TIPOPROD: P = productos, S = servicios.
 * Si no hay líneas, el encabezado cae en productos.
 */
function resolveTotalesPorTipo(row) {
  const hasLines =
    toNumber(row.LINEAS) > 0 ||
    toNumber(row.TOTAL_PRODUCTOS_RAW) !== 0 ||
    toNumber(row.TOTAL_SERVICIOS_RAW) !== 0;
  if (hasLines) {
    return {
      totalProductos: roundMoney(toNumber(row.TOTAL_PRODUCTOS_RAW)),
      totalServicios: roundMoney(toNumber(row.TOTAL_SERVICIOS_RAW)),
    };
  }
  return {
    totalProductos: roundMoney(resolveTotalHeader(row)),
    totalServicios: 0,
  };
}

/**
 * Desglose SAT GT sobre un monto con IVA incluido: base = monto / 1.12 ; IVA = monto − base.
 */
function baseEIvaDeMonto(monto, ivaFactor) {
  const { gravable, iva } = splitIvaFromTotal(monto, monto > 0, ivaFactor);
  return { base: roundMoney(gravable), iva: roundMoney(iva) };
}

/**
 * Desglose SAT GT:
 * - COM/DVP: base/IVA por productos y servicios (TIPOPROD P/S).
 * - COP: importe completo en Exentas (sin IVA recuperable).
 * - RTV/RTI: montos del documento.
 */
function desgloseIvaLibroCompras(row, ivaFactor) {
  const { totalProductos, totalServicios } = resolveTotalesPorTipo(row);
  const totalDoc = roundMoney(totalProductos + totalServicios);

  if (isRetencion(row)) {
    return {
      totalProductos: roundMoney(resolveTotalHeader(row)),
      totalServicios: 0,
      exento: roundMoney(toNumber(row.TOTALEXENTO)),
      baseTotal: roundMoney(toNumber(row.TOTALSINIVA)),
      baseServicios: 0,
      iva: roundMoney(toNumber(row.TOTALIVA)),
      total: roundMoney(resolveTotalHeader(row)),
    };
  }

  if (isCompraPeq(row)) {
    return {
      totalProductos,
      totalServicios,
      exento: totalDoc,
      baseTotal: 0,
      baseServicios: 0,
      iva: 0,
      total: totalDoc,
    };
  }

  const prod = baseEIvaDeMonto(totalProductos, ivaFactor);
  const serv = baseEIvaDeMonto(totalServicios, ivaFactor);
  const exentoHeader = roundMoney(toNumber(row.TOTALEXENTO));
  return {
    totalProductos,
    totalServicios,
    exento: exentoHeader,
    baseTotal: prod.base,
    baseServicios: serv.base,
    iva: roundMoney(prod.iva + serv.iva),
    total: totalDoc,
  };
}

function mapLibroComprasRow(row, index, ivaFactor) {
  const sign = signForRow(row);
  const d = desgloseIvaLibroCompras(row, ivaFactor);
  const tipodoc = tipodocOf(row);

  return {
    LINEA: index + 1,
    CODDOC: row.CODDOC ?? null,
    CORRELATIVO: row.CORRELATIVO ?? null,
    TIPODOC: tipodoc,
    DESDOC: row.DESDOC ?? null,
    FEL_SERIE: resolveSerie(row),
    FEL_NUMERO: resolveNumero(row),
    FEL_FECHA: row.FEL_FECHA ?? null,
    FECHA: row.FECHA ?? null,
    DOC_NIT: row.DOC_NIT ?? null,
    DOC_NOMCLIE: row.DOC_NOMCLIE ?? null,
    TOTAL: roundMoney(d.totalProductos * sign),
    TOTAL_SERVICIOS: roundMoney(d.totalServicios * sign),
    TOTALEXENTO: roundMoney(d.exento * sign),
    TOTALSINIVA: roundMoney(d.baseTotal * sign),
    BASE_SERVICIOS: roundMoney(d.baseServicios * sign),
    TOTALIVA: roundMoney(d.iva * sign),
    STATUS: String(row.STATUS ?? '').trim().toUpperCase(),
    ANULADO: isAnulado(row),
    ES_NOTA_CREDITO: isNotaCredito(row),
    ES_PEQ_CONTRIBUYENTE: tipodoc === 'COP',
  };
}

function summarizeRows(rows) {
  const totals = {
    total: 0,
    totalServicios: 0,
    exento: 0,
    gravado: 0,
    baseServicios: 0,
    iva: 0,
    documentos: rows.length,
    anulados: 0,
    compras: 0,
    peqContribuyente: 0,
    notasCredito: 0,
  };

  rows.forEach((r) => {
    if (r.ANULADO) {
      totals.anulados += 1;
      return;
    }
    if (r.ES_NOTA_CREDITO) totals.notasCredito += 1;
    else if (r.ES_PEQ_CONTRIBUYENTE) totals.peqContribuyente += 1;
    else totals.compras += 1;
    totals.total = roundMoney(totals.total + toNumber(r.TOTAL));
    totals.totalServicios = roundMoney(totals.totalServicios + toNumber(r.TOTAL_SERVICIOS));
    totals.exento = roundMoney(totals.exento + toNumber(r.TOTALEXENTO));
    totals.gravado = roundMoney(totals.gravado + toNumber(r.TOTALSINIVA));
    totals.baseServicios = roundMoney(totals.baseServicios + toNumber(r.BASE_SERVICIOS));
    totals.iva = roundMoney(totals.iva + toNumber(r.TOTALIVA));
  });

  return totals;
}

async function listLibroCompras(pool, sql, empnit, mes, anio) {
  const ivaFactor = await getIvaFactor(pool);
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('MES', sql.Int, mes)
    .input('ANIO', sql.Int, anio)
    .query(`
      SELECT
        d.ID,
        d.CODDOC,
        d.CORRELATIVO,
        d.FEL_SERIE,
        d.FEL_NUMERO,
        d.FEL_FECHA,
        d.SERIEFAC,
        d.NOFAC,
        d.FECHA,
        d.DOC_NIT,
        d.DOC_NOMCLIE,
        ISNULL(d.TOTALEXENTO, 0) AS TOTALEXENTO,
        ISNULL(d.TOTALSINIVA, 0) AS TOTALSINIVA,
        ISNULL(d.TOTALIVA, 0) AS TOTALIVA,
        ISNULL(d.TOTALCOSTO, 0) AS TOTALCOSTO,
        ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
        d.STATUS,
        t.TIPODOC,
        t.DESDOC,
        ISNULL(dp.LINEAS, 0) AS LINEAS,
        ISNULL(dp.TOTAL_PRODUCTOS, 0) AS TOTAL_PRODUCTOS_RAW,
        ISNULL(dp.TOTAL_SERVICIOS, 0) AS TOTAL_SERVICIOS_RAW
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t
        ON d.EMPNIT = t.EMPNIT AND d.CODDOC = t.CODDOC
      LEFT JOIN (
        SELECT
          EMPNIT,
          CODDOC,
          CORRELATIVO,
          COUNT(1) AS LINEAS,
          SUM(
            CASE
              WHEN UPPER(LTRIM(RTRIM(ISNULL(TIPOPROD, 'P')))) <> 'S'
              THEN CASE
                WHEN ISNULL(TOTALCOSTO, 0) <> 0 THEN ISNULL(TOTALCOSTO, 0)
                ELSE ISNULL(TOTALPRECIO, 0)
              END
              ELSE 0
            END
          ) AS TOTAL_PRODUCTOS,
          SUM(
            CASE
              WHEN UPPER(LTRIM(RTRIM(ISNULL(TIPOPROD, '')))) = 'S'
              THEN CASE
                WHEN ISNULL(TOTALCOSTO, 0) <> 0 THEN ISNULL(TOTALCOSTO, 0)
                ELSE ISNULL(TOTALPRECIO, 0)
              END
              ELSE 0
            END
          ) AS TOTAL_SERVICIOS
        FROM dbo.DOCPRODUCTOS
        GROUP BY EMPNIT, CODDOC, CORRELATIVO
      ) dp
        ON dp.EMPNIT = d.EMPNIT
       AND dp.CODDOC = d.CODDOC
       AND dp.CORRELATIVO = d.CORRELATIVO
      WHERE d.EMPNIT = @EMPNIT
        AND d.MES = @MES
        AND d.ANIO = @ANIO
        AND (
          ISNULL(t.CONTABLE, 'NO') = 'SI'
          OR UPPER(LTRIM(RTRIM(ISNULL(t.TIPODOC, '')))) IN (${TIPODOC_NOTAS_CREDITO.map((t) => `'${t}'`).join(', ')})
        )
        AND UPPER(LTRIM(RTRIM(ISNULL(t.TIPODOC, '')))) IN (${SQL_TIPODOC_LIBRO_COMPRAS_IN})
      ORDER BY
        CASE
          WHEN d.FEL_FECHA IS NOT NULL AND LTRIM(RTRIM(d.FEL_FECHA)) <> '' THEN d.FEL_FECHA
          ELSE CONVERT(VARCHAR(30), d.FECHA, 126)
        END,
        ISNULL(NULLIF(LTRIM(RTRIM(d.FEL_SERIE)), ''), ISNULL(d.SERIEFAC, d.CODDOC)),
        ISNULL(NULLIF(LTRIM(RTRIM(d.FEL_NUMERO)), ''), ISNULL(d.NOFAC, CAST(d.CORRELATIVO AS VARCHAR(30)))),
        d.ID
    `);

  const rows = result.recordset.map((row, index) => mapLibroComprasRow(row, index, ivaFactor));
  return {
    rows,
    totals: summarizeRows(rows),
    mes,
    anio,
    ivaFactor: roundMoney(ivaFactor),
  };
}

module.exports = {
  TIPODOC_COMPRAS,
  TIPODOC_COMPRAS_IVA,
  TIPODOC_COMPRAS_PEQ,
  TIPODOC_NOTAS_CREDITO,
  TIPODOC_LIBRO_COMPRAS,
  listLibroCompras,
  summarizeRows,
  desgloseIvaLibroCompras,
  mapLibroComprasRow,
};
