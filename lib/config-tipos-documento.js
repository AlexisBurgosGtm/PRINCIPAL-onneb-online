const fs = require('fs');
const path = require('path');

let cached = null;

function loadConfigTiposDocumento() {
  if (cached) return cached;
  const jsonPath = require('./app-paths').configTiposDocumentoPath();
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  cached = (raw.tipos || []).map((t) => ({
    TIPODOC: String(t.TIPODOC ?? '').trim().toUpperCase(),
    DESCRIPCION: String(t.DESCRIPCION ?? t.TIPODOC ?? '').trim(),
  }));
  return cached;
}

module.exports = { loadConfigTiposDocumento };
