/**
 * Reportes → Auditoría Cajas
 * Lista cortes (mes/año) y detalle de documentos por TIPODOC.
 */
const AuditoriaCajasView = {
  _container: null,
  _section: 'list', // list | detail
  _mes: null,
  _anio: null,
  _cortes: [],
  _corte: null,
  _grupos: [],
  _print: null,
  _filters: {},
  _selectedTipodoc: '',
  _concreFilter: '', // '' | CON | CRE
  _productos: [],
  _selectorProductos: '__PRODUCTOS__',
  _selectorTodos: '__TODOS__',
  _loading: false,
  _totalGeneral: 0,
  _totalDocs: 0,

  DOC_COLSPAN: 12,
  TIPODOC_FACTURA: ['FAC', 'FEF', 'FES', 'FEC'],
  TIPODOC_DEVOLUCION: ['DEV', 'FNC'],
  TIPODOC_RECIBOS: ['RCC', 'PRC'],

  escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  defaultPeriod() {
    const now = new Date();
    return { mes: now.getMonth() + 1, anio: now.getFullYear() };
  },

  formatFecha(value) {
    if (!value) return '—';
    const s = String(value).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    const dt = new Date(s);
    if (Number.isNaN(dt.getTime())) return this.escapeHtml(s);
    const d = String(dt.getDate()).padStart(2, '0');
    const mo = String(dt.getMonth() + 1).padStart(2, '0');
    return `${d}/${mo}/${dt.getFullYear()}`;
  },

  formatHora(hora, minuto) {
    const h = Number(hora);
    const m = Number(minuto);
    if (!Number.isFinite(h)) return '—';
    return `${String(h).padStart(2, '0')}:${String(Number.isFinite(m) ? m : 0).padStart(2, '0')}`;
  },

  formatMoney(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '—';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  formatMoneyCell(value) {
    const n = Number(value) || 0;
    if (!n) return '—';
    return this.formatMoney(n);
  },

  concreLabel(concre) {
    return String(concre || '').toUpperCase() === 'CRE' ? 'Crédito' : 'Contado';
  },

  concreFilterLabel() {
    if (this._concreFilter === 'CON') return 'Contado';
    if (this._concreFilter === 'CRE') return 'Crédito';
    return 'Todos';
  },

  mesOptionsHtml() {
    const names = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
    ];
    return names
      .map((label, i) => {
        const mes = i + 1;
        const sel = mes === Number(this._mes) ? ' selected' : '';
        return `<option value="${mes}"${sel}>${label}</option>`;
      })
      .join('');
  },

  anioOptionsHtml() {
    const cur = new Date().getFullYear();
    const years = [];
    for (let y = cur + 1; y >= 2020; y -= 1) years.push(y);
    return years
      .map((y) => {
        const sel = y === Number(this._anio) ? ' selected' : '';
        return `<option value="${y}"${sel}>${y}</option>`;
      })
      .join('');
  },

  tipodocOptionsHtml() {
    const selTodos =
      String(this._selectedTipodoc) === String(this._selectorTodos) ? ' selected' : '';
    const todosCount = (this._grupos || []).reduce((s, g) => s + (Number(g.count) || 0), 0);
    const gruposOpts = (this._grupos || [])
      .map((g) => {
        const sel = String(g.TIPODOC) === String(this._selectedTipodoc) ? ' selected' : '';
        return `<option value="${this.escapeHtml(g.TIPODOC)}"${sel}>${this.escapeHtml(
          g.TIPODOC
        )} — ${this.escapeHtml(g.DESDOC || '')} (${g.count})</option>`;
      })
      .join('');
    const selProd =
      String(this._selectedTipodoc) === String(this._selectorProductos) ? ' selected' : '';
    return `<option value="${this.escapeHtml(this._selectorTodos)}"${selTodos}>Todos (${todosCount})</option>${gruposOpts}<option value="${this.escapeHtml(this._selectorProductos)}"${selProd}>Resumen Productos (${(this._productos || []).length})</option>`;
  },

  isProductosView() {
    return String(this._selectedTipodoc) === String(this._selectorProductos);
  },

  isTodosView() {
    return String(this._selectedTipodoc) === String(this._selectorTodos);
  },

  concreOptionsHtml() {
    const opts = [
      { value: '', label: 'Todos' },
      { value: 'CON', label: 'Contado' },
      { value: 'CRE', label: 'Crédito' },
    ];
    return opts
      .map((o) => {
        const sel = String(this._concreFilter) === String(o.value) ? ' selected' : '';
        return `<option value="${o.value}"${sel}>${o.label}</option>`;
      })
      .join('');
  },

  buildTodosGrupo() {
    const rows = [];
    let anulados = 0;
    for (const g of this._grupos || []) {
      for (const r of g.rows || []) {
        rows.push(r);
        if (r.STATUS === 'A') anulados += 1;
      }
    }
    rows.sort((a, b) => {
      const fa = String(a.FECHA || '');
      const fb = String(b.FECHA || '');
      if (fa !== fb) return fa.localeCompare(fb);
      const ta = String(a.TIPODOC || '');
      const tb = String(b.TIPODOC || '');
      if (ta !== tb) return ta.localeCompare(tb, 'es');
      const ca = String(a.CODDOC || '');
      const cb = String(b.CODDOC || '');
      if (ca !== cb) return ca.localeCompare(cb, 'es');
      return (Number(a.CORRELATIVO) || 0) - (Number(b.CORRELATIVO) || 0);
    });
    return {
      TIPODOC: this._selectorTodos,
      DESDOC: 'Todos los documentos',
      rows,
      count: rows.length,
      anulados,
      ES_TODOS: true,
    };
  },

  visibleGrupos() {
    if (!this._selectedTipodoc || this.isProductosView()) return [];
    if (this.isTodosView()) {
      return this._grupos.length ? [this.buildTodosGrupo()] : [];
    }
    return (this._grupos || []).filter((g) => String(g.TIPODOC) === String(this._selectedTipodoc));
  },

  readListFilters() {
    const mesEl = this._container?.querySelector('#audcaja-mes');
    const anioEl = this._container?.querySelector('#audcaja-anio');
    if (mesEl) this._mes = Number(mesEl.value) || this._mes;
    if (anioEl) this._anio = Number(anioEl.value) || this._anio;
  },

  async fetchCortes() {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      mes: String(this._mes),
      anio: String(this._anio),
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/auditoria-cajas/cortes?${params}`);
    this._cortes = data.rows || [];
  },

  async fetchDetalle(id) {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/auditoria-cajas/cortes/${encodeURIComponent(id)}?${params}`);
    this._corte = data.corte || null;
    this._print = data.print || null;
    this._grupos = data.grupos || [];
    this._productos = data.productos || [];
    this._selectorProductos = data.selectorProductos || '__PRODUCTOS__';
    this._totalGeneral = Number(data.totalGeneral) || 0;
    this._totalDocs = Number(data.totalDocs) || 0;
    this._concreFilter = '';
    this._selectedTipodoc = this._grupos.length ? this._selectorTodos : this._selectorProductos;
    this._filters = {};
    this._filters[this._selectorTodos] = '';
    for (const g of this._grupos) {
      this._filters[g.TIPODOC] = '';
    }
  },

  filteredGrupoRows(grupo) {
    let rows = grupo.rows || [];
    if (this._concreFilter === 'CON' || this._concreFilter === 'CRE') {
      rows = rows.filter((r) => String(r.CONCRE || 'CON').toUpperCase() === this._concreFilter);
    }
    const q = String(this._filters[grupo.TIPODOC] || '')
      .trim()
      .toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = [
        this.formatFecha(r.FECHA),
        r.CODDOC,
        r.CORRELATIVO,
        r.CLIENTE,
        r.STATUS,
        r.TIPODOC,
        r.DESDOC,
        r.CONCRE_LABEL || this.concreLabel(r.CONCRE),
        r.IMPORTE,
        r.TOTALPRECIO,
        r.FPAGO_EFECTIVO,
        r.FPAGO_TARJETA,
        r.FPAGO_DEPOSITO,
        r.FPAGO_CHEQUE,
      ]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      return hay.includes(q);
    });
  },

  sumRows(rows) {
    const acc = {
      total: 0,
      totalEfectivo: 0,
      totalTarjeta: 0,
      totalDeposito: 0,
      totalCheque: 0,
      count: 0,
    };
    for (const r of rows || []) {
      acc.total += Number(r.IMPORTE) || 0;
      acc.totalEfectivo += Number(r.FPAGO_EFECTIVO) || 0;
      acc.totalTarjeta += Number(r.FPAGO_TARJETA) || 0;
      acc.totalDeposito += Number(r.FPAGO_DEPOSITO) || 0;
      acc.totalCheque += Number(r.FPAGO_CHEQUE) || 0;
      acc.count += 1;
    }
    return acc;
  },

  grupoTotalesFiltrados(grupo) {
    return this.sumRows(this.filteredGrupoRows(grupo));
  },

  renderDocRow(r) {
    const anulado = r.STATUS === 'A';
    const concre = String(r.CONCRE || 'CON').toUpperCase();
    const isCredito = concre === 'CRE';
    const badgeClass = isCredito ? 'text-bg-danger' : 'text-bg-primary';
    const badgeLabel = isCredito ? 'Crédito' : 'Contado';
    const printBtn = r.ES_RETIRO || r.ES_VALE_CAJA
      ? '<span class="text-muted small">—</span>'
      : `<button type="button" class="btn btn-sm btn-outline-secondary audcaja-doc-print"
            title="Imprimir documento"
            data-coddoc="${this.escapeHtml(r.CODDOC)}"
            data-corr="${this.escapeHtml(r.CORRELATIVO)}">
            <i class="fa-solid fa-print"></i>
          </button>`;
    return `
      <tr class="${anulado ? 'audcaja-row-anulado' : ''}"
        data-coddoc="${this.escapeHtml(r.CODDOC)}"
        data-corr="${this.escapeHtml(r.CORRELATIVO)}">
        <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
        <td>${this.escapeHtml(r.CODDOC || '—')}</td>
        <td class="text-end">${this.escapeHtml(r.CORRELATIVO ?? '—')}</td>
        <td>${this.escapeHtml(r.CLIENTE || '—')}</td>
        <td class="text-center">
          <span class="badge ${badgeClass} audcaja-badge-concre">${this.escapeHtml(badgeLabel)}</span>
        </td>
        <td class="text-end">${this.escapeHtml(this.formatMoneyCell(r.FPAGO_EFECTIVO))}</td>
        <td class="text-end">${this.escapeHtml(this.formatMoneyCell(r.FPAGO_TARJETA))}</td>
        <td class="text-end">${this.escapeHtml(this.formatMoneyCell(r.FPAGO_DEPOSITO))}</td>
        <td class="text-end">${this.escapeHtml(this.formatMoneyCell(r.FPAGO_CHEQUE))}</td>
        <td class="text-end">${this.escapeHtml(this.formatMoney(r.IMPORTE))}</td>
        <td class="text-center">${this.escapeHtml(r.STATUS)}</td>
        <td class="text-center">${printBtn}</td>
      </tr>`;
  },

  renderGrupoFoot(totales) {
    return `
      <tr>
        <td colspan="5" class="text-end fw-semibold">Totales (${totales.count})</td>
        <td class="text-end fw-semibold audcaja-tot-efe">${this.escapeHtml(this.formatMoney(totales.totalEfectivo))}</td>
        <td class="text-end fw-semibold audcaja-tot-tar">${this.escapeHtml(this.formatMoney(totales.totalTarjeta))}</td>
        <td class="text-end fw-semibold audcaja-tot-dep">${this.escapeHtml(this.formatMoney(totales.totalDeposito))}</td>
        <td class="text-end fw-semibold audcaja-tot-che">${this.escapeHtml(this.formatMoney(totales.totalCheque))}</td>
        <td class="text-end fw-semibold audcaja-grupo-total">${this.escapeHtml(this.formatMoney(totales.total))}</td>
        <td colspan="2"></td>
      </tr>`;
  },

  productoMetrics(p) {
    if (this._concreFilter === 'CON') {
      return { unidades: p.UNIDADES_CON, precio: p.PRECIO_CON };
    }
    if (this._concreFilter === 'CRE') {
      return { unidades: p.UNIDADES_CRE, precio: p.PRECIO_CRE };
    }
    return { unidades: p.UNIDADES, precio: p.PRECIO };
  },

  filteredProductos() {
    return (this._productos || []).filter((p) => {
      const m = this.productoMetrics(p);
      return Number(m.unidades) !== 0 || Number(m.precio) !== 0;
    });
  },

  renderProductosTable() {
    const rows = this.filteredProductos();
    let totU = 0;
    let totP = 0;
    const body = !rows.length
      ? `<tr><td colspan="4" class="text-center text-muted py-3">Sin productos en el corte</td></tr>`
      : rows
          .map((p) => {
            const m = this.productoMetrics(p);
            totU += Number(m.unidades) || 0;
            totP += Number(m.precio) || 0;
            return `<tr>
              <td class="font-monospace small">${this.escapeHtml(p.CODPROD)}</td>
              <td>${this.escapeHtml(p.DESPROD || '—')}</td>
              <td class="text-end">${this.escapeHtml(Number(m.unidades).toLocaleString('es-GT', { maximumFractionDigits: 3 }))}</td>
              <td class="text-end">${this.escapeHtml(this.formatMoney(m.precio))}</td>
            </tr>`;
          })
          .join('');

    return `
      <section class="audcaja-grupo audcaja-productos">
        <div class="audcaja-grupo-head d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div>
            <h3 class="audcaja-grupo-title mb-0">Resumen Productos</h3>
            <div class="text-muted audcaja-grupo-meta">${rows.length} producto(s) · Pago: ${this.escapeHtml(
              this.concreFilterLabel()
            )} (facturas − devoluciones)</div>
          </div>
        </div>
        <div class="audcaja-grupo-scroll">
          <table class="table table-sm table-hover align-middle mb-0 audcaja-table">
            <thead class="sticky-top">
              <tr>
                <th>CODPROD</th>
                <th>DESPROD</th>
                <th class="text-end">TOTALUNIDADES</th>
                <th class="text-end">TOTALPRECIO</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        <div class="audcaja-grupo-footer">
          <table class="table table-sm align-middle mb-0 audcaja-table">
            <tbody>
              <tr>
                <td colspan="2" class="text-end fw-semibold">Totales</td>
                <td class="text-end fw-semibold">${this.escapeHtml(
                  totU.toLocaleString('es-GT', { maximumFractionDigits: 3 })
                )}</td>
                <td class="text-end fw-semibold">${this.escapeHtml(this.formatMoney(totP))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>`;
  },

  renderCortesBody() {
    if (this._loading) {
      return `<tr><td colspan="9" class="text-center text-muted py-4">
        <i class="fa-solid fa-spinner fa-spin me-1"></i>Cargando…
      </td></tr>`;
    }
    if (!this._cortes.length) {
      return `<tr><td colspan="9" class="text-center text-muted py-4">No hay cortes en el período</td></tr>`;
    }
    return this._cortes
      .map(
        (c) => `
      <tr class="audcaja-corte-row" data-id="${this.escapeHtml(c.ID)}" role="button" tabindex="0">
        <td class="text-nowrap">${this.escapeHtml(c.CORRELATIVO)}</td>
        <td class="text-nowrap">${this.escapeHtml(this.formatFecha(c.FECHA))}</td>
        <td class="text-nowrap">${this.escapeHtml(this.formatHora(c.HORA, c.MINUTO))}</td>
        <td>${this.escapeHtml(c.DESCAJA || `Caja ${c.CODCAJA}`)}</td>
        <td class="text-end">${this.escapeHtml(c.TOTALMOVIMIENTOS)}</td>
        <td class="text-end">${this.escapeHtml(this.formatMoney(c.TOTALVENTA))}</td>
        <td class="text-end">${this.escapeHtml(this.formatMoney(c.TOTALREPORTADO))}</td>
        <td>${this.escapeHtml(c.USUARIO || '—')}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-primary audcaja-abrir" data-id="${this.escapeHtml(c.ID)}">
            Ver
          </button>
        </td>
      </tr>`
      )
      .join('');
  },

  renderListHtml() {
    return `
      <div class="pos-list-wrap audcaja-wrap">
        <div class="pos-list-header d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div>
            <h2 class="pos-list-title mb-0">Auditoría Cajas</h2>
            <p class="pos-list-sub text-muted mb-0">${this._cortes.length} corte(s)</p>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="audcaja-reload">
            <i class="fa-solid fa-rotate me-1"></i>Actualizar
          </button>
        </div>
        <div class="d-flex flex-wrap align-items-end gap-2 mb-3 mt-2">
          <div>
            <label class="form-label form-label-sm mb-0" for="audcaja-mes">Mes</label>
            <select id="audcaja-mes" class="form-select form-select-sm">${this.mesOptionsHtml()}</select>
          </div>
          <div>
            <label class="form-label form-label-sm mb-0" for="audcaja-anio">Año</label>
            <select id="audcaja-anio" class="form-select form-select-sm">${this.anioOptionsHtml()}</select>
          </div>
          <button type="button" class="btn btn-sm btn-primary" id="audcaja-aplicar">Aplicar</button>
        </div>
        <div class="table-responsive audcaja-list-scroll">
          <table class="table table-sm table-hover align-middle mb-0 audcaja-table">
            <thead>
              <tr>
                <th>No. corte</th>
                <th>Fecha</th>
                <th>Hora</th>
                <th>Caja</th>
                <th class="text-end">Movs.</th>
                <th class="text-end">Total venta</th>
                <th class="text-end">Reportado</th>
                <th>Usuario</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="audcaja-cortes-tbody">${this.renderCortesBody()}</tbody>
          </table>
        </div>
      </div>`;
  },

  renderGrupoTable(grupo) {
    const q = this.escapeHtml(this._filters[grupo.TIPODOC] || '');
    const rows = this.filteredGrupoRows(grupo);
    const totales = this.grupoTotalesFiltrados(grupo);
    const body = !rows.length
      ? `<tr><td colspan="${this.DOC_COLSPAN}" class="text-center text-muted py-2">Sin filas</td></tr>`
      : rows.map((r) => this.renderDocRow(r)).join('');
    const title = grupo.ES_TODOS
      ? 'Todos los documentos'
      : `${this.escapeHtml(grupo.TIPODOC)}
              <span class="text-muted fw-normal">— ${this.escapeHtml(grupo.DESDOC || '')}</span>`;
    const metaTipos = grupo.ES_TODOS
      ? ` · ${(this._grupos || []).length} tipo(s)`
      : '';

    return `
      <section class="audcaja-grupo" data-tipodoc="${this.escapeHtml(grupo.TIPODOC)}">
        <div class="audcaja-grupo-head d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div>
            <h3 class="audcaja-grupo-title mb-0">${title}</h3>
            <div class="text-muted audcaja-grupo-meta">${rows.length} de ${grupo.count} doc(s)${
              grupo.anulados ? ` · ${grupo.anulados} anulado(s)` : ''
            }${metaTipos} · Pago: ${this.escapeHtml(this.concreFilterLabel())}</div>
          </div>
          <div class="audcaja-grupo-search">
            <input type="search" class="form-control form-control-sm audcaja-grupo-q"
              data-tipodoc="${this.escapeHtml(grupo.TIPODOC)}"
              placeholder="Buscar…" value="${q}">
          </div>
        </div>
        <div class="audcaja-grupo-scroll">
          <table class="table table-sm table-hover align-middle mb-0 audcaja-table">
            <thead class="sticky-top">
              <tr>
                <th>Fecha</th>
                <th>Coddoc</th>
                <th class="text-end">Correlativo</th>
                <th>Cliente</th>
                <th class="text-center">Contado/Crédito</th>
                <th class="text-end">Efectivo</th>
                <th class="text-end">Tarjeta</th>
                <th class="text-end">Depósito</th>
                <th class="text-end">Cheque</th>
                <th class="text-end">Importe</th>
                <th class="text-center">Status</th>
                <th class="text-center" style="width:2.75rem"></th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        <div class="audcaja-grupo-footer">
          <table class="table table-sm align-middle mb-0 audcaja-table">
            <tbody class="audcaja-foot-body">${this.renderGrupoFoot(totales)}</tbody>
          </table>
        </div>
      </section>`;
  },

  detailContentHtml() {
    if (!this._grupos.length && !(this._productos || []).length) {
      return `<p class="text-muted mb-0">Este corte no tiene documentos marcados (NOCORTE).</p>`;
    }
    if (this.isProductosView()) return this.renderProductosTable();
    const tipodocOpts = this.tipodocOptionsHtml();
    if (!tipodocOpts) return `<p class="text-muted mb-0">Sin tipos de documento en este corte.</p>`;
    const grupos = this.visibleGrupos();
    if (!grupos.length) return `<p class="text-muted mb-0">Seleccione un tipo de documento.</p>`;
    return grupos.map((g) => this.renderGrupoTable(g)).join('');
  },

  allDocRows() {
    const rows = [];
    for (const g of this._grupos || []) {
      for (const r of g.rows || []) rows.push(r);
    }
    return rows;
  },

  inTipoSet(row, set) {
    return set.has(String(row.TIPODOC || '').trim().toUpperCase());
  },

  filterRowsByRubro(filtro) {
    const rows = this.allDocRows();
    const fac = new Set(this.TIPODOC_FACTURA);
    const dev = new Set(this.TIPODOC_DEVOLUCION);
    const rcc = new Set(this.TIPODOC_RECIBOS);
    switch (String(filtro || '')) {
      case 'todos':
        return rows;
      case 'ventas':
        return rows.filter((r) => this.inTipoSet(r, fac));
      case 'devoluciones':
        return rows.filter((r) => this.inTipoSet(r, dev));
      case 'credito':
        return rows.filter(
          (r) =>
            String(r.CONCRE || '').toUpperCase() === 'CRE' &&
            !this.inTipoSet(r, dev) &&
            !this.inTipoSet(r, rcc)
        );
      case 'recibos':
        return rows.filter((r) => this.inTipoSet(r, rcc));
      case 'efectivo':
        return rows.filter((r) => Number(r.FPAGO_EFECTIVO) > 0 && !this.inTipoSet(r, dev));
      case 'tarjeta':
        return rows.filter((r) => Number(r.FPAGO_TARJETA) > 0 && !this.inTipoSet(r, dev));
      case 'deposito':
        return rows.filter((r) => Number(r.FPAGO_DEPOSITO) > 0 && !this.inTipoSet(r, dev));
      case 'cheque':
        return rows.filter((r) => Number(r.FPAGO_CHEQUE) > 0 && !this.inTipoSet(r, dev));
      case 'vales-caja':
        return rows.filter((r) => r.ES_VALE_CAJA);
      case 'retiros':
        return rows.filter((r) => r.ES_RETIRO);
      case 'anuladas':
        return rows.filter((r) => r.STATUS === 'A' && this.inTipoSet(r, fac));
      default:
        return [];
    }
  },

  rubroTitulo(filtro) {
    const map = {
      todos: 'Movimientos / documentos',
      ventas: 'Ventas brutas',
      devoluciones: 'Notas de crédito (DEV/FNC)',
      credito: 'Ventas al crédito',
      recibos: 'Recibos RCC/PRC',
      efectivo: 'Efectivo',
      tarjeta: 'Tarjeta',
      deposito: 'Depósito',
      cheque: 'Cheque',
      'vales-caja': 'Vales de caja',
      retiros: 'Retiros a banco',
      anuladas: 'Anuladas',
    };
    return map[filtro] || 'Documentos del rubro';
  },

  rubroImporte(row, filtro) {
    if (filtro === 'tarjeta') return Number(row.FPAGO_TARJETA) || 0;
    if (filtro === 'deposito') return Number(row.FPAGO_DEPOSITO) || 0;
    if (filtro === 'cheque') return Number(row.FPAGO_CHEQUE) || 0;
    if (filtro === 'efectivo') return Number(row.FPAGO_EFECTIVO) || 0;
    const n = Number(row.IMPORTE) || 0;
    return filtro === 'devoluciones' ? Math.abs(n) : n;
  },

  renderResumenItem(label, value, filtro, extraClass = '') {
    const cls = extraClass ? ` ${extraClass}` : '';
    if (filtro) {
      return `
        <button type="button" class="audcaja-resumen-item audcaja-resumen-click${cls}"
          data-audcaja-filtro="${this.escapeHtml(filtro)}" title="Ver documentos de este rubro">
          <span class="audcaja-resumen-label">${this.escapeHtml(label)}</span>
          <span class="audcaja-resumen-value">${this.escapeHtml(value)}</span>
        </button>`;
    }
    return `
      <div class="audcaja-resumen-item${cls}">
        <span class="audcaja-resumen-label">${this.escapeHtml(label)}</span>
        <span class="audcaja-resumen-value">${this.escapeHtml(value)}</span>
      </div>`;
  },

  renderResumenHtml() {
    const r = this._print?.resumen || {};
    const reportado = this._print?.reportado || {};
    const faltante = Number(this._print?.faltante) || 0;
    const sobrante = Number(this._print?.sobrante) || 0;
    const diffHtml =
      faltante > 0
        ? this.renderResumenItem('Faltante', this.formatMoney(faltante), '', 'text-danger')
        : sobrante > 0
          ? this.renderResumenItem('Sobrante', this.formatMoney(sobrante), '', 'text-success')
          : this.renderResumenItem('Diferencia efectivo', 'Sin diferencia', '');

    return `
      <div class="audcaja-resumen-list">
        ${this.renderResumenItem('Movimientos', String(r.totalMovimientos ?? 0), 'todos')}
        ${this.renderResumenItem('Ventas brutas', this.formatMoney(r.totalVentasBrutas ?? r.totalVenta), 'ventas')}
        ${this.renderResumenItem('Notas de crédito', this.formatMoney(r.totalDevoluciones || 0), 'devoluciones', 'text-danger')}
        ${this.renderResumenItem('Total venta (neto)', this.formatMoney(r.totalVenta), 'todos')}
        ${this.renderResumenItem('Crédito', this.formatMoney(r.totalCredito), 'credito')}
        ${this.renderResumenItem('Recibos RCC/PRC', this.formatMoney(r.totalRecibos || 0), 'recibos', 'text-success')}
        ${this.renderResumenItem('Vales de caja (−)', this.formatMoney(r.totalValesCaja || 0), 'vales-caja', 'text-danger')}
        ${this.renderResumenItem('Retiros a banco (−)', this.formatMoney(r.totalRetiros || 0), 'retiros', 'text-danger')}
        ${this.renderResumenItem('Efectivo esperado', this.formatMoney(r.efectivoEsperado), 'efectivo', 'text-primary')}
        ${this.renderResumenItem('Efectivo (neto)', this.formatMoney(r.fpEfectivo), 'efectivo')}
        ${this.renderResumenItem('Tarjeta', this.formatMoney(r.fpTarjeta), 'tarjeta')}
        ${this.renderResumenItem('Depósito', this.formatMoney(r.fpDeposito), 'deposito')}
        ${this.renderResumenItem('Cheque', this.formatMoney(r.fpCheque), 'cheque')}
        <div class="audcaja-resumen-sep">Arqueo reportado</div>
        ${this.renderResumenItem('Efectivo contado', this.formatMoney(reportado.efectivo), '')}
        ${this.renderResumenItem('Tarjeta reportada', this.formatMoney(reportado.tarjeta), '')}
        ${this.renderResumenItem('Cheques reportados', this.formatMoney(reportado.cheques), '')}
        ${this.renderResumenItem('Depósito reportado', this.formatMoney(reportado.deposito), '')}
        ${diffHtml}
      </div>`;
  },

  renderRubroModalTable(filtro, rows) {
    if (!rows.length) {
      return '<p class="text-muted small mb-0 text-center py-3">Sin documentos en este rubro.</p>';
    }
    let total = 0;
    const body = rows
      .map((r) => {
        const imp = this.rubroImporte(r, filtro);
        total += imp;
        const anulado = r.STATUS === 'A' ? ' audcaja-row-anulado' : '';
        return `<tr class="${anulado}">
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
          <td>${this.escapeHtml(r.CODDOC || '—')}</td>
          <td class="text-end">${this.escapeHtml(r.CORRELATIVO ?? '—')}</td>
          <td>${this.escapeHtml(r.CLIENTE || '—')}</td>
          <td class="text-end fw-semibold">${this.escapeHtml(this.formatMoney(imp))}</td>
        </tr>`;
      })
      .join('');
    return `
      <div class="table-responsive audcaja-rubro-modal-table">
        <table class="table table-sm table-hover align-middle mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>Fecha</th>
              <th>Coddoc</th>
              <th class="text-end">Corr.</th>
              <th>Cliente</th>
              <th class="text-end">Importe</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr>
              <td colspan="4" class="text-end fw-semibold">Total (${rows.length})</td>
              <td class="text-end fw-semibold">${this.escapeHtml(this.formatMoney(total))}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  },

  async showRubroModal(filtro) {
    const rows = this.filterRowsByRubro(filtro);
    await Swal.fire({
      ...(typeof CatalogosUI !== 'undefined' ? CatalogosUI.modalBase() : {}),
      title: this.rubroTitulo(filtro),
      width: '48rem',
      html: this.renderRubroModalTable(filtro, rows),
      confirmButtonText:
        typeof CatalogosUI !== 'undefined' ? CatalogosUI.guardarButtonHtml('Cerrar') : 'Cerrar',
      showCancelButton: false,
    });
  },

  renderDetailHtml() {
    const c = this._corte || {};
    const tipodocOpts = this.tipodocOptionsHtml();

    return `
      <div class="pos-list-wrap audcaja-wrap audcaja-detail">
        <div class="pos-list-header d-flex flex-wrap align-items-start justify-content-between gap-2">
          <div>
            <button type="button" class="btn btn-sm btn-outline-secondary mb-2" id="audcaja-back">
              <i class="fa-solid fa-arrow-left me-1"></i>Volver a cortes
            </button>
            <h2 class="pos-list-title mb-0">Corte #${this.escapeHtml(c.CORRELATIVO)}</h2>
            <p class="pos-list-sub text-muted mb-0">
              ${this.escapeHtml(this.formatFecha(c.FECHA))}
              ${this.escapeHtml(this.formatHora(c.HORA, c.MINUTO))}
              · ${this.escapeHtml(c.DESCAJA || `Caja ${c.CODCAJA}`)}
              · Usuario ${this.escapeHtml(c.USUARIO || '—')}
              · ${this._totalDocs} doc(s)
              · Total ${this.escapeHtml(this.formatMoney(this._totalGeneral))}
            </p>
          </div>
          <div class="d-flex flex-wrap align-items-end gap-2">
            <div>
              <label class="form-label form-label-sm mb-0" for="audcaja-tipodoc">Tipo de documento</label>
              <select id="audcaja-tipodoc" class="form-select form-select-sm audcaja-tipodoc-select"
                ${tipodocOpts ? '' : 'disabled'}>
                ${tipodocOpts || '<option value="">Sin tipos</option>'}
              </select>
            </div>
            <div>
              <label class="form-label form-label-sm mb-0" for="audcaja-concre">Contado / Crédito</label>
              <select id="audcaja-concre" class="form-select form-select-sm audcaja-concre-select">
                ${this.concreOptionsHtml()}
              </select>
            </div>
            <button type="button" class="btn btn-sm btn-outline-primary" id="audcaja-print-cuadre">
              <i class="fa-solid fa-receipt me-1"></i>Imprimir Cuadre
            </button>
            <button type="button" class="btn btn-sm btn-primary" id="audcaja-print-reporte">
              <i class="fa-solid fa-print me-1"></i>Imprimir Reporte
            </button>
          </div>
        </div>
        <div class="row g-2 audcaja-detail-grid">
          <div class="col-12 col-lg-4 d-flex">
            <div class="card shadow-sm w-100 audcaja-resumen-card">
              <div class="card-header py-2 fw-semibold">Resumen del corte</div>
              <div class="card-body p-2" id="audcaja-resumen">
                ${this.renderResumenHtml()}
              </div>
            </div>
          </div>
          <div class="col-12 col-lg-8 d-flex">
            <div class="card shadow-sm w-100 audcaja-docs-card">
              <div class="card-body p-2 d-flex flex-column min-h-0" id="audcaja-grupos">
                ${this.detailContentHtml()}
              </div>
            </div>
          </div>
        </div>
      </div>`;
  },

  render() {
    if (!this._container) return;
    this._container.innerHTML =
      this._section === 'detail' ? this.renderDetailHtml() : this.renderListHtml();
    this.bindEvents();
  },

  refreshGruposPanel() {
    const scroll = this._container?.querySelector('#audcaja-grupos');
    if (!scroll) return;
    scroll.innerHTML = this.detailContentHtml();
    this.bindDetailGrupoEvents();
  },

  bindDocPrintButtons(root) {
    root?.querySelectorAll('.audcaja-doc-print').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.printDocumento(btn.getAttribute('data-coddoc'), btn.getAttribute('data-corr'), btn).catch(
          (err) => F.toast(err.message || 'No se pudo imprimir', 'error')
        );
      });
    });
  },

  bindDetailGrupoEvents() {
    this._container?.querySelectorAll('.audcaja-grupo-q').forEach((input) => {
      let timer = null;
      input.addEventListener('input', () => {
        const tipodoc = input.getAttribute('data-tipodoc');
        this._filters[tipodoc] = input.value || '';
        clearTimeout(timer);
        timer = setTimeout(() => this.refreshGrupo(tipodoc), 120);
      });
    });
    this.bindDocPrintButtons(this._container);
  },

  bindEvents() {
    if (this._section === 'list') {
      this._container.querySelector('#audcaja-reload')?.addEventListener('click', () => this.reloadList());
      this._container.querySelector('#audcaja-aplicar')?.addEventListener('click', () => this.reloadList());
      const tbody = this._container.querySelector('#audcaja-cortes-tbody');
      tbody?.addEventListener('click', (e) => {
        const btn = e.target.closest('.audcaja-abrir, .audcaja-corte-row');
        if (!btn) return;
        const id = Number(btn.getAttribute('data-id') || btn.closest('tr')?.getAttribute('data-id'));
        if (Number.isFinite(id)) this.openDetalle(id);
      });
      tbody?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const tr = e.target.closest('.audcaja-corte-row');
        if (!tr) return;
        e.preventDefault();
        const id = Number(tr.getAttribute('data-id'));
        if (Number.isFinite(id)) this.openDetalle(id);
      });
      return;
    }

    this._container.querySelector('#audcaja-back')?.addEventListener('click', () => this.backToList());
    this._container.querySelector('#audcaja-tipodoc')?.addEventListener('change', (e) => {
      this._selectedTipodoc = String(e.target.value || '');
      this.refreshGruposPanel();
    });
    this._container.querySelector('#audcaja-concre')?.addEventListener('change', (e) => {
      this._concreFilter = String(e.target.value || '');
      this.refreshGruposPanel();
    });
    this._container.querySelector('#audcaja-print-cuadre')?.addEventListener('click', () => {
      this.imprimirCuadre().catch((err) => F.toast(err.message || 'No se pudo imprimir el cuadre', 'error'));
    });
    this._container.querySelector('#audcaja-print-reporte')?.addEventListener('click', () => {
      this.imprimirReporte().catch((err) =>
        F.toast(err.message || 'No se pudo imprimir el reporte', 'error')
      );
    });
    this._container.querySelector('#audcaja-resumen')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-audcaja-filtro]');
      if (!btn) return;
      const filtro = btn.getAttribute('data-audcaja-filtro');
      if (filtro) this.showRubroModal(filtro);
    });
    this.bindDetailGrupoEvents();
  },

  refreshGrupo(tipodoc) {
    const section = this._container?.querySelector(
      `.audcaja-grupo[data-tipodoc="${String(tipodoc).replace(/"/g, '')}"]`
    );
    const grupo =
      String(tipodoc) === String(this._selectorTodos)
        ? this.buildTodosGrupo()
        : this._grupos.find((g) => g.TIPODOC === tipodoc);
    if (!section || !grupo) return;

    const rows = this.filteredGrupoRows(grupo);
    const totales = this.grupoTotalesFiltrados(grupo);
    const tbody = section.querySelector('.audcaja-grupo-scroll tbody');
    const footBody = section.querySelector('.audcaja-foot-body');
    const meta = section.querySelector('.audcaja-grupo-meta');

    if (meta) {
      const metaTipos = grupo.ES_TODOS ? ` · ${(this._grupos || []).length} tipo(s)` : '';
      meta.textContent = `${rows.length} de ${grupo.count} doc(s)${
        grupo.anulados ? ` · ${grupo.anulados} anulado(s)` : ''
      }${metaTipos} · Pago: ${this.concreFilterLabel()}`;
    }

    if (tbody) {
      tbody.innerHTML = !rows.length
        ? `<tr><td colspan="${this.DOC_COLSPAN}" class="text-center text-muted py-2">Sin filas</td></tr>`
        : rows.map((r) => this.renderDocRow(r)).join('');
      this.bindDocPrintButtons(tbody);
    }
    if (footBody) footBody.innerHTML = this.renderGrupoFoot(totales);
  },

  async printDocumento(coddoc, correlativo, btn) {
    if (!coddoc || correlativo == null || correlativo === '') {
      F.toast('Documento inválido', 'warning');
      return;
    }
    if (typeof DocPrint === 'undefined' || !DocPrint.printByKey) {
      F.toast('Impresión de documentos no disponible', 'warning');
      return;
    }
    if (btn) btn.disabled = true;
    try {
      await DocPrint.printByKey({
        coddoc: String(coddoc),
        correlativo: Number(correlativo),
        title: `${coddoc} #${correlativo}`,
      });
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  buildCuadrePrintHtml() {
    const p = this._print;
    const c = this._corte || {};
    if (!p) return '';
    const { caja, resumen, reportado, faltante, sobrante, obs, usuarioNombre, corte } = p;
    const money = (v) => PrintReport.escapeHtml(this.formatMoney(v));
    const row = (label, value) =>
      `<tr><td>${PrintReport.escapeHtml(label)}</td><td class="text-end">${value}</td></tr>`;
    const fecha = `${this.formatFecha(corte?.FECHA || c.FECHA)} ${this.formatHora(
      corte?.HORA ?? c.HORA,
      corte?.MINUTO ?? c.MINUTO
    )}`;
    const diffRow =
      faltante > 0
        ? row('Faltante', `<strong class="text-danger">${money(faltante)}</strong>`)
        : sobrante > 0
          ? row('Sobrante', `<strong class="text-success">${money(sobrante)}</strong>`)
          : row('Diferencia efectivo', '<strong>Sin diferencia</strong>');

    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({
        title: 'Cuadre de caja',
        subtitleHtml: `
          <p><strong>Corte #${PrintReport.escapeHtml(corte?.CORRELATIVO || c.CORRELATIVO)}</strong> · ${PrintReport.escapeHtml(fecha)}</p>
          <p><strong>Caja:</strong> ${PrintReport.escapeHtml(caja?.DESCAJA || c.DESCAJA || '')} (${PrintReport.escapeHtml(caja?.CODCAJA ?? c.CODCAJA)})</p>
          <p><strong>Usuario:</strong> ${PrintReport.escapeHtml(usuarioNombre || c.USUARIO || '')}</p>
          ${obs ? `<p><strong>Observaciones:</strong> ${PrintReport.escapeHtml(obs)}</p>` : ''}
        `,
      })}
      <h2 class="audcaja-print-section">Resumen del turno</h2>
      <table>
        <tbody>
          ${row('Movimientos', PrintReport.escapeHtml(String(resumen.totalMovimientos)))}
          ${row('Ventas brutas', money(resumen.totalVentasBrutas ?? resumen.totalVenta))}
          ${row('Notas de crédito (DEV/FNC)', money(resumen.totalDevoluciones || 0))}
          ${row('Total venta (neto)', money(resumen.totalVenta))}
          ${row('Ventas al crédito', money(resumen.totalCredito))}
          ${row('Recibos RCC/PRC', money(resumen.totalRecibos || 0))}
          ${row('Efectivo (neto)', money(resumen.fpEfectivo))}
          ${row('Vales de caja (−)', money(resumen.totalValesCaja || 0))}
          ${row('Retiros a banco (−)', money(resumen.totalRetiros || 0))}
          ${row('Efectivo esperado', money(resumen.efectivoEsperado))}
          ${row('Tarjeta (sistema)', money(resumen.fpTarjeta))}
          ${row('Depósito (sistema)', money(resumen.fpDeposito))}
          ${row('Cheque (sistema)', money(resumen.fpCheque))}
        </tbody>
      </table>
      <h2 class="audcaja-print-section">Arqueo reportado</h2>
      <table>
        <tbody>
          ${row('Efectivo contado', money(reportado.efectivo))}
          ${row('Tarjeta reportada', money(reportado.tarjeta))}
          ${row('Cheques reportados', money(reportado.cheques))}
          ${row('Depósito reportado', money(reportado.deposito))}
          ${diffRow}
        </tbody>
      </table>`;

    return PrintReport.wrapDocument({
      title: `Cuadre corte #${corte?.CORRELATIVO || c.CORRELATIVO}`,
      bodyHtml,
      extraStyles: `
        h2.audcaja-print-section{font-size:.95rem;margin:1rem 0 .35rem;font-weight:600}
        table{width:100%;border-collapse:collapse;margin-top:.35rem}
        td{padding:4px 6px;border-bottom:1px solid #e5e7eb}
        table td:first-child{width:55%}
      `,
    });
  },

  buildProductosPrintSection(money) {
    const productos = (this._productos || []).filter(
      (p) =>
        Number(p.UNIDADES) !== 0 ||
        Number(p.PRECIO) !== 0 ||
        Number(p.PRECIO_CON) !== 0 ||
        Number(p.PRECIO_CRE) !== 0
    );
    const fmtU = (v) =>
      PrintReport.escapeHtml(
        Number(v || 0).toLocaleString('es-GT', { maximumFractionDigits: 3 })
      );
    let totU = 0;
    let totCon = 0;
    let totCre = 0;
    const rows = productos
      .map((p) => {
        totU += Number(p.UNIDADES) || 0;
        totCon += Number(p.PRECIO_CON) || 0;
        totCre += Number(p.PRECIO_CRE) || 0;
        return `<tr>
          <td>${PrintReport.escapeHtml(p.CODPROD)}</td>
          <td>${PrintReport.escapeHtml(p.DESPROD || '')}</td>
          <td class="text-end">${fmtU(p.UNIDADES)}</td>
          <td class="text-end">${money(p.PRECIO_CON)}</td>
          <td class="text-end">${money(p.PRECIO_CRE)}</td>
        </tr>`;
      })
      .join('');

    return `
      <h2 class="audcaja-print-section">Resumen Productos
        <span class="muted">(${productos.length} producto(s) · facturas − devoluciones)</span>
      </h2>
      <table class="audcaja-print-table">
        <thead>
          <tr>
            <th>CODPROD</th>
            <th>DESPROD</th>
            <th class="text-end">TOTALUNIDADES</th>
            <th class="text-end">Contado</th>
            <th class="text-end">Crédito</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="5">Sin productos</td></tr>'}</tbody>
        <tfoot>
          <tr>
            <td colspan="2" class="text-end"><strong>Totales</strong></td>
            <td class="text-end"><strong>${fmtU(totU)}</strong></td>
            <td class="text-end"><strong>${money(totCon)}</strong></td>
            <td class="text-end"><strong>${money(totCre)}</strong></td>
          </tr>
        </tfoot>
      </table>`;
  },

  buildReportePrintHtml() {
    const c = this._corte || {};
    // Reporte completo: todos los tipos y docs (filtros de pantalla no aplican).
    const grupos = this._grupos || [];
    const money = (v) => PrintReport.escapeHtml(this.formatMoney(v));
    const moneyCell = (v) => {
      const n = Number(v) || 0;
      return n ? money(n) : '—';
    };
    const fecha = `${this.formatFecha(c.FECHA)} ${this.formatHora(c.HORA, c.MINUTO)}`;

    const sections = !grupos.length
      ? '<p>Este corte no tiene documentos marcados (NOCORTE).</p>'
      : grupos
          .map((g) => {
            const rowsData = g.rows || [];
            const totales = this.sumRows(rowsData);
            const rows = rowsData
              .map((r) => {
                const anulado = r.STATUS === 'A';
                const isCredito = String(r.CONCRE || 'CON').toUpperCase() === 'CRE';
                const badgeCls = isCredito ? 'badge-cre' : 'badge-con';
                const badgeLabel = isCredito ? 'Crédito' : 'Contado';
                return `<tr class="${anulado ? 'row-anulado' : ''}">
                  <td>${PrintReport.escapeHtml(this.formatFecha(r.FECHA))}</td>
                  <td>${PrintReport.escapeHtml(r.CODDOC || '')}</td>
                  <td class="text-end">${PrintReport.escapeHtml(String(r.CORRELATIVO ?? ''))}</td>
                  <td>${PrintReport.escapeHtml(r.CLIENTE || '')}</td>
                  <td class="text-center"><span class="badge ${badgeCls}">${PrintReport.escapeHtml(badgeLabel)}</span></td>
                  <td class="text-end">${moneyCell(r.FPAGO_EFECTIVO)}</td>
                  <td class="text-end">${moneyCell(r.FPAGO_TARJETA)}</td>
                  <td class="text-end">${moneyCell(r.FPAGO_DEPOSITO)}</td>
                  <td class="text-end">${moneyCell(r.FPAGO_CHEQUE)}</td>
                  <td class="text-end">${money(r.IMPORTE)}</td>
                  <td class="text-center">${PrintReport.escapeHtml(r.STATUS)}</td>
                </tr>`;
              })
              .join('');
            return `
              <h2 class="audcaja-print-section">${PrintReport.escapeHtml(g.TIPODOC)} — ${PrintReport.escapeHtml(g.DESDOC || '')}
                <span class="muted">(${totales.count} doc(s)${g.anulados ? `, ${g.anulados} anulado(s)` : ''})</span>
              </h2>
              <table class="audcaja-print-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Coddoc</th>
                    <th class="text-end">Correlativo</th>
                    <th>Cliente</th>
                    <th class="text-center">Contado/Crédito</th>
                    <th class="text-end">Efectivo</th>
                    <th class="text-end">Tarjeta</th>
                    <th class="text-end">Depósito</th>
                    <th class="text-end">Cheque</th>
                    <th class="text-end">Importe</th>
                    <th class="text-center">Status</th>
                  </tr>
                </thead>
                <tbody>${rows || '<tr><td colspan="11">Sin documentos</td></tr>'}</tbody>
                <tfoot>
                  <tr>
                    <td colspan="5" class="text-end"><strong>Totales</strong></td>
                    <td class="text-end"><strong>${money(totales.totalEfectivo)}</strong></td>
                    <td class="text-end"><strong>${money(totales.totalTarjeta)}</strong></td>
                    <td class="text-end"><strong>${money(totales.totalDeposito)}</strong></td>
                    <td class="text-end"><strong>${money(totales.totalCheque)}</strong></td>
                    <td class="text-end"><strong>${money(totales.total)}</strong></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>`;
          })
          .join('');

    const productosSection = this.buildProductosPrintSection(money);

    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({
        title: 'Reporte auditoría de caja',
        subtitleHtml: `
          <p><strong>Corte #${PrintReport.escapeHtml(c.CORRELATIVO)}</strong> · ${PrintReport.escapeHtml(fecha)}</p>
          <p><strong>Caja:</strong> ${PrintReport.escapeHtml(c.DESCAJA || `Caja ${c.CODCAJA}`)}
            · Usuario ${PrintReport.escapeHtml(c.USUARIO || '—')}
            · ${this._totalDocs} doc(s)
            · Total ${money(this._totalGeneral)}</p>
        `,
      })}
      ${sections}
      ${productosSection}`;

    return PrintReport.wrapDocument({
      title: `Auditoría corte #${c.CORRELATIVO}`,
      bodyHtml,
      extraStyles: `
        h2.audcaja-print-section{font-size:.95rem;margin:1.1rem 0 .35rem;font-weight:600;page-break-after:avoid}
        h2.audcaja-print-section .muted{font-weight:400;color:#666;font-size:.85rem}
        table.audcaja-print-table{width:100%;border-collapse:collapse;margin-bottom:.75rem;font-size:10px;page-break-inside:auto}
        table.audcaja-print-table th,table.audcaja-print-table td{border:1px solid #d1d5db;padding:3px 4px}
        table.audcaja-print-table th{background:#f3f4f6;text-align:left}
        table.audcaja-print-table thead{display:table-header-group}
        table.audcaja-print-table tr{page-break-inside:avoid}
        .row-anulado{color:#999;text-decoration:line-through}
        .text-end{text-align:right}
        .text-center{text-align:center}
        .badge{display:inline-block;padding:1px 6px;border-radius:999px;font-size:9px;font-weight:600;color:#fff}
        .badge-con{background:#0d6efd}
        .badge-cre{background:#dc3545}
      `,
    });
  },

  async imprimirCuadre() {
    if (typeof PrintReport === 'undefined') {
      F.toast('Impresión no disponible', 'warning');
      return;
    }
    if (!this._print) {
      F.toast('No hay datos de cuadre para este corte', 'warning');
      return;
    }
    await PrintReport.openAndPrint(() => this.buildCuadrePrintHtml(), 'width=800,height=700');
  },

  async imprimirReporte() {
    if (typeof PrintReport === 'undefined') {
      F.toast('Impresión no disponible', 'warning');
      return;
    }
    if (!this._corte) {
      F.toast('No hay corte cargado', 'warning');
      return;
    }
    await PrintReport.openAndPrint(() => this.buildReportePrintHtml(), 'width=1000,height=800');
  },

  async reloadList() {
    this.readListFilters();
    this._loading = true;
    this.render();
    try {
      await this.fetchCortes();
    } catch (err) {
      F.toast(err.message || 'Error al cargar cortes', 'error');
      this._cortes = [];
    } finally {
      this._loading = false;
      this.render();
    }
  },

  async openDetalle(id) {
    this._loading = true;
    try {
      await this.fetchDetalle(id);
      this._section = 'detail';
      this.render();
    } catch (err) {
      F.toast(err.message || 'Error al cargar detalle', 'error');
    } finally {
      this._loading = false;
    }
  },

  async backToList() {
    this._section = 'list';
    this._corte = null;
    this._print = null;
    this._grupos = [];
    this._productos = [];
    this._selectedTipodoc = '';
    this._concreFilter = '';
    this.render();
    if (!this._cortes.length) await this.reloadList();
  },

  async load(container) {
    this._container = container;
    const def = this.defaultPeriod();
    this._mes = def.mes;
    this._anio = def.anio;
    this._section = 'list';
    this._cortes = [];
    this._corte = null;
    this._print = null;
    this._grupos = [];
    this._productos = [];
    this._filters = {};
    this._selectedTipodoc = '';
    this._concreFilter = '';
    await this.reloadList();
  },
};

window.AuditoriaCajasView = AuditoriaCajasView;
