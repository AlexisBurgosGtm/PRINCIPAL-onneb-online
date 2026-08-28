/**
 * Reportes → Reportes de Marcas
 * Ventas netas + compras COM/COP por marca de producto.
 */
const ReportesMarcasView = {
  _container: null,
  _desde: '',
  _hasta: '',
  _loading: false,
  _loadingDetalle: false,
  _marcas: [],
  _totales: { ventas: 0, compras: 0, unidadesVenta: 0, unidadesCompra: 0 },
  _selectedCod: null,
  _detalle: null,
  _chart: null,
  _sortBy: 'ventas',
  _filters: { marcas: '', productos: '', clientes: '', proveedores: '' },

  escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  defaultRange() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hoy = `${y}-${m}-${d}`;
    return { desde: `${y}-${m}-01`, hasta: hoy };
  },

  formatFecha(value) {
    if (!value) return '—';
    const s = String(value).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return this.escapeHtml(s);
  },

  formatMoney(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '—';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  formatQty(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '—';
    return n.toLocaleString('es-GT', { maximumFractionDigits: 4 });
  },

  formatPct(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '—';
    return `${n.toLocaleString('es-GT', { maximumFractionDigits: 1 })}%`;
  },

  marcaKey(m) {
    return String(Number(m.CODMARCA) || 0);
  },

  readFilters() {
    const d = this._container?.querySelector('#repmar-desde');
    const h = this._container?.querySelector('#repmar-hasta');
    if (d) this._desde = String(d.value || '').trim();
    if (h) this._hasta = String(h.value || '').trim();
  },

  filterRows(rows, keys, q) {
    const query = String(q || '')
      .trim()
      .toLowerCase();
    if (!query) return rows || [];
    return (rows || []).filter((r) =>
      keys
        .map((k) => String(r[k] ?? '').toLowerCase())
        .join(' ')
        .includes(query)
    );
  },

  sortedMarcas() {
    const list = [...this._marcas];
    if (this._sortBy === 'compras') {
      list.sort(
        (a, b) =>
          (Number(b.COMPRAS) || 0) - (Number(a.COMPRAS) || 0) ||
          String(a.DESMARCA).localeCompare(String(b.DESMARCA))
      );
    } else if (this._sortBy === 'unidades') {
      list.sort(
        (a, b) =>
          (Number(b.UNIDADES_VENTA) || 0) - (Number(a.UNIDADES_VENTA) || 0) ||
          String(a.DESMARCA).localeCompare(String(b.DESMARCA))
      );
    } else {
      list.sort(
        (a, b) =>
          (Number(b.VENTAS) || 0) - (Number(a.VENTAS) || 0) ||
          String(a.DESMARCA).localeCompare(String(b.DESMARCA))
      );
    }
    return list;
  },

  filteredMarcas() {
    return this.filterRows(
      this.sortedMarcas(),
      ['CODMARCA', 'DESMARCA', 'VENTAS', 'COMPRAS', 'UNIDADES_VENTA', 'UNIDADES_COMPRA'],
      this._filters.marcas
    );
  },

  participacion(m) {
    const total = Number(this._totales?.ventas) || 0;
    if (!total) return 0;
    return ((Number(m.VENTAS) || 0) / total) * 100;
  },

  async fetchMarcas() {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      desde: this._desde,
      hasta: this._hasta,
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/reportes-marcas?${params}`);
    this._marcas = data.marcas || [];
    this._totales = data.totales || { ventas: 0, compras: 0, unidadesVenta: 0, unidadesCompra: 0 };
    return data;
  },

  async fetchDetalle(codmarca) {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      desde: this._desde,
      hasta: this._hasta,
      codmarca: String(codmarca),
      _: String(Date.now()),
    });
    this._detalle = await F.fetchJson(`/api/reportes-marcas/detalle?${params}`);
    return this._detalle;
  },

  destroyChart() {
    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }
  },

  buildChart() {
    if (typeof Chart === 'undefined') return;
    this.destroyChart();
    const canvas = this._container?.querySelector('#repmar-chart');
    if (!canvas) return;

    const serie = this._detalle?.serie || [];
    if (!serie.length) return;

    this._chart = new Chart(canvas, {
      data: {
        labels: serie.map((r) => this.formatFecha(r.FECHA)),
        datasets: [
          {
            type: 'bar',
            label: 'Uds. venta',
            data: serie.map((r) => Number(r.UNIDADES_VENTA) || 0),
            backgroundColor: 'rgba(124, 58, 237, 0.45)',
            borderColor: '#7c3aed',
            borderWidth: 1,
            yAxisID: 'yUnits',
            order: 3,
          },
          {
            type: 'line',
            label: 'Ventas',
            data: serie.map((r) => Number(r.VENTAS) || 0),
            borderColor: '#7c3aed',
            backgroundColor: 'rgba(124, 58, 237, 0.1)',
            fill: false,
            tension: 0.3,
            pointRadius: 3,
            yAxisID: 'yMoney',
            order: 1,
          },
          {
            type: 'line',
            label: 'Compras',
            data: serie.map((r) => Number(r.COMPRAS) || 0),
            borderColor: '#d97706',
            backgroundColor: 'rgba(217, 119, 6, 0.08)',
            borderDash: [4, 3],
            fill: false,
            tension: 0.3,
            pointRadius: 3,
            yAxisID: 'yMoney',
            order: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label(ctx) {
                const v = Number(ctx.raw) || 0;
                if (ctx.dataset.yAxisID === 'yMoney') {
                  return `${ctx.dataset.label}: ${v.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' })}`;
                }
                return `${ctx.dataset.label}: ${v.toLocaleString('es-GT', { maximumFractionDigits: 4 })}`;
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: 'Fecha' } },
          yMoney: {
            type: 'linear',
            position: 'left',
            ticks: {
              callback: (v) =>
                Number(v).toLocaleString('es-GT', { style: 'currency', currency: 'GTQ', maximumFractionDigits: 0 }),
            },
          },
          yUnits: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { callback: (v) => Number(v).toLocaleString('es-GT', { maximumFractionDigits: 0 }) },
          },
        },
      },
    });
  },

  renderSortButtons() {
    const ventasActive = this._sortBy === 'ventas' ? ' active' : '';
    const comprasActive = this._sortBy === 'compras' ? ' active' : '';
    const unidActive = this._sortBy === 'unidades' ? ' active' : '';
    return `
      <div class="repmar-sort-row">
        <button type="button" class="btn btn-sm btn-outline-primary repmar-sort-btn${ventasActive}" data-sort="ventas">
          <i class="fa-solid fa-sack-dollar me-1"></i>Ventas
        </button>
        <button type="button" class="btn btn-sm btn-outline-warning repmar-sort-btn${comprasActive}" data-sort="compras">
          <i class="fa-solid fa-cart-shopping me-1"></i>Compras
        </button>
        <button type="button" class="btn btn-sm btn-outline-secondary repmar-sort-btn${unidActive}" data-sort="unidades">
          <i class="fa-solid fa-boxes-stacked me-1"></i>Uds.
        </button>
      </div>`;
  },

  renderMarcaCards() {
    if (!this._marcas.length) {
      return `<div class="repmar-empty">Sin movimiento de marcas en el período</div>`;
    }
    const rows = this.filteredMarcas();
    if (!rows.length) {
      return `<div class="repmar-empty">Sin coincidencias</div>`;
    }
    const sortedAll = this.sortedMarcas();
    const rankMap = new Map(sortedAll.map((m, i) => [this.marcaKey(m), i + 1]));

    return rows
      .map((m) => {
        const key = this.marcaKey(m);
        const active = key === this._selectedCod ? ' active' : '';
        const rank = rankMap.get(key) || 0;
        const rankCls = rank <= 3 ? ` rank-${rank}` : '';
        const rankBadge = rank <= 3 ? `<span class="repmar-card-rank${rankCls}">#${rank}</span>` : '';
        const share = this.participacion(m);
        const codLabel = Number(m.CODMARCA) ? `Cód. ${m.CODMARCA}` : 'Sin código';
        return `
          <div class="repmar-card${active}" data-codmarca="${this.escapeHtml(key)}">
            ${rankBadge}
            <div class="repmar-card-code">${this.escapeHtml(codLabel)}</div>
            <div class="repmar-card-name">${this.escapeHtml(m.DESMARCA || 'Sin marca')}</div>
            <div class="repmar-card-stats">
              <span class="repmar-card-venta"><i class="fa-solid fa-arrow-trend-up me-1"></i>${this.escapeHtml(this.formatMoney(m.VENTAS))}</span>
              <span class="repmar-card-compra"><i class="fa-solid fa-truck me-1"></i>${this.escapeHtml(this.formatMoney(m.COMPRAS))}</span>
              <span class="text-muted"><i class="fa-solid fa-box-open me-1"></i>${this.escapeHtml(this.formatQty(m.UNIDADES_VENTA))} vta</span>
              <span class="text-muted"><i class="fa-solid fa-dolly me-1"></i>${this.escapeHtml(this.formatQty(m.UNIDADES_COMPRA))} cmp</span>
            </div>
            <div class="repmar-card-share">${this.escapeHtml(this.formatPct(share))} de ventas totales</div>
          </div>`;
      })
      .join('');
  },

  renderHero() {
    const d = this._detalle;
    if (!d) return '';
    const r = d.resumen || {};
    const share =
      Number(this._totales?.ventas) > 0
        ? ((Number(r.ventas) || 0) / Number(this._totales.ventas)) * 100
        : 0;
    const margen = Number(r.margen) || 0;
    const margenCls = margen >= 0 ? 'positive' : 'negative';

    return `
      <div class="repmar-hero">
        <div class="repmar-hero-title">${this.escapeHtml(d.desmarca || 'Marca')}</div>
        <div class="repmar-hero-code">Código marca: ${this.escapeHtml(d.codmarca ?? 0)}</div>
        <div class="repmar-kpi-row">
          <div class="repmar-kpi">
            <div class="repmar-kpi-label">Ventas netas</div>
            <div class="repmar-kpi-value">${this.escapeHtml(this.formatMoney(r.ventas))}</div>
          </div>
          <div class="repmar-kpi">
            <div class="repmar-kpi-label">Compras</div>
            <div class="repmar-kpi-value">${this.escapeHtml(this.formatMoney(r.compras))}</div>
          </div>
          <div class="repmar-kpi repmar-kpi-margen ${margenCls}">
            <div class="repmar-kpi-label">Margen bruto</div>
            <div class="repmar-kpi-value">${this.escapeHtml(this.formatMoney(r.margen))}</div>
          </div>
          <div class="repmar-kpi">
            <div class="repmar-kpi-label">Uds. venta</div>
            <div class="repmar-kpi-value">${this.escapeHtml(this.formatQty(r.unidadesVenta))}</div>
          </div>
          <div class="repmar-kpi">
            <div class="repmar-kpi-label">Uds. compra</div>
            <div class="repmar-kpi-value">${this.escapeHtml(this.formatQty(r.unidadesCompra))}</div>
          </div>
          <div class="repmar-kpi">
            <div class="repmar-kpi-label">Productos</div>
            <div class="repmar-kpi-value">${this.escapeHtml(r.numProductos ?? 0)}</div>
          </div>
          <div class="repmar-kpi">
            <div class="repmar-kpi-label">Clientes</div>
            <div class="repmar-kpi-value">${this.escapeHtml(r.numClientes ?? 0)}</div>
          </div>
          <div class="repmar-kpi">
            <div class="repmar-kpi-label">Proveedores</div>
            <div class="repmar-kpi-value">${this.escapeHtml(r.numProveedores ?? 0)}</div>
          </div>
          <div class="repmar-kpi">
            <div class="repmar-kpi-label">Participación</div>
            <div class="repmar-kpi-value">${this.escapeHtml(this.formatPct(share))}</div>
          </div>
        </div>
      </div>`;
  },

  renderProductosBody() {
    const all = this._detalle?.productos || [];
    if (!all.length) return '';
    const rows = this.filterRows(
      all,
      ['CODPROD', 'DESPROD', 'VENTAS', 'COMPRAS', 'UNIDADES_VENTA', 'UNIDADES_COMPRA'],
      this._filters.productos
    );
    if (!rows.length) {
      return `<tr><td colspan="5" class="text-center text-muted py-3">Sin coincidencias</td></tr>`;
    }
    const maxVenta = Math.max(...all.map((r) => Number(r.VENTAS) || 0), 1);
    return rows
      .map((r) => {
        const pct = ((Number(r.VENTAS) || 0) / maxVenta) * 100;
        return `
          <tr>
            <td class="small font-monospace">${this.escapeHtml(r.CODPROD || '—')}</td>
            <td>
              ${this.escapeHtml(r.DESPROD || '—')}
              <div class="repmar-bar repmar-bar-venta"><span style="width:${pct.toFixed(1)}%"></span></div>
            </td>
            <td class="text-end">${this.escapeHtml(this.formatQty(r.UNIDADES_VENTA))}</td>
            <td class="text-end fw-semibold text-primary">${this.escapeHtml(this.formatMoney(r.VENTAS))}</td>
            <td class="text-end text-warning">${this.escapeHtml(this.formatMoney(r.COMPRAS))}</td>
          </tr>`;
      })
      .join('');
  },

  renderProductosTable() {
    const all = this._detalle?.productos || [];
    if (!all.length) {
      return `<div class="repmar-empty py-2">Sin productos de esta marca</div>`;
    }
    const q = this._filters.productos;
    return `
      <input type="search" class="form-control form-control-sm repmar-search mb-2" data-section="productos"
        placeholder="Buscar productos…" value="${this.escapeHtml(q)}">
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0 repmar-table">
          <thead class="table-light sticky-top">
            <tr>
              <th>Cód.</th>
              <th>Producto</th>
              <th class="text-end">Uds. vta</th>
              <th class="text-end">Ventas</th>
              <th class="text-end">Compras</th>
            </tr>
          </thead>
          <tbody id="repmar-prods-tbody">${this.renderProductosBody()}</tbody>
        </table>
      </div>`;
  },

  renderClientesBody() {
    const all = this._detalle?.clientes || [];
    if (!all.length) return '';
    const rows = this.filterRows(
      all,
      ['DOC_NIT', 'DOC_NOMCLIE', 'CODCLIENTE', 'UNIDADES_VENTA', 'VENTAS'],
      this._filters.clientes
    );
    if (!rows.length) {
      return `<tr><td colspan="4" class="text-center text-muted py-3">Sin coincidencias</td></tr>`;
    }
    const maxVenta = Math.max(...all.map((r) => Number(r.VENTAS) || 0), 1);
    return rows
      .map((r) => {
        const pct = ((Number(r.VENTAS) || 0) / maxVenta) * 100;
        return `
          <tr>
            <td class="small text-muted">${this.escapeHtml(r.DOC_NIT || '—')}</td>
            <td>
              ${this.escapeHtml(r.DOC_NOMCLIE || 'Sin nombre')}
              <div class="repmar-bar repmar-bar-venta"><span style="width:${pct.toFixed(1)}%"></span></div>
            </td>
            <td class="text-end">${this.escapeHtml(this.formatQty(r.UNIDADES_VENTA))}</td>
            <td class="text-end fw-semibold">${this.escapeHtml(this.formatMoney(r.VENTAS))}</td>
          </tr>`;
      })
      .join('');
  },

  renderClientesTable() {
    const all = this._detalle?.clientes || [];
    if (!all.length) {
      return `<div class="repmar-empty py-2">Sin ventas de clientes para esta marca</div>`;
    }
    const q = this._filters.clientes;
    return `
      <input type="search" class="form-control form-control-sm repmar-search mb-2" data-section="clientes"
        placeholder="Buscar clientes…" value="${this.escapeHtml(q)}">
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0 repmar-table">
          <thead class="table-light sticky-top">
            <tr>
              <th>NIT</th>
              <th>Cliente</th>
              <th class="text-end">Unidades</th>
              <th class="text-end">Ventas</th>
            </tr>
          </thead>
          <tbody id="repmar-clientes-tbody">${this.renderClientesBody()}</tbody>
        </table>
      </div>`;
  },

  renderProveedoresBody() {
    const all = this._detalle?.proveedores || [];
    if (!all.length) return '';
    const rows = this.filterRows(
      all,
      ['DOC_NIT', 'DOC_NOMCLIE', 'CODPROVEEDOR', 'UNIDADES_COMPRA', 'COMPRAS'],
      this._filters.proveedores
    );
    if (!rows.length) {
      return `<tr><td colspan="4" class="text-center text-muted py-3">Sin coincidencias</td></tr>`;
    }
    const maxCompra = Math.max(...all.map((r) => Number(r.COMPRAS) || 0), 1);
    return rows
      .map((r) => {
        const pct = ((Number(r.COMPRAS) || 0) / maxCompra) * 100;
        return `
          <tr>
            <td class="small text-muted">${this.escapeHtml(r.DOC_NIT || '—')}</td>
            <td>
              ${this.escapeHtml(r.DOC_NOMCLIE || 'Sin nombre')}
              <div class="repmar-bar repmar-bar-compra"><span style="width:${pct.toFixed(1)}%"></span></div>
            </td>
            <td class="text-end">${this.escapeHtml(this.formatQty(r.UNIDADES_COMPRA))}</td>
            <td class="text-end fw-semibold text-warning">${this.escapeHtml(this.formatMoney(r.COMPRAS))}</td>
          </tr>`;
      })
      .join('');
  },

  renderProveedoresTable() {
    const all = this._detalle?.proveedores || [];
    if (!all.length) {
      return `<div class="repmar-empty py-2">Sin compras COM/COP de esta marca</div>`;
    }
    const q = this._filters.proveedores;
    return `
      <input type="search" class="form-control form-control-sm repmar-search mb-2" data-section="proveedores"
        placeholder="Buscar proveedores…" value="${this.escapeHtml(q)}">
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0 repmar-table">
          <thead class="table-light sticky-top">
            <tr>
              <th>NIT</th>
              <th>Proveedor</th>
              <th class="text-end">Unidades</th>
              <th class="text-end">Compras</th>
            </tr>
          </thead>
          <tbody id="repmar-prov-tbody">${this.renderProveedoresBody()}</tbody>
        </table>
      </div>`;
  },

  renderDetailPanel() {
    if (!this._selectedCod || !this._detalle) {
      return `
        <div class="card shadow-sm flex-grow-1">
          <div class="card-body repmar-empty">
            <i class="fa-solid fa-tags fa-2x mb-2 d-block opacity-50"></i>
            Seleccione una marca para ver ventas y compras
          </div>
        </div>`;
    }

    return `
      <div class="repmar-detail-col">
        ${this.renderHero()}
        <div class="card shadow-sm">
          <div class="card-body pb-2">
            <h6 class="card-title small fw-semibold mb-2">
              <i class="fa-solid fa-chart-column me-1" style="color:#7c3aed"></i>Ventas vs compras por fecha
            </h6>
            <div class="repmar-chart-wrap">
              <canvas id="repmar-chart" aria-label="Ventas y compras por fecha"></canvas>
            </div>
          </div>
        </div>
        <div class="card shadow-sm">
          <div class="card-header py-2 small fw-semibold">
            <i class="fa-solid fa-crown me-1 text-warning"></i>Productos de la marca
          </div>
          <div class="card-body p-2" id="repmar-prods-host">${this.renderProductosTable()}</div>
        </div>
        <div class="card shadow-sm">
          <div class="card-header py-2 small fw-semibold">
            <i class="fa-solid fa-users me-1 text-primary"></i>Clientes que compraron
          </div>
          <div class="card-body p-2" id="repmar-clientes-host">${this.renderClientesTable()}</div>
        </div>
        <div class="card shadow-sm">
          <div class="card-header py-2 small fw-semibold">
            <i class="fa-solid fa-truck me-1 text-warning"></i>Proveedores (COM / COP)
          </div>
          <div class="card-body p-2" id="repmar-prov-host">${this.renderProveedoresTable()}</div>
        </div>
      </div>`;
  },

  render() {
    const range = this.defaultRange();
    if (!this._desde) this._desde = range.desde;
    if (!this._hasta) this._hasta = range.hasta;

    return `
      <div class="repmar-wrap">
        <div class="card shadow-sm mb-3 repmar-toolbar">
          <div class="card-body py-2">
            <div class="d-flex flex-wrap align-items-end gap-2">
              <div>
                <label for="repmar-desde" class="form-label small mb-1">Desde</label>
                <input type="date" class="form-control form-control-sm" id="repmar-desde" value="${this.escapeHtml(this._desde)}">
              </div>
              <div>
                <label for="repmar-hasta" class="form-label small mb-1">Hasta</label>
                <input type="date" class="form-control form-control-sm" id="repmar-hasta" value="${this.escapeHtml(this._hasta)}">
              </div>
              <button type="button" class="btn btn-sm btn-primary" id="btn-repmar-cargar" style="background:#7c3aed;border-color:#7c3aed" ${this._loading ? 'disabled' : ''}>
                <i class="fa-solid fa-rotate me-1"></i>Cargar
              </button>
              <span class="small text-muted ms-1">${this._marcas.length} marca(s)</span>
              ${Number(this._totales?.ventas) > 0 ? `<span class="small ms-2 fw-semibold" style="color:#7c3aed">Ventas: ${this.escapeHtml(this.formatMoney(this._totales.ventas))}</span>` : ''}
              ${Number(this._totales?.compras) > 0 ? `<span class="small ms-2 fw-semibold text-warning">Compras: ${this.escapeHtml(this.formatMoney(this._totales.compras))}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="repmar-body">
          <div class="repmar-list-col card shadow-sm">
            <div class="card-header py-2 small fw-semibold">
              <i class="fa-solid fa-trophy me-1"></i>Ranking de marcas
            </div>
            <div class="card-body p-2 repmar-list-body">
              ${this.renderSortButtons()}
              <input type="search" class="form-control form-control-sm repmar-search" data-section="marcas"
                placeholder="Buscar marcas…" value="${this.escapeHtml(this._filters.marcas)}">
              <div class="repmar-list-scroll" id="repmar-list">
                ${this.renderMarcaCards()}
              </div>
            </div>
          </div>
          <div id="repmar-detail-wrap" class="repmar-detail-wrap">
            ${this.renderDetailPanel()}
          </div>
        </div>
      </div>`;
  },

  refreshMarcaList() {
    const el = this._container?.querySelector('#repmar-list');
    if (el) el.innerHTML = this.renderMarcaCards();
    const sortRow = this._container?.querySelector('.repmar-sort-row');
    if (sortRow) sortRow.outerHTML = this.renderSortButtons();
    this.bindSortButtons();
  },

  refreshProductosTable() {
    const tbody = this._container?.querySelector('#repmar-prods-tbody');
    if (tbody) {
      tbody.innerHTML = this.renderProductosBody();
      return;
    }
    const el = this._container?.querySelector('#repmar-prods-host');
    if (el) el.innerHTML = this.renderProductosTable();
  },

  refreshClientesTable() {
    const tbody = this._container?.querySelector('#repmar-clientes-tbody');
    if (tbody) {
      tbody.innerHTML = this.renderClientesBody();
      return;
    }
    const el = this._container?.querySelector('#repmar-clientes-host');
    if (el) el.innerHTML = this.renderClientesTable();
  },

  refreshProveedoresTable() {
    const tbody = this._container?.querySelector('#repmar-prov-tbody');
    if (tbody) {
      tbody.innerHTML = this.renderProveedoresBody();
      return;
    }
    const el = this._container?.querySelector('#repmar-prov-host');
    if (el) el.innerHTML = this.renderProveedoresTable();
  },

  refreshDetail() {
    const wrap = this._container?.querySelector('#repmar-detail-wrap');
    if (wrap) wrap.innerHTML = this.renderDetailPanel();
    this.buildChart();
  },

  bindSortButtons() {
    this._container?.querySelectorAll('.repmar-sort-btn').forEach((btn) => {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        const sort = btn.getAttribute('data-sort');
        if (!sort || sort === this._sortBy) return;
        this._sortBy = sort;
        this.refreshMarcaList();
      });
    });
  },

  async selectMarca(codmarca) {
    if (codmarca === undefined || codmarca === null) return;
    this._selectedCod = String(codmarca);
    this._filters.productos = '';
    this._filters.clientes = '';
    this._filters.proveedores = '';
    this.refreshMarcaList();
    this._loadingDetalle = true;
    const wrap = this._container?.querySelector('#repmar-detail-wrap');
    if (wrap) {
      wrap.innerHTML = `
        <div class="card shadow-sm flex-grow-1">
          <div class="card-body text-center text-muted py-5">
            <i class="fa-solid fa-spinner fa-spin me-1"></i>Analizando marca…
          </div>
        </div>`;
    }
    try {
      await this.fetchDetalle(codmarca);
      this.refreshDetail();
    } catch (err) {
      F.toast(err.message || 'Error al cargar detalle', 'error');
      this._detalle = null;
      this.refreshDetail();
    } finally {
      this._loadingDetalle = false;
    }
  },

  bindEvents() {
    this._container?.querySelector('#btn-repmar-cargar')?.addEventListener('click', () => {
      this.reload().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#repmar-desde')?.addEventListener('change', () => this.readFilters());
    this._container?.querySelector('#repmar-hasta')?.addEventListener('change', () => this.readFilters());

    this._container?.addEventListener('input', (e) => {
      const input = e.target.closest('.repmar-search');
      if (!input || !this._container.contains(input)) return;
      const section = input.dataset.section || '';
      this._filters[section] = input.value || '';
      if (section === 'marcas') this.refreshMarcaList();
      else if (section === 'productos') this.refreshProductosTable();
      else if (section === 'clientes') this.refreshClientesTable();
      else if (section === 'proveedores') this.refreshProveedoresTable();
    });

    this._container?.querySelector('#repmar-list')?.addEventListener('click', (e) => {
      const card = e.target.closest('.repmar-card');
      if (!card) return;
      const cod = card.getAttribute('data-codmarca');
      if (!cod || cod === this._selectedCod || this._loadingDetalle) return;
      this.selectMarca(cod).catch((err) => F.toast(err.message, 'error'));
    });

    this.bindSortButtons();
  },

  async reload() {
    if (this._loading) return;
    this._loading = true;
    this.readFilters();
    this.destroyChart();
    this._selectedCod = null;
    this._detalle = null;
    this._totales = { ventas: 0, compras: 0, unidadesVenta: 0, unidadesCompra: 0 };
    this._filters = { marcas: '', productos: '', clientes: '', proveedores: '' };
    const btn = this._container?.querySelector('#btn-repmar-cargar');
    if (btn) btn.disabled = true;
    try {
      await this.fetchMarcas();
      this.refreshMarcaList();
      const wrap = this._container?.querySelector('#repmar-detail-wrap');
      if (wrap) wrap.innerHTML = this.renderDetailPanel();
      const sorted = this.sortedMarcas();
      if (sorted.length) {
        await this.selectMarca(this.marcaKey(sorted[0]));
      }
    } finally {
      this._loading = false;
      if (btn) btn.disabled = false;
    }
  },

  async load(container) {
    this._container = container;
    const range = this.defaultRange();
    this._desde = range.desde;
    this._hasta = range.hasta;
    this._marcas = [];
    this._totales = { ventas: 0, compras: 0, unidadesVenta: 0, unidadesCompra: 0 };
    this._selectedCod = null;
    this._detalle = null;
    this._sortBy = 'ventas';
    this._filters = { marcas: '', productos: '', clientes: '', proveedores: '' };
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add('align-items-stretch', 'justify-content-start');
    container.innerHTML = this.render();
    this.bindEvents();
    await this.reload();
  },
};
