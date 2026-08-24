/**
 * DTE SV + columnas receptor CLIENTES + PRODUCTOS.INVMINIMO/INVMAXIMO → UPDATE_QUERIES.
 * Uso (OnneB o FS-SV; misma BD UPDATE_* compartida):
 *   node scripts/seed-update-query-dte-sv-schema.js
 *
 * Luego en el POS: Configuraciones → Actualizador BD → Año 2026 → Ejecutar.
 */
require('dotenv').config();
const { getUpdateDbConfig } = require('../config/update-database');
const { getUpdateDbPool, closeUpdateDbPool } = require('../lib/update-db-pool');
const {
  readSqlChunksFromScripts,
  insertUpdateQueryIfMissing,
} = require('./lib/seed-update-query');

async function main() {
  if (!getUpdateDbConfig()) {
    throw new Error('UPDATE_* no configurado en .env');
  }

  const chunks = readSqlChunksFromScripts('dbo.DTE_SV_SCHEMA.sql');
  const pool = await getUpdateDbPool();

  for (const chunk of chunks) {
    const marker = `DTE_SV:${chunk.name}`;
    const qryWithTag = `/* ${marker} */\n${chunk.qry}`;
    const result = await insertUpdateQueryIfMissing(pool, {
      qry: qryWithTag,
      version: 2026,
      db: 'P',
      existsQuery: `
        SELECT ID FROM UPDATE_QUERIES
        WHERE VERSION = @VERSION AND DB = @DB
          AND QRY LIKE @LIKE
      `,
      existsInputs: {
        LIKE: `%${marker}%`,
      },
    });
    if (result.inserted) {
      console.log(`[${chunk.name}] Insertado UPDATE_QUERIES ID=`, result.ids.join(', '));
    } else {
      console.log(`[${chunk.name}] Ya existe:`, result.ids.join(', '));
    }
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
