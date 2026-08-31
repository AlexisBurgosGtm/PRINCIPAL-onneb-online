/**
 * Vista Inventario — reporte de stock (INVSALDO + PRODUCTOS + MARCAS).
 */
const InventarioView = {
  _container: null,
  _rows: [],
  _totalCount: 0,
  _listTruncated: false,
  _filterQuery: '',
  _filterMarca: '',
  _filterHabilitado: '',
  _marcas: [],
  _totals: { SALDO: 0, TOTALCOSTO: 0, TOTALCOSTO_PROMEDIO: 0 },
  _loading: false,
  _exporting: false,
  _printing: false,

  tableColumns: [
    { key: 'CODPROD', label: 'Código' },
    { key: 'DESPROD', label: 'Descripción', cellClass: 'inventario-col-desc' },
    { key: 'DESMARCA', label: 'Marca' },
    { key: 'TIPOPROD', label: 'Tipo' },
    { key: 'SALDO', label: 'Saldo', type: 'qty' },
    { key: 'EXISTENCIA', label: 'Existencia', type: 'qty' },
    { key: 'COSTO_PROMEDIO', label: 'Costo prom.', type: 'money', ventasHidden: true },
    { key: 'COSTO', label: 'Costo', type: 'money', ventasHidden: true },
    { key: 'TOTALCOSTO', label: 'Total costo', type: 'money', ventasHidden: true },
    { key: 'TOTALCOSTO_PROMEDIO', label: 'Total costo prom.', type: 'money', ventasHidden: true },
    { key: 'HABILITADO', label: 'Habilitado' },
  ],

  isUsuarioVentas() {
    if (typeof TipoEmpleadoAccess === 'undefined') return false;
    const tipo = TipoEmpleadoAccess.getCodTipo();
    return Number(tipo) === TipoEmpleadoAccess.TIPO_VENDEDOR;
  },

  visibleTableColumns() {
    if (!this.isUsuarioVentas()) return this.tableColumns;
    return this.tableColumns.filter((c) => !c.ventasHidden);
  },

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
    if (Number.isNaN(n)) return '—';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  formatQty(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '—';
    return n.toLocaleString('es-GT', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  },

  cellValue(row, key) {
    if (!row) return null;
    const k = String(key);
    let val = row[k];
    if (val === undefined) val = row[k.toUpperCase()];
    if (val === undefined) val = row[k.toLowerCase()];
    return val;
  },

  formatCell(value, col) {
    if (value === null || value === undefined || value === '') return '—';
    if (col?.type === 'money') {
      return `<span class="inventario-money">${this.escapeHtml(this.formatMoney(value))}</span>`;
    }
    if (col?.type === 'qty') {
      return `<span class="inventario-qty">${this.escapeHtml(this.formatQty(value))}</span>`;
    }
    return this.escapeHtml(value);
  },

  productoLabelFromRow(row) {
    const codprod = String(this.cellValue(row, 'CODPROD') || '').trim();
    const desc = String(this.cellValue(row, 'DESPROD') || '').trim();
    return desc ? `${codprod} — ${desc}` : codprod;
  },

  renderTableBodyHtml(rows) {
    const cols = this.visibleTableColumns();
    const colSpan = cols.length;
    if (!rows.length) {
      const msg = this._filterQuery.trim() || this._filterMarca || this._filterHabilitado
        ? 'Ningún producto coincide con los filtros'
        : 'Sin registros de inventario para esta empresa';
      return `<tr><td colspan="${colSpan}" class="text-center text-muted py-4">${msg}</td></tr>`;
    }
    return rows
      .map((row) => {
        const codprod = String(this.cellValue(row, 'CODPROD') || '').trim();
        const cells = cols
          .map((c) => {
            const align = c.type === 'money' || c.type === 'qty' ? ' text-end' : '';
            const extra = c.cellClass ? ` ${c.cellClass}` : '';
            const val = this.cellValue(row, c.key);
            return `<td class="${`${align}${extra}`.trim()}">${this.formatCell(val, c)}</td>`;
          })
          .join('');
        const attrs = codprod
          ? ` class="inventario-row-clickable" data-codprod="${this.escapeHtml(codprod)}" role="button" tabindex="0" title="Ver movimientos"`
          : '';
        return `<tr${attrs}>${cells}</tr>`;
      })
      .join('');
  },

  renderTableFooterHtml() {
    if (!this._rows.length) return '';
    const cols = this.visibleTableColumns();
    const lead = cols.findIndex((c) => c.key === 'SALDO');
    const leadSpan = lead > 0 ? lead : 4;
    const afterSaldo = cols.slice(lead + 1);
    const cellsAfter = afterSaldo
      .map((c) => {
        if (c.key === 'TOTALCOSTO') {
          return `<td class="text-end inventario-money">${this.escapeHtml(this.formatMoney(this._totals.TOTALCOSTO))}</td>`;
        }
        if (c.key === 'TOTALCOSTO_PROMEDIO') {
          return `<td class="text-end inventario-money">${this.escapeHtml(this.formatMoney(this._totals.TOTALCOSTO_PROMEDIO))}</td>`;
        }
        return '<td></td>';
      })
      .join('');
    return `
      <tr class="inventario-total-row table-light fw-semibold">
        <td colspan="${leadSpan}" class="text-end">Totales</td>
        <td class="text-end inventario-qty">${this.escapeHtml(this.formatQty(this._totals.SALDO))}</td>
        ${cellsAfter}
      </tr>
    `;
  },

  badgeText() {
    const empNombre = F.getEmpNitNombre();
    const extra = empNombre ? ` · ${empNombre}` : '';
    const shown = this._rows.length;
    const total = this._totalCount;
    let countLabel;
    if (this._listTruncated) {
      countLabel = shown < total ? `Mostrando ${shown} de ${total}` : `${shown}+`;
    } else {
      countLabel = `${total}`;
    }
    return `<i class="fa-solid fa-boxes-stacked me-1"></i>${countLabel} registro(s) de inventario${this.filterSummaryHtml()}${this.escapeHtml(extra)}`;
  },

  filterSummaryHtml() {
    const parts = [];
    if (this._filterMarca) {
      const marca = this._marcas.find((m) => String(m.CODMARCA) === String(this._filterMarca));
      parts.push(marca?.DESMARCA || `Marca ${this._filterMarca}`);
    }
    if (this._filterHabilitado) parts.push(`Habilitado: ${this._filterHabilitado}`);
    if (this._filterQuery.trim()) parts.push(`Búsqueda: ${this._filterQuery.trim()}`);
    if (!parts.length) return '';
    return ` · ${this.escapeHtml(parts.join(' · '))}`;
  },

  marcaLabel() {
    if (!this._filterMarca) return 'Todas las marcas';
    const marca = this._marcas.find((m) => String(m.CODMARCA) === String(this._filterMarca));
    return marca?.DESMARCA || `Marca ${this._filterMarca}`;
  },

  habilitadoLabel() {
    if (!this._filterHabilitado) return 'Todos';
    return this._filterHabilitado;
  },

  buildListParams(extra = {}) {
    const empNit = F.getEmpNit();
    if (!empNit) throw new Error('No hay empresa activa. Cierre sesión e ingrese de nuevo.');
    const params = new URLSearchParams({
      empnit: empNit,
      _: String(Date.now()),
      ...extra,
    });
    const q = this._filterQuery.trim();
    if (q) params.set('q', q);
    if (this._filterMarca) params.set('codmarca', this._filterMarca);
    if (this._filterHabilitado) params.set('habilitado', this._filterHabilitado);
    return params;
  },

  apiUrlLista() {
    let limit = '100';
    if (this._filterQuery.trim()) {
      limit = '500';
    } else if (this._filterMarca) {
      limit = '0';
    }
    const params = this.buildListParams({ limit });
    return `/api/inventario/saldo?${params.toString()}`;
  },

  exportUrl() {
    const params = this.buildListParams();
    return `/api/inventario/saldo/export?${params.toString()}`;
  },

  printFetchUrl() {
    const params = this.buildListParams({ limit: '2000' });
    return `/api/inventario/saldo?${params.toString()}`;
  },

  renderMarcaOptions() {
    const opts = (this._marcas || [])
      .map((m) => {
        const val = String(m.CODMARCA);
        const label = m.DESMARCA || val;
        return `<option value="${this.escapeHtml(val)}"${this._filterMarca === val ? ' selected' : ''}>${this.escapeHtml(label)}</option>`;
      })
      .join('');
    return `<option value=""${!this._filterMarca ? ' selected' : ''}>TODAS</option>${opts}`;
  },

  renderFiltersCard() {
    return `
      <div class="card inventario-filters-card shadow-sm mb-3">
        <div class="card-body">
          <div class="d-flex flex-wrap align-items-end gap-2 inventario-filters-row">
            <div class="inventario-filter-marca">
              <label for="inventario-filter-marca" class="form-label small mb-1">Marca</label>
              <select class="form-select form-select-sm" id="inventario-filter-marca">
                ${this.renderMarcaOptions()}
              </select>
            </div>
            <div class="inventario-filter-habilitado">
              <label for="inventario-filter-habilitado" class="form-label small mb-1">Habilitado</label>
              <select class="form-select form-select-sm" id="inventario-filter-habilitado">
                <option value=""${!this._filterHabilitado ? ' selected' : ''}>TODOS</option>
                <option value="SI"${this._filterHabilitado === 'SI' ? ' selected' : ''}>SI</option>
                <option value="NO"${this._filterHabilitado === 'NO' ? ' selected' : ''}>NO</option>
              </select>
            </div>
            <div class="inventario-filter-search flex-grow-1">
              <label for="inventario-search" class="form-label small mb-1">Buscar</label>
              <div class="input-group input-group-sm">
                <span class="input-group-text" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></span>
                <input type="search" class="form-control" id="inventario-search"
                  placeholder="Código o descripción de producto… (Enter)"
                  value="${this.escapeHtml(this._filterQuery)}" autocomplete="off" spellcheck="false">
                <button type="button" class="btn btn-outline-secondary" id="btn-inventario-search-clear"
                  title="Limpiar búsqueda" aria-label="Limpiar búsqueda">
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
              </div>
            </div>
            <div class="inventario-filter-export"${this.isUsuarioVentas() ? ' hidden' : ''}>
              <label class="form-label small mb-1 d-block inventario-export-label" aria-hidden="true">&nbsp;</label>
              <button type="button" class="btn btn-sm btn-outline-success" id="btn-inventario-export">
                <i class="fa-solid fa-file-excel me-1" aria-hidden="true"></i>Exportar (xlsx)
              </button>
            </div>
          </div>
          <div class="inventario-badge small text-muted mt-2" id="inventario-count">${this.badgeText()}</div>
        </div>
      </div>
    `;
  },

  renderTableCard() {
    const headers = this.visibleTableColumns()
      .map((c) => {
        const align = c.type === 'money' || c.type === 'qty' ? ' text-end' : '';
        const extra = c.cellClass ? ` ${c.cellClass}` : '';
        return `<th scope="col" class="${`${align}${extra}`.trim()}">${this.escapeHtml(c.label)}</th>`;
      })
      .join('');
    return `
      <div class="card inventario-table-card shadow-sm">
        <div class="table-responsive">
          <table class="table table-sm table-hover table-striped mb-0">
            <thead class="table-light sticky-top">
              <tr>${headers}</tr>
            </thead>
            <tbody id="inventario-tbody">${this.renderTableBodyHtml(this._rows)}</tbody>
            <tfoot id="inventario-tfoot">${this.renderTableFooterHtml()}</tfoot>
          </table>
        </div>
      </div>
    `;
  },

  render() {
    return `
      <div class="inventario-vista-wrap">
        ${this.renderFiltersCard()}
        ${this.renderTableCard()}
        <button type="button" class="btn-onneb-nuevo-fab inventario-fab-print" id="btn-inventario-print"
          aria-label="Imprimir inventario" title="Imprimir inventario">
          <i class="fa-solid fa-print" aria-hidden="true"></i>
        </button>
      </div>
    `;
  },

  syncFiltersFromUi() {
    const marcaEl = document.getElementById('inventario-filter-marca');
    const habilitadoEl = document.getElementById('inventario-filter-habilitado');
    if (marcaEl) this._filterMarca = marcaEl.value;
    if (habilitadoEl) this._filterHabilitado = habilitadoEl.value;
  },

  updateTableView() {
    const tbody = this._container?.querySelector('#inventario-tbody');
    const tfoot = this._container?.querySelector('#inventario-tfoot');
    const badge = this._container?.querySelector('#inventario-count');
    if (tbody) tbody.innerHTML = this.renderTableBodyHtml(this._rows);
    if (tfoot) tfoot.innerHTML = this.renderTableFooterHtml();
    if (badge) badge.innerHTML = this.badgeText();
  },

  async fetchData() {
    const data = await F.fetchJson(this.apiUrlLista(), { cache: 'no-store' });
    this._rows = data.rows || [];
    this._totalCount = data.total ?? this._rows.length;
    this._listTruncated = Boolean(data.truncated);
    this._totals = data.totals || { SALDO: 0, TOTALCOSTO: 0, TOTALCOSTO_PROMEDIO: 0 };
    return data;
  },

  async fetchMarcas() {
    const empNit = F.getEmpNit();
    if (!empNit) {
      this._marcas = [];
      return;
    }
    const params = new URLSearchParams({ empnit: empNit, _: String(Date.now()) });
    const data = await F.fetchJson(`/api/marcas?${params.toString()}`, { cache: 'no-store' });
    this._marcas = data.rows || [];
  },

  bindMarcaFilter() {
    const sel = document.getElementById('inventario-filter-marca');
    if (!sel) return;
    sel.addEventListener('change', () => {
      this._filterMarca = sel.value;
      this.reload();
    });
  },

  bindHabilitadoFilter() {
    const sel = document.getElementById('inventario-filter-habilitado');
    if (!sel) return;
    sel.addEventListener('change', () => {
      this._filterHabilitado = sel.value;
      this.reload();
    });
  },

  bindSearch() {
    const search = document.getElementById('inventario-search');
    const clearBtn = document.getElementById('btn-inventario-search-clear');
    if (!search) return;

    const applySearch = () => {
      this._filterQuery = search.value.trim();
      this.reload();
    };

    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applySearch();
      }
    });

    search.addEventListener('search', () => {
      if (!search.value.trim()) {
        this._filterQuery = '';
        this.reload();
      }
    });

    clearBtn?.addEventListener('click', () => {
      search.value = '';
      this._filterQuery = '';
      this.reload();
      search.focus();
    });
  },

  bindTableRows() {
    const tbody = this._container?.querySelector('#inventario-tbody');
    if (!tbody || tbody.dataset.rowClickBound === '1') return;
    tbody.dataset.rowClickBound = '1';

    const openMovimientos = async (tr) => {
      const codprod = tr.getAttribute('data-codprod');
      if (!codprod || typeof ProductosView?.showReporteMovimientos !== 'function') return;
      const row = this._rows.find((r) => String(this.cellValue(r, 'CODPROD')).trim() === codprod);
      const label = row ? this.productoLabelFromRow(row) : codprod;
      try {
        await ProductosView.showReporteMovimientos(codprod, { label });
      } catch (err) {
        F.toast(err.message || 'Error al cargar movimientos', 'error');
      }
    };

    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr.inventario-row-clickable');
      if (!tr || !tbody.contains(tr)) return;
      openMovimientos(tr).catch(() => {});
    });

    tbody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr.inventario-row-clickable');
      if (!tr || !tbody.contains(tr)) return;
      e.preventDefault();
      openMovimientos(tr).catch(() => {});
    });
  },

  bindEvents() {
    this.bindMarcaFilter();
    this.bindHabilitadoFilter();
    this.bindSearch();
    this.bindTableRows();
    document.getElementById('btn-inventario-export')?.addEventListener('click', () => {
      this.onExportExcel();
    });
    document.getElementById('btn-inventario-print')?.addEventListener('click', () => {
      this.onPrint();
    });
  },

  async onExportExcel() {
    if (this.isUsuarioVentas()) {
      F.toast('No tiene permiso para exportar inventario', 'warning');
      return;
    }
    if (this._exporting) return;
    const empNit = F.getEmpNit();
    if (!empNit) {
      F.toast('No hay empresa activa en la sesión', 'warning');
      return;
    }
    this.syncFiltersFromUi();
    const btn = document.getElementById('btn-inventario-export');
    this._exporting = true;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(this.exportUrl(), { cache: 'no-store' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
      }
      const blob = await res.blob();
      const dispo = res.headers.get('Content-Disposition') || '';
      const match = dispo.match(/filename="?([^"]+)"?/i);
      const filename = match ? match[1] : `inventario_${empNit}.xlsx`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      F.toast('Excel exportado', 'success');
    } catch (err) {
      F.alert('Error', err.message, 'error');
    } finally {
      this._exporting = false;
      if (btn) btn.disabled = false;
    }
  },

  printCellText(value, col) {
    if (value === null || value === undefined || value === '') return '—';
    if (col?.type === 'money') return this.formatMoney(value);
    if (col?.type === 'qty') return this.formatQty(value);
    return String(value);
  },

  buildPrintHtml(rows, totals, truncated) {
    const now = new Date();
    const fecha = now.toLocaleString('es-GT');
    const cols = this.visibleTableColumns();
    const headers = cols
      .map((c) => {
        const align = c.type === 'money' || c.type === 'qty' ? ' class="text-end"' : '';
        return `<th${align}>${PrintReport.escapeHtml(c.label)}</th>`;
      })
      .join('');
    const body = rows.length
      ? rows
          .map((row) => {
            const cells = cols
              .map((c) => {
                const align = c.type === 'money' || c.type === 'qty' ? ' class="text-end"' : '';
                const val = this.cellValue(row, c.key);
                return `<td${align}>${PrintReport.escapeHtml(this.printCellText(val, c))}</td>`;
              })
              .join('');
            return `<tr>${cells}</tr>`;
          })
          .join('')
      : `<tr><td colspan="${cols.length}" class="text-center">Sin registros</td></tr>`;
    const lead = cols.findIndex((c) => c.key === 'SALDO');
    const leadSpan = lead > 0 ? lead : 4;
    const afterSaldo = cols.slice(lead + 1);
    const cellsAfter = afterSaldo
      .map((c) => {
        if (c.key === 'TOTALCOSTO') {
          return `<td class="text-end"><strong>${PrintReport.escapeHtml(this.formatMoney(totals.TOTALCOSTO))}</strong></td>`;
        }
        if (c.key === 'TOTALCOSTO_PROMEDIO') {
          return `<td class="text-end"><strong>${PrintReport.escapeHtml(this.formatMoney(totals.TOTALCOSTO_PROMEDIO))}</strong></td>`;
        }
        return '<td></td>';
      })
      .join('');
    const footer = rows.length
      ? `<tr class="totals"><td colspan="${leadSpan}" class="text-end"><strong>Totales</strong></td>
          <td class="text-end"><strong>${PrintReport.escapeHtml(this.formatQty(totals.SALDO))}</strong></td>
          ${cellsAfter}</tr>`
      : '';
    const truncNote = truncated
      ? '<p class="warn"><em>Nota: el listado impreso está limitado a 2000 registros.</em></p>'
      : '';
    return PrintReport.wrapDocument({
      title: 'Inventario',
      bodyHtml: `
        ${PrintReport.reportHeaderHtml({
          title: 'Reporte de inventario',
          subtitleHtml: `
            <p><strong>Fecha:</strong> ${PrintReport.escapeHtml(fecha)}</p>
            <p><strong>Marca:</strong> ${PrintReport.escapeHtml(this.marcaLabel())}</p>
            <p><strong>Habilitado:</strong> ${PrintReport.escapeHtml(this.habilitadoLabel())}</p>
            ${this._filterQuery.trim() ? `<p><strong>Búsqueda:</strong> ${PrintReport.escapeHtml(this._filterQuery.trim())}</p>` : ''}
            <p><strong>Registros:</strong> ${rows.length}</p>
            ${truncNote}
          `,
        })}
        <table>
          <thead><tr>${headers}</tr></thead>
          <tbody>${body}</tbody>
          ${footer ? `<tfoot>${footer}</tfoot>` : ''}
        </table>
      `,
    });
  },

  async onPrint() {
    if (this._printing) return;
    if (!F.getEmpNit()) {
      F.toast('No hay empresa activa en la sesión', 'warning');
      return;
    }
    this.syncFiltersFromUi();
    const btn = document.getElementById('btn-inventario-print');
    this._printing = true;
    if (btn) btn.disabled = true;
    try {
      const data = await F.fetchJson(this.printFetchUrl(), { cache: 'no-store' });
      const rows = data.rows || [];
      const totals = data.totals || { SALDO: 0, TOTALCOSTO: 0, TOTALCOSTO_PROMEDIO: 0 };
      await PrintReport.openAndPrint(
        () => this.buildPrintHtml(rows, totals, Boolean(data.truncated))
      );
    } catch (err) {
      F.alert('Error', err.message || 'Error al imprimir', 'error');
    } finally {
      this._printing = false;
      if (btn) btn.disabled = false;
    }
  },

  async reload() {
    if (!this._container || this._loading) return;
    this.syncFiltersFromUi();
    this._loading = true;
    const tbody = this._container.querySelector('#inventario-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="${this.tableColumns.length}" class="text-center text-muted py-4">
        <i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando…</td></tr>`;
    }
    try {
      await this.fetchData();
      this.updateTableView();
    } catch (err) {
      this._rows = [];
      this._totals = { SALDO: 0, TOTALCOSTO: 0, TOTALCOSTO_PROMEDIO: 0 };
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="${this.tableColumns.length}" class="text-center text-danger py-4">${this.escapeHtml(err.message)}</td></tr>`;
      }
      F.toast('Error al cargar inventario', 'error');
    } finally {
      this._loading = false;
    }
  },

  async load(container) {
    this._container = container;
    this._filterQuery = '';
    this._filterMarca = '';
    this._filterHabilitado = '';
    this._marcas = [];
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add('align-items-stretch', 'justify-content-start', 'p-3');

    if (!F.getEmpNit()) {
      container.innerHTML = `
        <div class="alert alert-warning m-3 w-100" role="alert">
          <i class="fa-solid fa-triangle-exclamation me-2"></i>
          No hay empresa activa. Cierre sesión e ingrese seleccionando una empresa.
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="text-center text-muted py-4 w-100">
        <i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando inventario…
      </div>
    `;

    try {
      await this.fetchMarcas();
      container.innerHTML = this.render();
      this.bindEvents();
      await this.reload();
    } catch (err) {
      container.innerHTML = `
        <div class="alert alert-danger m-0 w-100" role="alert">
          <i class="fa-solid fa-circle-exclamation me-2"></i>
          ${this.escapeHtml(err.message)}
        </div>
      `;
      F.toast('Error al cargar inventario', 'error');
    }
  },
};
