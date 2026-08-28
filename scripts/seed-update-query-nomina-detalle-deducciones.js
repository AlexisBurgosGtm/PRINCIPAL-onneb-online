/**
 * Nóminas — deducciones desglosadas por línea de planilla.
 * Uso: node scripts/seed-update-query-nomina-detalle-deducciones.js
 */
require('dotenv').config();
const { getUpdateDbConfig } = require('../config/update-database');
const { getUpdateDbPool, closeUpdateDbPool } = require('../lib/update-db-pool');
const { readSqlFromScripts, insertUpdateQueryIfMissing } = require('./lib/seed-update-query');

async function main() {
  if (!getUpdateDbConfig()) {
    throw new Error('UPDATE_* no configurado en .env');
  }

  const qry = readSqlFromScripts('dbo.NOMINA_DETALLE_DEDUCCIONES.sql');
  const pool = await getUpdateDbPool();
  const result = await insertUpdateQueryIfMissing(pool, {
    qry,
    existsQuery: `
      SELECT ID FROM UPDATE_QUERIES
      WHERE VERSION = @VERSION AND DB = @DB
        AND QRY LIKE '%@UPDATER_ID nomina-detalle-deducciones%'
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
