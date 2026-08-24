const sql = require('mssql');
const { mapProductoSearchRow } = require('./producto-precio-linea');
const { sqlExistenciaMedidaExpr } = require('./existencia-medida');
const { getSettingSino, SETTING_OPCION } = require('./settings');

function toProductoSearchLike(term) {
  const raw = String(term ?? '').trim();
  if (!raw) return '';
  const pattern = raw.replace(/\+/g, '%');
  return `%${pattern}%`;
}

function mapSearchRows(recordset, { useDesprod2, campoPrecio }) {
  return (recordset || []).map((row) =>
    mapProductoSearchRow(
      {
        CODPROD: row.CODPROD,
        DESPROD: row.DESPROD,
        DESPROD2: useDesprod2 ? (row.DESPROD2 ?? '') : '',
        DESMARCA: row.DESMARCA ?? '',
        COSTO_PROD: row.COSTO_PROD,
        TIPOPROD: row.TIPOPROD,
        CODMEDIDA: row.CODMEDIDA,
        PRECIO: row.PRECIO,
        MAYOREOA: row.MAYOREOA,
        MAYOREOB: row.MAYOREOB,
        MAYOREOC: row.MAYOREOC,
        COSTO: row.COSTO ?? row.COSTO_PROD,
        EQUIVALE: row.EQUIVALE,
        EXISTENCIA: row.EXISTENCIA,
      },
      campoPrecio
    )
  );
}

function buildSelectSql({ useDesprod2, includeMayoreo, withTop = true }) {
  const mayoreoSelect = includeMayoreo ? 'pr.MAYOREOA, pr.MAYOREOB, pr.MAYOREOC,' : '';
  const top = withTop ? 'SELECT TOP (@limit)' : 'SELECT';
  return `
    ${top}
      p.CODPROD,
      p.DESPROD,
      ${useDesprod2 ? 'p.DESPROD2,' : "CAST('' AS VARCHAR(255)) AS DESPROD2,"}
      m.DESMARCA,
      p.COSTO AS COSTO_PROD,
      p.TIPOPROD,
      pr.CODMEDIDA,
      pr.PRECIO,
      ${mayoreoSelect}
      pr.COSTO,
      pr.EQUIVALE,
      ${sqlExistenciaMedidaExpr('pr.EQUIVALE')}
    FROM dbo.PRODUCTOS p
    INNER JOIN dbo.PRECIOS pr
      ON p.EMPNIT = pr.EMPNIT AND p.CODPROD = pr.CODPROD
    LEFT JOIN dbo.Marcas m
      ON p.EMPNIT = m.EMPNIT AND p.CODMARCA = m.CODMARCA
    LEFT JOIN dbo.INVSALDO inv
      ON inv.EMPNIT = p.EMPNIT
     AND inv.CODPROD = p.CODPROD
  `;
}

function parseLimitProducts(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 50);
}

/**
 * Búsqueda de productos para movimientos (POS, cotizaciones, facturación, compras, inventario).
 * JOINs directos: PRODUCTOS + PRECIOS + Marcas + INVSALDO por claves de negocio.
 * DESPROD2: si la opción SETTINGS está en SI, se muestra en el resultado y la
 * búsqueda por descripción usa DESPROD + ' ' + DESPROD2 concatenados.
 *
 * Si el criterio coincide exactamente con CODPROD (sin LIKE), solo se devuelve ese producto.
 */
async function searchMovimientoProductos(pool, {
  empnit,
  q,
  limit = 40,
  limitProducts = null,
  campoPrecio,
  extraWhereSql = '',
  includeMayoreo = true,
  allowEmptyQ = false,
}) {
  const term = String(q ?? '').trim();
  if (!term && !allowEmptyQ) {
    return { rows: [], q: null, muestraDesprod2: 'NO', ...(campoPrecio ? { campoPrecio } : {}) };
  }

  const muestraDesprod2 = await getSettingSino(pool, SETTING_OPCION.MUESTRA_DESPROD2_EN_DOCS_Y_PRODS);
  const useDesprod2 = muestraDesprod2 === 'SI';
  const hasTerm = Boolean(term);
  const productLimit = parseLimitProducts(limitProducts);
  const selectSql = buildSelectSql({
    useDesprod2,
    includeMayoreo,
    withTop: !productLimit,
  });
  const baseWhere = `
    WHERE p.EMPNIT = @EMPNIT
      AND UPPER(RTRIM(ISNULL(p.HABILITADO, 'SI'))) = 'SI'
      AND UPPER(RTRIM(ISNULL(pr.HABILITADO, 'SI'))) = 'SI'
      ${extraWhereSql}
  `;

  if (hasTerm) {
    const exactReq = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('limit', sql.Int, productLimit ? 500 : limit)
      .input('qExact', sql.NVarChar, term);
    const exactSelect = productLimit
      ? buildSelectSql({ useDesprod2, includeMayoreo, withTop: false })
      : selectSql;
    const exactResult = await exactReq.query(`
      ${exactSelect}
      ${baseWhere}
        AND LTRIM(RTRIM(p.CODPROD)) = @qExact
      ORDER BY p.DESPROD, pr.CODMEDIDA
    `);
    if (exactResult.recordset?.length) {
      return {
        rows: mapSearchRows(exactResult.recordset, { useDesprod2, campoPrecio }),
        q: term,
        match: 'codprod',
        muestraDesprod2,
        ...(campoPrecio ? { campoPrecio } : {}),
      };
    }
  }

  const desprodFilter = useDesprod2
    ? `(LTRIM(RTRIM(ISNULL(p.DESPROD, ''))) + ' ' + LTRIM(RTRIM(ISNULL(p.DESPROD2, '')))) LIKE @qLike`
    : `p.DESPROD LIKE @qLike`;
  const qFilter = hasTerm
    ? `AND (
        p.CODPROD LIKE @qLike OR p.CODPROD2 LIKE @qLike
        OR ${desprodFilter}
        OR m.DESMARCA LIKE @qLike
      )`
    : '';

  if (productLimit) {
    const request = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('limitProducts', sql.Int, productLimit);
    if (hasTerm) {
      request.input('qLike', sql.NVarChar, toProductoSearchLike(term));
    }
    const result = await request.query(`
      ;WITH FoundProds AS (
        SELECT TOP (@limitProducts)
          p.CODPROD
        FROM dbo.PRODUCTOS p
        LEFT JOIN dbo.Marcas m
          ON p.EMPNIT = m.EMPNIT AND p.CODMARCA = m.CODMARCA
        WHERE p.EMPNIT = @EMPNIT
          AND UPPER(RTRIM(ISNULL(p.HABILITADO, 'SI'))) = 'SI'
          AND EXISTS (
            SELECT 1
            FROM dbo.PRECIOS prx
            WHERE prx.EMPNIT = p.EMPNIT
              AND prx.CODPROD = p.CODPROD
              AND UPPER(RTRIM(ISNULL(prx.HABILITADO, 'SI'))) = 'SI'
          )
          ${qFilter}
        GROUP BY p.CODPROD, p.DESPROD
        ORDER BY p.DESPROD, p.CODPROD
      )
      ${buildSelectSql({ useDesprod2, includeMayoreo, withTop: false })}
      INNER JOIN FoundProds fp ON fp.CODPROD = p.CODPROD
      ${baseWhere}
      ORDER BY p.DESPROD, pr.CODMEDIDA
    `);
    return {
      rows: mapSearchRows(result.recordset, { useDesprod2, campoPrecio }),
      q: term || null,
      match: hasTerm ? 'like' : null,
      muestraDesprod2,
      limitProducts: productLimit,
      ...(campoPrecio ? { campoPrecio } : {}),
    };
  }

  const request = pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('limit', sql.Int, limit);
  if (hasTerm) {
    request.input('qLike', sql.NVarChar, toProductoSearchLike(term));
  }

  const result = await request.query(`
    ${selectSql}
    ${baseWhere}
      ${qFilter}
    ORDER BY p.DESPROD, pr.CODMEDIDA
  `);

  return {
    rows: mapSearchRows(result.recordset, { useDesprod2, campoPrecio }),
    q: term || null,
    match: hasTerm ? 'like' : null,
    muestraDesprod2,
    ...(campoPrecio ? { campoPrecio } : {}),
  };
}

module.exports = { searchMovimientoProductos, toProductoSearchLike };
