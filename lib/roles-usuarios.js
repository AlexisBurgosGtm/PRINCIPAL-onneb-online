const fs = require('fs');
const path = require('path');

/** Legado (migración única → dbo.MENU_ACCESO_TIPOS). */
const ACCESO_PATH = require('./app-paths').menuAccesoTiposPath();
const TIPOS_PATH = require('./app-paths').tiposEmpleadoPath();

const ENSURE_TABLE_SQL = `
IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = 'MENU_ACCESO_TIPOS' AND schema_id = SCHEMA_ID('dbo')
)
BEGIN
  CREATE TABLE dbo.MENU_ACCESO_TIPOS (
    CODTIPOEMPLEADO INT NOT NULL,
    ACCESO_TOTAL BIT NOT NULL CONSTRAINT DF_MENU_ACCESO_TIPOS_TOTAL DEFAULT (0),
    MENUS NVARCHAR(MAX) NULL,
    FECHA_MOD DATETIME NULL,
    CONSTRAINT PK_MENU_ACCESO_TIPOS PRIMARY KEY (CODTIPOEMPLEADO)
  );
END
`;

const ALL_MENUS = [
  'inicio',
  'pedidos-mostrador',
  'comandas-restaurante',
  'facturacion',
  'facturas-electronicas',
  'facturacion-completa',
  'notas-credito',
  'notas-abono',
  'compras',
  'notas-debito',
  'vales-caja',
  'gastos',
  'corte-caja',
  'cotizaciones',
  'fraccionamiento-fac',
  'tareas',
  'embarques',
  'asignacion-pedidos',
  'pendientes-entrega',
  'despachos-en-cocina',
  'cuentas-cobrar',
  'recibos-caja-cxc',
  'cuentas-pagar',
  'retenciones-isr',
  'retenciones-iva',
  'retenciones-isr-recibidas',
  'retenciones-iva-recibidas',
  'libro-compras',
  'libro-ventas',
  'libro-diario',
  'libro-mayor',
  'libro-balance',
  'inventario-fiscal',
  'nomenclatura-contable',
  'formatos-contables',
  'configuraciones-contabilidad',
  'movimientos-banco',
  'bancos',
  'cuentas-bancarias',
  'productos-precios',
  'lista-precios',
  'inventario',
  'relleno-inventario',
  'entradas-inventario',
  'salidas-inventario',
  'inventario-retroactivo',
  'actualizacion-inventario',
  'actualizacion-costos',
  'crear-traslado',
  'recibir-traslado',
  'documentos',
  'lista-facturas',
  'cuadre-caja',
  'resumen-del-dia',
  'autorizaciones',
  'documentos-eliminados',
  'promociones',
  'auditoria-cajas',
  'reportes-ventas',
  'subir-catalogo',
  'descargar-catalogo',
  'traslados-en-transito',
  'empleados',
  'control-asistencia',
  'nomina-config',
  'nomina-conceptos',
  'nomina-empleados',
  'nomina-vales',
  'nomina-interna',
  'nomina-igss',
  'marcas',
  'medidas',
  'proveedores',
  'clientes',
  'tipo-negocios',
  'municipios',
  'departamentos',
  'rutas',
  'fabricantes',
  'ubicaciones',
  'mesas-restaurante',
  'cajas',
  'servicio-mecanica',
  'mantenimiento-llantas',
  'registro-kilometrajes',
  'vehiculos',
  'plataformas',
  'empresas',
  'config-general',
  'roles-usuarios',
  'tipo-documentos',
  'formatos-impresion',
  'credenciales-fel',
  'updater',
  'licencia',
];

const MENU_LABELS = {
  inicio: 'Inicio',
  'pedidos-mostrador': 'Pedidos de Mostrador',
  'comandas-restaurante': 'Comandas Restaurante',
  facturacion: 'Facturas normales',
  'facturas-electronicas': 'Facturas Electrónicas',
  'facturacion-completa': 'Facturación',
  'notas-credito': 'Notas de Credito (clientes)',
  'notas-abono': 'Notas de Abono',
  compras: 'Compras',
  'notas-debito': 'Notas de credito (Proveedores)',
  'vales-caja': 'Vales de Caja',
  gastos: 'Gastos',
  'corte-caja': 'Corte de Caja',
  cotizaciones: 'Cotizaciones',
  'fraccionamiento-fac': 'Fraccionamiento Facturas',
  tareas: 'Tareas',
  embarques: 'Embarques (picking)',
  'asignacion-pedidos': 'Asignación de Facturas',
  'pendientes-entrega': 'Pendientes Entrega',
  'despachos-en-cocina': 'Despachos en Cocina',
  'cuentas-cobrar': 'Cuentas por Cobrar',
  'recibos-caja-cxc': 'Recibos de Caja CXC',
  'cuentas-pagar': 'Cuentas por Pagar',
  'retenciones-isr': 'Retenciones Emitidas ISR',
  'retenciones-iva': 'Retenciones Emitidas IVA',
  'retenciones-isr-recibidas': 'Retenciones ISR Recibidas',
  'retenciones-iva-recibidas': 'Retenciones IVA Recibidas',
  'libro-compras': 'Libro Compras',
  'libro-ventas': 'Libro Ventas',
  'libro-diario': 'Libro Diario',
  'libro-mayor': 'Libro Mayor',
  'libro-balance': 'Libro Balance',
  'inventario-fiscal': 'Inventario Fiscal',
  'nomenclatura-contable': 'Nomenclatura Contable',
  'formatos-contables': 'Formatos Contables',
  'configuraciones-contabilidad': 'Configuraciones Contabilidad',
  'movimientos-banco': 'Movimientos',
  bancos: 'Bancos',
  'cuentas-bancarias': 'Cuentas Bancarias',
  'productos-precios': 'Productos y precios',
  'lista-precios': 'Lista Precios',
  inventario: 'Inventario',
  'relleno-inventario': 'Relleno de inventario',
  'entradas-inventario': 'Entradas de inventario',
  'salidas-inventario': 'Salidas de inventario',
  'inventario-retroactivo': 'Inventario Retroactivo',
  'actualizacion-inventario': 'Actualización de inventario',
  'actualizacion-costos': 'Actualización de costos',
  'crear-traslado': 'Crear Traslado',
  'recibir-traslado': 'Recibir Traslado',
  documentos: 'Documentos',
  'lista-facturas': 'Lista Facturas',
  'cuadre-caja': 'Cuadre de Caja',
  'resumen-del-dia': 'Resumen del día',
  autorizaciones: 'Autorizaciones',
  'documentos-eliminados': 'Documentos eliminados',
  promociones: 'Promociones',
  'auditoria-cajas': 'Auditoría Cajas',
  'reportes-ventas': 'Reportes de Ventas',
  'subir-catalogo': 'Subir catálogo',
  'descargar-catalogo': 'Descargar Catálogo',
  'traslados-en-transito': 'Traslados en tránsito',
  empleados: 'Empleados',
  'control-asistencia': 'Control de Asistencia',
  'nomina-config': 'Configuración nómina',
  'nomina-conceptos': 'Conceptos nómina',
  'nomina-empleados': 'Datos nómina empleados',
  'nomina-vales': 'Vales a Empleados',
  'nomina-interna': 'Nómina interna',
  'nomina-igss': 'Planilla IGSS',
  marcas: 'Marcas',
  medidas: 'Medidas',
  proveedores: 'Proveedores',
  clientes: 'Clientes',
  'tipo-negocios': 'Tipo de Negocios',
  municipios: 'Municipios',
  departamentos: 'Departamentos',
  rutas: 'Rutas',
  fabricantes: 'Fabricantes',
  ubicaciones: 'Ubicaciones',
  'mesas-restaurante': 'Mesas Restaurante',
  cajas: 'Cajas',
  'servicio-mecanica': 'Servicio Mecánica',
  'mantenimiento-llantas': 'Mantenimiento de llantas',
  'registro-kilometrajes': 'Registro de Kilometrajes',
  vehiculos: 'Vehículos',
  plataformas: 'Plataformas',
  empresas: 'Empresas',
  'config-general': 'Config general',
  'roles-usuarios': 'Roles de usuarios',
  'tipo-documentos': 'Tipo documentos',
  'formatos-impresion': 'Formatos de impresión',
  'credenciales-fel': 'Credenciales FEL',
  updater: 'Actualizador BD',
  licencia: 'Licencia',
};

const MENU_GROUPS = [
  // También alimenta el generador de licencias (lib/license-modules.js).
  // Toda vista nueva debe ir aquí en el grupo/módulo comercial correcto.
  { id: 'general', title: 'General', menus: ['inicio'] },
  {
    id: 'operaciones',
    title: 'Operaciones',
    menus: [
      'pedidos-mostrador',
      'comandas-restaurante',
      'cotizaciones',
      'fraccionamiento-fac',
      'facturacion',
      'facturas-electronicas',
      'facturacion-completa',
      'notas-credito',
      'notas-abono',
      'compras',
      'notas-debito',
      'gastos',
      'vales-caja',
      'corte-caja',
      'tareas',
    ],
  },
  {
    id: 'distribuidoras',
    title: 'Distribuidoras',
    menus: ['embarques', 'asignacion-pedidos'],
  },
  {
    id: 'despacho',
    title: 'Despacho',
    menus: ['pendientes-entrega', 'despachos-en-cocina'],
  },
  {
    id: 'cuentas',
    title: 'Cuentas por cobrar / pagar',
    menus: ['cuentas-cobrar', 'recibos-caja-cxc', 'cuentas-pagar'],
  },
  {
    id: 'inventarios',
    title: 'Inventarios',
    menus: [
      'productos-precios',
      'lista-precios',
      'inventario',
      'relleno-inventario',
      'entradas-inventario',
      'salidas-inventario',
      'inventario-retroactivo',
      'actualizacion-inventario',
      'actualizacion-costos',
    ],
  },
  {
    id: 'traslados',
    title: 'Traslados de Mercadería',
    menus: ['crear-traslado', 'recibir-traslado'],
  },
  { id: 'archivo', title: 'Archivo', menus: ['documentos', 'lista-facturas', 'cuadre-caja', 'resumen-del-dia', 'autorizaciones', 'documentos-eliminados', 'promociones'] },
  { id: 'reportes', title: 'Reportes', menus: ['auditoria-cajas', 'reportes-ventas'] },
  {
    id: 'online-services',
    title: 'Online Services',
    menus: ['subir-catalogo', 'descargar-catalogo', 'traslados-en-transito'],
  },
  {
    id: 'contabilidad',
    title: 'Contabilidad',
    menus: [
      'retenciones-isr',
      'retenciones-iva',
      'retenciones-isr-recibidas',
      'retenciones-iva-recibidas',
      'libro-compras',
      'libro-ventas',
      'libro-diario',
      'libro-mayor',
      'libro-balance',
      'inventario-fiscal',
      'nomenclatura-contable',
      'formatos-contables',
      'configuraciones-contabilidad',
    ],
  },
  {
    id: 'bancos',
    title: 'Bancos',
    menus: ['movimientos-banco', 'bancos', 'cuentas-bancarias'],
  },
  {
    id: 'rh',
    title: 'Recursos Humanos',
    menus: [
      'empleados',
      'control-asistencia',
      'nomina-config',
      'nomina-conceptos',
      'nomina-empleados',
      'nomina-vales',
      'nomina-interna',
      'nomina-igss',
    ],
  },
  {
    id: 'catalogos',
    title: 'Catálogos',
    menus: [
      'marcas',
      'medidas',
      'proveedores',
      'clientes',
      'tipo-negocios',
      'municipios',
      'departamentos',
      'rutas',
      'fabricantes',
      'ubicaciones',
      'mesas-restaurante',
      'cajas',
    ],
  },
  {
    id: 'transportes',
    title: 'Transportes',
    menus: [
      'servicio-mecanica',
      'mantenimiento-llantas',
      'registro-kilometrajes',
      'vehiculos',
      'plataformas',
    ],
  },
  {
    id: 'configuraciones',
    title: 'Configuraciones',
    menus: [
      'empresas',
      'config-general',
      'roles-usuarios',
      'tipo-documentos',
      'formatos-impresion',
      'credenciales-fel',
      'updater',
      'licencia',
    ],
  },
];

const ALL_MENUS_SET = new Set(ALL_MENUS);

function defaultAccesoMap() {
  return { 1: null };
}

function loadTiposEmpleado() {
  const raw = JSON.parse(fs.readFileSync(TIPOS_PATH, 'utf8'));
  return (Array.isArray(raw) ? raw : []).map((t) => ({
    value: Number(t.value),
    code: String(t.code || '').trim(),
    label: String(t.label || t.code || '').trim(),
  }));
}

function normalizeAccesoMap(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [key, val] of Object.entries(src)) {
    const cod = parseInt(key, 10);
    if (!Number.isFinite(cod) || cod <= 0) continue;
    if (val === null) {
      out[cod] = null;
      continue;
    }
    if (!Array.isArray(val)) continue;
    const menus = [...new Set(val.map((m) => String(m || '').trim()).filter((m) => ALL_MENUS_SET.has(m)))];
    if (!menus.includes('inicio')) menus.unshift('inicio');
    out[cod] = menus;
  }
  if (out[1] === undefined) out[1] = null;

  // Admin con lista casi completa (legado): promover a acceso total dinámico
  // para incluir opciones nuevas (p. ej. credenciales-fel) sin reconfigurar.
  if (Array.isArray(out[1])) {
    const meaningful = ALL_MENUS;
    const missing = meaningful.filter((m) => !out[1].includes(m));
    if (missing.length <= 5 && out[1].length >= meaningful.length - 5) {
      out[1] = null;
    }
  }

  return out;
}

function readLegacyAccesoFile() {
  try {
    if (!fs.existsSync(ACCESO_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(ACCESO_PATH, 'utf8'));
    return normalizeAccesoMap(raw);
  } catch (err) {
    console.warn('[roles-usuarios] readLegacyAccesoFile:', err.message);
    return null;
  }
}

function renameLegacyAccesoFile() {
  try {
    if (!fs.existsSync(ACCESO_PATH)) return;
    const bak = `${ACCESO_PATH}.migrated`;
    if (!fs.existsSync(bak)) fs.renameSync(ACCESO_PATH, bak);
  } catch {
    /* ignore */
  }
}

async function ensureMenuAccesoTable(pool) {
  await pool.request().query(ENSURE_TABLE_SQL);
}

function rowToMenus(row) {
  if (!row) return undefined;
  const total = row.ACCESO_TOTAL === true || row.ACCESO_TOTAL === 1 || String(row.ACCESO_TOTAL) === '1';
  if (total) return null;
  const raw = row.MENUS;
  if (raw == null || String(raw).trim() === '') return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAccesoMap(pool, sql, map) {
  const normalized = normalizeAccesoMap(map);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query('DELETE FROM dbo.MENU_ACCESO_TIPOS');
    for (const [cod, val] of Object.entries(normalized)) {
      const codtipo = parseInt(cod, 10);
      const full = val === null;
      const menusJson = full ? null : JSON.stringify(Array.isArray(val) ? val : []);
      await new sql.Request(tx)
        .input('CODTIPOEMPLEADO', sql.Int, codtipo)
        .input('ACCESO_TOTAL', sql.Bit, full ? 1 : 0)
        .input('MENUS', sql.NVarChar(sql.MAX), menusJson)
        .query(`
          INSERT INTO dbo.MENU_ACCESO_TIPOS (CODTIPOEMPLEADO, ACCESO_TOTAL, MENUS, FECHA_MOD)
          VALUES (@CODTIPOEMPLEADO, @ACCESO_TOTAL, @MENUS, GETDATE())
        `);
    }
    await tx.commit();
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      /* ignore */
    }
    throw err;
  }
  return normalized;
}

async function loadMenuAccesoMap(pool, sql) {
  await ensureMenuAccesoTable(pool);
  const result = await pool.request().query(`
    SELECT CODTIPOEMPLEADO, ACCESO_TOTAL, MENUS
    FROM dbo.MENU_ACCESO_TIPOS
  `);
  const rows = result.recordset || [];

  if (!rows.length) {
    const legacy = readLegacyAccesoFile() || defaultAccesoMap();
    const saved = await writeAccesoMap(pool, sql, legacy);
    renameLegacyAccesoFile();
    return saved;
  }

  const fromDb = {};
  for (const row of rows) {
    const cod = parseInt(row.CODTIPOEMPLEADO, 10);
    if (!Number.isFinite(cod) || cod <= 0) continue;
    fromDb[cod] = rowToMenus(row);
  }
  const normalized = normalizeAccesoMap(fromDb);

  const beforeSer = {};
  for (const [cod, val] of Object.entries(fromDb)) {
    beforeSer[String(cod)] = val;
  }
  const afterSer = {};
  for (const [cod, val] of Object.entries(normalized)) {
    afterSer[String(cod)] = val;
  }
  if (JSON.stringify(afterSer) !== JSON.stringify(beforeSer)) {
    return writeAccesoMap(pool, sql, normalized);
  }
  return normalized;
}

async function saveMenuAccesoMap(pool, sql, map) {
  await ensureMenuAccesoTable(pool);
  return writeAccesoMap(pool, sql, map);
}

async function setAccesoForTipo(pool, sql, codtipo, menusOrNull) {
  const cod = parseInt(codtipo, 10);
  if (!Number.isFinite(cod) || cod <= 0) {
    const err = new Error('Tipo de empleado inválido');
    err.statusCode = 400;
    throw err;
  }
  const map = await loadMenuAccesoMap(pool, sql);
  if (menusOrNull === null || menusOrNull === 'ALL' || menusOrNull === '*') {
    map[cod] = null;
  } else {
    const list = Array.isArray(menusOrNull) ? menusOrNull : [];
    const menus = [...new Set(list.map((m) => String(m || '').trim()).filter((m) => ALL_MENUS_SET.has(m)))];
    if (!menus.includes('inicio')) menus.unshift('inicio');
    map[cod] = menus;
  }
  return saveMenuAccesoMap(pool, sql, map);
}

function menuGroupsPayload() {
  return MENU_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    menus: g.menus.map((key) => ({
      key,
      label: MENU_LABELS[key] || key,
    })),
  }));
}

module.exports = {
  ALL_MENUS,
  MENU_LABELS,
  MENU_GROUPS,
  loadTiposEmpleado,
  loadMenuAccesoMap,
  saveMenuAccesoMap,
  setAccesoForTipo,
  menuGroupsPayload,
  normalizeAccesoMap,
  ensureMenuAccesoTable,
};
