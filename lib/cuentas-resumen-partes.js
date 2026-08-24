/**
 * Resumen CxC/CxP agrupado por cliente o proveedor (todos los docs con saldo).
 * DOCUMENTOS.CODCLIENTE guarda el código de cliente (CxC) o de proveedor (CxP).
 */

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const SQL_CODIGO_PARTE = `CASE WHEN ISNULL(d.CODCLIENTE, 0) > 0 THEN ISNULL(d.CODCLIENTE, 0) ELSE 0 END`;
const SQL_NIT_SIN_CODIGO = `CASE WHEN ISNULL(d.CODCLIENTE, 0) > 0 THEN N'' ELSE LTRIM(RTRIM(ISNULL(d.DOC_NIT, N''))) END`;
const SQL_NOM_SIN_CODIGO = `CASE WHEN ISNULL(d.CODCLIENTE, 0) > 0 THEN N'' ELSE LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, N''))) END`;

/**
 * @param {object} opts
 * @param {string} opts.tipodocSqlIn
 * @param {string} opts.saldoWhereSql
 * @param {string} [opts.extraWhereSql]
 * @param {string} opts.partyJoinSql
 * @param {string} opts.partyNameSql expresión SQL del nombre de catálogo (con fallback a DOC_NOMCLIE)
 * @param {string} [opts.q]
 */
async function fetchResumenPartes(pool, sql, empnit, opts) {
  const q = String(opts.q || '').trim();
  const qLike = q ? `%${q}%` : null;
  const extraWhere = opts.extraWhereSql ? `AND ${opts.extraWhereSql}` : '';

  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('q', sql.NVarChar, q || null)
    .input('qLike', sql.NVarChar, qLike)
    .query(`
      SELECT
        ${SQL_CODIGO_PARTE} AS CODIGO,
        ${SQL_NIT_SIN_CODIGO} AS NIT,
        ${SQL_NOM_SIN_CODIGO} AS NOMBRE_KEY,
        MAX(${opts.partyNameSql}) AS NOMBRE,
        COUNT(*) AS DOCUMENTOS,
        ISNULL(SUM(ISNULL(d.DOC_ABONO, 0)), 0) AS ABONO,
        ISNULL(SUM(ISNULL(d.DOC_SALDO, 0)), 0) AS SALDO
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON d.CODDOC = t.CODDOC AND d.EMPNIT = t.EMPNIT
      ${opts.partyJoinSql}
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${opts.tipodocSqlIn})
        AND d.STATUS = 'O'
        AND ISNULL(d.CONCRE, 'CON') = 'CRE'
        AND ${opts.saldoWhereSql}
        ${extraWhere}
        AND (
          @q IS NULL OR @q = ''
          OR CAST(ISNULL(d.CODCLIENTE, 0) AS VARCHAR(30)) LIKE @qLike
          OR d.DOC_NOMCLIE LIKE @qLike
          OR d.DOC_NIT LIKE @qLike
          OR ${opts.partyNameSql} LIKE @qLike
        )
      GROUP BY
        ${SQL_CODIGO_PARTE},
        ${SQL_NIT_SIN_CODIGO},
        ${SQL_NOM_SIN_CODIGO}
      ORDER BY SALDO DESC, NOMBRE ASC
    `);

  const rows = (result.recordset || []).map((r) => {
    const codigo = toNumber(r.CODIGO);
    return {
      codigo: codigo > 0 ? codigo : 0,
      nit: String(r.NIT || '').trim(),
      nombreKey: String(r.NOMBRE_KEY || '').trim(),
      nombre: String(r.NOMBRE || '').trim() || '—',
      documentos: toNumber(r.DOCUMENTOS),
      abono: toNumber(r.ABONO),
      saldo: toNumber(r.SALDO),
    };
  });

  const totales = rows.reduce(
    (acc, r) => {
      acc.partes += 1;
      acc.documentos += r.documentos;
      acc.abono += r.abono;
      acc.saldo += r.saldo;
      return acc;
    },
    { partes: 0, documentos: 0, abono: 0, saldo: 0 }
  );

  return { rows, totales };
}

function partyFilterSql(codigo, nit, nombre) {
  const cod = Number(codigo);
  if (Number.isFinite(cod) && cod > 0) {
    return {
      mode: 'codigo',
      codigo: Math.trunc(cod),
      nit: '',
      nombre: '',
      sql: 'AND ISNULL(d.CODCLIENTE, 0) = @CODPARTE',
    };
  }
  return {
    mode: 'sin-codigo',
    codigo: 0,
    nit: String(nit || '').trim(),
    nombre: String(nombre || '').trim(),
    sql: `
      AND ISNULL(d.CODCLIENTE, 0) = 0
      AND LTRIM(RTRIM(ISNULL(d.DOC_NIT, ''))) = @NITPARTE
      AND LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, ''))) = @NOMPARTE
    `,
  };
}

function bindPartyFilter(request, sql, filter) {
  request.input('CODPARTE', sql.Int, filter.codigo);
  request.input('NITPARTE', sql.NVarChar, filter.nit);
  request.input('NOMPARTE', sql.NVarChar, filter.nombre);
  return request;
}

module.exports = {
  fetchResumenPartes,
  partyFilterSql,
  bindPartyFilter,
  SQL_NOMBRE_CLIENTE: `ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(c.NOMBRECLIENTE, ''))), ''), ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(c.NEGOCIO, ''))), ''), LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, '')))))`,
  SQL_NOMBRE_PROVEEDOR: `ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(p.EMPRESA, ''))), ''), ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(p.RAZONSOCIAL, ''))), ''), LTRIM(RTRIM(ISNULL(d.DOC_NOMCLIE, '')))))`,
  SQL_JOIN_CLIENTES: 'LEFT JOIN dbo.CLIENTES c ON d.EMPNIT = c.EMPNIT AND d.CODCLIENTE = c.CODCLIENTE',
  SQL_JOIN_PROVEEDORES: 'LEFT JOIN dbo.PROVEEDORES p ON d.EMPNIT = p.EMPNIT AND d.CODCLIENTE = p.CODPROV',
};
