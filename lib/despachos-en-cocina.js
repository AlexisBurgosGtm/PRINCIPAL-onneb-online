/**
 * Consultas compartidas para Despachos en Cocina (lista + socket).
 */
const sql = require('mssql');
const { STATUS_ANULADO } = require('./documento-status');

const TIPODOC_COMANDA = 'CRS';
const SOLICITADO_COCINA = 1;

const SELECT_COCINA_ROWS = `
  SELECT
    l.Id AS ID,
    l.CODPROD,
    l.DESPROD,
    l.CODMEDIDA,
    l.CANTIDAD,
    l.OBS,
    ISNULL(l.SOLICITADO, 0) AS SOLICITADO,
    d.CODDOC,
    d.CORRELATIVO,
    d.CODVEN,
    d.CODEMBARQUE,
    ISNULL(NULLIF(LTRIM(RTRIM(e.NOMEMPLEADO)), ''), ISNULL(d.USUARIO, '—')) AS MESERO,
    ISNULL(
      NULLIF(LTRIM(RTRIM(m.DESMESA)), ''),
      ISNULL(NULLIF(LTRIM(RTRIM(m.CODMESA)), ''), ISNULL(NULLIF(LTRIM(RTRIM(d.OBS)), ''), ISNULL(d.CODEMBARQUE, '—')))
    ) AS MESA,
    p.CODCLATRES,
    ISNULL(c3.DESCLATRES, 'Sin ubicación') AS UBICACION
  FROM dbo.DOCPRODUCTOS l
  INNER JOIN dbo.DOCUMENTOS d
    ON d.EMPNIT = l.EMPNIT AND d.CODDOC = l.CODDOC AND d.CORRELATIVO = l.CORRELATIVO
  INNER JOIN dbo.TIPODOCUMENTOS t
    ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
  LEFT JOIN dbo.PRODUCTOS p
    ON p.EMPNIT = l.EMPNIT AND LTRIM(RTRIM(p.CODPROD)) = LTRIM(RTRIM(l.CODPROD))
  LEFT JOIN dbo.CLASIFICACIONTRES c3
    ON c3.EMPNIT = p.EMPNIT AND c3.CODCLATRES = p.CODCLATRES
  LEFT JOIN dbo.Empleados e
    ON e.EMPNIT = d.EMPNIT AND e.CODEMPLEADO = d.CODVEN
  LEFT JOIN dbo.RESTAURANTE_MESAS m
    ON m.EMPNIT = d.EMPNIT
    AND LTRIM(RTRIM(ISNULL(d.CODEMBARQUE, ''))) = CAST(m.ID AS VARCHAR(30))
`;

/**
 * @param {import('mssql').ConnectionPool} pool
 * @param {string} empnit
 * @param {number[]} ids
 */
async function fetchCocinaRowsByIds(pool, empnit, ids) {
  const clean = [...new Set((ids || []).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!clean.length) return [];

  const request = pool.request().input('EMPNIT', sql.VarChar, empnit);
  const placeholders = clean.map((id, i) => {
    const key = `ID${i}`;
    request.input(key, sql.Int, id);
    return `@${key}`;
  });

  const result = await request.query(`
    ${SELECT_COCINA_ROWS}
    WHERE l.EMPNIT = @EMPNIT
      AND t.TIPODOC = '${TIPODOC_COMANDA}'
      AND ISNULL(d.STATUS, '') <> '${STATUS_ANULADO}'
      AND l.Id IN (${placeholders.join(', ')})
    ORDER BY l.Id
  `);
  return result.recordset || [];
}

module.exports = {
  TIPODOC_COMANDA,
  SOLICITADO_COCINA,
  SELECT_COCINA_ROWS,
  fetchCocinaRowsByIds,
};
