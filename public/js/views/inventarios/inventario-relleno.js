/**
 * Vista Relleno de inventario — productos en o bajo mínimo (INVMINIMO).
 */
const InventarioRellenoView = {
  _container: null,
  _rows: [],
  _totalCount: 0,
  _listTruncated: false,
  _filterQuery: '',
  _filterMarca: '',
  _filterHabilitado: '',
  _marcas: [],
  _totals: { SALDO: 0, TOTALCOSTO: 0, ABASTECER: 0 },
  _loading: false,
  _exporting: false,
  _printing: false,
  _calculatingMinMax: false,

  tableColumns: [
    { key: 'CODPROD', label: 'Código' },
    { key: 'DESPROD', label: 'Descripción', cellClass: 'inventario-col-desc' },
    { key: 'DESMARCA', label: 'Marca' },
    { key: 'TIPOPROD', label: 'Tipo' },
    { key: 'SALDO', label: 'Saldo', type: 'qty' },
    { key: 'EXISTENCIA', label: 'Existencia', type: 'qty' },
    { key: 'COSTO', label: 'Costo', type: 'money', ventasHidden: true },
    { key: 'TOTALCOSTO', label: 'Total costo', type: 'money', ventasHidden: true },
    { key: 'INVMINIMO', label: 'Mínimo', type: 'qty' },
    { key: 'INVMAXIMO', label: 'Máximo', type: 'qty' },
    { key: 'ABASTECER', label: 'Abastecer', type: 'qty' },
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
        : 'Ningún producto en o bajo el mínimo de inventario';
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
        if (c.key === 'ABASTECER') {
          return `<td class="text-end inventario-qty">${this.escapeHtml(this.formatQty(this._totals.ABASTECER))}</td>`;
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
    return `<i class="fa-solid fa-boxes-stacked me-1"></i>${countLabel} producto(s) a rellenar${this.filterSummaryHtml()}${this.escapeHtml(extra)}`;
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
    return `/api/inventario/relleno?${params.toString()}`;
  },

  exportUrl() {
    const params = this.buildListParams();
    return `/api/inventario/relleno/export?${params.toString()}`;
  },

  printFetchUrl() {
    const params = this.buildListParams({ limit: '2000' });
    return `/api/inventario/relleno?${params.toString()}`;
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
      <div class="card relleno-filters-card shadow-sm mb-3">
        <div class="card-body">
          <div class="d-flex flex-wrap align-items-end gap-2 relleno-filters-row">
            <div class="relleno-filter-marca">
              <label for="relleno-filter-marca" class="form-label small mb-1">Marca</label>
              <select class="form-select form-select-sm" id="relleno-filter-marca">
                ${this.renderMarcaOptions()}
              </select>
            </div>
            <div class="relleno-filter-habilitado">
              <label for="relleno-filter-habilitado" class="form-label small mb-1">Habilitado</label>
              <select class="form-select form-select-sm" id="relleno-filter-habilitado">
                <option value=""${!this._filterHabilitado ? ' selected' : ''}>TODOS</option>
                <option value="SI"${this._filterHabilitado === 'SI' ? ' selected' : ''}>SI</option>
                <option value="NO"${this._filterHabilitado === 'NO' ? ' selected' : ''}>NO</option>
              </select>
            </div>
            <div class="relleno-filter-search flex-grow-1">
              <label for="relleno-search" class="form-label small mb-1">Buscar</label>
              <div class="input-group input-group-sm">
                <span class="input-group-text" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></span>
                <input type="search" class="form-control" id="relleno-search"
                  placeholder="Código o descripción de producto… (Enter)"
                  value="${this.escapeHtml(this._filterQuery)}" autocomplete="off" spellcheck="false">
                <button type="button" class="btn btn-outline-secondary" id="btn-relleno-search-clear"
                  title="Limpiar búsqueda" aria-label="Limpiar búsqueda">
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
              </div>
            </div>
            <div class="relleno-filter-config"${this.isUsuarioVentas() ? ' hidden' : ''}>
              <label class="form-label small mb-1 d-block relleno-config-label" aria-hidden="true">&nbsp;</label>
              <button type="button" class="btn btn-sm btn-outline-primary" id="btn-relleno-config-minmax">
                <i class="fa-solid fa-sliders me-1" aria-hidden="true"></i>Configurar Mínimos y máximos
              </button>
            </div>
            <div class="relleno-filter-export"${this.isUsuarioVentas() ? ' hidden' : ''}>
              <label class="form-label small mb-1 d-block relleno-export-label" aria-hidden="true">&nbsp;</label>
              <button type="button" class="btn btn-sm btn-outline-success" id="btn-relleno-export">
                <i class="fa-solid fa-file-excel me-1" aria-hidden="true"></i>Exportar (xlsx)
              </button>
            </div>
          </div>
          <div class="inventario-badge small text-muted mt-2" id="relleno-count">${this.badgeText()}</div>
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
            <tbody id="relleno-tbody">${this.renderTableBodyHtml(this._rows)}</tbody>
            <tfoot id="relleno-tfoot">${this.renderTableFooterHtml()}</tfoot>
          </table>
        </div>
      </div>
    `;
  },

  render() {
    return `
      <div class="inventario-vista-wrap relleno-vista-wrap w-100">
        ${this.renderFiltersCard()}
        ${this.renderTableCard()}
        <button type="button" class="btn-onneb-nuevo-fab relleno-fab-print" id="btn-relleno-print"
          aria-label="Imprimir relleno de inventario" title="Imprimir relleno de inventario">
          <i class="fa-solid fa-print" aria-hidden="true"></i>
        </button>
      </div>
    `;
  },

  syncFiltersFromUi() {
    const marcaEl = document.getElementById('relleno-filter-marca');
    const habilitadoEl = document.getElementById('relleno-filter-habilitado');
    if (marcaEl) this._filterMarca = marcaEl.value;
    if (habilitadoEl) this._filterHabilitado = habilitadoEl.value;
  },

  updateTableView() {
    const tbody = this._container?.querySelector('#relleno-tbody');
    const tfoot = this._container?.querySelector('#relleno-tfoot');
    const badge = this._container?.querySelector('#relleno-count');
    if (tbody) tbody.innerHTML = this.renderTableBodyHtml(this._rows);
    if (tfoot) tfoot.innerHTML = this.renderTableFooterHtml();
    if (badge) badge.innerHTML = this.badgeText();
  },

  async fetchData() {
    const data = await F.fetchJson(this.apiUrlLista(), { cache: 'no-store' });
    this._rows = data.rows || [];
    this._totalCount = data.total ?? this._rows.length;
    this._listTruncated = Boolean(data.truncated);
    this._totals = data.totals || { SALDO: 0, TOTALCOSTO: 0, ABASTECER: 0 };
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
    const sel = document.getElementById('relleno-filter-marca');
    if (!sel) return;
    sel.addEventListener('change', () => {
      this._filterMarca = sel.value;
      this.reload();
    });
  },

  bindHabilitadoFilter() {
    const sel = document.getElementById('relleno-filter-habilitado');
    if (!sel) return;
    sel.addEventListener('change', () => {
      this._filterHabilitado = sel.value;
      this.reload();
    });
  },

  bindSearch() {
    const search = document.getElementById('relleno-search');
    const clearBtn = document.getElementById('btn-relleno-search-clear');
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
    const tbody = this._container?.querySelector('#relleno-tbody');
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
    document.getElementById('btn-relleno-export')?.addEventListener('click', () => {
      this.onExportExcel();
    });
    document.getElementById('btn-relleno-config-minmax')?.addEventListener('click', () => {
      this.onConfigMinMax().catch(() => {});
    });
    document.getElementById('btn-relleno-print')?.addEventListener('click', () => {
      this.onPrint();
    });
  },

  mesOptionsHtml(selected) {
    const meses = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
    ];
    return meses
      .map((label, idx) => {
        const val = idx + 1;
        const sel = Number(selected) === val ? ' selected' : '';
        return `<option value="${val}"${sel}>${label}</option>`;
      })
      .join('');
  },

  anioOptionsHtml(selected) {
    const opts = [];
    for (let y = 2020; y <= 2060; y += 1) {
      const sel = Number(selected) === y ? ' selected' : '';
      opts.push(`<option value="${y}"${sel}>${y}</option>`);
    }
    return opts.join('');
  },

  diasOptionsHtml(selected) {
    const opts = [];
    for (let d = 1; d <= 30; d += 1) {
      const sel = Number(selected) === d ? ' selected' : '';
      opts.push(`<option value="${d}"${sel}>${d}</option>`);
    }
    return opts.join('');
  },

  buildConfigMinMaxHtml() {
    const now = new Date();
    const mes = now.getMonth() + 1;
    const anio = now.getFullYear();
    const anioSel = anio >= 2020 && anio <= 2060 ? anio : 2025;
    return `
      <div class="text-start relleno-config-minmax-form">
        <section class="mb-3">
          <h3 class="h6 mb-2">Establece Máximos</h3>
          <div class="row g-2">
            <div class="col-sm-4">
              <label for="relleno-cfg-mes-inicial" class="form-label small mb-1">Mes inicial</label>
              <select class="form-select form-select-sm" id="relleno-cfg-mes-inicial">
                ${this.mesOptionsHtml(1)}
              </select>
            </div>
            <div class="col-sm-4">
              <label for="relleno-cfg-mes-final" class="form-label small mb-1">Mes final</label>
              <select class="form-select form-select-sm" id="relleno-cfg-mes-final">
                ${this.mesOptionsHtml(mes)}
              </select>
            </div>
            <div class="col-sm-4">
              <label for="relleno-cfg-anio" class="form-label small mb-1">Año</label>
              <select class="form-select form-select-sm" id="relleno-cfg-anio">
                ${this.anioOptionsHtml(anioSel)}
              </select>
            </div>
          </div>
          <p class="small text-muted mb-0 mt-2">
            El máximo será el promedio mensual de unidades vendidas (FAC / FEL) en el rango.
          </p>
        </section>
        <section>
          <h3 class="h6 mb-2">Días de mínimo de inventario</h3>
          <label for="relleno-cfg-dias" class="form-label small mb-1">Días</label>
          <select class="form-select form-select-sm" id="relleno-cfg-dias" style="max-width: 8rem;">
            ${this.diasOptionsHtml(30)}
          </select>
          <p class="small text-muted mb-0 mt-2">
            El mínimo será el promedio mensual dividido entre estos días.
          </p>
        </section>
      </div>
    `;
  },

  async onConfigMinMax() {
    if (this.isUsuarioVentas()) {
      F.toast('No tiene permiso para configurar mínimos y máximos', 'warning');
      return;
    }
    if (this._calculatingMinMax) return;
    const empNit = F.getEmpNit();
    if (!empNit) {
      F.toast('No hay empresa activa en la sesión', 'warning');
      return;
    }

    const modalOpts = typeof CatalogosUI !== 'undefined' ? CatalogosUI.modalBase() : {};
    const result = await Swal.fire({
      ...modalOpts,
      title: 'Configurar Mínimos y máximos',
      width: 560,
      html: this.buildConfigMinMaxHtml(),
      showCancelButton: true,
      confirmButtonText:
        typeof CatalogosUI !== 'undefined'
          ? CatalogosUI.guardarButtonHtml('Calcular Mínimos y Máximo')
          : 'Calcular Mínimos y Máximo',
      cancelButtonText:
        typeof CatalogosUI !== 'undefined' ? CatalogosUI.cancelButtonHtml('Cancelar') : 'Cancelar',
      focusConfirm: false,
      preConfirm: () => {
        const mesInicial = parseInt(document.getElementById('relleno-cfg-mes-inicial')?.value, 10);
        const mesFinal = parseInt(document.getElementById('relleno-cfg-mes-final')?.value, 10);
        const anio = parseInt(document.getElementById('relleno-cfg-anio')?.value, 10);
        const dias = parseInt(document.getElementById('relleno-cfg-dias')?.value, 10);
        if (!mesInicial || !mesFinal || mesInicial > mesFinal) {
          Swal.showValidationMessage('El mes inicial no puede ser mayor que el mes final');
          return false;
        }
        if (!anio || anio < 2020 || anio > 2060) {
          Swal.showValidationMessage('Seleccione un año válido');
          return false;
        }
        if (!dias || dias < 1 || dias > 30) {
          Swal.showValidationMessage('Seleccione días entre 1 y 30');
          return false;
        }
        return { mesInicial, mesFinal, anio, dias };
      },
    });

    if (!result.isConfirmed || !result.value) return;
    const payload = result.value;

    this._calculatingMinMax = true;
    Swal.fire({
      ...modalOpts,
      title: 'Calculando…',
      html: '<p class="small text-muted mb-0">Actualizando mínimos y máximos según ventas. Espere…</p>',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: () => Swal.showLoading(),
    });

    try {
      const params = new URLSearchParams({ empnit: empNit });
      const res = await fetch(`/api/inventario/relleno/calcular-min-max?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);

      Swal.close();
      F.toast(
        `Actualizados ${data.productosActualizados || 0} producto(s)` +
          (data.productosConVentas != null ? ` (${data.productosConVentas} con ventas)` : ''),
        'success'
      );
      await this.reload();
    } catch (err) {
      Swal.close();
      F.alert('Error', err.message || 'No se pudo calcular mínimos y máximos', 'error');
    } finally {
      this._calculatingMinMax = false;
    }
  },

  async onExportExcel() {
    if (this.isUsuarioVentas()) {
      F.toast('No tiene permiso para exportar relleno de inventario', 'warning');
      return;
    }
    if (this._exporting) return;
    const empNit = F.getEmpNit();
    if (!empNit) {
      F.toast('No hay empresa activa en la sesión', 'warning');
      return;
    }
    this.syncFiltersFromUi();
    const btn = document.getElementById('btn-relleno-export');
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
      const filename = match ? match[1] : `relleno_inventario_${empNit}.xlsx`;
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
        if (c.key === 'ABASTECER') {
          return `<td class="text-end"><strong>${PrintReport.escapeHtml(this.formatQty(totals.ABASTECER))}</strong></td>`;
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
      title: 'Relleno de inventario',
      bodyHtml: `
        ${PrintReport.reportHeaderHtml({
          title: 'Relleno de inventario',
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
    const btn = document.getElementById('btn-relleno-print');
    this._printing = true;
    if (btn) btn.disabled = true;
    try {
      const data = await F.fetchJson(this.printFetchUrl(), { cache: 'no-store' });
      const rows = data.rows || [];
      const totals = data.totals || { SALDO: 0, TOTALCOSTO: 0, ABASTECER: 0 };
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
    const tbody = this._container.querySelector('#relleno-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="${this.tableColumns.length}" class="text-center text-muted py-4">
        <i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando…</td></tr>`;
    }
    try {
      await this.fetchData();
      this.updateTableView();
    } catch (err) {
      this._rows = [];
      this._totals = { SALDO: 0, TOTALCOSTO: 0, ABASTECER: 0 };
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
