/**
 * Módulos comerciales de licencia (instalación completa, no por EMPNIT).
 *
 * FUENTE DE VERDAD del generador (Mariandre):
 *   MENU_GROUPS en lib/roles-usuarios.js
 *
 * Al crear una vista / data-menu nuevo:
 *   1) ALL_MENUS + MENU_LABELS + MENU_GROUPS (roles-usuarios.js)
 *   2) API_PREFIX_RULES aquí (si hay /api/…) con menu(s) de esa vista
 *   3) sidebar, app.js, tipo-empleado-access.js
 * Ver .cursor/rules/licencias-nuevas-vistas.mdc
 */
const { MENU_GROUPS, MENU_LABELS, ALL_MENUS } = require('./roles-usuarios');

/** Menús siempre disponibles sin licencia activa (solo activar licencia). */
const CORE_MENUS = ['licencia'];

/**
 * Prefijos API → vistas (data-menu) requeridas.
 * Basta con que UNA de `menus` esté licenciada.
 * Incluir `module` (= MENU_GROUPS[].id) para integridad del catálogo.
 */
const API_PREFIX_RULES = [
  { prefix: '/api/pos', module: 'operaciones', menus: ['pedidos-mostrador'] },
  { prefix: '/api/comandas-restaurante', module: 'operaciones', menus: ['comandas-restaurante'] },
  { prefix: '/api/despachos-en-cocina', module: 'despacho', menus: ['despachos-en-cocina'] },
  { prefix: '/api/cotizaciones', module: 'operaciones', menus: ['cotizaciones'] },
  { prefix: '/api/fraccionamiento-fac', module: 'operaciones', menus: ['fraccionamiento-fac', 'facturacion-completa'] },
  { prefix: '/api/facturacion', module: 'operaciones', menus: ['facturacion', 'facturas-electronicas', 'facturacion-completa', 'asignacion-pedidos'] },
  { prefix: '/api/fel', module: 'operaciones', menus: ['facturas-electronicas', 'facturacion-completa', 'asignacion-pedidos'] },
  { prefix: '/api/notas-credito', module: 'operaciones', menus: ['notas-credito'] },
  { prefix: '/api/notas-abono', module: 'operaciones', menus: ['notas-abono'] },
  { prefix: '/api/compras', module: 'operaciones', menus: ['compras'] },
  { prefix: '/api/notas-debito', module: 'operaciones', menus: ['notas-debito'] },
  { prefix: '/api/corte-caja', module: 'operaciones', menus: ['corte-caja'] },
  { prefix: '/api/vales-caja', module: 'operaciones', menus: ['vales-caja'] },
  { prefix: '/api/tareas', module: 'operaciones', menus: ['tareas'] },
  { prefix: '/api/suscripciones', module: 'operaciones', menus: ['pedidos-mostrador', 'facturacion'] },
  { prefix: '/api/embarques', module: 'distribuidoras', menus: ['embarques'] },
  { prefix: '/api/asignacion-pedidos', module: 'distribuidoras', menus: ['asignacion-pedidos'] },

  { prefix: '/api/cuentas-cobrar', module: 'cuentas', menus: ['cuentas-cobrar'] },
  { prefix: '/api/recibos-caja-cxc', module: 'cuentas', menus: ['recibos-caja-cxc'] },
  { prefix: '/api/cuentas-pagar', module: 'cuentas', menus: ['cuentas-pagar'] },

  { prefix: '/api/productos', module: 'inventarios', menus: ['productos-precios'] },
  { prefix: '/api/lista-precios', module: 'inventarios', menus: ['lista-precios'] },
  { prefix: '/api/actualizacion-costos', module: 'inventarios', menus: ['actualizacion-costos'] },
  { prefix: '/api/inventario/ent', module: 'inventarios', menus: ['entradas-inventario'] },
  { prefix: '/api/inventario/sal', module: 'inventarios', menus: ['salidas-inventario'] },
  { prefix: '/api/traslados/crear', module: 'traslados', menus: ['crear-traslado'] },
  { prefix: '/api/traslados/recibir', module: 'traslados', menus: ['recibir-traslado'] },
  {
    prefix: '/api/inventario',
    module: 'inventarios',
    menus: ['inventario', 'relleno-inventario', 'inventario-retroactivo', 'actualizacion-inventario', 'entradas-inventario', 'salidas-inventario'],
  },

  { prefix: '/api/documentos', module: 'archivo', menus: ['documentos', 'lista-facturas'] },
  { prefix: '/api/lista-facturas', module: 'archivo', menus: ['lista-facturas'] },
  { prefix: '/api/cuadre-caja', module: 'archivo', menus: ['cuadre-caja'] },
  { prefix: '/api/resumen-del-dia', module: 'archivo', menus: ['resumen-del-dia'] },
  { prefix: '/api/autorizaciones', module: 'archivo', menus: ['autorizaciones'] },
  { prefix: '/api/documentos-eliminados', module: 'archivo', menus: ['documentos-eliminados'] },
  { prefix: '/api/promociones', module: 'archivo', menus: ['promociones'] },
  { prefix: '/api/auditoria-cajas', module: 'reportes', menus: ['auditoria-cajas'] },
  { prefix: '/api/reportes-ventas', module: 'reportes', menus: ['reportes-ventas'] },
  { prefix: '/api/reportes-clientes', module: 'reportes', menus: ['reportes-clientes'] },
  { prefix: '/api/reportes-productos', module: 'reportes', menus: ['reportes-productos'] },
  { prefix: '/api/reportes-marcas', module: 'reportes', menus: ['reportes-marcas'] },

  { prefix: '/api/retenciones-isr-recibidas', module: 'contabilidad', menus: ['retenciones-isr-recibidas'] },
  { prefix: '/api/retenciones-iva-recibidas', module: 'contabilidad', menus: ['retenciones-iva-recibidas'] },
  { prefix: '/api/retenciones-isr', module: 'contabilidad', menus: ['retenciones-isr'] },
  { prefix: '/api/retenciones-iva', module: 'contabilidad', menus: ['retenciones-iva'] },
  { prefix: '/api/libro-compras', module: 'contabilidad', menus: ['libro-compras'] },
  { prefix: '/api/libro-ventas', module: 'contabilidad', menus: ['libro-ventas'] },
  { prefix: '/api/libro-diario', module: 'contabilidad', menus: ['libro-diario'] },
  { prefix: '/api/libro-mayor', module: 'contabilidad', menus: ['libro-mayor'] },
  { prefix: '/api/libro-balance', module: 'contabilidad', menus: ['libro-balance'] },
  { prefix: '/api/inventario-fiscal', module: 'contabilidad', menus: ['inventario-fiscal'] },
  { prefix: '/api/nomenclatura-contable', module: 'contabilidad', menus: ['nomenclatura-contable'] },
  { prefix: '/api/formatos-contables', module: 'contabilidad', menus: ['formatos-contables'] },
  { prefix: '/api/config-contabilidad', module: 'contabilidad', menus: ['configuraciones-contabilidad'] },

  { prefix: '/api/movimientos-banco', module: 'bancos', menus: ['movimientos-banco'] },
  { prefix: '/api/bancos', module: 'bancos', menus: ['bancos'] },
  { prefix: '/api/cuentas-bancarias', module: 'bancos', menus: ['cuentas-bancarias'] },

  { prefix: '/api/empleados', module: 'rh', menus: ['empleados'] },
  { prefix: '/api/asistencia', module: 'rh', menus: ['control-asistencia'] },
  { prefix: '/api/nomina/vales', module: 'rh', menus: ['nomina-vales', 'nomina-interna'] },
  {
    prefix: '/api/nomina',
    module: 'rh',
    menus: ['nomina-config', 'nomina-conceptos', 'nomina-empleados', 'nomina-interna', 'nomina-igss'],
  },

  { prefix: '/api/marcas', module: 'catalogos', menus: ['marcas'] },
  { prefix: '/api/medidas', module: 'catalogos', menus: ['medidas'] },
  { prefix: '/api/proveedores', module: 'catalogos', menus: ['proveedores'] },
  { prefix: '/api/clientes', module: 'catalogos', menus: ['clientes'] },
  { prefix: '/api/tipo-negocios', module: 'catalogos', menus: ['tipo-negocios'] },
  { prefix: '/api/municipios', module: 'catalogos', menus: ['municipios'] },
  { prefix: '/api/departamentos', module: 'catalogos', menus: ['departamentos'] },
  { prefix: '/api/rutas', module: 'catalogos', menus: ['rutas'] },
  { prefix: '/api/fabricantes', module: 'catalogos', menus: ['fabricantes'] },
  { prefix: '/api/ubicaciones', module: 'catalogos', menus: ['ubicaciones'] },
  { prefix: '/api/mesas-restaurante', module: 'catalogos', menus: ['mesas-restaurante'] },
  { prefix: '/api/cajas', module: 'catalogos', menus: ['cajas'] },

  { prefix: '/api/servicio-mecanica', module: 'transportes', menus: ['servicio-mecanica'] },
  { prefix: '/api/mantenimiento-llantas', module: 'transportes', menus: ['mantenimiento-llantas'] },
  { prefix: '/api/kilometrajes', module: 'transportes', menus: ['registro-kilometrajes'] },
  { prefix: '/api/vehiculos', module: 'transportes', menus: ['vehiculos'] },
  { prefix: '/api/plataformas', module: 'transportes', menus: ['plataformas'] },

  { prefix: '/api/tipo-documentos', module: 'configuraciones', menus: ['tipo-documentos'] },
  { prefix: '/api/formatos-impresion', module: 'configuraciones', menus: ['formatos-impresion'] },
  { prefix: '/api/credenciales-fel', module: 'configuraciones', menus: ['credenciales-fel'] },
  { prefix: '/api/updater', module: 'configuraciones', menus: ['updater'] },
  { prefix: '/api/roles-usuarios', module: 'configuraciones', menus: ['roles-usuarios'] },
];

/** @deprecated alias — preferir API_PREFIX_RULES */
const API_PREFIX_TO_MODULE = API_PREFIX_RULES.map((r) => ({
  prefix: r.prefix,
  module: r.module,
}));

/** Rutas API siempre permitidas (login, salud, licencia). */
const API_ALWAYS_OPEN = [
  '/api/auth',
  '/api/health',
  '/api/build-meta',
  '/api/license',
  '/api/community',
  '/api/config',
  '/api/empresas',
  '/api/dashboard',
];

function menusAssignedToLicenseGroups() {
  const assigned = new Set(CORE_MENUS);
  for (const group of MENU_GROUPS) {
    for (const m of group.menus || []) assigned.add(m);
  }
  assigned.add('licencia');
  return assigned;
}

function allLicensableMenus() {
  return [...menusAssignedToLicenseGroups()].filter((m) => !CORE_MENUS.includes(m) || m === 'inicio');
}

/**
 * Menús en ALL_MENUS que no están en ningún MENU_GROUPS / núcleo.
 */
function findUnassignedLicenseMenus() {
  const assigned = menusAssignedToLicenseGroups();
  return ALL_MENUS.filter((m) => !assigned.has(m));
}

function findUnknownApiModules() {
  const groupIds = new Set(MENU_GROUPS.map((g) => g.id).filter((id) => id !== 'general'));
  const unknown = new Set();
  for (const row of API_PREFIX_RULES) {
    if (!groupIds.has(row.module)) unknown.add(row.module);
  }
  return [...unknown];
}

function findUnknownApiMenus() {
  const assigned = menusAssignedToLicenseGroups();
  const unknown = new Set();
  for (const row of API_PREFIX_RULES) {
    for (const m of row.menus || []) {
      if (!assigned.has(m)) unknown.add(m);
    }
  }
  return [...unknown];
}

function assertLicenseCatalogIntegrity({ log = console.warn, throwOnError = false } = {}) {
  const unassigned = findUnassignedLicenseMenus();
  const unknownApi = findUnknownApiModules();
  const unknownMenus = findUnknownApiMenus();
  const problems = [];
  if (unassigned.length) {
    problems.push(
      `Menús en ALL_MENUS sin grupo de licencia (MENU_GROUPS): ${unassigned.join(', ')}`
    );
  }
  if (unknownApi.length) {
    problems.push(
      `API_PREFIX_RULES usa módulos inexistentes en MENU_GROUPS: ${unknownApi.join(', ')}`
    );
  }
  if (unknownMenus.length) {
    problems.push(
      `API_PREFIX_RULES referencia menús fuera de MENU_GROUPS: ${unknownMenus.join(', ')}`
    );
  }
  for (const msg of problems) {
    log(`[Licencia] ${msg}`);
  }
  if (throwOnError && problems.length) {
    throw new Error(problems.join(' | '));
  }
  return { ok: problems.length === 0, unassigned, unknownApi, unknownMenus, problems };
}

function licenseModulesCatalog() {
  return MENU_GROUPS.filter((g) => g.id !== 'general').map((g) => ({
    id: g.id,
    title: g.title,
    menus: [...g.menus],
    menuLabels: (g.menus || []).map((key) => ({
      key,
      label: MENU_LABELS[key] || key,
    })),
  }));
}

function menusForModules(moduleIds) {
  const wanted = new Set((moduleIds || []).map((m) => String(m || '').trim()).filter(Boolean));
  const menus = new Set(CORE_MENUS);
  for (const group of MENU_GROUPS) {
    if (group.id === 'general') {
      for (const m of group.menus) menus.add(m);
      continue;
    }
    if (!wanted.has(group.id)) continue;
    for (const m of group.menus) menus.add(m);
  }
  menus.add('licencia');
  return menus;
}

/** Módulos que tienen al menos una vista seleccionada (excluye menús núcleo). */
function modulesFromMenus(menuKeys) {
  const core = new Set(CORE_MENUS);
  const wanted = new Set(
    (menuKeys || [])
      .map((m) => String(m || '').trim())
      .filter((m) => m && !core.has(m))
  );
  const modules = [];
  for (const group of MENU_GROUPS) {
    if (group.id === 'general') continue;
    if ((group.menus || []).some((m) => wanted.has(m))) modules.push(group.id);
  }
  return modules;
}

/**
 * Normaliza la lista firmada de menús.
 * Preferir `menus` explícitos; si no hay, expandir desde `modules` (licencias antiguas).
 */
function normalizeLicenseMenus({ modules, menus } = {}) {
  const valid = menusAssignedToLicenseGroups();
  let selected = [];
  if (Array.isArray(menus) && menus.length) {
    selected = menus.map((m) => String(m || '').trim()).filter((m) => valid.has(m));
  } else {
    selected = [...menusForModules(modules)];
  }
  const out = new Set(selected);
  for (const c of CORE_MENUS) out.add(c);
  // Con licencia válida, Inicio siempre queda habilitado.
  out.add('inicio');
  out.add('licencia');
  return [...out].sort();
}

function resolveApiRule(pathname) {
  const pathOnly = String(pathname || '').split('?')[0];
  const sorted = [...API_PREFIX_RULES].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const row of sorted) {
    if (pathOnly === row.prefix || pathOnly.startsWith(`${row.prefix}/`)) {
      return row;
    }
  }
  return null;
}

function resolveApiModule(pathname) {
  return resolveApiRule(pathname)?.module || null;
}

function resolveApiMenus(pathname) {
  const rule = resolveApiRule(pathname);
  return rule?.menus ? [...rule.menus] : null;
}

function isApiAlwaysOpen(pathname) {
  const pathOnly = String(pathname || '').split('?')[0];
  if (pathOnly === '/api/roles-usuarios/acceso') return true;
  return API_ALWAYS_OPEN.some((p) => pathOnly === p || pathOnly.startsWith(`${p}/`));
}

module.exports = {
  CORE_MENUS,
  MENU_LABELS,
  ALL_MENUS,
  API_PREFIX_RULES,
  API_PREFIX_TO_MODULE,
  API_ALWAYS_OPEN,
  licenseModulesCatalog,
  menusForModules,
  modulesFromMenus,
  normalizeLicenseMenus,
  resolveApiModule,
  resolveApiMenus,
  resolveApiRule,
  isApiAlwaysOpen,
  findUnassignedLicenseMenus,
  findUnknownApiModules,
  findUnknownApiMenus,
  assertLicenseCatalogIntegrity,
  allLicensableMenus,
  menusAssignedToLicenseGroups,
};
