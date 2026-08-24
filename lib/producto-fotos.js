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

const FOTOS_DIR_NAME = 'Fotos_productos';
const WEBDAV_ROOT = '/Fotos_productos';
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const ALLOWED_EXT_SET = new Set(ALLOWED_EXT);

function fotosRootDir() {
  return require('./app-paths').fotosProductosDir();
}

function sanitizeSegment(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || '_';
}

function empDir(empnit) {
  return path.join(fotosRootDir(), sanitizeSegment(empnit));
}

function webDavEmpDir(empnit) {
  return `${WEBDAV_ROOT}/${sanitizeSegment(empnit)}`;
}

function webDavFilePath(empnit, filename) {
  return `${webDavEmpDir(empnit)}/${filename}`;
}

function ensureFotosDirs(empnit) {
  const root = fotosRootDir();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  const dir = empDir(empnit);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeExt(extRaw) {
  let ext = String(extRaw || '').toLowerCase();
  if (!ext.startsWith('.')) ext = `.${ext}`;
  if (ext === '.jpeg') ext = '.jpg';
  return ALLOWED_EXT_SET.has(ext) || ALLOWED_EXT_SET.has(ext === '.jpg' ? '.jpeg' : ext) ? ext : null;
}

function filenameFor(codprod, ext) {
  return `${sanitizeSegment(codprod)}${ext}`;
}

function apiFotoUrl(empnit, codprod) {
  return `/api/productos/${encodeURIComponent(codprod)}/foto?empnit=${encodeURIComponent(empnit)}&_=${Date.now()}`;
}

function listCandidateFilesLocal(empnit, codprod) {
  const dir = empDir(empnit);
  if (!fs.existsSync(dir)) return [];
  const base = sanitizeSegment(codprod).toLowerCase();
  return fs
    .readdirSync(dir)
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXT_SET.has(ext)) return false;
      const stem = path.basename(name, ext).toLowerCase();
      return stem === base;
    })
    .map((name) => path.join(dir, name));
}

function findProductoFotoPathLocal(empnit, codprod) {
  const files = listCandidateFilesLocal(empnit, codprod);
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

async function getGuardadoFotosModo(pool) {
  await ensureSettingDefault(pool, SETTING_OPCION.GUARDADO_FOTOS);
  const raw = await getSettingValue(pool, SETTING_OPCION.GUARDADO_FOTOS);
  return normalizeGuardadoFotos(raw ?? 'LOCAL');
}

async function isGuardadoFotosLocal(pool) {
  return (await getGuardadoFotosModo(pool)) === 'LOCAL';
}

async function isGuardadoFotosHost(pool) {
  return (await getGuardadoFotosModo(pool)) === 'HOST';
}

async function findWebDavFoto(empnit, codprod) {
  if (!isWebDavConfigured()) return null;
  const client = createWebDavClient();
  const base = sanitizeSegment(codprod).toLowerCase();
  const dir = webDavEmpDir(empnit);
  let items = [];
  try {
    items = await client.getDirectoryContents(dir);
  } catch (err) {
    if (err?.status === 404 || err?.statusCode === 404) return null;
    throw err;
  }
  const matches = (items || [])
    .filter((it) => it.type === 'file')
    .filter((it) => {
      const name = path.basename(it.filename || it.basename || '');
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXT_SET.has(ext)) return false;
      return path.basename(name, ext).toLowerCase() === base;
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
    remotePath: hit.filename.startsWith('/') ? hit.filename : `${dir}/${filename}`,
    filename,
  };
}

async function resolveProductoFoto(pool, empnit, codprod) {
  const modo = await getGuardadoFotosModo(pool);
  if (modo === 'HOST') {
    const remote = await findWebDavFoto(empnit, codprod);
    if (!remote) return null;
    return {
      modo: 'HOST',
      filename: remote.filename,
      remotePath: remote.remotePath,
      url: apiFotoUrl(empnit, codprod),
    };
  }
  const abs = findProductoFotoPathLocal(empnit, codprod);
  if (!abs) return null;
  const filename = path.basename(abs);
  return {
    modo: 'LOCAL',
    path: abs,
    filename,
    url: apiFotoUrl(empnit, codprod),
  };
}

/** @deprecated use resolveProductoFoto */
function resolvePublicFoto(empnit, codprod) {
  const abs = findProductoFotoPathLocal(empnit, codprod);
  if (!abs) return null;
  const filename = path.basename(abs);
  return {
    path: abs,
    filename,
    url: apiFotoUrl(empnit, codprod),
  };
}

async function readProductoFotoBuffer(pool, empnit, codprod) {
  const meta = await resolveProductoFoto(pool, empnit, codprod);
  if (!meta) return null;
  if (meta.modo === 'HOST') {
    const client = createWebDavClient();
    const buf = await client.getFileContents(meta.remotePath);
    return { buffer: Buffer.isBuffer(buf) ? buf : Buffer.from(buf), filename: meta.filename, meta };
  }
  return { buffer: fs.readFileSync(meta.path), filename: meta.filename, meta };
}

function removeProductoFotosLocal(empnit, codprod) {
  for (const file of listCandidateFilesLocal(empnit, codprod)) {
    try {
      fs.unlinkSync(file);
    } catch (_) {
      /* ignore */
    }
  }
}

async function removeProductoFotosHost(empnit, codprod) {
  const remote = await findWebDavFoto(empnit, codprod);
  if (!remote) return;
  const client = createWebDavClient();
  try {
    await client.deleteFile(remote.remotePath);
  } catch (err) {
    if (err?.status !== 404 && err?.statusCode !== 404) throw err;
  }
}

async function removeProductoFotos(pool, empnit, codprod) {
  const modo = await getGuardadoFotosModo(pool);
  if (modo === 'HOST') {
    if (!isWebDavConfigured()) {
      const err = new Error('WebDAV no configurado (STORAGE_SERVER / STORAGE_USER / STORAGE_PASS)');
      err.statusCode = 503;
      throw err;
    }
    await removeProductoFotosHost(empnit, codprod);
    return;
  }
  removeProductoFotosLocal(empnit, codprod);
}

function saveProductoFotoLocal(empnit, codprod, file) {
  const ext = normalizeExt(path.extname(file.originalname || '')) || '.jpg';
  if (!ALLOWED_EXT_SET.has(ext) && ext !== '.jpg') {
    const err = new Error('Formato de imagen no permitido (jpg, png, webp, gif)');
    err.statusCode = 400;
    throw err;
  }
  const dir = ensureFotosDirs(empnit);
  removeProductoFotosLocal(empnit, codprod);
  const filename = filenameFor(codprod, ext);
  const dest = path.join(dir, filename);
  fs.writeFileSync(dest, file.buffer);
  return {
    filename,
    url: apiFotoUrl(empnit, codprod),
    path: dest,
    modo: 'LOCAL',
  };
}

async function saveProductoFotoHost(empnit, codprod, file) {
  if (!isWebDavConfigured()) {
    const err = new Error('WebDAV no configurado (STORAGE_SERVER / STORAGE_USER / STORAGE_PASS)');
    err.statusCode = 503;
    throw err;
  }
  const ext = normalizeExt(path.extname(file.originalname || '')) || '.jpg';
  const client = createWebDavClient();
  const dir = webDavEmpDir(empnit);
  await ensureWebDavDir(client, dir);
  await removeProductoFotosHost(empnit, codprod);
  const filename = filenameFor(codprod, ext);
  const remotePath = webDavFilePath(empnit, filename);
  await client.putFileContents(remotePath, file.buffer, { overwrite: true });
  return {
    filename,
    url: apiFotoUrl(empnit, codprod),
    remotePath,
    modo: 'HOST',
  };
}

async function saveProductoFoto(pool, empnit, codprod, file) {
  const modo = await getGuardadoFotosModo(pool);
  if (modo === 'HOST') return saveProductoFotoHost(empnit, codprod, file);
  return saveProductoFotoLocal(empnit, codprod, file);
}

module.exports = {
  FOTOS_DIR_NAME,
  ALLOWED_EXT: ALLOWED_EXT_SET,
  fotosRootDir,
  ensureFotosDirs,
  findProductoFotoPath: findProductoFotoPathLocal,
  resolvePublicFoto,
  resolveProductoFoto,
  readProductoFotoBuffer,
  getGuardadoFotosModo,
  isGuardadoFotosLocal,
  isGuardadoFotosHost,
  saveProductoFoto,
  removeProductoFotos,
  sanitizeSegment,
};
