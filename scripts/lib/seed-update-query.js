/**
 * Helpers para insertar scripts SQL en UPDATE_QUERIES (hosting).
 */
const fs = require('fs');
const path = require('path');
const sql = require('mssql');

function readSqlFromScripts(sqlFileName) {
  const filePath = path.join(__dirname, '..', 'sql', sqlFileName);
  let qry = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  qry = qry
    .split(/\nGO\s*\n/i)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
  return qry.replace(/\nGO\s*$/i, '').trim();
}

/**
 * @param {sql.ConnectionPool} pool
 * @param {{ qry: string, version?: number, db?: string, existsQuery: string, existsInputs?: object }} opts
 */
async function insertUpdateQueryIfMissing(pool, opts) {
  const version = opts.version ?? 2026;
  const db = opts.db ?? 'P';
  const request = pool.request().input('VERSION', sql.Int, version).input('DB', sql.VarChar(1), db);
  if (opts.existsInputs) {
    for (const [key, value] of Object.entries(opts.existsInputs)) {
      request.input(key, value);
    }
  }
  const check = await request.query(opts.existsQuery);
  if (check.recordset.length) {
    return { inserted: false, ids: check.recordset.map((r) => r.ID) };
  }
  const ins = await pool
    .request()
    .input('QRY', sql.NVarChar(sql.MAX), opts.qry)
    .input('VERSION', sql.Int, version)
    .input('DB', sql.VarChar(1), db)
    .query(`
      INSERT INTO UPDATE_QUERIES (QRY, FECHA, VERSION, DB)
      OUTPUT INSERTED.ID
      VALUES (@QRY, GETDATE(), @VERSION, @DB)
    `);
  return { inserted: true, ids: [ins.recordset[0].ID] };
}

function readSqlChunksFromScripts(sqlFileName) {
  const full = readSqlFromScripts(sqlFileName);
  const markerRe = /^--\s*@UPDATER_CHUNK\s+(\S+)\s*$/gm;
  const chunks = [];
  let lastIndex = 0;
  let lastName = null;
  let match;
  while ((match = markerRe.exec(full)) !== null) {
    if (lastName !== null) {
      const body = full.slice(lastIndex, match.index).trim();
      if (body) chunks.push({ name: lastName, qry: body });
    }
    lastName = match[1];
    lastIndex = markerRe.lastIndex;
  }
  if (lastName !== null) {
    const body = full.slice(lastIndex).trim();
    if (body) chunks.push({ name: lastName, qry: body });
  }
  if (!chunks.length) {
    return [{ name: sqlFileName, qry: full }];
  }
  return chunks;
}

module.exports = {
  readSqlFromScripts,
  readSqlChunksFromScripts,
  insertUpdateQueryIfMissing,
};
