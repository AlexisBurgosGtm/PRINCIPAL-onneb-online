const fs = require('fs');
const path = require('path');
const {
  SETTING_OPCION,
  getSettingValue,
  ensureSettingDefault,
  normalizeGuardadoFotos,
} = require('./settings');
const {
  createWebDavClient,
  ensureWebDavDir,
  isWebDavConfigured,
} = require('./storage-webdav');

const FOTOS_DIR_NAME = 'EMPLEADOS';
const WEBDAV_ROOT = '/EMPLEADOS';
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const ALLOWED_EXT_SET = new Set(ALLOWED_EXT);
const STORE_EXT = '.png';

function fotosRootDir() {
  return require('./app-paths').empleadosFotosDir();
}

function sanitizeSegment(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || '_';
}

/** Nombre fijo: empnit-codempleado.png */
function filenameFor(empnit, codempleado) {
  return `${sanitizeSegment(empnit)}-${sanitizeSegment(codempleado)}${STORE_EXT}`;
}

function localFilePath(empnit, codempleado) {
  return path.join(fotosRootDir(), filenameFor(empnit, codempleado));
}

function webDavFilePath(empnit, codempleado) {
  return `${WEBDAV_ROOT}/${filenameFor(empnit, codempleado)}`;
}

function ensureFotosDir() {
  const root = fotosRootDir();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return root;
}

function apiFotoUrl(empnit, codempleado) {
  return `/api/empleados/${encodeURIComponent(codempleado)}/foto?empnit=${encodeURIComponent(empnit)}&_=${Date.now()}`;
}

function normalizeExt(extRaw) {
  let ext = String(extRaw || '').toLowerCase();
  if (!ext.startsWith('.')) ext = `.${ext}`;
  if (ext === '.jpeg') ext = '.jpg';
  return ALLOWED_EXT_SET.has(ext) ? ext : null;
}

async function getGuardadoFotosModo(pool) {
  await ensureSettingDefault(pool, SETTING_OPCION.GUARDADO_FOTOS);
  const raw = await getSettingValue(pool, SETTING_OPCION.GUARDADO_FOTOS);
  return normalizeGuardadoFotos(raw ?? 'LOCAL');
}

function findEmpleadoFotoPathLocal(empnit, codempleado) {
  const abs = localFilePath(empnit, codempleado);
  if (fs.existsSync(abs)) return abs;
  // Compat: buscar otras extensiones con el mismo stem
  const stem = `${sanitizeSegment(empnit)}-${sanitizeSegment(codempleado)}`.toLowerCase();
  const root = fotosRootDir();
  if (!fs.existsSync(root)) return null;
  const matches = fs
    .readdirSync(root)
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXT_SET.has(ext)) return false;
      return path.basename(name, ext).toLowerCase() === stem;
    })
    .map((name) => path.join(root, name));
  if (!matches.length) return null;
  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0];
}

async function findWebDavFoto(empnit, codempleado) {
  if (!isWebDavConfigured()) return null;
  const client = createWebDavClient();
  const preferred = webDavFilePath(empnit, codempleado);
  try {
    await client.stat(preferred);
    return { remotePath: preferred, filename: path.basename(preferred) };
  } catch (err) {
    if (err?.status !== 404 && err?.statusCode !== 404) {
      /* continue listing */
    }
  }
  let items = [];
  try {
    items = await client.getDirectoryContents(WEBDAV_ROOT);
  } catch (err) {
    if (err?.status === 404 || err?.statusCode === 404) return null;
    throw err;
  }
  const stem = `${sanitizeSegment(empnit)}-${sanitizeSegment(codempleado)}`.toLowerCase();
  const matches = (items || [])
    .filter((it) => it.type === 'file')
    .filter((it) => {
      const name = path.basename(it.filename || it.basename || '');
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXT_SET.has(ext)) return false;
      return path.basename(name, ext).toLowerCase() === stem;
    });
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const ta = new Date(a.lastmod || 0).getTime();
    const tb = new Date(b.lastmod || 0).getTime();
    return tb - ta;
  });
  const hit = matches[0];
  const filename = path.basename(hit.filename || hit.basename);
  return {
    remotePath: hit.filename.startsWith('/') ? hit.filename : `${WEBDAV_ROOT}/${filename}`,
    filename,
  };
}

async function resolveEmpleadoFoto(pool, empnit, codempleado) {
  const modo = await getGuardadoFotosModo(pool);
  if (modo === 'HOST') {
    const remote = await findWebDavFoto(empnit, codempleado);
    if (!remote) return null;
    return {
      modo: 'HOST',
      filename: remote.filename,
      remotePath: remote.remotePath,
      url: apiFotoUrl(empnit, codempleado),
    };
  }
  const abs = findEmpleadoFotoPathLocal(empnit, codempleado);
  if (!abs) return null;
  return {
    modo: 'LOCAL',
    path: abs,
    filename: path.basename(abs),
    url: apiFotoUrl(empnit, codempleado),
  };
}

async function readEmpleadoFotoBuffer(pool, empnit, codempleado) {
  const meta = await resolveEmpleadoFoto(pool, empnit, codempleado);
  if (!meta) return null;
  if (meta.modo === 'HOST') {
    const client = createWebDavClient();
    const buf = await client.getFileContents(meta.remotePath);
    return { buffer: Buffer.isBuffer(buf) ? buf : Buffer.from(buf), filename: meta.filename, meta };
  }
  return { buffer: fs.readFileSync(meta.path), filename: meta.filename, meta };
}

function removeEmpleadoFotosLocal(empnit, codempleado) {
  const stem = `${sanitizeSegment(empnit)}-${sanitizeSegment(codempleado)}`.toLowerCase();
  const root = fotosRootDir();
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED_EXT_SET.has(ext)) continue;
    if (path.basename(name, ext).toLowerCase() !== stem) continue;
    try {
      fs.unlinkSync(path.join(root, name));
    } catch {
      /* ignore */
    }
  }
}

async function removeEmpleadoFotosHost(empnit, codempleado) {
  if (!isWebDavConfigured()) return;
  const client = createWebDavClient();
  const remote = await findWebDavFoto(empnit, codempleado);
  if (!remote) return;
  try {
    await client.deleteFile(remote.remotePath);
  } catch (err) {
    if (err?.status !== 404 && err?.statusCode !== 404) throw err;
  }
}

async function removeEmpleadoFotos(pool, empnit, codempleado) {
  const modo = await getGuardadoFotosModo(pool);
  if (modo === 'HOST') {
    if (!isWebDavConfigured()) {
      const err = new Error('WebDAV no configurado (STORAGE_SERVER / STORAGE_USER / STORAGE_PASS)');
      err.statusCode = 503;
      throw err;
    }
    await removeEmpleadoFotosHost(empnit, codempleado);
    return;
  }
  removeEmpleadoFotosLocal(empnit, codempleado);
}

function assertImageFile(file) {
  const ext = normalizeExt(path.extname(file.originalname || '')) || normalizeExt(file.mimetype?.replace('image/', '.'));
  if (!ext) {
    const err = new Error('Formato de imagen no permitido (jpg, png, webp, gif)');
    err.statusCode = 400;
    throw err;
  }
  if (!file.buffer || !file.buffer.length) {
    const err = new Error('Archivo de imagen vacío');
    err.statusCode = 400;
    throw err;
  }
}

function saveEmpleadoFotoLocal(empnit, codempleado, file) {
  assertImageFile(file);
  ensureFotosDir();
  removeEmpleadoFotosLocal(empnit, codempleado);
  const filename = filenameFor(empnit, codempleado);
  const dest = path.join(fotosRootDir(), filename);
  fs.writeFileSync(dest, file.buffer);
  return {
    filename,
    url: apiFotoUrl(empnit, codempleado),
    path: dest,
    modo: 'LOCAL',
  };
}

async function saveEmpleadoFotoHost(empnit, codempleado, file) {
  if (!isWebDavConfigured()) {
    const err = new Error('WebDAV no configurado (STORAGE_SERVER / STORAGE_USER / STORAGE_PASS)');
    err.statusCode = 503;
    throw err;
  }
  assertImageFile(file);
  const client = createWebDavClient();
  await ensureWebDavDir(client, WEBDAV_ROOT);
  await removeEmpleadoFotosHost(empnit, codempleado);
  const filename = filenameFor(empnit, codempleado);
  const remotePath = webDavFilePath(empnit, codempleado);
  await client.putFileContents(remotePath, file.buffer, { overwrite: true });
  return {
    filename,
    url: apiFotoUrl(empnit, codempleado),
    remotePath,
    modo: 'HOST',
  };
}

async function saveEmpleadoFoto(pool, empnit, codempleado, file) {
  const modo = await getGuardadoFotosModo(pool);
  if (modo === 'HOST') return saveEmpleadoFotoHost(empnit, codempleado, file);
  return saveEmpleadoFotoLocal(empnit, codempleado, file);
}

module.exports = {
  FOTOS_DIR_NAME,
  filenameFor,
  apiFotoUrl,
  getGuardadoFotosModo,
  resolveEmpleadoFoto,
  readEmpleadoFotoBuffer,
  saveEmpleadoFoto,
  removeEmpleadoFotos,
};
