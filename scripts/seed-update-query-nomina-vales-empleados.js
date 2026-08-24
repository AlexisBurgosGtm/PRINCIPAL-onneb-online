/**
 * Nóminas — vales a empleados, pagos, PASSKEY en Empleados.
 * Uso: node scripts/seed-update-query-nomina-vales-empleados.js
 */
require('dotenv').config();
const { getUpdateDbConfig } = require('../config/update-database');
const { getUpdateDbPool, closeUpdateDbPool } = require('../lib/update-db-pool');
const { readSqlFromScripts, insertUpdateQueryIfMissing } = require('./lib/seed-update-query');

async function main() {
  if (!getUpdateDbConfig()) {
    throw new Error('UPDATE_* no configurado en .env');
  }

  const qry = readSqlFromScripts('dbo.NOMINA_VALES_EMPLEADOS.sql');
  const pool = await getUpdateDbPool();
  const result = await insertUpdateQueryIfMissing(pool, {
    qry,
    existsQuery: `
      SELECT ID FROM UPDATE_QUERIES
      WHERE VERSION = @VERSION AND DB = @DB
        AND QRY LIKE '%NOMINA_VALES_EMPLEADOS%'
        AND QRY LIKE '%CREATE TABLE%'
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
