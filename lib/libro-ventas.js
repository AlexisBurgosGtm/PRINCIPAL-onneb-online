const { getIvaFactor, splitIvaFromTotal } = require('./impuestos');

const TIPODOC_VENTAS = ['FEF', 'FEC', 'FES'];
const TIPODOC_NOTAS_CREDITO = ['FNC'];
const TIPODOC_LIBRO_VENTAS = [...TIPODOC_VENTAS, ...TIPODOC_NOTAS_CREDITO];

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function isAnulado(row) {
  return String(row?.STATUS ?? '').trim().toUpperCase() === 'A';
}

function isNotaCredito(row) {
  return String(row?.TIPODOC ?? '').trim().toUpperCase() === 'FNC';
}

function signForRow(row) {
  if (isAnulado(row)) return 0;
  return isNotaCredito(row) ? -1 : 1;
}

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
    totalProductos: roundMoney(toNumber(row.TOTALPRECIO)),
    totalServicios: 0,
  };
}

function baseEIvaDeMonto(monto, ivaFactor) {
  const { gravable, iva } = splitIvaFromTotal(monto, monto > 0, ivaFactor);
  return { base: roundMoney(gravable), iva: roundMoney(iva) };
}

/**
 * Desglose SAT GT: base = total / 1.12 ; IVA = total − base.
 * Productos (TIPOPROD=P) y servicios (TIPOPROD=S) por separado.
 * TOTALEXENTO del encabezado se reporta aparte (no forma parte de las bases).
 */
function desgloseIvaLibro(row, ivaFactor) {
  const { totalProductos, totalServicios } = resolveTotalesPorTipo(row);
  const prod = baseEIvaDeMonto(totalProductos, ivaFactor);
  const serv = baseEIvaDeMonto(totalServicios, ivaFactor);
  return {
    totalProductos,
    totalServicios,
    exento: roundMoney(toNumber(row.TOTALEXENTO)),
    baseTotal: prod.base,
    baseServicios: serv.base,
    iva: roundMoney(prod.iva + serv.iva),
  };
}

function mapLibroVentasRow(row, index, ivaFactor) {
  const sign = signForRow(row);
  const d = desgloseIvaLibro(row, ivaFactor);

  return {
    LINEA: index + 1,
    CODDOC: row.CODDOC ?? null,
    CORRELATIVO: row.CORRELATIVO ?? null,
    TIPODOC: String(row.TIPODOC ?? '').trim().toUpperCase(),
    DESDOC: row.DESDOC ?? null,
    FEL_SERIE: row.FEL_SERIE ?? null,
    FEL_NUMERO: row.FEL_NUMERO ?? null,
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
    ventas: 0,
    notasCredito: 0,
  };

  rows.forEach((r) => {
    if (r.ANULADO) {
      totals.anulados += 1;
      return;
    }
    if (r.ES_NOTA_CREDITO) totals.notasCredito += 1;
    else totals.ventas += 1;
    totals.total = roundMoney(totals.total + toNumber(r.TOTAL));
    totals.totalServicios = roundMoney(totals.totalServicios + toNumber(r.TOTAL_SERVICIOS));
    totals.exento = roundMoney(totals.exento + toNumber(r.TOTALEXENTO));
    totals.gravado = roundMoney(totals.gravado + toNumber(r.TOTALSINIVA));
    totals.baseServicios = roundMoney(totals.baseServicios + toNumber(r.BASE_SERVICIOS));
    totals.iva = roundMoney(totals.iva + toNumber(r.TOTALIVA));
  });

  return totals;
}

async function listLibroVentas(pool, sql, empnit, mes, anio) {
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
        d.FECHA,
        d.DOC_NIT,
        d.DOC_NOMCLIE,
        ISNULL(d.TOTALEXENTO, 0) AS TOTALEXENTO,
        ISNULL(d.TOTALSINIVA, 0) AS TOTALSINIVA,
        ISNULL(d.TOTALIVA, 0) AS TOTALIVA,
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
              THEN ISNULL(TOTALPRECIO, 0)
              ELSE 0
            END
          ) AS TOTAL_PRODUCTOS,
          SUM(
            CASE
              WHEN UPPER(LTRIM(RTRIM(ISNULL(TIPOPROD, '')))) = 'S'
              THEN ISNULL(TOTALPRECIO, 0)
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
        AND ISNULL(t.CONTABLE, 'NO') = 'SI'
        AND t.TIPODOC IN ('FEF', 'FEC', 'FES', 'FNC')
      ORDER BY
        CASE
          WHEN d.FEL_FECHA IS NOT NULL AND LTRIM(RTRIM(d.FEL_FECHA)) <> '' THEN d.FEL_FECHA
          ELSE CONVERT(VARCHAR(30), d.FECHA, 126)
        END,
        ISNULL(d.FEL_SERIE, d.CODDOC),
        ISNULL(d.FEL_NUMERO, CAST(d.CORRELATIVO AS VARCHAR(30))),
        d.ID
    `);

  const rows = result.recordset.map((row, index) => mapLibroVentasRow(row, index, ivaFactor));
  return {
    rows,
    totals: summarizeRows(rows),
    mes,
    anio,
    ivaFactor: roundMoney(ivaFactor),
  };
}

module.exports = {
  TIPODOC_VENTAS,
  TIPODOC_NOTAS_CREDITO,
  TIPODOC_LIBRO_VENTAS,
  listLibroVentas,
  summarizeRows,
  desgloseIvaLibro,
};
