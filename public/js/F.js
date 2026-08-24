/**
 * Funciones genéricas del proyecto OnneB POS
 * Uso: F.nombreFuncion(...)
 */
let F = {
  /**
   * Muestra alerta con SweetAlert2
   */
  alert(title, text = '', icon = 'info') {
    const onlyOk = typeof CatalogosUI !== 'undefined';
    if (onlyOk) {
      return Swal.fire({
        ...CatalogosUI.modalBase(),
        title,
        text,
        icon,
        showCancelButton: false,
        confirmButtonText: CatalogosUI.guardarButtonHtml('Aceptar'),
      });
    }
    return Swal.fire({
      title,
      text,
      icon,
      confirmButtonColor: '#2563eb',
    });
  },

  /**
   * Toast breve
   */
  toast(message, icon = 'success') {
    const Toast = Swal.mixin({
      toast: true,
      position: 'top-end',
      showConfirmButton: false,
      timer: 2800,
      timerProgressBar: true,
    });
    return Toast.fire({ icon, title: message });
  },

  /**
   * Fecha en formato dd-mm-yyyy (día calendario; sin desfase UTC en cadenas YYYY-MM-DD).
   */
  formatDateDD(date = new Date()) {
    if (date == null || date === '') return '—';
    if (typeof DocFecha !== 'undefined' && DocFecha.formatDisplay) {
      const disp = DocFecha.formatDisplay(date, '');
      if (disp) return disp.replace(/\//g, '-');
    }
    if (typeof date === 'string') {
      const m = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    }
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '—';
    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const year = d.getUTCFullYear();
    return `${day}-${month}-${year}`;
  },

  /**
   * Formato de fecha local
   */
  formatDate(date = new Date(), locale = 'es-MX') {
    if (typeof date === 'string') {
      const m = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        return `${m[3]}/${m[2]}/${m[1]}`;
      }
    }
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '—';
    if (date instanceof Date || (typeof date === 'string' && /T00:00:00(\.\d+)?Z$/i.test(String(date)))) {
      const day = String(d.getUTCDate()).padStart(2, '0');
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const year = d.getUTCFullYear();
      return `${day}/${month}/${year}`;
    }
    return d.toLocaleDateString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  },

  /**
   * Formato de moneda
   */
  formatCurrency(amount, currency = 'MXN', locale = 'es-MX') {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  },

  /**
   * Debounce para eventos
   */
  debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), delay);
    };
  },

  /**
   * Query selector seguro
   */
  $(selector, parent = document) {
    return parent.querySelector(selector);
  },

  /**
   * Guardar / leer JSON en localStorage (sesión de trabajo; se limpia al recargar la página).
   * Migra datos previos de sessionStorage.
   */
  session(key, value) {
    try {
      if (value === undefined) {
        let raw = localStorage.getItem(key);
        if (!raw) {
          raw = sessionStorage.getItem(key);
          if (raw) {
            localStorage.setItem(key, raw);
            sessionStorage.removeItem(key);
          }
        }
        return raw ? JSON.parse(raw) : null;
      }
      const json = JSON.stringify(value);
      localStorage.setItem(key, json);
      sessionStorage.setItem(key, json);
      return value;
    } catch (err) {
      console.warn('[Session]', err);
      return value === undefined ? null : value;
    }
  },

  clearSession(key) {
    try {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    } catch (err) {
      console.warn('[Session] clear:', err);
    }
  },

  isLoggedIn() {
    const user = this.session('user');
    return Boolean(user?.empNit);
  },

  /** EMPNIT de la empresa activa (sesión global) */
  getEmpNit() {
    const user = this.session('user');
    return user?.empNit ?? window.OnnebContext?.empNit ?? null;
  },

  getEmpNitNombre() {
    const user = this.session('user');
    return user?.empNombre ?? window.OnnebContext?.empNombre ?? '';
  },

  /**
   * CODTIPOEMPRESA: 1 PRINCIPAL, 2 SUCURSAL.
   * @returns {number|null}
   */
  getCodTipoEmpresa() {
    const raw =
      this.session('user')?.codTipoEmpresa ?? window.OnnebContext?.codTipoEmpresa ?? null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  },

  isEmpresaPrincipal() {
    return this.getCodTipoEmpresa() === 1;
  },

  isEmpresaSucursal() {
    return this.getCodTipoEmpresa() === 2;
  },

  /** CODEMPLEADO de la sesión (null si superusuario o no definido). */
  sessionCodEmpleado() {
    const n = parseInt(this.session('user')?.codempleado, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  },

  isAdminOrSuperUser() {
    const user = this.session('user') || {};
    if (user.superUser) return true;
    if (typeof TipoEmpleadoAccess !== 'undefined') {
      return Number(TipoEmpleadoAccess.getCodTipo(user)) === TipoEmpleadoAccess.TIPO_ADMIN;
    }
    return Number(user.codtipoempleado) === 1;
  },

  /** COSTO de productos/precios: Administrador o Contabilidad. */
  canViewCosto() {
    if (typeof TipoEmpleadoAccess !== 'undefined' && typeof TipoEmpleadoAccess.canViewCosto === 'function') {
      return TipoEmpleadoAccess.canViewCosto(this.session('user'));
    }
    if (this.isAdminOrSuperUser()) return true;
    return Number(this.session('user')?.codtipoempleado) === 7;
  },

  /**
   * Token de navegación de menú: evita que un load async anterior pise la vista actual.
   */
  _menuNavToken: 0,
  _activeMenuKey: '',

  beginMenuNavigation(key) {
    this._menuNavToken += 1;
    this._activeMenuKey = String(key || '');
    return this._menuNavToken;
  },

  getMenuNavToken() {
    return this._menuNavToken;
  },

  getActiveMenuKey() {
    return this._activeMenuKey || '';
  },

  isMenuNavigationCurrent(token) {
    return Number(token) === Number(this._menuNavToken);
  },

  /**
   * Si el usuario es admin, asegura que su CODEMPLEADO aparezca en el selector de vendedores.
   * Para no-admin no altera la lista.
   */
  ensureVendedoresForSession(vendedores) {
    const list = Array.isArray(vendedores) ? [...vendedores] : [];
    if (!this.isAdminOrSuperUser()) return list;
    const cod = this.sessionCodEmpleado();
    if (cod == null) return list;
    if (list.some((v) => String(v.CODEMPLEADO) === String(cod))) return list;
    const user = this.session('user') || {};
    const nombre = String(user.nomempleado || user.usuario || `Empleado ${cod}`).trim();
    list.unshift({ CODEMPLEADO: cod, NOMEMPLEADO: nombre });
    return list;
  },

  /**
   * CODVEN por defecto: empleado de sesión si aparece en la lista de vendedores.
   * Admin: se usa su CODEMPLEADO (tras ensureVendedoresForSession).
   * @param {Array<{CODEMPLEADO:number|string}>} vendedores
   */
  defaultCodvenFromSession(vendedores) {
    const cod = this.sessionCodEmpleado();
    if (cod == null) return null;
    const ok = (vendedores || []).some((v) => String(v.CODEMPLEADO) === String(cod));
    return ok ? cod : null;
  },

  /** CODCAJA preferido si está en la lista; si no, la primera caja. */
  pickCajaDefault(cajas, preferred) {
    const list = Array.isArray(cajas) ? cajas : [];
    const want = String(preferred ?? '').trim();
    if (want) {
      const match = list.find((c) => String(c.CODCAJA ?? '').trim() === want);
      if (match) return String(match.CODCAJA);
    }
    return list[0] != null ? String(list[0].CODCAJA) : '';
  },

  setEmpresaGlobal(empNit, empNombre = '', codTipoEmpresa = undefined) {
    const prev = this.session('user') || {};
    let tip = prev.codTipoEmpresa ?? null;
    if (codTipoEmpresa !== undefined && codTipoEmpresa !== null && codTipoEmpresa !== '') {
      const n = parseInt(codTipoEmpresa, 10);
      tip = Number.isFinite(n) && n > 0 ? n : null;
    }
    window.OnnebContext = {
      ...(window.OnnebContext || {}),
      empNit,
      empNombre,
      codTipoEmpresa: tip,
    };
    this.session('user', { ...prev, empNit, empNombre, codTipoEmpresa: tip });
  },

  async ensureCodTipoEmpresa() {
    let tip = this.getCodTipoEmpresa();
    if (tip != null) return tip;
    const empnit = this.getEmpNit();
    if (!empnit) return null;
    try {
      const data = await this.fetchJson(
        `/api/empresas/tipo?empnit=${encodeURIComponent(empnit)}&_=${Date.now()}`,
        { cache: 'no-store' }
      );
      tip = data.CODTIPOEMPRESA == null ? null : Number(data.CODTIPOEMPRESA);
      if (Number.isFinite(tip) && tip > 0) {
        this.setEmpresaGlobal(empnit, this.getEmpNitNombre(), tip);
        return tip;
      }
    } catch (err) {
      console.warn('[F] ensureCodTipoEmpresa:', err?.message || err);
    }
    return null;
  },

  /** Socket.IO compartido (misma conexión / rooms de sesión). */
  _socket: null,

  setSocket(socket) {
    this._socket = socket || null;
    window.OnnebSocket = this._socket;
  },

  getSocket() {
    return this._socket || window.OnnebSocket || null;
  },

  /**
   * Bloqueo global durante POST/PUT/PATCH/DELETE (evita doble envío).
   */
  _mutationDepth: 0,

  beginMutation() {
    this._mutationDepth += 1;
    if (this._mutationDepth === 1) {
      document.body.classList.add('onneb-mutation-busy');
      document.body.setAttribute('aria-busy', 'true');
    }
  },

  endMutation() {
    if (this._mutationDepth <= 0) return;
    this._mutationDepth -= 1;
    if (this._mutationDepth === 0) {
      document.body.classList.remove('onneb-mutation-busy');
      document.body.removeAttribute('aria-busy');
    }
  },

  async runMutation(fn) {
    this.beginMutation();
    try {
      return await fn();
    } finally {
      this.endMutation();
    }
  },

  isMutationMethod(method) {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || 'GET').toUpperCase());
  },

  /**
   * Petición fetch con JSON
   */
  async fetchJson(url, options = {}) {
    const isMutation = this.isMutationMethod(options.method);
    if (isMutation) this.beginMutation();
    try {
      const headers = { Accept: 'application/json', ...options.headers };
      try {
        if (this.session('user')?.superUser) {
          headers['X-Super-User'] = '1';
        }
      } catch {
        /* sesión no disponible */
      }
      const res = await fetch(url, {
        cache: options.cache ?? 'no-store',
        ...options,
        headers,
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        let payload = null;
        try {
          const errBody = await res.json();
          payload = errBody;
          if (errBody.error) message = errBody.error;
        } catch {
          /* respuesta no JSON */
        }
        const err = new Error(message);
        if (payload) err.payload = payload;
        throw err;
      }
      if (res.status === 204) return null;
      return res.json();
    } finally {
      if (isMutation) this.endMutation();
    }
  },

  /** TOKEN de instalación (host de actualizaciones / comunidad). */
  _token: null,
  _runtimeLoaded: false,

  getToken() {
    if (this._token != null && this._token !== '') return this._token;
    return window.OnnebContext?.token || '';
  },

  setToken(token) {
    const value = String(token ?? '').trim();
    this._token = value;
    window.OnnebContext = {
      ...(window.OnnebContext || {}),
      token: value,
    };
    window.OnnebToken = value;
    return value;
  },

  async loadRuntime() {
    if (this._runtimeLoaded && this._token != null) {
      return { token: this.getToken() };
    }
    try {
      const data = await this.fetchJson(`/api/community/runtime?_=${Date.now()}`, {
        cache: 'no-store',
      });
      this.setToken(data.token || '');
      this._runtimeLoaded = true;
      return data;
    } catch (err) {
      console.warn('[F.loadRuntime]', err?.message || err);
      this.setToken('');
      this._runtimeLoaded = true;
      return { token: '' };
    }
  },
};
