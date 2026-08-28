/**
 * Reportes → Reportes de Productos
 * Ventas FAC/FEL por producto: ranking, KPIs, gráfica dual y clientes top.
 */
const ReportesProductosView = {
  _container: null,
  _desde: '',
  _hasta: '',
  _loading: false,
  _loadingDetalle: false,
  _productos: [],
  _totales: { unidades: 0, precio: 0 },
  _selectedCod: null,
  _detalle: null,
  _chart: null,
  _sortBy: 'precio',
  _filters: { productos: '', documentos: '', clientes: '' },

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

  readFilters() {
    const d = this._container?.querySelector('#repprod-desde');
    const h = this._container?.querySelector('#repprod-hasta');
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

  sortedProductos() {
    const list = [...this._productos];
    if (this._sortBy === 'unidades') {
      list.sort(
        (a, b) =>
          (Number(b.TOTALUNIDADES) || 0) - (Number(a.TOTALUNIDADES) || 0) ||
          String(a.CODPROD).localeCompare(String(b.CODPROD))
      );
    } else {
      list.sort(
        (a, b) =>
          (Number(b.TOTALPRECIO) || 0) - (Number(a.TOTALPRECIO) || 0) ||
          String(a.CODPROD).localeCompare(String(b.CODPROD))
      );
    }
    return list;
  },

  filteredProductos() {
    const sorted = this.sortedProductos();
    return this.filterRows(sorted, ['CODPROD', 'DESPROD', 'TOTALUNIDADES', 'TOTALPRECIO'], this._filters.productos);
  },

  participacion(p) {
    const total = Number(this._totales?.precio) || 0;
    if (!total) return 0;
    return ((Number(p.TOTALPRECIO) || 0) / total) * 100;
  },

  async fetchProductos() {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      desde: this._desde,
      hasta: this._hasta,
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/reportes-productos?${params}`);
    this._productos = data.productos || [];
    this._totales = data.totales || { unidades: 0, precio: 0 };
    return data;
  },

  async fetchDetalle(codprod) {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      desde: this._desde,
      hasta: this._hasta,
      codprod: String(codprod || '').trim(),
      _: String(Date.now()),
    });
    this._detalle = await F.fetchJson(`/api/reportes-productos/detalle?${params}`);
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
    const canvas = this._container?.querySelector('#repprod-chart');
    if (!canvas) return;

    const serie = this._detalle?.serie || [];
    if (!serie.length) return;

    this._chart = new Chart(canvas, {
      data: {
        labels: serie.map((r) => this.formatFecha(r.FECHA)),
        datasets: [
          {
            type: 'bar',
            label: 'Unidades',
            data: serie.map((r) => Number(r.UNIDADES) || 0),
            backgroundColor: 'rgba(16, 185, 129, 0.55)',
            borderColor: '#10b981',
            borderWidth: 1,
            yAxisID: 'yUnits',
            order: 2,
          },
          {
            type: 'line',
            label: 'Ventas',
            data: serie.map((r) => Number(r.MONTO) || 0),
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.12)',
            fill: true,
            tension: 0.3,
            pointRadius: 4,
            yAxisID: 'yMoney',
            order: 1,
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

  renderProductCards() {
    if (!this._productos.length) {
      return `<div class="repprod-empty">Sin ventas de productos en el período</div>`;
    }
    const rows = this.filteredProductos();
    if (!rows.length) {
      return `<div class="repprod-empty">Sin coincidencias</div>`;
    }
    const sortedAll = this.sortedProductos();
    const rankMap = new Map(sortedAll.map((p, i) => [p.CODPROD, i + 1]));

    return rows
      .map((p) => {
        const active = p.CODPROD === this._selectedCod ? ' active' : '';
        const rank = rankMap.get(p.CODPROD) || 0;
        const rankCls = rank <= 3 ? ` rank-${rank}` : '';
        const rankBadge =
          rank <= 3 ? `<span class="repprod-card-rank${rankCls}">#${rank}</span>` : '';
        const share = this.participacion(p);
        return `
          <div class="repprod-card${active}" data-codprod="${this.escapeHtml(p.CODPROD)}">
            ${rankBadge}
            <div class="repprod-card-code">${this.escapeHtml(p.CODPROD || '—')}</div>
            <div class="repprod-card-name">${this.escapeHtml(p.DESPROD || 'Sin descripción')}</div>
            <div class="repprod-card-stats">
              <span><i class="fa-solid fa-box-open me-1 text-muted"></i>${this.escapeHtml(this.formatQty(p.TOTALUNIDADES))}</span>
              <span class="fw-semibold">${this.escapeHtml(this.formatMoney(p.TOTALPRECIO))}</span>
            </div>
            <div class="repprod-card-share">${this.escapeHtml(this.formatPct(share))} del total vendido</div>
          </div>`;
      })
      .join('');
  },

  renderHero() {
    const d = this._detalle;
    if (!d) return '';
    const r = d.resumen || {};
    const share =
      Number(this._totales?.precio) > 0
        ? ((Number(r.precio) || 0) / Number(this._totales.precio)) * 100
        : 0;

    return `
      <div class="repprod-hero">
        <div class="repprod-hero-title">${this.escapeHtml(d.desprod || d.codprod || 'Producto')}</div>
        <div class="repprod-hero-code">${this.escapeHtml(d.codprod || '')}</div>
        <div class="repprod-kpi-row">
          <div class="repprod-kpi">
            <div class="repprod-kpi-label">Ventas</div>
            <div class="repprod-kpi-value">${this.escapeHtml(this.formatMoney(r.precio))}</div>
          </div>
          <div class="repprod-kpi">
            <div class="repprod-kpi-label">Unidades</div>
            <div class="repprod-kpi-value">${this.escapeHtml(this.formatQty(r.unidades))}</div>
          </div>
          <div class="repprod-kpi">
            <div class="repprod-kpi-label">Precio prom.</div>
            <div class="repprod-kpi-value">${this.escapeHtml(this.formatMoney(r.precioPromedio))}</div>
          </div>
          <div class="repprod-kpi">
            <div class="repprod-kpi-label">Clientes</div>
            <div class="repprod-kpi-value">${this.escapeHtml(r.numClientes ?? 0)}</div>
          </div>
          <div class="repprod-kpi">
            <div class="repprod-kpi-label">Facturas</div>
            <div class="repprod-kpi-value">${this.escapeHtml(r.numDocumentos ?? 0)}</div>
          </div>
          <div class="repprod-kpi">
            <div class="repprod-kpi-label">Participación</div>
            <div class="repprod-kpi-value">${this.escapeHtml(this.formatPct(share))}</div>
          </div>
        </div>
      </div>`;
  },

  renderDocumentosBody() {
    const all = this._detalle?.documentos || [];
    if (!all.length) return '';
    const rows = this.filterRows(all, [
      'FECHA',
      'TIPODOC',
      'CODDOC',
      'CORRELATIVO',
      'DOC_NOMCLIE',
      'FEL_SERIE',
      'FEL_NUMERO',
      'LINE_UNIDADES',
      'LINE_PRECIO',
      'TOTALPRECIO',
    ], this._filters.documentos);
    if (!rows.length) {
      return `<tr><td colspan="7" class="text-center text-muted py-3">Sin coincidencias</td></tr>`;
    }
    return rows
      .map((r) => {
        const label = `${r.CODDOC || ''} #${r.CORRELATIVO ?? ''}`;
        const fel =
          r.FEL_SERIE || r.FEL_NUMERO ? `${r.FEL_SERIE || ''}-${r.FEL_NUMERO || ''}` : '—';
        return `
          <tr data-coddoc="${this.escapeHtml(r.CODDOC || '')}" data-correlativo="${this.escapeHtml(r.CORRELATIVO ?? '')}"
            data-tipodoc="${this.escapeHtml(r.TIPODOC || '')}" data-desdoc="${this.escapeHtml(r.DESDOC || '')}">
            <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
            <td>${this.escapeHtml(r.TIPODOC || '—')}</td>
            <td>${this.escapeHtml(label)}</td>
            <td class="small">${this.escapeHtml(r.DOC_NOMCLIE || '—')}</td>
            <td class="text-end">${this.escapeHtml(this.formatQty(r.LINE_UNIDADES))}</td>
            <td class="text-end">${this.escapeHtml(this.formatMoney(r.LINE_PRECIO))}</td>
            <td class="text-center">
              <button type="button" class="btn btn-sm btn-outline-secondary repprod-print-btn" title="Imprimir">
                <i class="fa-solid fa-print"></i>
              </button>
            </td>
          </tr>`;
      })
      .join('');
  },

  renderDocumentosTable() {
    const all = this._detalle?.documentos || [];
    if (!all.length) {
      return `<div class="repprod-empty py-2">Sin documentos con este producto</div>`;
    }
    const q = this._filters.documentos;
    return `
      <input type="search" class="form-control form-control-sm repprod-search mb-2" data-section="documentos"
        placeholder="Buscar facturas…" value="${this.escapeHtml(q)}">
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0 repprod-table">
          <thead class="table-light sticky-top">
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Documento</th>
              <th>Cliente</th>
              <th class="text-end">Uds.</th>
              <th class="text-end">Línea</th>
              <th class="text-center"></th>
            </tr>
          </thead>
          <tbody id="repprod-docs-tbody">${this.renderDocumentosBody()}</tbody>
        </table>
      </div>`;
  },

  renderClientesBody() {
    const all = this._detalle?.clientes || [];
    if (!all.length) return '';
    const rows = this.filterRows(
      all,
      ['DOC_NIT', 'DOC_NOMCLIE', 'CODCLIENTE', 'TOTALUNIDADES', 'TOTALPRECIO'],
      this._filters.clientes
    );
    if (!rows.length) {
      return `<tr><td colspan="4" class="text-center text-muted py-3">Sin coincidencias</td></tr>`;
    }
    const maxPrecio = Math.max(...all.map((r) => Number(r.TOTALPRECIO) || 0), 1);
    return rows
      .map((r) => {
        const pct = ((Number(r.TOTALPRECIO) || 0) / maxPrecio) * 100;
        return `
          <tr>
            <td class="small text-muted">${this.escapeHtml(r.DOC_NIT || '—')}</td>
            <td>
              ${this.escapeHtml(r.DOC_NOMCLIE || 'Sin nombre')}
              <div class="repprod-client-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
            </td>
            <td class="text-end">${this.escapeHtml(this.formatQty(r.TOTALUNIDADES))}</td>
            <td class="text-end fw-semibold">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
          </tr>`;
      })
      .join('');
  },

  renderClientesTable() {
    const all = this._detalle?.clientes || [];
    if (!all.length) {
      return `<div class="repprod-empty py-2">Sin clientes con compras de este producto</div>`;
    }
    const q = this._filters.clientes;
    return `
      <input type="search" class="form-control form-control-sm repprod-search mb-2" data-section="clientes"
        placeholder="Buscar clientes…" value="${this.escapeHtml(q)}">
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0 repprod-table">
          <thead class="table-light sticky-top">
            <tr>
              <th>NIT</th>
              <th>Cliente</th>
              <th class="text-end">Unidades</th>
              <th class="text-end">Total</th>
            </tr>
          </thead>
          <tbody id="repprod-clientes-tbody">${this.renderClientesBody()}</tbody>
        </table>
      </div>`;
  },

  renderDetailPanel() {
    if (!this._selectedCod || !this._detalle) {
      return `
        <div class="card shadow-sm flex-grow-1">
          <div class="card-body repprod-empty">
            <i class="fa-solid fa-chart-pie fa-2x mb-2 d-block opacity-50"></i>
            Seleccione un producto para ver su rendimiento
          </div>
        </div>`;
    }

    return `
      <div class="repprod-detail-col">
        ${this.renderHero()}
        <div class="card shadow-sm">
          <div class="card-body pb-2">
            <h6 class="card-title small fw-semibold mb-2">
              <i class="fa-solid fa-chart-column me-1 text-success"></i>Unidades vs ventas por fecha
            </h6>
            <div class="repprod-chart-wrap">
              <canvas id="repprod-chart" aria-label="Unidades y ventas por fecha"></canvas>
            </div>
          </div>
        </div>
        <div class="card shadow-sm">
          <div class="card-header py-2 small fw-semibold">
            <i class="fa-solid fa-crown me-1 text-warning"></i>Quién compró este producto
          </div>
          <div class="card-body p-2" id="repprod-clientes-host">${this.renderClientesTable()}</div>
        </div>
        <div class="card shadow-sm">
          <div class="card-header py-2 small fw-semibold">Facturas con este producto</div>
          <div class="card-body p-2" id="repprod-docs-host">${this.renderDocumentosTable()}</div>
        </div>
      </div>`;
  },

  renderSortButtons() {
    const precioActive = this._sortBy === 'precio' ? ' active' : '';
    const unidActive = this._sortBy === 'unidades' ? ' active' : '';
    return `
      <div class="repprod-sort-row">
        <button type="button" class="btn btn-sm btn-outline-success repprod-sort-btn${precioActive}" data-sort="precio">
          <i class="fa-solid fa-sack-dollar me-1"></i>Ventas $
        </button>
        <button type="button" class="btn btn-sm btn-outline-success repprod-sort-btn${unidActive}" data-sort="unidades">
          <i class="fa-solid fa-boxes-stacked me-1"></i>Unidades
        </button>
      </div>`;
  },

  render() {
    const range = this.defaultRange();
    if (!this._desde) this._desde = range.desde;
    if (!this._hasta) this._hasta = range.hasta;

    return `
      <div class="repprod-wrap">
        <div class="card shadow-sm mb-3 repprod-toolbar">
          <div class="card-body py-2">
            <div class="d-flex flex-wrap align-items-end gap-2">
              <div>
                <label for="repprod-desde" class="form-label small mb-1">Desde</label>
                <input type="date" class="form-control form-control-sm" id="repprod-desde" value="${this.escapeHtml(this._desde)}">
              </div>
              <div>
                <label for="repprod-hasta" class="form-label small mb-1">Hasta</label>
                <input type="date" class="form-control form-control-sm" id="repprod-hasta" value="${this.escapeHtml(this._hasta)}">
              </div>
              <button type="button" class="btn btn-sm btn-success" id="btn-repprod-cargar" ${this._loading ? 'disabled' : ''}>
                <i class="fa-solid fa-rotate me-1"></i>Cargar
              </button>
              <span class="small text-muted ms-1">${this._productos.length} producto(s)</span>
              ${Number(this._totales?.precio) > 0 ? `<span class="small text-success ms-2 fw-semibold">Total: ${this.escapeHtml(this.formatMoney(this._totales.precio))}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="repprod-body">
          <div class="repprod-list-col card shadow-sm">
            <div class="card-header py-2 small fw-semibold">
              <i class="fa-solid fa-trophy me-1"></i>Ranking de productos
            </div>
            <div class="card-body p-2 repprod-list-body">
              ${this.renderSortButtons()}
              <input type="search" class="form-control form-control-sm repprod-search" data-section="productos"
                placeholder="Buscar productos…" value="${this.escapeHtml(this._filters.productos)}">
              <div class="repprod-list-scroll" id="repprod-list">
                ${this.renderProductCards()}
              </div>
            </div>
          </div>
          <div id="repprod-detail-wrap" class="repprod-detail-wrap">
            ${this.renderDetailPanel()}
          </div>
        </div>
      </div>`;
  },

  refreshProductList() {
    const el = this._container?.querySelector('#repprod-list');
    if (el) el.innerHTML = this.renderProductCards();
    const sortRow = this._container?.querySelector('.repprod-sort-row');
    if (sortRow) sortRow.outerHTML = this.renderSortButtons();
    this.bindSortButtons();
  },

  refreshDocumentosTable() {
    const tbody = this._container?.querySelector('#repprod-docs-tbody');
    if (tbody) {
      tbody.innerHTML = this.renderDocumentosBody();
      return;
    }
    const el = this._container?.querySelector('#repprod-docs-host');
    if (el) el.innerHTML = this.renderDocumentosTable();
  },

  refreshClientesTable() {
    const tbody = this._container?.querySelector('#repprod-clientes-tbody');
    if (tbody) {
      tbody.innerHTML = this.renderClientesBody();
      return;
    }
    const el = this._container?.querySelector('#repprod-clientes-host');
    if (el) el.innerHTML = this.renderClientesTable();
  },

  refreshDetail() {
    const wrap = this._container?.querySelector('#repprod-detail-wrap');
    if (wrap) wrap.innerHTML = this.renderDetailPanel();
    this.buildChart();
  },

  bindSortButtons() {
    this._container?.querySelectorAll('.repprod-sort-btn').forEach((btn) => {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        const sort = btn.getAttribute('data-sort');
        if (!sort || sort === this._sortBy) return;
        this._sortBy = sort;
        this.refreshProductList();
      });
    });
  },

  async selectProduct(codprod) {
    if (!codprod) return;
    this._selectedCod = codprod;
    this._filters.documentos = '';
    this._filters.clientes = '';
    this.refreshProductList();
    this._loadingDetalle = true;
    const wrap = this._container?.querySelector('#repprod-detail-wrap');
    if (wrap) {
      wrap.innerHTML = `
        <div class="card shadow-sm flex-grow-1">
          <div class="card-body text-center text-muted py-5">
            <i class="fa-solid fa-spinner fa-spin me-1"></i>Analizando producto…
          </div>
        </div>`;
    }
    try {
      await this.fetchDetalle(codprod);
      this.refreshDetail();
    } catch (err) {
      F.toast(err.message || 'Error al cargar detalle', 'error');
      this._detalle = null;
      this.refreshDetail();
    } finally {
      this._loadingDetalle = false;
    }
  },

  async imprimirDocumento(coddoc, correlativo, row) {
    if (!coddoc || correlativo === undefined || correlativo === null || correlativo === '') {
      F.toast('Documento incompleto para imprimir', 'warning');
      return;
    }
    if (typeof DocOpciones === 'undefined') {
      F.toast('Componente DocOpciones no disponible', 'error');
      return;
    }
    await DocOpciones.imprimir(coddoc, correlativo, row);
  },

  bindEvents() {
    this._container?.querySelector('#btn-repprod-cargar')?.addEventListener('click', () => {
      this.reload().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#repprod-desde')?.addEventListener('change', () => this.readFilters());
    this._container?.querySelector('#repprod-hasta')?.addEventListener('change', () => this.readFilters());

    this._container?.addEventListener('input', (e) => {
      const input = e.target.closest('.repprod-search');
      if (!input || !this._container.contains(input)) return;
      const section = input.dataset.section || '';
      this._filters[section] = input.value || '';
      if (section === 'productos') this.refreshProductList();
      else if (section === 'documentos') this.refreshDocumentosTable();
      else if (section === 'clientes') this.refreshClientesTable();
    });

    this._container?.querySelector('#repprod-list')?.addEventListener('click', (e) => {
      const card = e.target.closest('.repprod-card');
      if (!card) return;
      const cod = card.getAttribute('data-codprod');
      if (!cod || cod === this._selectedCod || this._loadingDetalle) return;
      this.selectProduct(cod).catch((err) => F.toast(err.message, 'error'));
    });

    this._container?.addEventListener('click', (e) => {
      const btn = e.target.closest('.repprod-print-btn');
      if (!btn || !this._container.contains(btn)) return;
      const tr = btn.closest('tr');
      if (!tr) return;
      const row = {
        CODDOC: tr.dataset.coddoc,
        CORRELATIVO: tr.dataset.correlativo,
        TIPODOC: tr.dataset.tipodoc,
        DESDOC: tr.dataset.desdoc,
      };
      this.imprimirDocumento(row.CODDOC, row.CORRELATIVO, row).catch((err) =>
        F.alert('Error', err.message || 'No se pudo imprimir', 'error')
      );
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
    this._filters = { productos: '', documentos: '', clientes: '' };
    const btn = this._container?.querySelector('#btn-repprod-cargar');
    if (btn) btn.disabled = true;
    try {
      await this.fetchProductos();
      this.refreshProductList();
      const wrap = this._container?.querySelector('#repprod-detail-wrap');
      if (wrap) wrap.innerHTML = this.renderDetailPanel();
      const sorted = this.sortedProductos();
      if (sorted.length) {
        await this.selectProduct(sorted[0].CODPROD);
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
    this._productos = [];
    this._totales = { unidades: 0, precio: 0 };
    this._selectedCod = null;
    this._detalle = null;
    this._sortBy = 'precio';
    this._filters = { productos: '', documentos: '', clientes: '' };
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add('align-items-stretch', 'justify-content-start');
    container.innerHTML = this.render();
    this.bindEvents();
    await this.reload();
  },
};
