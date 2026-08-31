/**
 * PRECIOS/INVSALDO.COSTO_PROMEDIO → UPDATE_QUERIES (solo si la columna no existe).
 * Si las columnas ya existen en tu BD, no hace falta ejecutar esto.
 * Uso (OnneB o FS-SV; misma BD UPDATE_* compartida):
 *   node scripts/seed-update-query-costo-promedio.js
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

  const chunks = readSqlChunksFromScripts('dbo.COSTO_PROMEDIO_COLUMNS.sql');
  const pool = await getUpdateDbPool();

  for (const chunk of chunks) {
    const marker = `COSTO_PROMEDIO:${chunk.name}`;
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
