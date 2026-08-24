/**
 * Consolidado de productos en documentos con saldo (CxC / CxP).
 */
async function fetchConsolidadoProductos(pool, sql, empnit, { tipodocSqlIn, saldoWhereSql }) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT
        LTRIM(RTRIM(ISNULL(l.CODPROD, ''))) AS CODPROD,
        MAX(ISNULL(l.DESPROD, '')) AS DESPROD,
        ISNULL(SUM(ISNULL(l.TOTALUNIDADES, 0)), 0) AS TOTALUNIDADES,
        ISNULL(SUM(ISNULL(l.TOTALPRECIO, 0)), 0) AS TOTALPRECIO,
        COUNT(*) AS LINEAS,
        COUNT(DISTINCT CONCAT(d.CODDOC, '-', CAST(d.CORRELATIVO AS VARCHAR(30)))) AS DOCUMENTOS
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      INNER JOIN dbo.DOCPRODUCTOS l
        ON l.EMPNIT = d.EMPNIT
       AND l.CODDOC = d.CODDOC
       AND l.CORRELATIVO = d.CORRELATIVO
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${tipodocSqlIn})
        AND d.STATUS = 'O'
        AND ISNULL(d.CONCRE, 'CON') = 'CRE'
        AND ${saldoWhereSql}
      GROUP BY LTRIM(RTRIM(ISNULL(l.CODPROD, '')))
      ORDER BY TOTALPRECIO DESC, CODPROD ASC
    `);

  const rows = (result.recordset || []).map((r) => ({
    CODPROD: String(r.CODPROD || '').trim(),
    DESPROD: String(r.DESPROD || '').trim(),
    TOTALUNIDADES: Number(r.TOTALUNIDADES) || 0,
    TOTALPRECIO: Number(r.TOTALPRECIO) || 0,
    LINEAS: Number(r.LINEAS) || 0,
    DOCUMENTOS: Number(r.DOCUMENTOS) || 0,
  }));

  const totales = rows.reduce(
    (acc, r) => {
      acc.totalUnidades += r.TOTALUNIDADES;
      acc.totalPrecio += r.TOTALPRECIO;
      acc.productos += 1;
      return acc;
    },
    { totalUnidades: 0, totalPrecio: 0, productos: 0 }
  );

  return { rows, totales };
}

async function fetchConsolidadoProductoDocumentos(pool, sql, empnit, codprod, { tipodocSqlIn, saldoWhereSql }) {
  const code = String(codprod ?? '').trim();
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROD', sql.VarChar, code)
    .query(`
      SELECT
        d.FECHA,
        d.VENCIMIENTO,
        d.CODDOC,
        d.CORRELATIVO,
        d.DOC_NOMCLIE,
        d.CODCLIENTE,
        LTRIM(RTRIM(ISNULL(l.CODMEDIDA, ''))) AS CODMEDIDA,
        ISNULL(l.CANTIDAD, 0) AS CANTIDAD,
        ISNULL(l.PRECIO, 0) AS PRECIO,
        ISNULL(l.TOTALPRECIO, 0) AS TOTALPRECIO
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      INNER JOIN dbo.DOCPRODUCTOS l
        ON l.EMPNIT = d.EMPNIT
       AND l.CODDOC = d.CODDOC
       AND l.CORRELATIVO = d.CORRELATIVO
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${tipodocSqlIn})
        AND d.STATUS = 'O'
        AND ISNULL(d.CONCRE, 'CON') = 'CRE'
        AND ${saldoWhereSql}
        AND LTRIM(RTRIM(ISNULL(l.CODPROD, ''))) = @CODPROD
      ORDER BY d.FECHA DESC, d.CORRELATIVO DESC, l.Id
    `);

  const rows = (result.recordset || []).map((r) => ({
    FECHA: r.FECHA ?? null,
    VENCIMIENTO: r.VENCIMIENTO ?? null,
    CODDOC: r.CODDOC ?? null,
    CORRELATIVO: r.CORRELATIVO ?? null,
    DOC_NOMCLIE: String(r.DOC_NOMCLIE || '').trim(),
    CODCLIENTE: r.CODCLIENTE ?? null,
    CODMEDIDA: String(r.CODMEDIDA || '').trim(),
    CANTIDAD: Number(r.CANTIDAD) || 0,
    PRECIO: Number(r.PRECIO) || 0,
    TOTALPRECIO: Number(r.TOTALPRECIO) || 0,
  }));

  const totales = rows.reduce(
    (acc, r) => {
      acc.lineas += 1;
      acc.cantidad += r.CANTIDAD;
      acc.totalPrecio += r.TOTALPRECIO;
      return acc;
    },
    { lineas: 0, cantidad: 0, totalPrecio: 0 }
  );

  return { rows, totales, CODPROD: code };
}

module.exports = {
  fetchConsolidadoProductos,
  fetchConsolidadoProductoDocumentos,
};
