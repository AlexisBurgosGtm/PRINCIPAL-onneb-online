/**
 * Reportes → Reportes Clientes
 * Ventas FAC/FEL por cliente: ranking, KPIs, gráfica dual y productos top.
 */
const ReportesClientesView = {
  _container: null,
  _desde: '',
  _hasta: '',
  _loading: false,
  _loadingDetalle: false,
  _clientes: [],
  _totales: { unidades: 0, precio: 0 },
  _selectedKey: null,
  _detalle: null,
  _chart: null,
  _sortBy: 'precio',
  _filters: { clientes: '', documentos: '', productos: '' },

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

  clientKey(c) {
    return `${Number(c.CODCLIENTE) || 0}|${String(c.DOC_NIT || '').trim()}`;
  },

  readFilters() {
    const d = this._container?.querySelector('#repcli-desde');
    const h = this._container?.querySelector('#repcli-hasta');
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

  sortedClientes() {
    const list = [...this._clientes];
    if (this._sortBy === 'unidades') {
      list.sort(
        (a, b) =>
          (Number(b.TOTALUNIDADES) || 0) - (Number(a.TOTALUNIDADES) || 0) ||
          String(a.DOC_NOMCLIE).localeCompare(String(b.DOC_NOMCLIE))
      );
    } else {
      list.sort(
        (a, b) =>
          (Number(b.MONTO) || 0) - (Number(a.MONTO) || 0) ||
          String(a.DOC_NOMCLIE).localeCompare(String(b.DOC_NOMCLIE))
      );
    }
    return list;
  },

  filteredClientes() {
    return this.filterRows(
      this.sortedClientes(),
      ['DOC_NIT', 'DOC_NOMCLIE', 'CODCLIENTE', 'MONTO', 'TOTALUNIDADES'],
      this._filters.clientes
    );
  },

  participacion(c) {
    const total = Number(this._totales?.precio) || 0;
    if (!total) return 0;
    return ((Number(c.MONTO) || 0) / total) * 100;
  },

  async fetchClientes() {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      desde: this._desde,
      hasta: this._hasta,
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/reportes-clientes?${params}`);
    this._clientes = data.clientes || [];
    this._totales = data.totales || { unidades: 0, precio: 0 };
    return data;
  },

  async fetchDetalle(cliente) {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      desde: this._desde,
      hasta: this._hasta,
      codcliente: String(cliente.CODCLIENTE || 0),
      doc_nit: String(cliente.DOC_NIT || '').trim(),
      _: String(Date.now()),
    });
    this._detalle = await F.fetchJson(`/api/reportes-clientes/detalle?${params}`);
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
    const canvas = this._container?.querySelector('#repcli-chart');
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
            backgroundColor: 'rgba(37, 99, 235, 0.5)',
            borderColor: '#2563eb',
            borderWidth: 1,
            yAxisID: 'yUnits',
            order: 2,
          },
          {
            type: 'line',
            label: 'Compras',
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

  renderSortButtons() {
    const precioActive = this._sortBy === 'precio' ? ' active' : '';
    const unidActive = this._sortBy === 'unidades' ? ' active' : '';
    return `
      <div class="repcli-sort-row">
        <button type="button" class="btn btn-sm btn-outline-primary repcli-sort-btn${precioActive}" data-sort="precio">
          <i class="fa-solid fa-sack-dollar me-1"></i>Compras $
        </button>
        <button type="button" class="btn btn-sm btn-outline-primary repcli-sort-btn${unidActive}" data-sort="unidades">
          <i class="fa-solid fa-boxes-stacked me-1"></i>Unidades
        </button>
      </div>`;
  },

  renderClientCards() {
    if (!this._clientes.length) {
      return `<div class="repcli-empty">Sin clientes con ventas en el período</div>`;
    }
    const rows = this.filteredClientes();
    if (!rows.length) {
      return `<div class="repcli-empty">Sin coincidencias</div>`;
    }
    const sortedAll = this.sortedClientes();
    const rankMap = new Map(sortedAll.map((c, i) => [this.clientKey(c), i + 1]));

    return rows
      .map((c) => {
        const key = this.clientKey(c);
        const active = key === this._selectedKey ? ' active' : '';
        const rank = rankMap.get(key) || 0;
        const rankCls = rank <= 3 ? ` rank-${rank}` : '';
        const rankBadge = rank <= 3 ? `<span class="repcli-card-rank${rankCls}">#${rank}</span>` : '';
        const share = this.participacion(c);
        return `
          <div class="repcli-client-card${active}" data-client-key="${this.escapeHtml(key)}"
            data-codcliente="${this.escapeHtml(c.CODCLIENTE || 0)}"
            data-doc-nit="${this.escapeHtml(c.DOC_NIT || '')}">
            ${rankBadge}
            <div class="repcli-client-nit">${this.escapeHtml(c.DOC_NIT || '—')}</div>
            <div class="repcli-client-name">${this.escapeHtml(c.DOC_NOMCLIE || 'Sin nombre')}</div>
            <div class="repcli-client-stats">
              <span><i class="fa-solid fa-box-open me-1 text-muted"></i>${this.escapeHtml(this.formatQty(c.TOTALUNIDADES))}</span>
              <span class="fw-semibold">${this.escapeHtml(this.formatMoney(c.MONTO))}</span>
            </div>
            <div class="repcli-client-share">${this.escapeHtml(this.formatPct(share))} del total vendido</div>
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
    const titulo = d.doc_nomclie || d.doc_nit || 'Cliente';

    return `
      <div class="repcli-hero">
        <div class="repcli-hero-title">${this.escapeHtml(titulo)}</div>
        <div class="repcli-hero-nit">${this.escapeHtml(d.doc_nit || '')}</div>
        <div class="repcli-kpi-row">
          <div class="repcli-kpi">
            <div class="repcli-kpi-label">Compras</div>
            <div class="repcli-kpi-value">${this.escapeHtml(this.formatMoney(r.precio))}</div>
          </div>
          <div class="repcli-kpi">
            <div class="repcli-kpi-label">Unidades</div>
            <div class="repcli-kpi-value">${this.escapeHtml(this.formatQty(r.unidades))}</div>
          </div>
          <div class="repcli-kpi">
            <div class="repcli-kpi-label">Precio prom.</div>
            <div class="repcli-kpi-value">${this.escapeHtml(this.formatMoney(r.precioPromedio))}</div>
          </div>
          <div class="repcli-kpi">
            <div class="repcli-kpi-label">Ticket prom.</div>
            <div class="repcli-kpi-value">${this.escapeHtml(this.formatMoney(r.ticketPromedio))}</div>
          </div>
          <div class="repcli-kpi">
            <div class="repcli-kpi-label">Productos</div>
            <div class="repcli-kpi-value">${this.escapeHtml(r.numProductos ?? 0)}</div>
          </div>
          <div class="repcli-kpi">
            <div class="repcli-kpi-label">Facturas</div>
            <div class="repcli-kpi-value">${this.escapeHtml(r.numDocumentos ?? 0)}</div>
          </div>
          <div class="repcli-kpi">
            <div class="repcli-kpi-label">Participación</div>
            <div class="repcli-kpi-value">${this.escapeHtml(this.formatPct(share))}</div>
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
      'FEL_SERIE',
      'FEL_NUMERO',
      'TOTALPRECIO',
      'DESDOC',
    ], this._filters.documentos);
    if (!rows.length) {
      return `<tr><td colspan="6" class="text-center text-muted py-3">Sin coincidencias</td></tr>`;
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
            <td class="small text-muted">${this.escapeHtml(fel)}</td>
            <td class="text-end">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
            <td class="text-center text-nowrap">
              <button type="button" class="btn btn-sm btn-outline-secondary repcli-print-btn" title="Imprimir documento">
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
      return `<div class="repcli-empty py-2">Sin documentos</div>`;
    }
    const q = this._filters.documentos;
    return `
      <input type="search" class="form-control form-control-sm repcli-search mb-2" data-section="documentos"
        placeholder="Buscar facturas…" value="${this.escapeHtml(q)}">
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0 repcli-table">
          <thead class="table-light sticky-top">
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Documento</th>
              <th>FEL</th>
              <th class="text-end">Total</th>
              <th class="text-center"></th>
            </tr>
          </thead>
          <tbody id="repcli-docs-tbody">${this.renderDocumentosBody()}</tbody>
        </table>
      </div>`;
  },

  renderProductosBody() {
    const all = this._detalle?.productos || [];
    if (!all.length) return '';
    const rows = this.filterRows(
      all,
      ['CODPROD', 'DESPROD', 'TOTALUNIDADES', 'TOTALPRECIO'],
      this._filters.productos
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
            <td class="small font-monospace">${this.escapeHtml(r.CODPROD || '—')}</td>
            <td>
              ${this.escapeHtml(r.DESPROD || '—')}
              <div class="repcli-prod-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
            </td>
            <td class="text-end">${this.escapeHtml(this.formatQty(r.TOTALUNIDADES))}</td>
            <td class="text-end fw-semibold">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
          </tr>`;
      })
      .join('');
  },

  renderProductosTable() {
    const all = this._detalle?.productos || [];
    if (!all.length) {
      return `<div class="repcli-empty py-2">Sin productos</div>`;
    }
    const q = this._filters.productos;
    return `
      <input type="search" class="form-control form-control-sm repcli-search mb-2" data-section="productos"
        placeholder="Buscar productos…" value="${this.escapeHtml(q)}">
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0 repcli-table">
          <thead class="table-light sticky-top">
            <tr>
              <th>Cód.</th>
              <th>Producto</th>
              <th class="text-end">Unidades</th>
              <th class="text-end">Total</th>
            </tr>
          </thead>
          <tbody id="repcli-prods-tbody">${this.renderProductosBody()}</tbody>
        </table>
      </div>`;
  },

  renderDetailPanel() {
    if (!this._selectedKey || !this._detalle) {
      return `
        <div class="card shadow-sm flex-grow-1">
          <div class="card-body repcli-empty">
            <i class="fa-solid fa-users fa-2x mb-2 d-block opacity-50"></i>
            Seleccione un cliente para ver su perfil de compras
          </div>
        </div>`;
    }

    return `
      <div class="repcli-detail-col">
        ${this.renderHero()}
        <div class="card shadow-sm">
          <div class="card-body pb-2">
            <h6 class="card-title small fw-semibold mb-2">
              <i class="fa-solid fa-chart-column me-1 text-primary"></i>Unidades vs compras por fecha
            </h6>
            <div class="repcli-chart-wrap">
              <canvas id="repcli-chart" aria-label="Unidades y compras por fecha"></canvas>
            </div>
          </div>
        </div>
        <div class="card shadow-sm">
          <div class="card-header py-2 small fw-semibold">
            <i class="fa-solid fa-crown me-1 text-warning"></i>Qué compró este cliente
          </div>
          <div class="card-body p-2" id="repcli-prods-host">${this.renderProductosTable()}</div>
        </div>
        <div class="card shadow-sm">
          <div class="card-header py-2 small fw-semibold">Facturas</div>
          <div class="card-body p-2" id="repcli-docs-host">${this.renderDocumentosTable()}</div>
        </div>
      </div>`;
  },

  render() {
    const range = this.defaultRange();
    if (!this._desde) this._desde = range.desde;
    if (!this._hasta) this._hasta = range.hasta;

    return `
      <div class="repcli-wrap">
        <div class="card shadow-sm mb-3 repcli-toolbar">
          <div class="card-body py-2">
            <div class="d-flex flex-wrap align-items-end gap-2">
              <div>
                <label for="repcli-desde" class="form-label small mb-1">Desde</label>
                <input type="date" class="form-control form-control-sm" id="repcli-desde" value="${this.escapeHtml(this._desde)}">
              </div>
              <div>
                <label for="repcli-hasta" class="form-label small mb-1">Hasta</label>
                <input type="date" class="form-control form-control-sm" id="repcli-hasta" value="${this.escapeHtml(this._hasta)}">
              </div>
              <button type="button" class="btn btn-sm btn-primary" id="btn-repcli-cargar" ${this._loading ? 'disabled' : ''}>
                <i class="fa-solid fa-rotate me-1"></i>Cargar
              </button>
              <span class="small text-muted ms-1">${this._clientes.length} cliente(s)</span>
              ${Number(this._totales?.precio) > 0 ? `<span class="small text-primary ms-2 fw-semibold">Total: ${this.escapeHtml(this.formatMoney(this._totales.precio))}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="repcli-body">
          <div class="repcli-clients-col card shadow-sm">
            <div class="card-header py-2 small fw-semibold">
              <i class="fa-solid fa-trophy me-1"></i>Ranking de clientes
            </div>
            <div class="card-body p-2 repcli-clients-body">
              ${this.renderSortButtons()}
              <input type="search" class="form-control form-control-sm repcli-search" data-section="clientes"
                placeholder="Buscar clientes…" value="${this.escapeHtml(this._filters.clientes)}">
              <div class="repcli-clients-scroll" id="repcli-clients-list">
                ${this.renderClientCards()}
              </div>
            </div>
          </div>
          <div id="repcli-detail-wrap" class="repcli-detail-wrap">
            ${this.renderDetailPanel()}
          </div>
        </div>
      </div>`;
  },

  refreshClientList() {
    const el = this._container?.querySelector('#repcli-clients-list');
    if (el) el.innerHTML = this.renderClientCards();
    const sortRow = this._container?.querySelector('.repcli-sort-row');
    if (sortRow) sortRow.outerHTML = this.renderSortButtons();
    this.bindSortButtons();
  },

  refreshDocumentosTable() {
    const tbody = this._container?.querySelector('#repcli-docs-tbody');
    if (tbody) {
      tbody.innerHTML = this.renderDocumentosBody();
      return;
    }
    const el = this._container?.querySelector('#repcli-docs-host');
    if (el) el.innerHTML = this.renderDocumentosTable();
  },

  refreshProductosTable() {
    const tbody = this._container?.querySelector('#repcli-prods-tbody');
    if (tbody) {
      tbody.innerHTML = this.renderProductosBody();
      return;
    }
    const el = this._container?.querySelector('#repcli-prods-host');
    if (el) el.innerHTML = this.renderProductosTable();
  },

  refreshDetail() {
    const wrap = this._container?.querySelector('#repcli-detail-wrap');
    if (wrap) wrap.innerHTML = this.renderDetailPanel();
    this.buildChart();
  },

  bindSortButtons() {
    this._container?.querySelectorAll('.repcli-sort-btn').forEach((btn) => {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        const sort = btn.getAttribute('data-sort');
        if (!sort || sort === this._sortBy) return;
        this._sortBy = sort;
        this.refreshClientList();
      });
    });
  },

  async selectClient(key) {
    const cliente = this._clientes.find((c) => this.clientKey(c) === key);
    if (!cliente) return;
    this._selectedKey = key;
    this._filters.documentos = '';
    this._filters.productos = '';
    this.refreshClientList();
    this._loadingDetalle = true;
    const wrap = this._container?.querySelector('#repcli-detail-wrap');
    if (wrap) {
      wrap.innerHTML = `
        <div class="card shadow-sm flex-grow-1">
          <div class="card-body text-center text-muted py-5">
            <i class="fa-solid fa-spinner fa-spin me-1"></i>Analizando cliente…
          </div>
        </div>`;
    }
    try {
      await this.fetchDetalle(cliente);
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
    this._container?.querySelector('#btn-repcli-cargar')?.addEventListener('click', () => {
      this.reload().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#repcli-desde')?.addEventListener('change', () => this.readFilters());
    this._container?.querySelector('#repcli-hasta')?.addEventListener('change', () => this.readFilters());

    this._container?.addEventListener('input', (e) => {
      const input = e.target.closest('.repcli-search');
      if (!input || !this._container.contains(input)) return;
      const section = input.dataset.section || '';
      this._filters[section] = input.value || '';
      if (section === 'clientes') this.refreshClientList();
      else if (section === 'documentos') this.refreshDocumentosTable();
      else if (section === 'productos') this.refreshProductosTable();
    });

    this._container?.querySelector('#repcli-clients-list')?.addEventListener('click', (e) => {
      const card = e.target.closest('.repcli-client-card');
      if (!card) return;
      const key = card.getAttribute('data-client-key');
      if (!key || key === this._selectedKey || this._loadingDetalle) return;
      this.selectClient(key).catch((err) => F.toast(err.message, 'error'));
    });

    this._container?.addEventListener('click', (e) => {
      const btn = e.target.closest('.repcli-print-btn');
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
    this._selectedKey = null;
    this._detalle = null;
    this._totales = { unidades: 0, precio: 0 };
    this._filters = { clientes: '', documentos: '', productos: '' };
    const btn = this._container?.querySelector('#btn-repcli-cargar');
    if (btn) btn.disabled = true;
    try {
      await this.fetchClientes();
      this.refreshClientList();
      const wrap = this._container?.querySelector('#repcli-detail-wrap');
      if (wrap) wrap.innerHTML = this.renderDetailPanel();
      const sorted = this.sortedClientes();
      if (sorted.length) {
        await this.selectClient(this.clientKey(sorted[0]));
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
    this._clientes = [];
    this._totales = { unidades: 0, precio: 0 };
    this._selectedKey = null;
    this._detalle = null;
    this._sortBy = 'precio';
    this._filters = { clientes: '', documentos: '', productos: '' };
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add('align-items-stretch', 'justify-content-start');
    container.innerHTML = this.render();
    this.bindEvents();
    await this.reload();
  },
};
