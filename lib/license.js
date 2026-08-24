const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  CORE_MENUS,
  licenseModulesCatalog,
  modulesFromMenus,
  normalizeLicenseMenus,
  resolveApiMenus,
  isApiAlwaysOpen,
} = require('./license-modules');

const LICENSE_PATH = require('./app-paths').licenseJsonPath();
const PUBLIC_KEY_PATH = require('./app-paths').licensePublicKeyPath();

let _cache = null;

function enforceStrict() {
  // Compat: LICENSE_ENFORCE=1 fuerza restricción (histórico).
  return String(process.env.LICENSE_ENFORCE || '').trim() === '1';
}

/** Modo abierto sin archivo de licencia (solo desarrollo). Por defecto: restringido. */
function allowOpenWithoutLicense() {
  if (String(process.env.LICENSE_OPEN || '').trim() === '1') return true;
  // Si LICENSE_ENFORCE=1, nunca abrir sin licencia.
  if (enforceStrict()) return false;
  // Por defecto ya no hay modo abierto: sin licencia = solo menú Licencia.
  return false;
}

function readPublicKey() {
  if (!fs.existsSync(PUBLIC_KEY_PATH)) return null;
  return fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
}

function canonicalPayload(payload) {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

function verifyLicenseDocument(doc) {
  if (!doc || typeof doc !== 'object') {
    return { ok: false, error: 'Documento de licencia inválido' };
  }
  const payload = doc.payload;
  const signature = String(doc.signature || '').trim();
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Falta payload de licencia' };
  }
  if (!signature) {
    return { ok: false, error: 'Falta firma de licencia' };
  }
  const publicKey = readPublicKey();
  if (!publicKey) {
    return { ok: false, error: 'No hay clave pública (config/license-public.pem)' };
  }
  const data = Buffer.from(canonicalPayload(payload), 'utf8');
  const sig = Buffer.from(signature, 'base64');
  let valid = false;
  try {
    valid = crypto.verify('SHA256', data, publicKey, sig);
  } catch (err) {
    return { ok: false, error: `Firma no verificable: ${err.message}` };
  }
  if (!valid) {
    return { ok: false, error: 'Firma de licencia inválida' };
  }

  const modules = Array.isArray(payload.modules)
    ? payload.modules.map((m) => String(m || '').trim()).filter(Boolean)
    : [];
  const menus = Array.isArray(payload.menus)
    ? payload.menus.map((m) => String(m || '').trim()).filter(Boolean)
    : [];
  const expiresAt = payload.expiresAt ? String(payload.expiresAt).trim() : null;
  let expired = false;
  if (expiresAt) {
    const exp = new Date(expiresAt);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() < Date.now()) {
      expired = true;
    }
  }

  return {
    ok: true,
    expired,
    payload: {
      v: Number(payload.v) || 1,
      licenseId: String(payload.licenseId || '').trim(),
      customer: String(payload.customer || '').trim(),
      issuedAt: payload.issuedAt || null,
      expiresAt,
      modules,
      menus,
      notes: String(payload.notes || '').trim(),
    },
  };
}

function loadLicenseFile() {
  if (!fs.existsSync(LICENSE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8'));
  } catch (err) {
    return { _parseError: err.message };
  }
}

function evaluateLicense() {
  const raw = loadLicenseFile();
  if (!raw) {
    if (allowOpenWithoutLicense()) {
      return {
        mode: 'open',
        status: 'open',
        message: 'Sin archivo de licencia — instalación en modo abierto (LICENSE_OPEN=1)',
        modules: licenseModulesCatalog().map((m) => m.id),
        menus: null,
        customer: null,
        expiresAt: null,
        licenseId: null,
        issuedAt: null,
        notes: '',
      };
    }
    return {
      mode: 'restricted',
      status: 'missing',
      message: 'No hay licencia instalada. Active una licencia válida para usar el sistema.',
      modules: [],
      menus: [...CORE_MENUS],
      customer: null,
      expiresAt: null,
      licenseId: null,
      issuedAt: null,
      notes: '',
    };
  }
  if (raw._parseError) {
    return {
      mode: 'restricted',
      status: 'invalid',
      message: `Licencia ilegible: ${raw._parseError}`,
      modules: [],
      menus: [...CORE_MENUS],
      customer: null,
      expiresAt: null,
      licenseId: null,
      issuedAt: null,
      notes: '',
    };
  }

  const verified = verifyLicenseDocument(raw);
  if (!verified.ok) {
    return {
      mode: 'restricted',
      status: 'invalid',
      message: verified.error,
      modules: [],
      menus: [...CORE_MENUS],
      customer: null,
      expiresAt: null,
      licenseId: null,
      issuedAt: null,
      notes: '',
    };
  }

  if (verified.expired) {
    return {
      mode: 'restricted',
      status: 'expired',
      message: 'La licencia está vencida',
      modules: [],
      menus: [...CORE_MENUS],
      customer: verified.payload.customer,
      expiresAt: verified.payload.expiresAt,
      licenseId: verified.payload.licenseId,
      issuedAt: verified.payload.issuedAt,
      notes: verified.payload.notes,
    };
  }

  const menus = normalizeLicenseMenus({
    modules: verified.payload.modules,
    menus: verified.payload.menus,
  });
  const modules =
    verified.payload.modules?.length > 0
      ? verified.payload.modules
      : modulesFromMenus(menus);
  return {
    mode: 'licensed',
    status: 'valid',
    message: 'Licencia válida',
    modules,
    menus,
    customer: verified.payload.customer,
    expiresAt: verified.payload.expiresAt,
    licenseId: verified.payload.licenseId,
    issuedAt: verified.payload.issuedAt,
    notes: verified.payload.notes,
  };
}

function getLicenseStatus({ refresh = false } = {}) {
  if (!_cache || refresh) {
    _cache = evaluateLicense();
  }
  return _cache;
}

function invalidateLicenseCache() {
  _cache = null;
}

function activateLicense(doc) {
  const verified = verifyLicenseDocument(doc);
  if (!verified.ok) {
    const err = new Error(verified.error);
    err.statusCode = 400;
    throw err;
  }
  if (verified.expired) {
    const err = new Error('No se puede activar una licencia vencida');
    err.statusCode = 400;
    throw err;
  }
  // Guardar el payload original firmado (incluye menus si vienen).
  const originalPayload =
    doc.payload && typeof doc.payload === 'object' ? doc.payload : verified.payload;
  const dataDir = path.dirname(LICENSE_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const toSave = {
    payload: originalPayload,
    signature: String(doc.signature).trim(),
  };
  fs.writeFileSync(LICENSE_PATH, `${JSON.stringify(toSave, null, 2)}\n`, 'utf8');
  invalidateLicenseCache();
  return getLicenseStatus({ refresh: true });
}

function clearLicense() {
  if (fs.existsSync(LICENSE_PATH)) {
    fs.unlinkSync(LICENSE_PATH);
  }
  invalidateLicenseCache();
  return getLicenseStatus({ refresh: true });
}

function isMenuLicensed(menuKey) {
  const key = String(menuKey || '').trim();
  if (!key) return false;
  if (CORE_MENUS.includes(key)) return true;
  const st = getLicenseStatus();
  if (st.menus === null) return true;
  return st.menus.includes(key);
}

function isModuleLicensed(moduleId) {
  const id = String(moduleId || '').trim();
  if (!id) return true;
  const st = getLicenseStatus();
  if (st.mode === 'open') return true;
  if (st.modules.includes(id)) return true;
  // Parcial: alguna vista del módulo está licenciada
  const group = licenseModulesCatalog().find((m) => m.id === id);
  if (!group || st.menus === null) return false;
  return (group.menus || []).some((m) => st.menus.includes(m));
}

function licenseMiddleware(req, res, next) {
  const pathname = req.originalUrl || req.url || '';
  if (!pathname.startsWith('/api/')) return next();
  if (isApiAlwaysOpen(pathname)) return next();

  const menus = resolveApiMenus(pathname);
  if (!menus || !menus.length) return next();

  if (menus.some((m) => isMenuLicensed(m))) return next();

  // Super usuario: Actualizador BD usable aunque no esté en la licencia.
  const isSuper =
    String(req.headers['x-super-user'] || req.query.superUser || '').trim() === '1';
  if (isSuper && menus.includes('updater')) return next();

  return res.status(403).json({
    error: 'Esta vista/API no está incluida en la licencia de esta instalación',
    code: 'LICENSE_MENU_DENIED',
    menus,
  });
}

function publicStatusPayload() {
  const st = getLicenseStatus();
  const catalog = licenseModulesCatalog();
  return {
    mode: st.mode,
    status: st.status,
    message: st.message,
    customer: st.customer,
    expiresAt: st.expiresAt,
    issuedAt: st.issuedAt,
    licenseId: st.licenseId,
    notes: st.notes,
    modules: st.modules,
    menus: st.menus,
    enforce: !allowOpenWithoutLicense(),
    catalog,
    coreMenus: [...CORE_MENUS],
    hasPublicKey: Boolean(readPublicKey()),
  };
}

module.exports = {
  LICENSE_PATH,
  PUBLIC_KEY_PATH,
  getLicenseStatus,
  invalidateLicenseCache,
  activateLicense,
  clearLicense,
  verifyLicenseDocument,
  isMenuLicensed,
  isModuleLicensed,
  licenseMiddleware,
  publicStatusPayload,
  canonicalPayload,
  enforceStrict,
  allowOpenWithoutLicense,
};
