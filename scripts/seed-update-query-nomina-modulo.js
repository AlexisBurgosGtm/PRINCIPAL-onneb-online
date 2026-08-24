/**
 * Módulo Nóminas — tablas principales + campos en Empleados (varios lotes UPDATE_QUERIES).
 * Uso: node scripts/seed-update-query-nomina-modulo.js
 */
require('dotenv').config();
const { getUpdateDbConfig } = require('../config/update-database');
const { getUpdateDbPool, closeUpdateDbPool } = require('../lib/update-db-pool');
const { readSqlChunksFromScripts, insertUpdateQueryIfMissing } = require('./lib/seed-update-query');

const CHUNK_CHECKS = {
  NOMINA_TABLAS: `
    SELECT ID FROM UPDATE_QUERIES
    WHERE VERSION = @VERSION AND DB = @DB
      AND QRY LIKE '%NOMINA_CONFIG%'
      AND QRY LIKE '%NOMINA_EMPLEADO%'
      AND QRY LIKE '%CREATE TABLE%'
  `,
  NOMINA_PLANILLAS: `
    SELECT ID FROM UPDATE_QUERIES
    WHERE VERSION = @VERSION AND DB = @DB
      AND QRY LIKE '%NOMINA_PLANILLAS%'
      AND QRY LIKE '%NOMINA_DETALLE%'
      AND QRY LIKE '%CREATE TABLE%'
  `,
  NOMINA_EMPLEADOS_CAMPOS: `
    SELECT ID FROM UPDATE_QUERIES
    WHERE VERSION = @VERSION AND DB = @DB
      AND QRY LIKE '%PRIMER_NOMBRE%'
      AND QRY LIKE '%Empleados%'
      AND QRY LIKE '%ALTER TABLE%'
  `,
};

async function main() {
  if (!getUpdateDbConfig()) {
    throw new Error('UPDATE_* no configurado en .env');
  }

  const chunks = readSqlChunksFromScripts('dbo.NOMINA.sql');
  const pool = await getUpdateDbPool();

  for (const chunk of chunks) {
    const existsQuery = CHUNK_CHECKS[chunk.name];
    if (!existsQuery) {
      console.warn('Sin check definido para chunk', chunk.name);
      continue;
    }
    const result = await insertUpdateQueryIfMissing(pool, {
      qry: chunk.qry,
      existsQuery,
    });
    if (result.inserted) {
      console.log(`[${chunk.name}] Insertado UPDATE_QUERIES ID=`, result.ids.join(', '));
    } else {
      console.log(`[${chunk.name}] Ya existe en UPDATE_QUERIES:`, result.ids.join(', '));
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
