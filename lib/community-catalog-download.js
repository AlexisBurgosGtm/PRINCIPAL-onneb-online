/**
 * Descarga catálogo desde COMMUNITY_* hacia tablas locales (EMPNIT sesión) con bulk insert.
 * Maestros: MARCAS, MEDIDAS, CLASIFICACIONUNO, PROVEEDORES←CLASIFICACIONTRES
 * Ítems: PRODUCTOS, PRECIOS + INVSALDO (conserva existencia/mín/máx locales).
 */
const sql = require('mssql');
const {
  CLOUD_EMPNIT,
  mapCommunityToProveedores,
} = require('./community-catalog-upload');
const { deleteOrphanInvSaldo, syncMissingInvSaldo } = require('./invsaldo');

const BULK_CHUNK = 1500;
const BULK_TIMEOUT_MS = 10 * 60 * 1000;

/** Lectura nube + carga local (maestros → productos). */
const DOWNLOAD_SPECS = [
  {
    key: 'marcas',
    community: 'COMMUNITY_MARCAS',
    local: 'Marcas',
    previewCols: `
      CAST(CODMARCA AS VARCHAR(50)) AS CODIGO,
      LTRIM(RTRIM(ISNULL(CAST(DESMARCA AS NVARCHAR(250)), ''))) AS NOMBRE
    `,
  },
  {
    key: 'medidas',
    community: 'COMMUNITY_MEDIDAS',
    local: 'MEDIDAS',
    previewCols: `
      LTRIM(RTRIM(CAST(CODMEDIDA AS VARCHAR(50)))) AS CODIGO,
      LTRIM(RTRIM(ISNULL(CAST(TIPOPRECIO AS NVARCHAR(100)), ''))) AS NOMBRE
    `,
  },
  {
    key: 'clasificacionuno',
    community: 'COMMUNITY_CLASIFICACIONUNO',
    local: 'CLASIFICACIONUNO',
    previewCols: `
      CAST(CODCLAUNO AS VARCHAR(50)) AS CODIGO,
      LTRIM(RTRIM(ISNULL(CAST(DESCLAUNO AS NVARCHAR(250)), ''))) AS NOMBRE
    `,
  },
  {
    key: 'proveedores',
    community: 'COMMUNITY_CLASIFICACIONTRES',
    local: 'PROVEEDORES',
    mapFromCommunity: mapCommunityToProveedores,
    previewCols: `
      CAST(CODCLATRES AS VARCHAR(50)) AS CODIGO,
      LTRIM(RTRIM(ISNULL(CAST(DESCLATRES AS NVARCHAR(250)), ''))) AS NOMBRE
    `,
  },
  {
    key: 'productos',
    community: 'COMMUNITY_PRODUCTOS',
    local: 'PRODUCTOS',
  },
  {
    key: 'precios',
    community: 'COMMUNITY_PRECIOS',
    local: 'PRECIOS',
  },
];

function safeIdent(name) {
  return String(name || '').replace(/[^A-Za-z0-9_]/g, '');
}

function mapSqlType(typeName, maxLength, precision, scale) {
  const t = String(typeName || '').toLowerCase();
  const maxLen = Number(maxLength);
  const prec = Number(precision) || 18;
  const sc = scale == null ? 2 : Number(scale);
  switch (t) {
    case 'int':
      return sql.Int;
    case 'bigint':
      return sql.BigInt;
    case 'smallint':
      return sql.SmallInt;
    case 'tinyint':
      return sql.TinyInt;
    case 'bit':
      return sql.Bit;
    case 'float':
      return sql.Float;
    case 'real':
      return sql.Real;
    case 'decimal':
    case 'numeric':
      return sql.Decimal(prec, sc);
    case 'money':
      return sql.Money;
    case 'smallmoney':
      return sql.SmallMoney;
    case 'date':
      return sql.Date;
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
      return sql.DateTime2(7);
    case 'time':
      return sql.Time(7);
    case 'uniqueidentifier':
      return sql.UniqueIdentifier;
    case 'nvarchar':
      return maxLen === -1 ? sql.NVarChar(sql.MAX) : sql.NVarChar(Math.max(1, Math.floor(maxLen / 2)));
    case 'varchar':
      return maxLen === -1 ? sql.VarChar(sql.MAX) : sql.VarChar(Math.max(1, maxLen));
    case 'nchar':
      return sql.NChar(Math.max(1, Math.floor(maxLen / 2)));
    case 'char':
      return sql.Char(Math.max(1, maxLen));
    case 'ntext':
      return sql.NText;
    case 'text':
      return sql.Text;
    case 'varbinary':
      return maxLen === -1 ? sql.VarBinary(sql.MAX) : sql.VarBinary(Math.max(1, maxLen));
    case 'binary':
      return sql.Binary(Math.max(1, maxLen));
    case 'image':
      return sql.Image;
    default:
      return sql.NVarChar(sql.MAX);
  }
}

async function getTableColumns(pool, tableName) {
  const safe = safeIdent(tableName);
  const result = await pool.request().query(`
    SELECT
      c.name AS COLUMN_NAME,
      c.is_identity AS IS_IDENTITY,
      c.is_nullable AS IS_NULLABLE,
      c.max_length AS MAX_LENGTH,
      c.precision AS PRECISION,
      c.scale AS SCALE,
      t.name AS TYPE_NAME
    FROM sys.columns c
    INNER JOIN sys.types t ON c.user_type_id = t.user_type_id
    WHERE c.object_id = OBJECT_ID(N'dbo.${safe}')
    ORDER BY c.column_id
  `);
  return (result.recordset || []).map((r) => ({
    name: String(r.COLUMN_NAME),
    isIdentity: Boolean(r.IS_IDENTITY),
    nullable: Boolean(r.IS_NULLABLE),
    type: mapSqlType(r.TYPE_NAME, r.MAX_LENGTH, r.PRECISION, r.SCALE),
  }));
}

function rowValueMap(row) {
  const map = {};
  for (const key of Object.keys(row || {})) {
    map[String(key).toUpperCase()] = row[key];
  }
  return map;
}

function resolveCell(colName, upperRow, extras) {
  const u = String(colName).toUpperCase();
  if (Object.prototype.hasOwnProperty.call(extras, u)) return extras[u];
  if (Object.prototype.hasOwnProperty.call(upperRow, u)) {
    const v = upperRow[u];
    return v === undefined ? null : v;
  }
  return null;
}

async function bulkInsertLocal(pool, tableName, columns, rows, extras) {
  if (!rows.length) return 0;

  const sourceKeys = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) sourceKeys.add(String(key).toUpperCase());
  }
  sourceKeys.add('EMPNIT');

  const skipCols = new Set(['TOKEN', 'ID']);
  const insertCols = columns.filter((c) => {
    const u = String(c.name).toUpperCase();
    if (c.isIdentity) return false;
    if (skipCols.has(u)) return false;
    return sourceKeys.has(u) || u === 'EMPNIT';
  });
  if (!insertCols.length) {
    throw new Error(`Sin columnas insertables en ${tableName}`);
  }
  if (!insertCols.some((c) => c.name.toUpperCase() === 'EMPNIT')) {
    throw new Error(`${tableName} no tiene columna EMPNIT`);
  }

  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += BULK_CHUNK) {
    const chunk = rows.slice(offset, offset + BULK_CHUNK);
    const table = new sql.Table(`dbo.${safeIdent(tableName)}`);
    table.create = false;
    for (const col of insertCols) {
      table.columns.add(col.name, col.type, { nullable: col.nullable, primary: false });
    }
    for (const row of chunk) {
      const upper = rowValueMap(row);
      const values = insertCols.map((col) => resolveCell(col.name, upper, extras));
      table.rows.add(...values);
    }
    const request = pool.request();
    request.timeout = BULK_TIMEOUT_MS;
    await request.bulk(table);
    inserted += chunk.length;
  }
  return inserted;
}

async function deleteLocalByEmpnit(pool, tableName, empnit) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`DELETE FROM dbo.[${safeIdent(tableName)}] WHERE EMPNIT = @EMPNIT`);
  return Number(result.rowsAffected?.[0] || 0);
}

async function readCommunityTable(hostPool, token, communityTable) {
  const result = await hostPool
    .request()
    .input('TOKEN', sql.VarChar, String(token || '').trim())
    .input('EMPNIT', sql.VarChar, CLOUD_EMPNIT)
    .query(`
      SELECT *
      FROM dbo.[${safeIdent(communityTable)}]
      WHERE LTRIM(RTRIM(CAST(TOKEN AS VARCHAR(100)))) = LTRIM(RTRIM(@TOKEN))
        AND UPPER(LTRIM(RTRIM(CAST(EMPNIT AS VARCHAR(50))))) = UPPER(LTRIM(RTRIM(@EMPNIT)))
    `);
  return result.recordset || [];
}

/**
 * Preview para UI: listados resumidos + totales.
 */
async function previewCatalogFromCommunity({ hostPool, token }) {
  const tokenVal = String(token || '').trim();
  if (!tokenVal) throw new Error('TOKEN no configurado');

  const masterKeys = ['marcas', 'medidas', 'clasificacionuno', 'proveedores'];
  const masters = {};
  const totales = {};

  for (const spec of DOWNLOAD_SPECS.filter((s) => masterKeys.includes(s.key))) {
    const result = await hostPool
      .request()
      .input('TOKEN', sql.VarChar, tokenVal)
      .input('EMPNIT', sql.VarChar, CLOUD_EMPNIT)
      .query(`
        SELECT ${spec.previewCols}
        FROM dbo.[${safeIdent(spec.community)}]
        WHERE LTRIM(RTRIM(CAST(TOKEN AS VARCHAR(100)))) = LTRIM(RTRIM(@TOKEN))
          AND UPPER(LTRIM(RTRIM(CAST(EMPNIT AS VARCHAR(50))))) = UPPER(LTRIM(RTRIM(@EMPNIT)))
        ORDER BY 2, 1
      `);
    masters[spec.key] = result.recordset || [];
    totales[spec.key] = masters[spec.key].length;
  }

  const products = await hostPool
    .request()
    .input('TOKEN', sql.VarChar, tokenVal)
    .input('EMPNIT', sql.VarChar, CLOUD_EMPNIT)
    .query(`
      SELECT
        LTRIM(RTRIM(CAST(CODPROD AS VARCHAR(50)))) AS CODPROD,
        LTRIM(RTRIM(ISNULL(CAST(DESPROD AS NVARCHAR(250)), ''))) AS DESPROD,
        ISNULL(COSTO, 0) AS COSTO,
        LTRIM(RTRIM(ISNULL(CAST(HABILITADO AS VARCHAR(10)), ''))) AS HABILITADO
      FROM dbo.COMMUNITY_PRODUCTOS
      WHERE LTRIM(RTRIM(CAST(TOKEN AS VARCHAR(100)))) = LTRIM(RTRIM(@TOKEN))
        AND UPPER(LTRIM(RTRIM(CAST(EMPNIT AS VARCHAR(50))))) = UPPER(LTRIM(RTRIM(@EMPNIT)))
      ORDER BY DESPROD, CODPROD
    `);

  const prices = await hostPool
    .request()
    .input('TOKEN', sql.VarChar, tokenVal)
    .input('EMPNIT', sql.VarChar, CLOUD_EMPNIT)
    .query(`
      SELECT
        LTRIM(RTRIM(CAST(CODPROD AS VARCHAR(50)))) AS CODPROD,
        LTRIM(RTRIM(ISNULL(CAST(CODMEDIDA AS VARCHAR(50)), ''))) AS CODMEDIDA,
        ISNULL(EQUIVALE, 1) AS EQUIVALE,
        ISNULL(COSTO, 0) AS COSTO,
        ISNULL(PRECIO, 0) AS PRECIO
      FROM dbo.COMMUNITY_PRECIOS
      WHERE LTRIM(RTRIM(CAST(TOKEN AS VARCHAR(100)))) = LTRIM(RTRIM(@TOKEN))
        AND UPPER(LTRIM(RTRIM(CAST(EMPNIT AS VARCHAR(50))))) = UPPER(LTRIM(RTRIM(@EMPNIT)))
      ORDER BY CODPROD, CODMEDIDA
    `);

  totales.productos = (products.recordset || []).length;
  totales.precios = (prices.recordset || []).length;

  return {
    ok: true,
    empnitCloud: CLOUD_EMPNIT,
    totales,
    marcas: masters.marcas,
    medidas: masters.medidas,
    clasificacionuno: masters.clasificacionuno,
    proveedores: masters.proveedores,
    productos: products.recordset || [],
    precios: prices.recordset || [],
  };
}

/**
 * Reemplaza catálogo local con el de la nube (TOKEN + GENERAL).
 * Conserva EXISTENCIA, INVMINIMO e INVMAXIMO locales por CODPROD (sucursal).
 */
async function downloadCatalogFromCommunity({ localPool, hostPool, token, empnit }) {
  const tokenVal = String(token || '').trim();
  const empnitVal = String(empnit || '').trim();
  if (!tokenVal) throw new Error('TOKEN no configurado');
  if (!empnitVal) throw new Error('EMPNIT requerido');

  const localStockByCodprod = await snapshotLocalProductStock(localPool, empnitVal);

  const cloudRows = {};
  for (const spec of DOWNLOAD_SPECS) {
    let rows = await readCommunityTable(hostPool, tokenVal, spec.community);
    if (typeof spec.mapFromCommunity === 'function') {
      rows = spec.mapFromCommunity(rows);
    }
    cloudRows[spec.key] = rows;
  }

  if (!cloudRows.productos.length) {
    throw Object.assign(new Error('No hay productos en la nube para este TOKEN (EMPNIT=GENERAL)'), {
      statusCode: 404,
    });
  }

  cloudRows.productos = applyLocalStockToProductRows(cloudRows.productos, localStockByCodprod);

  const extras = { EMPNIT: empnitVal };
  const eliminados = {};
  const insertados = {};

  // 1) Borrar catálogo de ítems, luego maestros
  eliminados.precios = await deleteLocalByEmpnit(localPool, 'PRECIOS', empnitVal);
  eliminados.invsaldo = await deleteLocalByEmpnit(localPool, 'INVSALDO', empnitVal);
  eliminados.productos = await deleteLocalByEmpnit(localPool, 'PRODUCTOS', empnitVal);
  eliminados.proveedores = await deleteLocalByEmpnit(localPool, 'PROVEEDORES', empnitVal);
  eliminados.clasificacionuno = await deleteLocalByEmpnit(localPool, 'CLASIFICACIONUNO', empnitVal);
  eliminados.medidas = await deleteLocalByEmpnit(localPool, 'MEDIDAS', empnitVal);
  eliminados.marcas = await deleteLocalByEmpnit(localPool, 'Marcas', empnitVal);

  // 2) Insertar maestros y luego productos/precios
  for (const spec of DOWNLOAD_SPECS) {
    const cols = await getTableColumns(localPool, spec.local);
    if (!cols.length) {
      throw new Error(`Tabla local ${spec.local} no encontrada`);
    }
    insertados[spec.key] = await bulkInsertLocal(
      localPool,
      spec.local,
      cols,
      cloudRows[spec.key] || [],
      extras
    );
  }

  const invsaldoHuerfanos = await deleteOrphanInvSaldo(localPool, empnitVal);
  // SALDO desde EXISTENCIA ya restaurada (no forzar ceros).
  const invsaldoCreados = await syncMissingInvSaldo(localPool, empnitVal);

  return {
    ok: true,
    empnit: empnitVal,
    empnitCloud: CLOUD_EMPNIT,
    eliminados,
    insertados,
    conservadosLocales: localStockByCodprod.size,
    invsaldo: {
      huerfanosEliminados: invsaldoHuerfanos,
      creadosConExistenciaLocal: invsaldoCreados,
    },
  };
}

/** Snapshot por CODPROD: existencia / mín / máx locales antes de reemplazar catálogo. */
async function snapshotLocalProductStock(pool, empnit) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT
        LTRIM(RTRIM(CAST(p.CODPROD AS VARCHAR(50)))) AS CODPROD,
        ISNULL(p.EXISTENCIA, 0) AS EXISTENCIA,
        ISNULL(p.INVMINIMO, 0) AS INVMINIMO,
        ISNULL(p.INVMAXIMO, 0) AS INVMAXIMO
      FROM dbo.PRODUCTOS p
      WHERE p.EMPNIT = @EMPNIT
    `);
  const map = new Map();
  for (const r of result.recordset || []) {
    const key = String(r.CODPROD || '')
      .trim()
      .toUpperCase();
    if (!key) continue;
    map.set(key, {
      EXISTENCIA: Number(r.EXISTENCIA) || 0,
      INVMINIMO: Number(r.INVMINIMO) || 0,
      INVMAXIMO: Number(r.INVMAXIMO) || 0,
    });
  }
  return map;
}

function applyLocalStockToProductRows(rows, localMap) {
  if (!localMap || !localMap.size) return rows || [];
  return (rows || []).map((row) => {
    const upper = rowValueMap(row);
    const key = String(upper.CODPROD || '')
      .trim()
      .toUpperCase();
    const local = localMap.get(key);
    if (!local) return row;
    return {
      ...row,
      EXISTENCIA: local.EXISTENCIA,
      INVMINIMO: local.INVMINIMO,
      INVMAXIMO: local.INVMAXIMO,
    };
  });
}

module.exports = {
  previewCatalogFromCommunity,
  downloadCatalogFromCommunity,
  CLOUD_EMPNIT,
};
