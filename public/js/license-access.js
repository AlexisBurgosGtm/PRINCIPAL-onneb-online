/**
 * Licencia de instalación (módulos comprados).
 * Se combina con TipoEmpleadoAccess: licencia ∩ rol.
 */
const LicenseAccess = {
  _status: null,
  _loading: null,
  /** Días de anticipación para avisar vencimiento en el header. */
  EXPIRY_WARN_DAYS: 2,

  async refresh() {
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try {
        const data = await F.fetchJson(`/api/license/status?_=${Date.now()}`, {
          cache: 'no-store',
        });
        this._status = data;
        this.updateExpiryBadge();
        return data;
      } catch (err) {
        console.warn('[LicenseAccess]', err?.message || err);
        // Sin poder leer licencia → restringir a solo Licencia (no abrir todo el menú).
        this._status = {
          mode: 'restricted',
          status: 'missing',
          menus: ['licencia'],
          modules: [],
          message: err?.message || 'No se pudo leer la licencia',
        };
        this.updateExpiryBadge();
        return this._status;
      } finally {
        this._loading = null;
      }
    })();
    return this._loading;
  },

  status() {
    return this._status;
  },

  /** true si hay licencia válida o modo abierto explícito. */
  hasActiveLicense() {
    const st = this._status;
    if (!st) return false;
    if (st.mode === 'open' || st.status === 'open') return true;
    return st.mode === 'licensed' && st.status === 'valid';
  },

  isSuperUser() {
    try {
      return Boolean(typeof F !== 'undefined' && F.session?.('user')?.superUser);
    } catch {
      return false;
    }
  },

  /** Menús siempre visibles aunque no estén en la licencia (Licencia; Actualizador para super usuario). */
  isLicenseExemptMenu(menuKey) {
    const key = String(menuKey || '').trim();
    if (key === 'licencia') return true;
    if (key === 'updater' && this.isSuperUser()) return true;
    return false;
  },

  /** null = todos los menús (modo abierto). */
  allowedMenus() {
    const st = this._status;
    if (!st) return new Set(['licencia']);
    if (st.menus === null || st.mode === 'open') return null;
    return new Set(st.menus || ['licencia']);
  },

  canAccessMenu(menuKey) {
    const key = String(menuKey || '').trim();
    if (!key) return false;
    if (this.isLicenseExemptMenu(key)) return true;
    const allowed = this.allowedMenus();
    if (!allowed) return true;
    if (allowed.has(key)) return true;
    // Fraccionamiento usable desde la vista Facturación (mismo flujo operativo).
    if (key === 'fraccionamiento-fac' && allowed.has('facturacion-completa')) return true;
    return false;
  },

  /**
   * Parsea expiresAt a medianoche local (evita desfases UTC).
   * @returns {Date|null}
   */
  parseExpiryDate(expiresAt) {
    if (!expiresAt) return null;
    const s = String(expiresAt).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (!y || mo < 1 || mo > 12 || d < 1) return null;
      return new Date(y, mo - 1, d);
    }
    const dt = new Date(s);
    if (Number.isNaN(dt.getTime())) return null;
    return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  },

  /** Días hasta el vencimiento (0 = hoy, negativo = ya venció). */
  daysUntilExpiry(expiresAt = this._status?.expiresAt) {
    const exp = this.parseExpiryDate(expiresAt);
    if (!exp) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((exp.getTime() - today.getTime()) / 86400000);
  },

  /**
   * Aviso de vencimiento si hay fecha y faltan ≤ EXPIRY_WARN_DAYS días (o ya venció).
   * @returns {{ days: number, short: string, title: string }|null}
   */
  expiryWarning() {
    const st = this._status;
    if (!st?.expiresAt) return null;
    // Solo con licencia cargada (no modo abierto sin fecha).
    if (st.mode === 'open' && !st.licenseId) return null;
    const days = this.daysUntilExpiry(st.expiresAt);
    if (days == null || days > this.EXPIRY_WARN_DAYS) return null;

    const fecha =
      typeof DocFecha !== 'undefined' && DocFecha.formatDisplay
        ? DocFecha.formatDisplay(this.parseExpiryDate(st.expiresAt) || st.expiresAt)
        : (() => {
            const d = this.parseExpiryDate(st.expiresAt);
            if (!d) return String(st.expiresAt);
            return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
          })();

    if (days < 0) {
      return {
        days,
        short: 'Licencia vencida',
        title: `La licencia venció el ${fecha}. Renueve la licencia.`,
      };
    }
    if (days === 0) {
      return {
        days,
        short: 'Licencia vence hoy',
        title: `La licencia vence hoy (${fecha}).`,
      };
    }
    if (days === 1) {
      return {
        days,
        short: 'Licencia vence mañana',
        title: `La licencia vence mañana (${fecha}).`,
      };
    }
    return {
      days,
      short: `Licencia vence en ${days} días`,
      title: `La licencia vence el ${fecha} (en ${days} días).`,
    };
  },

  updateExpiryBadge() {
    const el = document.getElementById('header-license-expiry-badge');
    if (!el) return;
    const warn = this.expiryWarning();
    if (!warn) {
      el.hidden = true;
      el.textContent = '';
      el.removeAttribute('title');
      return;
    }
    el.hidden = false;
    el.textContent = warn.short;
    el.title = warn.title;
    el.setAttribute('role', 'status');
  },

  clearExpiryBadge() {
    const el = document.getElementById('header-license-expiry-badge');
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
    el.removeAttribute('title');
  },

  applyAfterRoleFilter() {
    const licensed = this.allowedMenus();
    if (!licensed) return;
    document.querySelectorAll('.sidebar-link[data-menu]').forEach((link) => {
      const key = link.dataset.menu;
      if (this.isLicenseExemptMenu(key)) {
        const li = link.closest('li');
        if (li) li.hidden = false;
        return;
      }
      if (!licensed.has(key)) {
        const li = link.closest('li');
        if (li) li.hidden = true;
      }
    });
    document.querySelectorAll('.sidebar-accordion .accordion-item').forEach((item) => {
      if (item.classList.contains('sidebar-favoritos-item')) {
        item.hidden = !this.hasActiveLicense();
        return;
      }
      if (item.classList.contains('sidebar-spacer-item')) {
        item.hidden = !this.hasActiveLicense();
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
};
