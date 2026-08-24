/**
 * DOCPRODUCTOS.SOLICITADO (0/1) para comandas → cocina.
 * Uso: node scripts/seed-update-query-docproductos-solicitado.js
 */
require('dotenv').config();
const { getUpdateDbConfig } = require('../config/update-database');
const { getUpdateDbPool, closeUpdateDbPool } = require('../lib/update-db-pool');
const { readSqlFromScripts, insertUpdateQueryIfMissing } = require('./lib/seed-update-query');

async function main() {
  if (!getUpdateDbConfig()) {
    throw new Error('UPDATE_* no configurado en .env');
  }

  const qry = readSqlFromScripts('dbo.DOCPRODUCTOS.SOLICITADO.sql');
  const pool = await getUpdateDbPool();
  const result = await insertUpdateQueryIfMissing(pool, {
    qry,
    existsQuery: `
      SELECT ID FROM UPDATE_QUERIES
      WHERE VERSION = @VERSION AND DB = @DB
        AND QRY LIKE '%DOCPRODUCTOS%'
        AND QRY LIKE '%SOLICITADO%'
    `,
  });

  if (result.inserted) {
    console.log('Insertado UPDATE_QUERIES ID=', result.ids.join(', '));
  } else {
    console.log('Ya existe en UPDATE_QUERIES:', result.ids.join(', '));
  }

  await closeUpdateDbPool();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeUpdateDbPool();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
