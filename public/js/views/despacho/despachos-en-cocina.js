/**
 * Despacho → Despachos en Cocina.
 * Líneas CRS con SOLICITADO=1; despachar → SOLICITADO=2.
 * Filtro por Ubicación (CLASIFICACIONTRES).
 * Socket `cocina:nuevo`: toast no bloqueante + filas nuevas sin recargar.
 */
const DespachosEnCocinaView = {
  _container: null,
  _rows: [],
  _ubicaciones: [],
  _filterUbicacion: '',
  _busyId: null,
  _socketBound: false,

  escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  formatQty(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return Number.isInteger(n) ? String(n) : n.toLocaleString('es-GT', { maximumFractionDigits: 3 });
  },

  formatObs(value) {
    const s = String(value || '').trim();
    if (!s || s.toUpperCase() === 'SN') return '—';
    return s;
  },

  apiUrl(path = '', extra = {}) {
    const params = new URLSearchParams({
      empnit: F.getEmpNit() || '',
      _: String(Date.now()),
      ...extra,
    });
    const segment = path ? (path.startsWith('/') ? path : `/${path}`) : '';
    return `/api/despachos-en-cocina${segment}?${params}`;
  },

  isViewActive() {
    return (
      typeof F !== 'undefined' &&
      typeof F.getActiveMenuKey === 'function' &&
      F.getActiveMenuKey() === 'despachos-en-cocina' &&
      !!this._container
    );
  },

  bindSocket() {
    if (this._socketBound || typeof io === 'undefined') return;
    const socket =
      (typeof F !== 'undefined' && typeof F.getSocket === 'function' && F.getSocket()) ||
      window.OnnebSocket ||
      null;
    if (!socket) return;
    socket.on('cocina:nuevo', (data) => this.onCocinaNuevo(data));
    this._socketBound = true;
  },

  rowMatchesFilter(row) {
    if (this._filterUbicacion === '' || this._filterUbicacion == null) return true;
    return String(row?.CODCLATRES ?? '') === String(this._filterUbicacion);
  },

  onCocinaNuevo(data) {
    if (!this.isViewActive()) return;
    const userEmp = typeof F !== 'undefined' ? F.getEmpNit() : '';
    if (data?.empnit && userEmp && String(data.empnit) !== String(userEmp)) return;

    const msg = String(data?.mensaje || '').trim() || 'Nuevos productos en cocina';
    this.showLiveNotice(msg);

    const incoming = Array.isArray(data?.rows) ? data.rows : [];
    if (!incoming.length) return;

    const existing = new Set(this._rows.map((r) => String(r.ID)));
    const toAdd = incoming.filter(
      (r) => r && r.ID != null && !existing.has(String(r.ID)) && this.rowMatchesFilter(r)
    );
    if (!toAdd.length) return;

    this._rows = toAdd.concat(this._rows);
    this.updateTableView();
  },

  /** Aviso no bloqueante (no usa Swal: no cierra el confirm de Despachar). */
  showLiveNotice(message) {
    const wrap = this._container?.querySelector('.despachos-cocina-wrap');
    if (!wrap) {
      if (typeof F !== 'undefined') F.toast(message, 'info');
      return;
    }
    let el = wrap.querySelector('#dec-live-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dec-live-notice';
      el.setAttribute('role', 'status');
      el.className = 'alert alert-info py-2 px-3 mb-3 dec-live-notice';
      wrap.insertBefore(el, wrap.firstChild);
    }
    el.textContent = message;
    el.style.display = '';
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => {
      if (el) el.style.display = 'none';
    }, 4500);
  },

  ubicacionOptionsHtml() {
    const opts = [{ value: '', label: 'TODAS' }].concat(
      (this._ubicaciones || []).map((u) => ({
        value: String(u.CODCLATRES),
        label: String(u.DESCLATRES || u.CODCLATRES),
      }))
    );
    return opts
      .map(
        (o) =>
          `<option value="${this.escapeHtml(o.value)}"${String(this._filterUbicacion) === String(o.value) ? ' selected' : ''}>${this.escapeHtml(o.label)}</option>`
      )
      .join('');
  },

  async fetchData() {
    const extra = {};
    if (this._filterUbicacion !== '' && this._filterUbicacion != null) {
      extra.codclatres = String(this._filterUbicacion);
    }
    const data = await F.fetchJson(this.apiUrl('', extra));
    this._rows = data.rows || [];
    this._ubicaciones = data.ubicaciones || this._ubicaciones || [];
  },

  renderTableBodyHtml() {
    if (!this._rows.length) {
      return `<tr><td colspan="7" class="text-center text-muted py-4">Sin productos pendientes de despacho</td></tr>`;
    }
    return this._rows
      .map((row) => {
        const id = row.ID;
        const busy = this._busyId != null && String(this._busyId) === String(id);
        return `<tr data-id="${this.escapeHtml(id)}">
          <td class="small">${this.escapeHtml(row.MESERO || '—')}</td>
          <td class="small fw-semibold">${this.escapeHtml(row.MESA || '—')}</td>
          <td>
            <div class="fw-semibold">${this.escapeHtml(row.DESPROD || '—')}</div>
            <div class="small text-muted">${this.escapeHtml(row.CODPROD || '')}</div>
          </td>
          <td class="small text-center">${this.escapeHtml(row.CODMEDIDA || '—')}</td>
          <td class="text-end fw-semibold">${this.escapeHtml(this.formatQty(row.CANTIDAD))}</td>
          <td class="small">${this.escapeHtml(this.formatObs(row.OBS))}</td>
          <td class="text-end text-nowrap">
            <button type="button" class="btn btn-sm btn-success dec-despachar"
              data-id="${this.escapeHtml(id)}" title="Marcar como despachado"${busy ? ' disabled' : ''}>
              <i class="fa-solid fa-check me-1" aria-hidden="true"></i>Despachar
            </button>
          </td>
        </tr>`;
      })
      .join('');
  },

  renderHtml() {
    return `
      <div class="catalogo-empresa-view w-100 despachos-cocina-wrap">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
          <div>
            <h5 class="mb-0">Despachos en Cocina</h5>
            <p class="small text-muted mb-0">Productos enviados a cocina (comandas) pendientes de despacho</p>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-dec-refresh">
            <i class="fa-solid fa-rotate-right me-1"></i>Actualizar
          </button>
        </div>
        <div class="card shadow-sm mb-3">
          <div class="card-body py-2">
            <div class="d-flex flex-wrap align-items-end gap-3">
              <div>
                <label for="dec-filter-ubicacion" class="form-label small mb-1">Ubicación</label>
                <select class="form-select form-select-sm" id="dec-filter-ubicacion" style="min-width: 14rem">
                  ${this.ubicacionOptionsHtml()}
                </select>
              </div>
              <div class="small text-muted pb-1" id="dec-count">${this._rows.length} pendiente(s)</div>
            </div>
          </div>
        </div>
        <div class="card shadow-sm">
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0">
              <thead class="table-light">
                <tr>
                  <th>Mesero</th>
                  <th>Mesa</th>
                  <th>Producto</th>
                  <th class="text-center">Medida</th>
                  <th class="text-end">Cantidad</th>
                  <th>Obs.</th>
                  <th class="text-end">Acciones</th>
                </tr>
              </thead>
              <tbody id="dec-tbody">${this.renderTableBodyHtml()}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  },

  updateTableView() {
    const tbody = this._container?.querySelector('#dec-tbody');
    const count = this._container?.querySelector('#dec-count');
    if (tbody) tbody.innerHTML = this.renderTableBodyHtml();
    if (count) count.textContent = `${this._rows.length} pendiente(s)`;
  },

  async reload() {
    try {
      await this.fetchData();
      this.updateTableView();
      const sel = this._container?.querySelector('#dec-filter-ubicacion');
      if (sel && sel.innerHTML !== this.ubicacionOptionsHtml()) {
        const prev = sel.value;
        sel.innerHTML = this.ubicacionOptionsHtml();
        sel.value = prev;
      }
    } catch (err) {
      F.toast(err.message || 'No se pudo cargar', 'error');
    }
  },

  async onDespachar(id) {
    const row = this._rows.find((r) => String(r.ID) === String(id));
    const label = row?.DESPROD || `línea #${id}`;
    const ok = await CatalogosUI.fireConfirm({
      title: '¿Despachar producto?',
      html: `<p class="mb-0">¿Confirma despachar <strong>${this.escapeHtml(label)}</strong>${
        row?.MESA ? ` · Mesa <strong>${this.escapeHtml(row.MESA)}</strong>` : ''
      }?</p>`,
      icon: 'question',
      confirmText: 'Sí, despachar',
      confirmClass: 'btn-catalogo-guardar',
    });
    if (!ok) return;

    this._busyId = id;
    this.updateTableView();
    try {
      await F.fetchJson(this.apiUrl(`/lineas/${encodeURIComponent(id)}/despachar`), {
        method: 'POST',
      });
      this._rows = this._rows.filter((r) => String(r.ID) !== String(id));
      F.toast('Producto despachado', 'success');
    } catch (err) {
      F.toast(err.message || 'No se pudo despachar', 'error');
      await this.reload();
    } finally {
      this._busyId = null;
      this.updateTableView();
    }
  },

  bindEvents() {
    this._container?.querySelector('#btn-dec-refresh')?.addEventListener('click', () => {
      this.reload();
    });
    this._container?.querySelector('#dec-filter-ubicacion')?.addEventListener('change', (e) => {
      this._filterUbicacion = e.target.value;
      this.reload();
    });
    this._container?.querySelector('#dec-tbody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.dec-despachar');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      if (id != null) this.onDespachar(id);
    });
  },

  async load(container) {
    this._container = container;
    this.bindSocket();
    container.innerHTML = '<p class="text-muted p-3">Cargando despachos en cocina…</p>';
    try {
      await this.fetchData();
      container.innerHTML = this.renderHtml();
      this.bindEvents();
    } catch (err) {
      container.innerHTML = `<div class="alert alert-danger m-3">${this.escapeHtml(err.message || 'Error')}</div>`;
    }
  },
};
