/**
 * Inventarios → Lista Precios
 * Listado de PRECIOS × PRODUCTOS con búsqueda y export Excel (todos, sin filtro).
 * COSTO solo visible para Administrador y Contabilidad.
 */
const ListaPreciosView = {
  _container: null,
  _rows: [],
  _totalCount: 0,
  _listTruncated: false,
  _filterQuery: '',
  _loading: false,
  _searchTimer: null,

  escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Q 0.00';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return n.toLocaleString('es-GT', { maximumFractionDigits: 4 });
  },

  /** COSTO: Administrador o Contabilidad. */
  showCosto() {
    if (typeof F !== 'undefined' && typeof F.canViewCosto === 'function') {
      return F.canViewCosto();
    }
    if (typeof TipoEmpleadoAccess !== 'undefined' && typeof TipoEmpleadoAccess.canViewCosto === 'function') {
      return TipoEmpleadoAccess.canViewCosto();
    }
    return false;
  },

  colCount() {
    return this.showCosto() ? 13 : 11;
  },

  apiUrl(path = '', params = {}) {
    const empNit = F.getEmpNit();
    if (!empNit) throw new Error('No hay empresa activa. Cierre sesión e ingrese de nuevo.');
    const qs = new URLSearchParams({ empnit: empNit, ...params });
    return `/api/lista-precios${path}?${qs.toString()}`;
  },

  listApiUrl() {
    const params = { _: String(Date.now()) };
    const q = String(this._filterQuery || '').trim();
    if (q) params.q = q;
    if (this.showCosto()) params.includeCosto = '1';
    return this.apiUrl('', params);
  },

  badgeText() {
    const shown = this._rows.length;
    const total = this._totalCount;
    const countLabel =
      this._listTruncated && shown < total ? `Mostrando ${shown} de ${total}` : `${total}`;
    return `<i class="fa-solid fa-tags me-1"></i>${countLabel} precio(s)`;
  },

  async load(container) {
    this._container = container;
    container.className = 'main-content flex-grow-1 d-flex p-3 align-items-stretch justify-content-start';
    container.innerHTML = `
      <div class="lista-precios-wrap w-100">
        <div class="text-muted small py-4 text-center">
          <i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando lista de precios…
        </div>
      </div>`;
    try {
      await this.fetchList();
      this.render();
    } catch (err) {
      container.innerHTML = `
        <div class="lista-precios-wrap w-100">
          <div class="alert alert-danger mb-0">${this.escapeHtml(err.message || 'Error')}</div>
        </div>`;
    }
  },

  async fetchList() {
    const data = await F.fetchJson(this.listApiUrl(), { cache: 'no-store' });
    this._rows = data.rows || [];
    this._totalCount = data.total ?? this._rows.length;
    this._listTruncated = Boolean(data.truncated);
    return data;
  },

  async reloadList() {
    if (this._loading) return;
    this._loading = true;
    const tbody = this._container?.querySelector('#lp-tbody');
    const badge = this._container?.querySelector('#lp-count');
    const cols = this.colCount();
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="${cols}" class="text-center text-muted py-4">
        <i class="fa-solid fa-spinner fa-spin me-2"></i>Buscando…
      </td></tr>`;
    }
    try {
      await this.fetchList();
      if (tbody) tbody.innerHTML = this.renderRows();
      if (badge) badge.innerHTML = this.badgeText();
    } catch (err) {
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="${cols}" class="text-center text-danger py-4">${this.escapeHtml(err.message || 'Error')}</td></tr>`;
      }
      F.toast(err.message || 'Error al cargar', 'error');
    } finally {
      this._loading = false;
    }
  },

  renderRows() {
    const cols = this.colCount();
    const showCosto = this.showCosto();
    if (!this._rows.length) {
      const msg = this._filterQuery.trim()
        ? 'Ningún precio coincide con la búsqueda'
        : 'Sin precios registrados';
      return `<tr><td colspan="${cols}" class="text-center text-muted py-4">${msg}</td></tr>`;
    }
    return this._rows
      .map((row) => {
        const costoCell = showCosto
          ? `<td class="text-end text-nowrap">${this.escapeHtml(this.formatMoney(row.COSTO_PROMEDIO))}</td>
          <td class="text-end text-nowrap">${this.escapeHtml(this.formatMoney(row.COSTO))}</td>`
          : '';
        return `
      <tr>
        <td class="font-monospace small">${this.escapeHtml(row.CODPROD ?? '')}</td>
        <td>${this.escapeHtml(row.DESPROD ?? '')}</td>
        <td class="text-muted small">${this.escapeHtml(row.DESPROD2 ?? '') || '—'}</td>
        <td>${this.escapeHtml(row.DESMARCA ?? '') || '—'}</td>
        <td>${this.escapeHtml(row.CODMEDIDA ?? '')}</td>
        <td class="text-end">${this.escapeHtml(this.formatNumber(row.EQUIVALE))}</td>
        ${costoCell}
        <td class="text-end text-nowrap">${this.escapeHtml(this.formatMoney(row.PRECIO))}</td>
        <td class="text-end text-nowrap">${this.escapeHtml(this.formatMoney(row.MAYOREOC))}</td>
        <td class="text-end text-nowrap">${this.escapeHtml(this.formatMoney(row.MAYOREOB))}</td>
        <td class="text-end text-nowrap">${this.escapeHtml(this.formatMoney(row.MAYOREOA))}</td>
        <td class="text-end text-nowrap">${this.escapeHtml(this.formatNumber(row.EXISTENCIA))}</td>
      </tr>`;
      })
      .join('');
  },

  render() {
    const wrap = this._container?.querySelector('.lista-precios-wrap') || this._container;
    if (!wrap) return;
    const showCosto = this.showCosto();
    const costoHeader = showCosto
      ? '<th scope="col" class="text-end">COSTO_PROM.</th><th scope="col" class="text-end">COSTO</th>'
      : '';
    wrap.innerHTML = `
      <div class="w-100">
        <div class="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-3">
          <div>
            <h2 class="h5 mb-1">Lista Precios</h2>
            <p class="text-muted small mb-0">
              Precios por producto y medida. La exportación incluye todos los registros (sin filtro).
            </p>
          </div>
          <span class="badge text-bg-light border" id="lp-count">${this.badgeText()}</span>
        </div>

        <div class="card shadow-sm">
          <div class="card-body">
            <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
              <div class="input-group input-group-sm" style="max-width: 28rem">
                <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
                <input type="search" class="form-control" id="lp-search"
                  placeholder="Código, producto, marca o medida…"
                  value="${this.escapeHtml(this._filterQuery)}" autocomplete="off">
                <button type="button" class="btn btn-outline-secondary" id="lp-search-clear" title="Limpiar">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
              <button type="button" class="btn btn-sm btn-outline-success" id="lp-export">
                <i class="fa-solid fa-file-excel me-1"></i>Exportar Excel
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary" id="lp-refresh">
                <i class="fa-solid fa-rotate me-1"></i>Actualizar
              </button>
              <span class="small text-muted">Sin búsqueda: 100 registros; escriba para filtrar.</span>
            </div>

            <div class="table-responsive">
              <table class="table table-sm table-hover table-striped align-middle mb-0">
                <thead class="table-light">
                  <tr>
                    <th scope="col">CODIGO</th>
                    <th scope="col">PRODUCTO</th>
                    <th scope="col">DESCRIPCION</th>
                    <th scope="col">MARCA</th>
                    <th scope="col">MEDIDA</th>
                    <th scope="col" class="text-end">EQUIVALE</th>
                    ${costoHeader}
                    <th scope="col" class="text-end">PRECIO</th>
                    <th scope="col" class="text-end">MAYOREOC</th>
                    <th scope="col" class="text-end">MAYOREOB</th>
                    <th scope="col" class="text-end">MAYOREOA</th>
                    <th scope="col" class="text-end">EXISTENCIA</th>
                  </tr>
                </thead>
                <tbody id="lp-tbody">${this.renderRows()}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>`;
    this.bindEvents();
  },

  bindEvents() {
    const search = this._container?.querySelector('#lp-search');
    search?.addEventListener('input', () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this._filterQuery = String(search.value || '').trim();
        this.reloadList();
      }, 320);
    });
    this._container?.querySelector('#lp-search-clear')?.addEventListener('click', () => {
      clearTimeout(this._searchTimer);
      this._filterQuery = '';
      if (search) search.value = '';
      this.reloadList();
    });
    this._container?.querySelector('#lp-refresh')?.addEventListener('click', () => {
      this.reloadList();
    });
    this._container?.querySelector('#lp-export')?.addEventListener('click', () => {
      this.onExportExcel().catch((err) => F.alert('Error', err.message || 'Error al exportar', 'error'));
    });
  },

  async onExportExcel() {
    const empNit = F.getEmpNit();
    if (!empNit) return;
    const btn = this._container?.querySelector('#lp-export');
    if (btn) btn.disabled = true;
    try {
      const params = { _: String(Date.now()) };
      if (this.showCosto()) params.includeCosto = '1';
      const url = this.apiUrl('/export', params);
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText || 'Error al exportar');
      }
      const blob = await res.blob();
      const dispo = res.headers.get('Content-Disposition') || '';
      const match = dispo.match(/filename="?([^"]+)"?/i);
      const filename = match ? match[1] : `lista_precios_${empNit}.xlsx`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      F.toast('Excel exportado (todos los registros)', 'success');
    } finally {
      if (btn) btn.disabled = false;
    }
  },
};
