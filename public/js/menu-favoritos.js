/**
 * Favoritos del menú lateral — preferencia por dispositivo (localStorage).
 * Clona opciones autorizadas del sidebar; no altera permisos del servidor.
 * Incluye FAB flotante arrastrable para abrir el menú de favoritos.
 */
const MenuFavoritos = {
  STORAGE_PREFIX: 'onneb-menu-favoritos',
  EXCLUDE_KEYS: new Set(['inicio']),

  escapeHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  storageKey() {
    const user = typeof F !== 'undefined' ? F.session('user') : null;
    const emp = String(user?.empNit || (typeof F !== 'undefined' ? F.getEmpNit() : '') || 'sin-emp').trim();
    const who = user?.superUser
      ? 'su'
      : String(user?.codempleado || user?.usuario || user?.username || 'anon').trim();
    return `${this.STORAGE_PREFIX}:${emp}:${who}`;
  },

  loadKeys() {
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const keys = Array.isArray(parsed?.keys) ? parsed.keys : Array.isArray(parsed) ? parsed : [];
      return keys.map((k) => String(k || '').trim()).filter(Boolean);
    } catch {
      return [];
    }
  },

  saveKeys(keys) {
    const clean = [...new Set((keys || []).map((k) => String(k || '').trim()).filter(Boolean))];
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify({ keys: clean }));
    } catch (err) {
      if (typeof F !== 'undefined') {
        F.toast(err.message || 'No se pudieron guardar los favoritos', 'error');
      }
    }
    return clean;
  },

  canAccess(key) {
    if (!key || this.EXCLUDE_KEYS.has(key)) return false;
    if (typeof TipoEmpleadoAccess === 'undefined') return true;
    return TipoEmpleadoAccess.canAccessMenu(key);
  },

  /** Enlaces canónicos del menú (sin clones de favoritos ni Configurar). */
  catalogLinks() {
    return Array.from(
      document.querySelectorAll(
        '#sidebar .sidebar-link[data-menu]:not(.js-favorito):not([data-favoritos-config])'
      )
    );
  },

  catalogByKey() {
    const map = new Map();
    for (const link of this.catalogLinks()) {
      const key = String(link.dataset.menu || '').trim();
      if (!key || this.EXCLUDE_KEYS.has(key) || map.has(key)) continue;
      const icon = link.querySelector('i')?.outerHTML || '<i class="fa-solid fa-circle" aria-hidden="true"></i>';
      const label = link.textContent.replace(/\s+/g, ' ').trim();
      map.set(key, { key, label, iconHtml: icon });
    }
    return map;
  },

  authorizedCandidates() {
    return [...this.catalogByKey().values()]
      .filter((item) => this.canAccess(item.key))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));
  },

  favoriteItems() {
    const catalog = this.catalogByKey();
    return this.loadKeys()
      .filter((k) => this.canAccess(k) && catalog.has(k))
      .map((k) => catalog.get(k))
      .filter(Boolean);
  },

  listEl() {
    return document.getElementById('sidebar-favoritos-list');
  },

  render() {
    const list = this.listEl();
    if (!list) return;

    list.querySelectorAll('li.js-favorito-wrap').forEach((li) => li.remove());

    const catalog = this.catalogByKey();
    const keys = this.loadKeys().filter((k) => this.canAccess(k) && catalog.has(k));

    for (const key of keys) {
      const item = catalog.get(key);
      if (!item) continue;
      const li = document.createElement('li');
      li.className = 'js-favorito-wrap';
      li.innerHTML = `<a href="#" class="sidebar-link js-favorito" data-menu="${this.escapeHtml(key)}">${item.iconHtml} ${this.escapeHtml(item.label)}</a>`;
      list.appendChild(li);
    }
  },

  navigateTo(key) {
    const link =
      document.querySelector(`#sidebar .sidebar-link[data-menu="${key}"]:not(.js-favorito)`) ||
      document.querySelector(`#sidebar .sidebar-link[data-menu="${key}"]`);
    if (link) {
      link.click();
      return;
    }
    if (typeof F !== 'undefined') {
      F.toast('No se encontró la opción en el menú', 'warning');
    }
  },

  /** Modal Asistente: favoritos (izq.) + herramientas (der.). */
  openMenu() {
    const items = this.favoriteItems();
    const modalOpts =
      typeof CatalogosUI !== 'undefined'
        ? CatalogosUI.modalBase()
        : { customClass: { popup: 'modal-catalogo' } };

    const favHtml = items.length
      ? items
          .map(
            (c) => `
        <button type="button" class="favoritos-menu-item" data-favorito-nav="${this.escapeHtml(c.key)}">
          <span class="favoritos-config-icon">${c.iconHtml}</span>
          <span class="favoritos-config-label">${this.escapeHtml(c.label)}</span>
        </button>`
          )
          .join('')
      : `<p class="small text-muted mb-0">Aún no tiene favoritos. Configúrelos desde el menú lateral (Favoritos).</p>`;

    Swal.fire({
      ...modalOpts,
      title: 'Asistente',
      width: 'min(52rem, 96vw)',
      html: `
        <div class="asistente-modal-grid text-start">
          <div class="asistente-modal-col">
            <div class="asistente-card">
              <div class="asistente-card-title"><i class="fa-solid fa-star me-1"></i>Favoritos</div>
              <div class="favoritos-menu-list">${favHtml}</div>
            </div>
          </div>
          <div class="asistente-modal-col">
            <div class="asistente-card asistente-tools-card">
              <div class="asistente-tabs" role="tablist" aria-label="Herramientas del asistente">
                <button type="button" class="asistente-tab is-active" data-asist-tab="calcular" role="tab" aria-selected="true">
                  <i class="fa-solid fa-calculator" aria-hidden="true"></i>CALCULAR
                </button>
                <button type="button" class="asistente-tab" data-asist-tab="documentos" role="tab" aria-selected="false">
                  <i class="fa-solid fa-file-lines" aria-hidden="true"></i>DOCUMENTOS
                </button>
                <button type="button" class="asistente-tab" data-asist-tab="precios" role="tab" aria-selected="false">
                  <i class="fa-solid fa-tags" aria-hidden="true"></i>PRECIOS
                </button>
              </div>
              <div class="asistente-tab-panels">
                <div class="asistente-tab-panel is-active" data-asist-panel="calcular" role="tabpanel">
                  <div class="row g-2">
                    <div class="col-6">
                      <label class="form-label small mb-0" for="asist-costo">Costo</label>
                      <input type="number" step="0.01" min="0" id="asist-costo" class="form-control form-control-sm" placeholder="0.00">
                    </div>
                    <div class="col-6">
                      <label class="form-label small mb-0" for="asist-ganancia">% Ganancia</label>
                      <input type="number" step="0.01" id="asist-ganancia" class="form-control form-control-sm" placeholder="0" value="30">
                    </div>
                    <div class="col-12">
                      <label class="form-label small mb-0" for="asist-precio">Precio de venta (margen sobre venta)</label>
                      <p class="small text-muted mb-1">Costo ÷ (1 − %). El % es ganancia sobre el precio final.</p>
                      <input type="text" id="asist-precio" class="form-control form-control-sm text-danger fw-bold" readonly value="Q 0.00">
                    </div>
                    <div class="col-12">
                      <label class="form-label small mb-0" for="asist-precio-markup">Precio de venta (costo + %)</label>
                      <p class="small text-muted mb-1">Costo × (1 + %). El % se aplica sobre el costo.</p>
                      <input type="text" id="asist-precio-markup" class="form-control form-control-sm text-primary fw-bold" readonly value="Q 0.00">
                    </div>
                  </div>
                </div>
                <div class="asistente-tab-panel" data-asist-panel="documentos" role="tabpanel" hidden>
                  <div class="row g-2 align-items-end">
                    <div class="col-5">
                      <label class="form-label small mb-0" for="asist-coddoc">Serie (CODDOC)</label>
                      <input type="text" id="asist-coddoc" class="form-control form-control-sm" placeholder="Ej. FAC" autocomplete="off">
                    </div>
                    <div class="col-4">
                      <label class="form-label small mb-0" for="asist-corr">Correlativo</label>
                      <input type="number" step="1" min="1" id="asist-corr" class="form-control form-control-sm" placeholder="0">
                    </div>
                    <div class="col-3">
                      <button type="button" class="btn btn-sm btn-primary w-100" id="asist-doc-buscar">Buscar</button>
                    </div>
                    <div class="col-12">
                      <div id="asist-doc-result" class="asistente-doc-result small text-muted">Ingrese serie y correlativo para consultar.</div>
                    </div>
                  </div>
                </div>
                <div class="asistente-tab-panel" data-asist-panel="precios" role="tabpanel" hidden>
                  <div class="input-group input-group-sm mb-2">
                    <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
                    <input type="search" id="asist-prod-q" class="form-control" placeholder="Código o descripción…" autocomplete="off">
                    <button type="button" class="btn btn-primary" id="asist-prod-buscar">Buscar</button>
                  </div>
                  <div id="asist-prod-result" class="asistente-prod-result small text-muted">Escriba y pulse Buscar o Enter (máx. 10 productos).</div>
                </div>
              </div>
            </div>
          </div>
        </div>`,
      showConfirmButton: false,
      showCancelButton: true,
      cancelButtonText:
        typeof CatalogosUI !== 'undefined'
          ? CatalogosUI.cancelButtonHtml('Cerrar')
          : 'Cerrar',
      didOpen: () => {
        const popup = Swal.getPopup();
        popup?.querySelectorAll('[data-favorito-nav]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-favorito-nav');
            Swal.close();
            this.navigateTo(key);
          });
        });
        this.bindAsistenteTools(popup);
        this.bindAsistenteTabs(popup);
      },
    });
  },

  formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Q 0.00';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  formatFechaDoc(value) {
    if (!value) return '—';
    const s = String(value).slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return s;
  },

  formatExistencia(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('es-GT', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  },

  bindAsistenteTabs(popup) {
    if (!popup) return;
    const tabs = Array.from(popup.querySelectorAll('.asistente-tab[data-asist-tab]'));
    const panels = Array.from(popup.querySelectorAll('.asistente-tab-panel[data-asist-panel]'));
    if (!tabs.length) return;

    const activate = (key) => {
      tabs.forEach((tab) => {
        const on = tab.getAttribute('data-asist-tab') === key;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      panels.forEach((panel) => {
        const on = panel.getAttribute('data-asist-panel') === key;
        panel.classList.toggle('is-active', on);
        if (on) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
      });
      const focusMap = {
        calcular: '#asist-costo',
        documentos: '#asist-coddoc',
        precios: '#asist-prod-q',
      };
      popup.querySelector(focusMap[key] || '')?.focus();
    };

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        activate(tab.getAttribute('data-asist-tab'));
      });
    });
  },

  bindAsistenteTools(popup) {
    if (!popup) return;
    const costoEl = popup.querySelector('#asist-costo');
    const ganEl = popup.querySelector('#asist-ganancia');
    const precioEl = popup.querySelector('#asist-precio');
    const precioMarkupEl = popup.querySelector('#asist-precio-markup');

    const updatePrecio = () => {
      const costo = Number(costoEl?.value);
      const pct = Number(ganEl?.value);
      if (!Number.isFinite(costo) || costo < 0 || !Number.isFinite(pct)) {
        if (precioEl) precioEl.value = 'Q 0.00';
        if (precioMarkupEl) precioMarkupEl.value = 'Q 0.00';
        return;
      }
      if (pct >= 100) {
        if (precioEl) precioEl.value = '—';
      } else {
        const precioMargen = (costo * 100) / (100 - pct);
        if (precioEl) precioEl.value = this.formatMoney(precioMargen);
      }
      const precioMarkup = costo * (1 + pct / 100);
      if (precioMarkupEl) precioMarkupEl.value = this.formatMoney(precioMarkup);
    };
    costoEl?.addEventListener('input', updatePrecio);
    ganEl?.addEventListener('input', updatePrecio);
    updatePrecio();

    const resultEl = popup.querySelector('#asist-doc-result');
    const buscarBtn = popup.querySelector('#asist-doc-buscar');
    let lastDoc = null;
    const runBuscar = async () => {
      const coddoc = String(popup.querySelector('#asist-coddoc')?.value || '').trim();
      const corrRaw = popup.querySelector('#asist-corr')?.value;
      const correlativo = parseInt(corrRaw, 10);
      lastDoc = null;
      if (!coddoc) {
        if (resultEl) {
          resultEl.className = 'asistente-doc-result small text-danger';
          resultEl.textContent = 'Indique la serie interna (CODDOC).';
        }
        return;
      }
      if (!Number.isFinite(correlativo) || correlativo < 0) {
        if (resultEl) {
          resultEl.className = 'asistente-doc-result small text-danger';
          resultEl.textContent = 'Indique un correlativo válido.';
        }
        return;
      }
      if (typeof F === 'undefined' || !F.getEmpNit()) {
        if (resultEl) {
          resultEl.className = 'asistente-doc-result small text-danger';
          resultEl.textContent = 'No hay empresa activa.';
        }
        return;
      }
      if (resultEl) {
        resultEl.className = 'asistente-doc-result small text-muted';
        resultEl.textContent = 'Buscando…';
      }
      if (buscarBtn) buscarBtn.disabled = true;
      try {
        const url =
          `/api/documentos/resumen/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}` +
          `?empnit=${encodeURIComponent(F.getEmpNit())}&_=${Date.now()}`;
        const data = await F.fetchJson(url, { cache: 'no-store' });
        lastDoc = data;
        if (resultEl) {
          resultEl.className = 'asistente-doc-result small';
          resultEl.innerHTML = `
            <div class="asistente-doc-ok">
              <div><strong>${this.escapeHtml(data.CODDOC)} #${this.escapeHtml(data.CORRELATIVO)}</strong></div>
              <div>Fecha: <strong>${this.escapeHtml(this.formatFechaDoc(data.FECHA))}</strong></div>
              <div>NIT: <strong>${this.escapeHtml(data.DOC_NIT || '—')}</strong></div>
              <div>Cliente: <strong>${this.escapeHtml(data.DOC_NOMCLIE || '—')}</strong></div>
              <div>Importe: <strong>${this.escapeHtml(this.formatMoney(data.TOTALPRECIO))}</strong></div>
              <div class="mt-2">
                <button type="button" class="btn btn-sm btn-outline-secondary" id="asist-doc-reimprimir">
                  <i class="fa-solid fa-print me-1"></i>Reimprimir
                </button>
              </div>
            </div>`;
          resultEl.querySelector('#asist-doc-reimprimir')?.addEventListener('click', async () => {
            if (!lastDoc) return;
            try {
              if (typeof DocOpciones !== 'undefined' && DocOpciones.imprimir) {
                await DocOpciones.imprimir(lastDoc.CODDOC, lastDoc.CORRELATIVO, lastDoc);
              } else if (typeof DocPrint !== 'undefined' && DocPrint.printByKey) {
                await DocPrint.printByKey({
                  coddoc: lastDoc.CODDOC,
                  correlativo: lastDoc.CORRELATIVO,
                  title: `${lastDoc.CODDOC} #${lastDoc.CORRELATIVO}`,
                });
              } else {
                F.toast('No se pudo reimprimir', 'error');
              }
            } catch (err) {
              F.toast(err.message || 'Error al reimprimir', 'error');
            }
          });
        }
      } catch (err) {
        if (resultEl) {
          resultEl.className = 'asistente-doc-result small text-danger';
          resultEl.textContent = err.message || 'No se pudo buscar el documento';
        }
      } finally {
        if (buscarBtn) buscarBtn.disabled = false;
      }
    };
    buscarBtn?.addEventListener('click', () => {
      runBuscar().catch(() => {});
    });
    popup.querySelector('#asist-corr')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runBuscar().catch(() => {});
      }
    });
    popup.querySelector('#asist-coddoc')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        popup.querySelector('#asist-corr')?.focus();
      }
    });

    this.bindAsistenteProductos(popup);
  },

  renderAsistenteProductosHtml(rows) {
    if (!rows.length) {
      return '<p class="small text-muted mb-0">No se encontraron productos.</p>';
    }
    const groups = [];
    const byCode = new Map();
    for (const r of rows) {
      const code = String(r.CODPROD || '').trim();
      if (!code) continue;
      if (!byCode.has(code)) {
        const nombre = [r.DESPROD, r.DESPROD2].filter(Boolean).join(' · ') || '—';
        const group = { CODPROD: code, nombre, precios: [] };
        byCode.set(code, group);
        groups.push(group);
      }
      byCode.get(code).precios.push(r);
    }
    return `
      <div class="asistente-prod-list">
        ${groups
          .map(
            (g) => `
          <div class="asistente-prod-group">
            <div class="asistente-prod-info">
              <div class="asistente-prod-code">${this.escapeHtml(g.CODPROD)}</div>
              <div class="asistente-prod-name">${this.escapeHtml(g.nombre)}</div>
            </div>
            <div class="asistente-prod-prices">
              ${g.precios
                .map((r) => {
                  const med = String(r.CODMEDIDA || '').trim() || '—';
                  return `
                <div class="asistente-prod-price-row">
                  <span class="asistente-prod-med">${this.escapeHtml(med)}</span>
                  <span class="asistente-prod-exist" title="Existencia en esta medida (saldo / equivale)">Exist. ${this.escapeHtml(this.formatExistencia(r.EXISTENCIA))}</span>
                  <span class="asistente-prod-precio">${this.escapeHtml(this.formatMoney(r.PRECIO))}</span>
                </div>`;
                })
                .join('')}
            </div>
          </div>`
          )
          .join('')}
      </div>`;
  },

  bindAsistenteProductos(popup) {
    if (!popup) return;
    const qEl = popup.querySelector('#asist-prod-q');
    const btn = popup.querySelector('#asist-prod-buscar');
    const resultEl = popup.querySelector('#asist-prod-result');
    let timer = null;

    const runBuscar = async () => {
      const q = String(qEl?.value || '').trim();
      if (!q) {
        if (resultEl) {
          resultEl.className = 'asistente-prod-result small text-muted';
          resultEl.textContent = 'Escriba y pulse Buscar o Enter (máx. 10 productos).';
        }
        return;
      }
      if (typeof F === 'undefined' || !F.getEmpNit()) {
        if (resultEl) {
          resultEl.className = 'asistente-prod-result small text-danger';
          resultEl.textContent = 'No hay empresa activa.';
        }
        return;
      }
      if (resultEl) {
        resultEl.className = 'asistente-prod-result small text-muted';
        resultEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Buscando…';
      }
      if (btn) btn.disabled = true;
      try {
        const url =
          `/api/asistente/productos?empnit=${encodeURIComponent(F.getEmpNit())}` +
          `&q=${encodeURIComponent(q)}&_=${Date.now()}`;
        const data = await F.fetchJson(url, { cache: 'no-store' });
        const rows = data.rows || [];
        if (resultEl) {
          resultEl.className = 'asistente-prod-result small';
          resultEl.innerHTML = this.renderAsistenteProductosHtml(rows);
        }
      } catch (err) {
        if (resultEl) {
          resultEl.className = 'asistente-prod-result small text-danger';
          resultEl.textContent = err.message || 'No se pudo buscar productos';
        }
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    btn?.addEventListener('click', () => {
      runBuscar().catch(() => {});
    });
    qEl?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(timer);
      runBuscar().catch(() => {});
    });
    qEl?.addEventListener('input', () => {
      clearTimeout(timer);
      const q = String(qEl.value || '').trim();
      if (!q) {
        if (resultEl) {
          resultEl.className = 'asistente-prod-result small text-muted';
          resultEl.textContent = 'Escriba y pulse Buscar o Enter (máx. 10 productos).';
        }
        return;
      }
      timer = setTimeout(() => {
        runBuscar().catch(() => {});
      }, 400);
    });
  },

  openConfig() {
    const candidates = this.authorizedCandidates();
    if (!candidates.length) {
      if (typeof F !== 'undefined') {
        F.toast('No hay opciones de menú disponibles para favoritos', 'warning');
      }
      return;
    }

    const selected = new Set(this.loadKeys().filter((k) => this.canAccess(k)));
    const rows = candidates
      .map((c) => {
        const checked = selected.has(c.key) ? ' checked' : '';
        return `<label class="favoritos-config-row">
          <input type="checkbox" class="form-check-input favoritos-config-check" value="${this.escapeHtml(c.key)}"${checked}>
          <span class="favoritos-config-icon">${c.iconHtml}</span>
          <span class="favoritos-config-label">${this.escapeHtml(c.label)}</span>
        </label>`;
      })
      .join('');

    const modalOpts =
      typeof CatalogosUI !== 'undefined'
        ? CatalogosUI.modalBase()
        : { customClass: { popup: 'modal-catalogo' } };

    Swal.fire({
      ...modalOpts,
      title: 'Configurar Favoritos',
      width: 'min(28rem, 96vw)',
      html: `
        <p class="small text-muted text-start mb-2">
          Elija las vistas autorizadas que desea ver en <strong>Favoritos</strong>. Se guardan solo en este dispositivo.
        </p>
        <div class="favoritos-config-list text-start">${rows}</div>
      `,
      showCancelButton: true,
      confirmButtonText:
        typeof CatalogosUI !== 'undefined'
          ? CatalogosUI.guardarButtonHtml('Guardar')
          : 'Guardar',
      cancelButtonText:
        typeof CatalogosUI !== 'undefined'
          ? CatalogosUI.cancelButtonHtml('Cancelar')
          : 'Cancelar',
      focusConfirm: false,
      preConfirm: () => {
        const checks = Swal.getPopup()?.querySelectorAll('.favoritos-config-check:checked') || [];
        return Array.from(checks).map((el) => el.value);
      },
    }).then((result) => {
      if (!result.isConfirmed) return;
      this.saveKeys(result.value || []);
      this.render();
      if (typeof F !== 'undefined') F.toast('Favoritos actualizados', 'success');
    });
  },

  bind() {
    if (this._bound) return;
    this._bound = true;
    document.getElementById('sidebar')?.addEventListener('click', (e) => {
      const cfg = e.target.closest('[data-favoritos-config], #btn-favoritos-config');
      if (!cfg) return;
      e.preventDefault();
      e.stopPropagation();
      this.openConfig();
    });
    FavoritosFab.init();
  },
};

/**
 * Botón flotante arrastrable (Asistente) → abre el modal de menú Favoritos.
 * Posición persistida en localStorage por dispositivo.
 */
const FavoritosFab = {
  POS_KEY: 'onneb-favoritos-fab-pos',
  SIZE: 56,
  WIDTH_FALLBACK: 56,
  MARGIN: 8,
  BOTTOM_DEFAULT: 20, // ~1.25rem
  DRAG_THRESHOLD: 6,

  el() {
    return document.getElementById('btn-favoritos-fab');
  },

  measure() {
    const btn = this.el();
    if (!btn) return { w: this.WIDTH_FALLBACK, h: this.SIZE };
    const rect = btn.getBoundingClientRect();
    return {
      w: Math.max(rect.width || this.WIDTH_FALLBACK, 1),
      h: Math.max(rect.height || this.SIZE, 1),
    };
  },

  loadPos() {
    try {
      const raw = localStorage.getItem(this.POS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      const left = Number(p?.left);
      const top = Number(p?.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      return { left, top };
    } catch {
      return null;
    }
  },

  savePos(left, top) {
    try {
      localStorage.setItem(this.POS_KEY, JSON.stringify({ left, top }));
    } catch {
      /* ignore quota */
    }
  },

  defaultPos() {
    const w = window.innerWidth || 360;
    const h = window.innerHeight || 640;
    const size = this.measure();
    return {
      left: Math.max(this.MARGIN, (w - size.w) / 2),
      top: Math.max(this.MARGIN, h - this.BOTTOM_DEFAULT - size.h),
    };
  },

  clamp(left, top) {
    const size = this.measure();
    const maxL = Math.max(this.MARGIN, (window.innerWidth || 0) - size.w - this.MARGIN);
    const maxT = Math.max(this.MARGIN, (window.innerHeight || 0) - size.h - this.MARGIN);
    return {
      left: Math.min(Math.max(this.MARGIN, left), maxL),
      top: Math.min(Math.max(this.MARGIN, top), maxT),
    };
  },

  applyPos(left, top) {
    const btn = this.el();
    if (!btn) return;
    const p = this.clamp(left, top);
    btn.style.left = `${p.left}px`;
    btn.style.top = `${p.top}px`;
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    return p;
  },

  restoreOrDefault() {
    const saved = this.loadPos();
    const pos = saved || this.defaultPos();
    this.applyPos(pos.left, pos.top);
  },

  setVisible(visible) {
    const btn = this.el();
    if (!btn) return;
    btn.classList.toggle('is-visible', Boolean(visible));
    btn.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (visible) this.restoreOrDefault();
  },

  init() {
    if (this._bound) return;
    const btn = this.el();
    if (!btn) return;
    this._bound = true;

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let pointerId = null;

    const onPointerDown = (e) => {
      if (e.button != null && e.button !== 0) return;
      const rect = btn.getBoundingClientRect();
      dragging = true;
      moved = false;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      btn.classList.add('is-dragging');
      try {
        btn.setPointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) >= this.DRAG_THRESHOLD) moved = true;
      if (!moved) return;
      this.applyPos(originLeft + dx, originTop + dy);
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      btn.classList.remove('is-dragging');
      try {
        if (pointerId != null) btn.releasePointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      pointerId = null;
      if (moved) {
        const rect = btn.getBoundingClientRect();
        const p = this.applyPos(rect.left, rect.top);
        this.savePos(p.left, p.top);
        return;
      }
      if (typeof MenuFavoritos !== 'undefined') MenuFavoritos.openMenu();
    };

    btn.addEventListener('pointerdown', onPointerDown);
    btn.addEventListener('pointermove', onPointerMove);
    btn.addEventListener('pointerup', onPointerUp);
    btn.addEventListener('pointercancel', onPointerUp);
    btn.addEventListener('click', (e) => {
      // Evita click nativo tras drag; el openMenu se dispara en pointerup si no hubo drag.
      e.preventDefault();
      e.stopPropagation();
    });

    window.addEventListener('resize', () => {
      if (!btn.classList.contains('is-visible')) return;
      const rect = btn.getBoundingClientRect();
      const p = this.applyPos(rect.left, rect.top);
      this.savePos(p.left, p.top);
    });

    this.restoreOrDefault();
  },
};
