/**
 * Rutas de la app: desarrollo vs ejecutable empaquetado (pkg).
 *
 * - getBundleRoot(): código/assets embebidos (snapshot de pkg o carpeta del repo).
 * - getDataRoot(): carpeta instalable junto al .exe (writable): .env, fotos, data/license, etc.
 */
const fs = require('fs');
const path = require('path');

function isPackaged() {
  return Boolean(process.pkg);
}

/** Raíz del proyecto en repo, o snapshot dentro del .exe. */
function getBundleRoot() {
  return path.join(__dirname, '..');
}

/**
 * Carpeta de instalación (writable).
 * Empaquetado: directorio del .exe. Desarrollo: raíz del repo.
 */
function getDataRoot() {
  if (isPackaged()) {
    return path.dirname(process.execPath);
  }
  return getBundleRoot();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function envFilePath() {
  return path.join(getDataRoot(), '.env');
}

function pidFilePath() {
  return path.join(getDataRoot(), '.server.pid');
}

function publicDir() {
  return path.join(getBundleRoot(), 'public');
}

/** JSON de configuración embebido (solo lectura). */
function bundleDataDir() {
  return path.join(getBundleRoot(), 'data');
}

/** data/ writable junto al exe (licencia, menú por tipo, etc.). */
function writableDataDir() {
  return ensureDir(path.join(getDataRoot(), 'data'));
}

function fotosProductosDir() {
  return ensureDir(path.join(getDataRoot(), 'Fotos_productos'));
}

function empleadosFotosDir() {
  return ensureDir(path.join(getDataRoot(), 'EMPLEADOS'));
}

function licenseJsonPath() {
  return path.join(writableDataDir(), 'license.json');
}

function licensePublicKeyPath() {
  return path.join(getBundleRoot(), 'config', 'license-public.pem');
}

function menuAccesoTiposPath() {
  return path.join(writableDataDir(), 'menu-acceso-tipos.json');
}

function tiposEmpleadoPath() {
  return path.join(publicDir(), 'data', 'tipos-empleado.json');
}

function configTiposDocumentoPath() {
  return path.join(bundleDataDir(), 'config-tipos-documento.json');
}

function felAdendasPath() {
  return path.join(bundleDataDir(), 'fel-adendas.json');
}

module.exports = {
  isPackaged,
  getBundleRoot,
  getDataRoot,
  ensureDir,
  envFilePath,
  pidFilePath,
  publicDir,
  bundleDataDir,
  writableDataDir,
  fotosProductosDir,
  empleadosFotosDir,
  licenseJsonPath,
  licensePublicKeyPath,
  menuAccesoTiposPath,
  tiposEmpleadoPath,
  configTiposDocumentoPath,
  felAdendasPath,
};
