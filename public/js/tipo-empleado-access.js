/**
 * Permisos de menú e inicio según CODTIPOEMPLEADO (Empleados).
 * El mapa por tipo puede sobrescribirse desde /api/roles-usuarios (Roles de usuarios).
 */
const TipoEmpleadoAccess = {
  TIPO_ADMIN: 1,
  TIPO_SUPERVISOR: 2,
  TIPO_VENDEDOR: 3,
  TIPO_VISITADOR: 4,
  TIPO_BODEGA: 5,
  TIPO_TRANSPORTE: 6,
  TIPO_CONTABILIDAD: 7,
  TIPO_CAJERO: 8,

  ALL_MENUS: [
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
    'reportes-clientes',
    'reportes-productos',
    'reportes-marcas',
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
  ],

  MENU_BY_TIPO: {
    1: null,
    2: [
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
    'reportes-clientes',
    'reportes-productos',
    'reportes-marcas',
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
      'clientes',
      'proveedores',
      'rutas',
    ],
    3: [
      'inicio',
      'pedidos-mostrador',
      'comandas-restaurante',
      'cotizaciones',
      'fraccionamiento-fac',
      'tareas',
      'inventario',
      'relleno-inventario',
    ],
    4: ['inicio', 'clientes', 'rutas', 'documentos', 'lista-facturas', 'resumen-del-dia'],
    5: [
      'inicio',
      'productos-precios',
      'lista-precios',
      'inventario',
      'relleno-inventario',
      'entradas-inventario',
      'salidas-inventario',
      'actualizacion-inventario',
      'actualizacion-costos',
      'crear-traslado',
      'recibir-traslado',
      'pendientes-entrega',
      'despachos-en-cocina',
      'embarques',
      'asignacion-pedidos',
    ],
    6: [
      'inicio',
      'embarques',
      'asignacion-pedidos',
      'servicio-mecanica',
      'mantenimiento-llantas',
      'registro-kilometrajes',
      'vehiculos',
      'plataformas',
    ],
    7: [
      'inicio',
      'libro-compras',
      'libro-ventas',
      'libro-diario',
      'libro-mayor',
      'libro-balance',
      'inventario-fiscal',
      'movimientos-banco',
      'bancos',
      'cuentas-bancarias',
    ],
    8: [
      'inicio',
      'facturacion',
      'facturas-electronicas',
      'facturacion-completa',
      'fraccionamiento-fac',
      'corte-caja',
      'cuentas-cobrar',
      'recibos-caja-cxc',
    ],
  },

  _accesoLoaded: false,

  applyMenuAccesoMap(acceso) {
    if (!acceso || typeof acceso !== 'object') return;
    const next = { ...this.MENU_BY_TIPO };
    for (const [key, val] of Object.entries(acceso)) {
      const cod = parseInt(key, 10);
      if (!Number.isFinite(cod) || cod <= 0) continue;
      if (val === null) {
        next[cod] = null;
        continue;
      }
      if (!Array.isArray(val)) continue;
      const menus = val.map((m) => String(m || '').trim()).filter((m) => this.ALL_MENUS.includes(m));
      if (!menus.includes('inicio')) menus.unshift('inicio');
      // Admin con lista casi completa → acceso total (incluye menús nuevos)
      if (cod === this.TIPO_ADMIN) {
        const meaningful = this.ALL_MENUS;
        const missing = meaningful.filter((m) => !menus.includes(m));
        if (missing.length <= 5 && menus.length >= meaningful.length - 5) {
          next[cod] = null;
          continue;
        }
      }
      next[cod] = menus;
    }
    if (next[this.TIPO_ADMIN] === undefined) next[this.TIPO_ADMIN] = null;
    this.MENU_BY_TIPO = next;
    this._accesoLoaded = true;
  },

  async refreshMenuAccess() {
    try {
      const data = await F.fetchJson(`/api/roles-usuarios/acceso?_=${Date.now()}`, {
        cache: 'no-store',
      });
      this.applyMenuAccesoMap(data.acceso || {});
    } catch (err) {
      console.warn('[TipoEmpleadoAccess] refreshMenuAccess:', err?.message || err);
    }
  },

  getSessionUser() {
    return F.session('user') || {};
  },

  getCodTipo(sessionUser) {
    const user = sessionUser || this.getSessionUser();
    if (user?.superUser) return this.TIPO_ADMIN;
    const n = Number(user?.codtipoempleado);
    return Number.isFinite(n) && n > 0 ? n : null;
  },

  /** COSTO visible solo para Administrador y Contabilidad. */
  canViewCosto(sessionUser) {
    const cod = this.getCodTipo(sessionUser);
    return cod === this.TIPO_ADMIN || cod === this.TIPO_CONTABILIDAD;
  },

  /**
   * Menús permitidos según perfil (Roles de usuarios).
   * null en el mapa = acceso a todas las opciones del catálogo actual.
   * Admin sin restricción explícita → siempre acceso total.
   */
  allowedMenus(codtipo) {
    if (codtipo === null || codtipo === undefined) {
      return new Set(this.ALL_MENUS);
    }
    const list = this.MENU_BY_TIPO[codtipo];
    if (list === null || list === undefined) {
      return new Set(this.ALL_MENUS);
    }
    if (Array.isArray(list) && list.length) {
      return new Set(list);
    }
    if (Number(codtipo) === this.TIPO_ADMIN) {
      return new Set(this.ALL_MENUS);
    }
    return new Set(['inicio']);
  },

  canAccessMenu(menuKey, sessionUser) {
    const key = String(menuKey || '').trim();
    if (!key) return false;
    if (key === 'licencia') return true;
    // Super usuario: Actualizador BD siempre, aunque no esté en la licencia.
    if (key === 'updater') {
      const user = sessionUser || this.getSessionUser();
      if (user?.superUser) return true;
    }
    if (typeof LicenseAccess !== 'undefined' && !LicenseAccess.canAccessMenu(key)) {
      return false;
    }
    const allowed = this.allowedMenus(this.getCodTipo(sessionUser));
    if (!allowed.has(key)) return false;
    if (key === 'subir-catalogo' || key === 'descargar-catalogo') {
      const tip =
        typeof F !== 'undefined' && typeof F.getCodTipoEmpresa === 'function'
          ? F.getCodTipoEmpresa()
          : null;
      if (key === 'subir-catalogo' && tip !== 1) return false;
      if (key === 'descargar-catalogo' && tip !== 2) return false;
    }
    return true;
  },

  tipoLabel(codtipo) {
    const cache = window._onnebTiposEmpleadoCache || [];
    const found = cache.find((t) => Number(t.value) === Number(codtipo));
    if (found) return String(found.label || found.code || '').trim();
    const fallback = {
      1: 'ADMINISTRADOR',
      2: 'SUPERVISOR',
      3: 'VENDEDOR',
      4: 'VISITADOR',
      5: 'BODEGA',
      6: 'TRANSPORTE',
      7: 'CONTABILIDAD',
      8: 'CAJERO',
    };
    return fallback[codtipo] || 'Empleado';
  },

  applySidebarVisibility() {
    const allowed = this.allowedMenus(this.getCodTipo());
    const tipEmpresa =
      typeof F !== 'undefined' && typeof F.getCodTipoEmpresa === 'function'
        ? F.getCodTipoEmpresa()
        : null;
    const licenseOk =
      typeof LicenseAccess === 'undefined' ? true : LicenseAccess.hasActiveLicense();

    document.querySelectorAll('.sidebar-link[data-menu]').forEach((link) => {
      const key = link.dataset.menu;
      const li = link.closest('li');
      if (!li) return;
      let visible = false;
      if (typeof LicenseAccess !== 'undefined' && LicenseAccess.isLicenseExemptMenu?.(key)) {
        visible = true;
      } else if (key === 'licencia') {
        visible = true;
      } else if (!licenseOk && typeof LicenseAccess !== 'undefined') {
        visible = LicenseAccess.canAccessMenu(key);
      } else {
        visible = allowed.has(key);
        if (visible && typeof LicenseAccess !== 'undefined' && !LicenseAccess.canAccessMenu(key)) {
          visible = false;
        }
      }
      if (key === 'subir-catalogo') visible = visible && tipEmpresa === 1;
      if (key === 'descargar-catalogo') visible = visible && tipEmpresa === 2;
      li.hidden = !visible;
    });
    document.querySelectorAll('.sidebar-accordion .accordion-item').forEach((item) => {
      if (item.classList.contains('sidebar-favoritos-item')) {
        item.hidden = !licenseOk;
        return;
      }
      if (item.classList.contains('sidebar-spacer-item')) {
        item.hidden = !licenseOk;
        return;
      }
      const links = item.querySelectorAll('.sidebar-link[data-menu]');
      const anyVisible = Array.from(links).some((link) => {
        const li = link.closest('li');
        return li && !li.hidden;
      });
      item.hidden = !anyVisible;
    });
    if (typeof MenuFavoritos !== 'undefined') {
      MenuFavoritos.render();
    }
  },

  resetSidebarVisibility() {
    document.querySelectorAll('.sidebar-link[data-menu]').forEach((link) => {
      const li = link.closest('li');
      if (li) li.hidden = false;
    });
    document.querySelectorAll('.sidebar-accordion .accordion-item').forEach((item) => {
      item.hidden = false;
    });
  },
};
