/**
 * Vista Movimientos bancarios — DOCUMENTOS_BANCO + abonos CXC/CXP.
 */
const MovimientosBancoView = {
  _container: null,
  _rows: [],
  _cuentas: [],
  _filterQuery: '',
  _filterCuenta: '',
  _filterMes: null,
  _filterAnio: null,
  _mode: 'list', // list | form | detail
  _editId: null,
  _detail: null,
  _form: null,
  _pendingDocs: [],
  _pendingQuery: '',
  _loading: false,

  escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  usuario() {
    const u = F.session('user');
    return u?.username || u?.usuario || 'BANCOS';
  },

  todayIsoDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  formatMoney(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return 'Q 0.00';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  roundCentavos(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.round((x + Number.EPSILON) * 100) / 100;
  },

  formatFecha(value) {
    if (!value) return '—';
    const s = String(value).slice(0, 10);
    const [y, m, d] = s.split('-');
    if (d && m && y) return `${d}/${m}/${y}`;
    return s;
  },

  tipoLabel(tipo) {
    return String(tipo).toUpperCase() === 'S' ? 'Salida' : 'Entrada';
  },

  emptyForm(tipo = 'E') {
    return {
      TIPO: tipo,
      CODDOC: '',
      CORRELATIVO: '',
      CODCUENTA: '',
      FECHA: this.todayIsoDate(),
      NODOCUMENTO: '',
      ENCARGADO: '',
      DESCRIPCION: '',
      OBS: '',
      CATEGORIA: 'DEPOSITO',
      IMPORTE: 0,
      abonos: [],
    };
  },

  tipodocLabel(tipo) {
    return String(tipo).toUpperCase() === 'S' ? 'DPS' : 'DPE';
  },

  CATEGORIA_OPTIONS: ['DEPOSITO', 'TRANSFERENCIA', 'CHEQUE'],
  _series: [],

  categoriaOptionsHtml(selected) {
    const sel = String(selected || 'DEPOSITO').toUpperCase();
    return this.CATEGORIA_OPTIONS.map((opt) => {
      const isSel = sel === opt ? ' selected' : '';
      return `<option value="${opt}"${isSel}>${opt}</option>`;
    }).join('');
  },

  seriesOptionsHtml(selected) {
    if (!this._series.length) {
      return '<option value="">— Sin series activas —</option>';
    }
    return (
      '<option value="">— Seleccione serie —</option>' +
      this._series
        .map((s) => {
          const label = s.DESDOC ? `${s.CODDOC} — ${s.DESDOC}` : s.CODDOC;
          const sel = String(s.CODDOC) === String(selected) ? ' selected' : '';
          return `<option value="${this.escapeHtml(s.CODDOC)}"${sel}>${this.escapeHtml(label)}</option>`;
        })
        .join('')
    );
  },

  apiListUrl(extra = {}) {
    const emp = F.getEmpNit();
    const params = new URLSearchParams({ empnit: emp, limit: '300', ...extra });
    return `/api/movimientos-banco?${params}`;
  },

  async fetchCuentas() {
    const emp = F.getEmpNit();
    const data = await F.fetchJson(
      `/api/cuentas-bancarias?empnit=${encodeURIComponent(emp)}&_=${Date.now()}`,
      { cache: 'no-store' }
    );
    this._cuentas = data.rows || [];
    return this._cuentas;
  },

  async fetchSeries(tipo = 'E') {
    const emp = F.getEmpNit();
    const tipodoc = this.tipodocLabel(tipo);
    const data = await F.fetchJson(
      `/api/movimientos-banco/tipos?empnit=${encodeURIComponent(emp)}&tipodoc=${encodeURIComponent(tipodoc)}&_=${Date.now()}`,
      { cache: 'no-store' }
    );
    this._series = data.rows || [];
    return this._series;
  },

  async fetchSiguiente(coddoc) {
    const emp = F.getEmpNit();
    const tipodoc = this.tipodocLabel(this._form?.TIPO || 'E');
    const params = new URLSearchParams({
      empnit: emp,
      tipodoc,
      _: String(Date.now()),
    });
    if (coddoc) params.set('coddoc', coddoc);
    const data = await F.fetchJson(`/api/movimientos-banco/siguiente?${params}`, { cache: 'no-store' });
    return data.siguiente || null;
  },

  async refreshCorrelativoPreview() {
    const corrInp = this._container?.querySelector('#mb-correlativo');
    const coddoc = this._container?.querySelector('#mb-coddoc')?.value || this._form?.CODDOC;
    if (!corrInp) return;
    if (!coddoc) {
      corrInp.value = '';
      if (this._form) this._form.CORRELATIVO = '';
      return;
    }
    corrInp.value = '…';
    try {
      const sig = await this.fetchSiguiente(coddoc);
      const corr = sig?.CORRELATIVO ?? '';
      corrInp.value = String(corr);
      if (this._form) {
        this._form.CODDOC = coddoc;
        this._form.CORRELATIVO = corr;
      }
    } catch (err) {
      corrInp.value = '';
      F.toast(err.message || 'No se pudo cargar el correlativo', 'error');
    }
  },

  felSatLabel(row) {
    const tipodoc = String(row?.TIPODOC || '').trim().toUpperCase();
    const esCompra = tipodoc === 'COM' || tipodoc === 'COP';
    const serie = esCompra
      ? String(row?.SAT_SERIE || row?.SERIEFAC || '').trim()
      : String(row?.SAT_SERIE || row?.FEL_SERIE || '').trim();
    const numero = esCompra
      ? String(row?.SAT_NUMERO || row?.NOFAC || '').trim()
      : String(row?.SAT_NUMERO || row?.FEL_NUMERO || '').trim();
    if (!serie && !numero) return '—';
    return [serie, numero].filter(Boolean).join('-');
  },

  async fetchList() {
    const params = { _: String(Date.now()) };
    if (this._filterQuery.trim()) params.q = this._filterQuery.trim();
    if (this._filterCuenta) params.codcuenta = String(this._filterCuenta);
    if (this._filterMes) params.mes = String(this._filterMes);
    if (this._filterAnio) params.anio = String(this._filterAnio);
    const data = await F.fetchJson(this.apiListUrl(params), { cache: 'no-store' });
    this._rows = data.rows || [];
    return this._rows;
  },

  filtroCuentaOptionsHtml() {
    const opts = [`<option value=""${this._filterCuenta ? '' : ' selected'}>Todas</option>`];
    for (const c of this._cuentas || []) {
      const id = String(c.CODCUENTA ?? '');
      const banco = String(c.DESBANCO || '').trim();
      const cuenta = String(c.NOCUENTA || '').trim();
      const label = [banco, cuenta].filter(Boolean).join(' · ') || `Cuenta ${id}`;
      const sel = String(this._filterCuenta) === id ? ' selected' : '';
      opts.push(`<option value="${this.escapeHtml(id)}"${sel}>${this.escapeHtml(label)}</option>`);
    }
    return opts.join('');
  },

  filtroPeriodoHtml() {
    const period =
      this._filterMes && this._filterAnio
        ? { mes: this._filterMes, anio: this._filterAnio }
        : typeof LibroContableCommon !== 'undefined'
          ? LibroContableCommon.defaultPeriod()
          : { mes: new Date().getMonth() + 1, anio: new Date().getFullYear() };
    if (!this._filterMes) this._filterMes = period.mes;
    if (!this._filterAnio) this._filterAnio = period.anio;
    if (typeof LibroContableCommon !== 'undefined') {
      return LibroContableCommon.periodSelectsHtml('mb-filtro', this._filterMes, this._filterAnio);
    }
    return `
      <select class="form-select form-select-sm" id="mb-filtro-mes" style="min-width:7rem">
        <option value="${this._filterMes}">${this._filterMes}</option>
      </select>
      <select class="form-select form-select-sm" id="mb-filtro-anio" style="min-width:5.5rem">
        <option value="${this._filterAnio}">${this._filterAnio}</option>
      </select>`;
  },
  async fetchDetail(id) {
    const emp = F.getEmpNit();
    return F.fetchJson(
      `/api/movimientos-banco/${encodeURIComponent(id)}?empnit=${encodeURIComponent(emp)}&_=${Date.now()}`,
      { cache: 'no-store' }
    );
  },

  async fetchPendientes() {
    const emp = F.getEmpNit();
    const tipo = this._form?.TIPO || 'E';
    const params = new URLSearchParams({
      empnit: emp,
      tipo,
      limit: '80',
      _: String(Date.now()),
    });
    if (this._pendingQuery.trim()) params.set('q', this._pendingQuery.trim());
    const data = await F.fetchJson(`/api/movimientos-banco/documentos-pendientes?${params}`, {
      cache: 'no-store',
    });
    this._pendingDocs = data.rows || [];
    return this._pendingDocs;
  },

  abonosSum() {
    return (this._form?.abonos || []).reduce((s, a) => s + (Number(a.ABONO) || 0), 0);
  },

  syncImporteFromAbonos() {
    if (!this._form) return;
    if (this._form.abonos.length) {
      this._form.IMPORTE = Math.round(this.abonosSum() * 1000) / 1000;
    }
  },

  cuentaOptionsHtml(selected) {
    if (!this._cuentas.length) {
      return '<option value="">— Sin cuentas bancarias —</option>';
    }
    return (
      '<option value="">— Seleccione —</option>' +
      this._cuentas
        .map((c) => {
          const label = `${c.DESBANCO || 'Banco'} — ${c.NOCUENTA || c.CODCUENTA}`;
          const sel = String(c.CODCUENTA) === String(selected) ? ' selected' : '';
          return `<option value="${this.escapeHtml(c.CODCUENTA)}"${sel}>${this.escapeHtml(label)}</option>`;
        })
        .join('')
    );
  },

  renderListHtml() {
    const body = !this._rows.length
      ? `<tr><td colspan="9" class="text-center text-muted py-4">Sin movimientos bancarios</td></tr>`
      : this._rows
          .map((r) => {
            const isSalida = String(r.TIPO).toUpperCase() === 'S';
            const badge = isSalida ? 'bg-danger' : 'bg-success';
            return `<tr class="mb-row" data-id="${this.escapeHtml(r.ID)}" role="button" tabindex="0">
              <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
              <td><span class="badge ${badge}">${this.escapeHtml(this.tipoLabel(r.TIPO))}</span></td>
              <td class="fw-semibold text-nowrap">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</td>
              <td class="small">${this.escapeHtml(r.DESBANCO || '—')}<div class="text-muted">${this.escapeHtml(r.NOCUENTA || '')}</div></td>
              <td>${this.escapeHtml(r.NODOCUMENTO || '—')}</td>
              <td>${this.escapeHtml(r.ENCARGADO || r.DESCRIPCION || '—')}</td>
              <td class="small text-muted">${this.escapeHtml(r.CATEGORIA || '—')}</td>
              <td class="text-end fw-semibold ${isSalida ? 'text-danger' : 'text-success'}">${this.escapeHtml(this.formatMoney(r.IMPORTE))}</td>
              <td class="text-end text-nowrap">
                <button type="button" class="btn btn-sm btn-outline-primary mb-btn-view" data-id="${this.escapeHtml(r.ID)}" title="Ver"><i class="fa-solid fa-eye"></i></button>
                <button type="button" class="btn btn-sm btn-outline-secondary mb-btn-edit" data-id="${this.escapeHtml(r.ID)}" title="Editar"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="btn btn-sm btn-outline-danger mb-btn-del" data-id="${this.escapeHtml(r.ID)}" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
              </td>
            </tr>`;
          })
          .join('');

    return `
      <div class="card shadow-sm mb-3">
        <div class="card-body py-2">
          <div class="d-flex flex-wrap align-items-end gap-2 mb-2">
            <div>
              <label class="form-label small mb-0" for="mb-filtro-cuenta">Cuenta bancaria</label>
              <select class="form-select form-select-sm" id="mb-filtro-cuenta" style="min-width:14rem">
                ${this.filtroCuentaOptionsHtml()}
              </select>
            </div>
            ${this.filtroPeriodoHtml()}
          </div>
          <div class="d-flex flex-wrap align-items-center gap-2">
            <div class="input-group input-group-sm flex-grow-1" style="min-width:12rem">
              <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
              <input type="search" class="form-control" id="mb-search" placeholder="Buscar documento, cuenta, encargado…"
                value="${this.escapeHtml(this._filterQuery)}" autocomplete="off">
            </div>
            <button type="button" class="btn btn-sm btn-success" id="mb-btn-nueva-entrada">
              <i class="fa-solid fa-arrow-down me-1"></i>Nueva Entrada
            </button>
            <button type="button" class="btn btn-sm btn-danger" id="mb-btn-nueva-salida">
              <i class="fa-solid fa-arrow-up me-1"></i>Nueva Salida
            </button>
          </div>
        </div>
      </div>
      <div class="card shadow-sm">
        <div class="table-responsive">
          <table class="table table-sm table-hover table-striped mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Documento</th>
                <th>Cuenta</th>
                <th>No. doc</th>
                <th>Encargado / Desc.</th>
                <th>Categoría</th>
                <th class="text-end">Importe</th>
                <th class="text-end">Acciones</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
      <p class="small text-muted mt-2 mb-0">Entrada (E) = depósitos / cobros CXC. Salida (S) = cheques / pagos CXP.</p>`;
  },

  renderAbonosTableHtml(editable) {
    const rows = this._form?.abonos || [];
    const labelDocs = this._form?.TIPO === 'S' ? 'compras' : 'facturas';
    if (!rows.length) {
      return `<div class="text-center text-muted small py-4 px-2">Sin ${labelDocs} agregadas. Use el botón + en la lista de la izquierda.</div>`;
    }
    const body = rows
      .map((a, idx) => {
        const montoInput = editable
          ? `<input type="number" class="form-control form-control-sm text-end mb-abono-monto" data-idx="${idx}" min="0.01" step="0.01" value="${this.escapeHtml(a.ABONO)}">`
          : this.escapeHtml(this.formatMoney(a.ABONO));
        const removeBtn = editable
          ? `<button type="button" class="btn btn-sm btn-outline-danger mb-abono-remove" data-idx="${idx}" title="Quitar"><i class="fa-solid fa-xmark"></i></button>`
          : '';
        return `<tr>
          <td class="fw-semibold text-nowrap small">${this.escapeHtml(a.CODDOC_FAC)} #${this.escapeHtml(a.CORRELATIVO_FAC)}</td>
          <td class="small text-nowrap">${this.escapeHtml(this.felSatLabel(a))}</td>
          <td class="small">${this.escapeHtml(a.DOC_NOMCLIE || '—')}</td>
          <td class="text-end small text-muted">${this.escapeHtml(this.formatMoney(a.DOC_SALDO))}</td>
          <td class="text-end" style="min-width:6rem">${montoInput}</td>
          <td class="text-end">${removeBtn}</td>
        </tr>`;
      })
      .join('');
    return `
      <div class="mb-docs-scroll">
        <table class="table table-sm table-striped mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>Documento</th>
              <th>SAT</th>
              <th>Nombre</th>
              <th class="text-end">Saldo</th>
              <th class="text-end">Abono</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot class="table-light">
            <tr>
              <td colspan="4" class="text-end fw-semibold small">Total</td>
              <td class="text-end fw-bold text-danger">${this.escapeHtml(this.formatMoney(this.abonosSum()))}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  },

  renderPendingPickerHtml() {
    const label = this._form?.TIPO === 'S' ? 'compras CXP' : 'facturas CXC';
    const body = !this._pendingDocs.length
      ? `<tr><td colspan="6" class="text-center text-muted py-4">Sin ${label} con saldo</td></tr>`
      : this._pendingDocs
          .map((d) => {
            const key = `${d.CODDOC}|${d.CORRELATIVO}`;
            const already = (this._form.abonos || []).some(
              (a) => String(a.CODDOC_FAC) === String(d.CODDOC) && String(a.CORRELATIVO_FAC) === String(d.CORRELATIVO)
            );
            return `<tr>
              <td class="fw-semibold text-nowrap small">${this.escapeHtml(d.CODDOC)} #${this.escapeHtml(d.CORRELATIVO)}</td>
              <td class="small text-nowrap">${this.escapeHtml(this.felSatLabel(d))}</td>
              <td class="small">${this.escapeHtml(d.DOC_NOMCLIE || d.NEGOCIO || '—')}</td>
              <td class="text-nowrap small">${this.escapeHtml(this.formatFecha(d.FECHA))}</td>
              <td class="text-end fw-semibold small text-primary">${this.escapeHtml(this.formatMoney(d.DOC_SALDO))}</td>
              <td class="text-end">
                <button type="button" class="btn btn-sm btn-outline-success mb-add-doc" data-key="${this.escapeHtml(key)}"
                  ${already ? 'disabled' : ''} title="Agregar">
                  <i class="fa-solid fa-plus"></i>
                </button>
              </td>
            </tr>`;
          })
          .join('');
    return `
      <div class="mb-docs-panel">
        <div class="mb-docs-panel__title">
          <i class="fa-solid fa-list me-1"></i>Lista ${this.escapeHtml(label)} pendientes
        </div>
        <div class="input-group input-group-sm mb-2">
          <input type="search" class="form-control" id="mb-pending-search" placeholder="Buscar cliente, doc, NIT, FEL…"
            value="${this.escapeHtml(this._pendingQuery)}" autocomplete="off">
          <button type="button" class="btn btn-outline-secondary" id="mb-pending-btn">Buscar</button>
        </div>
        <div class="mb-docs-scroll">
          <table class="table table-sm table-hover mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th>Documento</th>
                <th>SAT</th>
                <th>Nombre</th>
                <th>Fecha</th>
                <th class="text-end">Saldo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>`;
  },

  renderAbonosPanelHtml(editable) {
    const label = this._form?.TIPO === 'S' ? 'compras agregadas' : 'facturas agregadas';
    return `
      <div class="mb-docs-panel">
        <div class="mb-docs-panel__title d-flex align-items-center justify-content-between gap-2">
          <span><i class="fa-solid fa-file-circle-check me-1"></i>${this.escapeHtml(label)}</span>
          <span class="badge text-bg-danger">${(this._form?.abonos || []).length}</span>
        </div>
        <div id="mb-abonos-wrap">${this.renderAbonosTableHtml(editable)}</div>
      </div>`;
  },

  renderFormHtml() {
    const f = this._form;
    const isEdit = Boolean(this._editId);
    const importeLocked = f.abonos.length > 0;
    const isSalida = String(f.TIPO).toUpperCase() === 'S';
    const tipodoc = this.tipodocLabel(f.TIPO);
    const tipoBadge = isSalida
      ? `<span class="badge bg-danger">Salida (${tipodoc})</span>`
      : `<span class="badge bg-success">Entrada (${tipodoc})</span>`;
    const titulo = isEdit
      ? 'Editar movimiento'
      : isSalida
        ? 'Nueva salida bancaria'
        : 'Nueva entrada bancaria';
    const serieHtml = isEdit
      ? `<input type="text" class="form-control form-control-sm" value="${this.escapeHtml(f.CODDOC)}" readonly>
         <input type="hidden" id="mb-coddoc" value="${this.escapeHtml(f.CODDOC)}">`
      : `<select id="mb-coddoc" class="form-select form-select-sm" required>${this.seriesOptionsHtml(f.CODDOC)}</select>`;
    return `
      <div class="card shadow-sm mb-form-card">
        <div class="card-header d-flex flex-wrap align-items-center justify-content-between gap-2 py-2">
          <strong><i class="fa-solid fa-money-bill-transfer me-2"></i>${titulo}</strong>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="mb-btn-cancel">Cancelar</button>
        </div>
        <div class="card-body">
          <div class="row g-2 mb-2">
            <div class="col-6 col-sm-4 col-lg">
              <label class="form-label small mb-0">Tipo</label>
              <div class="form-control form-control-sm bg-light d-flex align-items-center mb-tipo-badge">
                ${tipoBadge}
              </div>
              <input type="hidden" id="mb-tipo" value="${this.escapeHtml(f.TIPO)}">
            </div>
            <div class="col-6 col-sm-4 col-lg">
              <label class="form-label small mb-0" for="mb-coddoc">Serie</label>
              ${serieHtml}
            </div>
            <div class="col-6 col-sm-4 col-lg">
              <label class="form-label small mb-0" for="mb-correlativo">Correlativo</label>
              <input type="text" id="mb-correlativo" class="form-control form-control-sm fw-semibold" readonly
                value="${this.escapeHtml(f.CORRELATIVO)}">
            </div>
            <div class="col-6 col-sm-6 col-lg">
              <label class="form-label small mb-0" for="mb-fecha">Fecha</label>
              <input type="date" id="mb-fecha" class="form-control form-control-sm" value="${this.escapeHtml(f.FECHA)}">
            </div>
            <div class="col-12 col-sm-6 col-lg">
              <label class="form-label small mb-0" for="mb-importe">Importe</label>
              <div class="input-group input-group-sm mb-importe-group">
                <span class="input-group-text">Q</span>
                <input type="number" id="mb-importe" class="form-control mb-importe-input text-end" min="0.01" step="0.01"
                  value="${this.escapeHtml(f.IMPORTE)}" ${importeLocked || isEdit ? 'readonly' : ''}>
              </div>
            </div>
          </div>

          <div class="row g-2 mb-2">
            <div class="col-12 col-md-5">
              <label class="form-label small mb-0" for="mb-cuenta">Cuenta bancaria</label>
              <select id="mb-cuenta" class="form-select form-select-sm" required>${this.cuentaOptionsHtml(f.CODCUENTA)}</select>
            </div>
            <div class="col-6 col-md-3">
              <label class="form-label small mb-0" for="mb-categoria">Categoría</label>
              <select id="mb-categoria" class="form-select form-select-sm" required>
                ${this.categoriaOptionsHtml(f.CATEGORIA)}
              </select>
            </div>
            <div class="col-6 col-md-4">
              <label class="form-label small mb-0" for="mb-nodoc">No. boleta</label>
              <input type="text" id="mb-nodoc" class="form-control form-control-sm" maxlength="150" value="${this.escapeHtml(f.NODOCUMENTO)}">
            </div>
          </div>

          <div class="row g-2 mb-3">
            <div class="col-12 col-md-4">
              <label class="form-label small mb-0" for="mb-encargado">Encargado</label>
              <input type="text" id="mb-encargado" class="form-control form-control-sm" maxlength="250" value="${this.escapeHtml(f.ENCARGADO)}">
            </div>
            <div class="col-12 col-md-4">
              <label class="form-label small mb-0" for="mb-descripcion">Descripción</label>
              <input type="text" id="mb-descripcion" class="form-control form-control-sm" maxlength="250" value="${this.escapeHtml(f.DESCRIPCION)}">
            </div>
            <div class="col-12 col-md-4">
              <label class="form-label small mb-0" for="mb-obs">Observaciones</label>
              <input type="text" id="mb-obs" class="form-control form-control-sm" maxlength="255" value="${this.escapeHtml(f.OBS)}">
            </div>
          </div>

          ${
            isEdit
              ? `<div class="alert alert-info small py-2 mb-0">La edición solo actualiza datos generales. Los abonos vinculados no se modifican aquí.</div>`
              : `
          <h6 class="mb-2">
            <i class="fa-solid fa-file-invoice-dollar me-1"></i>Documentos a abonar
            <span class="text-muted fw-normal small">(${f.TIPO === 'S' ? 'pagos a proveedores CXP' : 'cobros de clientes CXC'})</span>
          </h6>
          <div class="row g-2 align-items-stretch">
            <div class="col-12 col-md-6">${this.renderPendingPickerHtml()}</div>
            <div class="col-12 col-md-6">${this.renderAbonosPanelHtml(true)}</div>
          </div>
          `
          }

          <div class="mb-form-actions d-flex justify-content-end gap-2">
            <button type="button" class="btn btn-outline-secondary" id="mb-btn-cancel-2">Cancelar</button>
            <button type="button" class="btn btn-primary" id="mb-btn-save">
              <i class="fa-solid fa-floppy-disk me-1"></i>Guardar
            </button>
          </div>
        </div>
      </div>`;
  },

  renderDetailHtml() {
    const m = this._detail?.movimiento || {};
    const abonos = this._detail?.abonos || [];
    const isSalida = String(m.TIPO).toUpperCase() === 'S';
    const abonosBody = !abonos.length
      ? `<tr><td colspan="5" class="text-center text-muted py-3">Sin facturas / compras vinculadas</td></tr>`
      : abonos
          .map(
            (a) => `<tr>
          <td class="fw-semibold text-nowrap">${this.escapeHtml(a.CODDOC_FAC)} #${this.escapeHtml(a.CORRELATIVO_FAC)}</td>
          <td>${this.escapeHtml(a.DOC_NOMCLIE || '—')}</td>
          <td class="text-end">${this.escapeHtml(this.formatMoney(a.ABONO))}</td>
          <td class="small text-nowrap">${a.CODDOC_REC ? `${this.escapeHtml(a.CODDOC_REC)} #${this.escapeHtml(a.CORRELATIVO_REC)}` : '—'}</td>
          <td class="small">${this.escapeHtml(a.FECHA || '—')}</td>
        </tr>`
          )
          .join('');
    return `
      <div class="card shadow-sm">
        <div class="card-header d-flex flex-wrap align-items-center justify-content-between gap-2 py-2">
          <strong><i class="fa-solid fa-receipt me-2"></i>${this.escapeHtml(m.CODDOC)} #${this.escapeHtml(m.CORRELATIVO)}</strong>
          <div class="d-flex gap-2">
            <button type="button" class="btn btn-sm btn-outline-secondary" id="mb-btn-back">Volver</button>
            <button type="button" class="btn btn-sm btn-outline-primary" id="mb-btn-edit-from-detail" data-id="${this.escapeHtml(m.ID)}">Editar</button>
            <button type="button" class="btn btn-sm btn-outline-danger" id="mb-btn-del-from-detail" data-id="${this.escapeHtml(m.ID)}">Eliminar</button>
          </div>
        </div>
        <div class="card-body">
          <div class="row g-2 small mb-3">
            <div class="col-6 col-md-3"><span class="text-muted">Fecha</span><div class="fw-semibold">${this.escapeHtml(this.formatFecha(m.FECHA))}</div></div>
            <div class="col-6 col-md-3"><span class="text-muted">Tipo</span><div><span class="badge ${isSalida ? 'bg-danger' : 'bg-success'}">${this.escapeHtml(this.tipoLabel(m.TIPO))}</span></div></div>
            <div class="col-6 col-md-3"><span class="text-muted">Cuenta</span><div class="fw-semibold">${this.escapeHtml(m.DESBANCO || '')} ${this.escapeHtml(m.NOCUENTA || '')}</div></div>
            <div class="col-6 col-md-3"><span class="text-muted">Importe</span><div class="fw-bold ${isSalida ? 'text-danger' : 'text-success'}">${this.escapeHtml(this.formatMoney(m.IMPORTE))}</div></div>
            <div class="col-6 col-md-3"><span class="text-muted">No. documento</span><div>${this.escapeHtml(m.NODOCUMENTO || '—')}</div></div>
            <div class="col-6 col-md-3"><span class="text-muted">Encargado</span><div>${this.escapeHtml(m.ENCARGADO || '—')}</div></div>
            <div class="col-6 col-md-3"><span class="text-muted">Categoría</span><div>${this.escapeHtml(m.CATEGORIA || '—')}</div></div>
            <div class="col-12 col-md-3"><span class="text-muted">Descripción</span><div>${this.escapeHtml(m.DESCRIPCION || '—')}</div></div>
            <div class="col-12"><span class="text-muted">Obs.</span><div>${this.escapeHtml(m.OBS || '—')}</div></div>
          </div>
          <h6 class="mb-2">Documentos abonados</h6>
          <div class="table-responsive">
            <table class="table table-sm table-striped mb-0">
              <thead class="table-light">
                <tr>
                  <th>Factura / Compra</th>
                  <th>Nombre</th>
                  <th class="text-end">Abono</th>
                  <th>Recibo</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>${abonosBody}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  },

  renderShell() {
    let content = this.renderListHtml();
    if (this._mode === 'form') content = this.renderFormHtml();
    if (this._mode === 'detail') content = this.renderDetailHtml();
    return `
      <div class="mb-wrap w-100">
        <div class="d-flex flex-wrap align-items-end justify-content-between gap-2 mb-3">
          <div>
            <h2 class="h5 mb-1"><i class="fa-solid fa-money-bill-transfer me-2 text-primary"></i>Movimientos</h2>
            <p class="text-muted small mb-0">Documentos bancarios (depósitos, cheques, transferencias) y abonos CXC/CXP</p>
          </div>
        </div>
        ${content}
      </div>`;
  },

  readFormFromDom() {
    if (!this._form) return;
    const tipoHidden = this._container.querySelector('#mb-tipo');
    if (tipoHidden && !this._editId) {
      this._form.TIPO = tipoHidden.value === 'S' ? 'S' : 'E';
    }
    this._form.CODDOC = this._container.querySelector('#mb-coddoc')?.value || this._form.CODDOC || '';
    this._form.CORRELATIVO = this._container.querySelector('#mb-correlativo')?.value || this._form.CORRELATIVO || '';
    this._form.CODCUENTA = this._container.querySelector('#mb-cuenta')?.value || '';
    this._form.FECHA = this._container.querySelector('#mb-fecha')?.value || this.todayIsoDate();
    this._form.NODOCUMENTO = this._container.querySelector('#mb-nodoc')?.value || '';
    this._form.ENCARGADO = this._container.querySelector('#mb-encargado')?.value || '';
    this._form.DESCRIPCION = this._container.querySelector('#mb-descripcion')?.value || '';
    this._form.OBS = this._container.querySelector('#mb-obs')?.value || '';
    this._form.CATEGORIA = this._container.querySelector('#mb-categoria')?.value || '';
    if (!this._form.abonos.length) {
      this._form.IMPORTE = Number(this._container.querySelector('#mb-importe')?.value || 0);
    } else {
      this.syncImporteFromAbonos();
    }
  },

  async openNew(tipo = 'E') {
    this._editId = null;
    this._form = this.emptyForm(tipo === 'S' ? 'S' : 'E');
    this._pendingQuery = '';
    this._mode = 'form';
    try {
      await this.fetchSeries(this._form.TIPO);
      if (this._series.length) {
        this._form.CODDOC = this._series[0].CODDOC;
        const sig = await this.fetchSiguiente(this._form.CODDOC);
        this._form.CORRELATIVO = sig?.CORRELATIVO ?? '';
      }
      await this.fetchPendientes();
    } catch (err) {
      this._pendingDocs = [];
      if (!this._series.length) {
        F.alert(
          'Sin series',
          err.message ||
            `Configure en Tipo documentos series con TIPODOC = ${this.tipodocLabel(this._form.TIPO)}`,
          'warning'
        );
      }
    }
    this._container.innerHTML = this.renderShell();
    this.bindEvents();
  },

  async openEdit(id) {
    try {
      const data = await this.fetchDetail(id);
      const m = data.movimiento;
      this._editId = m.ID;
      this._form = {
        TIPO: m.TIPO || 'E',
        CODDOC: m.CODDOC || '',
        CORRELATIVO: m.CORRELATIVO ?? '',
        CODCUENTA: m.CODCUENTA || '',
        FECHA: String(m.FECHA || '').slice(0, 10) || this.todayIsoDate(),
        NODOCUMENTO: m.NODOCUMENTO || '',
        ENCARGADO: m.ENCARGADO || '',
        DESCRIPCION: m.DESCRIPCION || '',
        OBS: m.OBS || '',
        CATEGORIA: this.CATEGORIA_OPTIONS.includes(String(m.CATEGORIA || '').toUpperCase())
          ? String(m.CATEGORIA).toUpperCase()
          : 'DEPOSITO',
        IMPORTE: Math.abs(Number(m.IMPORTE) || 0),
        abonos: [],
      };
      this._mode = 'form';
      this._container.innerHTML = this.renderShell();
      this.bindEvents();
    } catch (err) {
      F.alert('Error', err.message || 'No se pudo cargar el movimiento', 'error');
    }
  },

  async openDetail(id) {
    try {
      this._detail = await this.fetchDetail(id);
      this._mode = 'detail';
      this._container.innerHTML = this.renderShell();
      this.bindEvents();
    } catch (err) {
      F.alert('Error', err.message || 'No se pudo cargar el detalle', 'error');
    }
  },

  async backToList() {
    this._mode = 'list';
    this._editId = null;
    this._form = null;
    this._detail = null;
    await this.fetchList();
    this._container.innerHTML = this.renderShell();
    this.bindEvents();
  },

  async saveForm() {
    this.readFormFromDom();
    const f = this._form;
    if (!f.CODCUENTA) {
      F.toast('Seleccione la cuenta bancaria', 'warning');
      return;
    }
    if (!this._editId && !f.CODDOC) {
      F.toast('Seleccione la serie del documento', 'warning');
      return;
    }
    if (!f.abonos.length && !(Number(f.IMPORTE) > 0)) {
      F.toast('Indique el importe o agregue documentos a abonar', 'warning');
      return;
    }

    const emp = F.getEmpNit();
    const btn = this._container.querySelector('#mb-btn-save');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Guardando…';
    }

    try {
      if (this._editId) {
        await F.fetchJson(`/api/movimientos-banco/${this._editId}?empnit=${encodeURIComponent(emp)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            FECHA: f.FECHA,
            CODCUENTA: f.CODCUENTA,
            NODOCUMENTO: f.NODOCUMENTO,
            ENCARGADO: f.ENCARGADO,
            DESCRIPCION: f.DESCRIPCION,
            OBS: f.OBS,
            CATEGORIA: f.CATEGORIA,
            USUARIO: this.usuario(),
          }),
        });
        F.toast('Movimiento actualizado', 'success');
      } else {
        await F.fetchJson(`/api/movimientos-banco?empnit=${encodeURIComponent(emp)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            TIPO: f.TIPO,
            CODDOC: f.CODDOC,
            CODCUENTA: f.CODCUENTA,
            FECHA: f.FECHA,
            NODOCUMENTO: f.NODOCUMENTO,
            ENCARGADO: f.ENCARGADO,
            DESCRIPCION: f.DESCRIPCION,
            OBS: f.OBS,
            CATEGORIA: f.CATEGORIA,
            IMPORTE: f.IMPORTE,
            USUARIO: this.usuario(),
            abonos: f.abonos.map((a) => ({
              CODDOC_FAC: a.CODDOC_FAC,
              CORRELATIVO_FAC: a.CORRELATIVO_FAC,
              ABONO: a.ABONO,
            })),
          }),
        });
        F.toast(
          f.abonos.length
            ? `Movimiento creado con ${f.abonos.length} documento(s) abonado(s)`
            : 'Movimiento creado',
          'success'
        );
      }
      await this.backToList();
    } catch (err) {
      F.alert('Error', err.message || 'No se pudo guardar', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-floppy-disk me-1"></i>Guardar';
      }
    }
  },

  async deleteMovimiento(id) {
    const row = this._rows.find((r) => String(r.ID) === String(id));
    const label = row ? `${row.CODDOC} #${row.CORRELATIVO}` : `ID ${id}`;
    const pass = await CatalogosUI.confirmEliminarDocumento({
      label,
      tipo: 'movimiento bancario',
      kind: 'documento',
      coddoc: row?.CODDOC || '',
      correlativo: row?.CORRELATIVO || '',
      tipodoc: 'BANCO',
    });
    if (!pass) return;
    try {
      const emp = F.getEmpNit();
      await F.fetchJson(`/api/movimientos-banco/${id}?empnit=${encodeURIComponent(emp)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: String(pass) }),
      });
      F.toast('Movimiento eliminado', 'success');
      await this.backToList();
    } catch (err) {
      F.alert('Error', err.message || 'No se pudo eliminar', 'error');
    }
  },

  addPendingDoc(coddoc, correlativo) {
    const doc = this._pendingDocs.find(
      (d) => String(d.CODDOC) === String(coddoc) && String(d.CORRELATIVO) === String(correlativo)
    );
    if (!doc) return;
    const exists = this._form.abonos.some(
      (a) => String(a.CODDOC_FAC) === String(coddoc) && String(a.CORRELATIVO_FAC) === String(correlativo)
    );
    if (exists) return;
    this._form.abonos.push({
      CODDOC_FAC: doc.CODDOC,
      CORRELATIVO_FAC: doc.CORRELATIVO,
      TIPODOC: doc.TIPODOC || null,
      DOC_NOMCLIE: doc.DOC_NOMCLIE || doc.NEGOCIO || '',
      DOC_SALDO: doc.DOC_SALDO,
      FEL_SERIE: doc.FEL_SERIE || null,
      FEL_NUMERO: doc.FEL_NUMERO || null,
      SERIEFAC: doc.SERIEFAC || null,
      NOFAC: doc.NOFAC || null,
      SAT_SERIE: doc.SAT_SERIE || null,
      SAT_NUMERO: doc.SAT_NUMERO || null,
      ABONO: Number(doc.DOC_SALDO) || 0,
    });
    this.syncImporteFromAbonos();
    this.refreshFormPartial();
  },

  refreshFormPartial() {
    this.readFormFromDom();
    const wrap = this._container.querySelector('#mb-abonos-wrap');
    if (wrap) wrap.innerHTML = this.renderAbonosTableHtml(true);
    const badge = this._container.querySelector('.mb-docs-panel .badge');
    if (badge) badge.textContent = String((this._form.abonos || []).length);
    const importe = this._container.querySelector('#mb-importe');
    if (importe) {
      importe.value = String(this._form.IMPORTE || 0);
      importe.readOnly = this._form.abonos.length > 0;
    }
    this.bindAbonoEvents();
    this._container.querySelectorAll('.mb-add-doc').forEach((btn) => {
      const key = btn.getAttribute('data-key') || '';
      const [cod, corr] = key.split('|');
      const already = this._form.abonos.some(
        (a) => String(a.CODDOC_FAC) === String(cod) && String(a.CORRELATIVO_FAC) === String(corr)
      );
      btn.disabled = already;
    });
  },

  bindAbonoEvents() {
    this._container?.querySelectorAll('.mb-abono-monto').forEach((inp) => {
      inp.addEventListener('change', () => {
        const idx = Number(inp.getAttribute('data-idx'));
        const line = this._form.abonos[idx];
        if (!line) return;
        let val = Number(inp.value) || 0;
        const max = Number(line.DOC_SALDO) || 0;
        const maxC = this.roundCentavos(max);
        const valC = this.roundCentavos(val);
        if (valC > maxC) {
          F.toast(`El abono no puede superar el saldo (${this.formatMoney(maxC)})`, 'warning');
          val = maxC;
          inp.value = String(maxC);
        }
        if (val < 0) val = 0;
        line.ABONO = this.roundCentavos(val);
        this.syncImporteFromAbonos();
        this.refreshFormPartial();
      });
    });
    this._container?.querySelectorAll('.mb-abono-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-idx'));
        this._form.abonos.splice(idx, 1);
        this.syncImporteFromAbonos();
        this.refreshFormPartial();
      });
    });
  },

  bindEvents() {
    const reloadList = async () => {
      try {
        await this.fetchList();
        this._container.innerHTML = this.renderShell();
        this.bindEvents();
      } catch (err) {
        F.toast(err.message || 'Error al buscar', 'error');
      }
    };

    const search = this._container?.querySelector('#mb-search');
    let t = null;
    search?.addEventListener('input', () => {
      this._filterQuery = search.value;
      clearTimeout(t);
      t = setTimeout(() => {
        reloadList().catch(() => {});
      }, 350);
    });

    this._container?.querySelector('#mb-filtro-cuenta')?.addEventListener('change', (e) => {
      this._filterCuenta = String(e.target.value || '').trim();
      reloadList().catch(() => {});
    });
    this._container?.querySelector('#mb-filtro-mes')?.addEventListener('change', (e) => {
      this._filterMes = Number(e.target.value) || this._filterMes;
      reloadList().catch(() => {});
    });
    this._container?.querySelector('#mb-filtro-anio')?.addEventListener('change', (e) => {
      this._filterAnio = Number(e.target.value) || this._filterAnio;
      reloadList().catch(() => {});
    });

    this._container?.querySelector('#mb-btn-nueva-entrada')?.addEventListener('click', () => {
      this.openNew('E').catch((err) => F.toast(err.message || 'Error', 'error'));
    });
    this._container?.querySelector('#mb-btn-nueva-salida')?.addEventListener('click', () => {
      this.openNew('S').catch((err) => F.toast(err.message || 'Error', 'error'));
    });
    this._container?.querySelector('#mb-btn-cancel')?.addEventListener('click', () => this.backToList());
    this._container?.querySelector('#mb-btn-cancel-2')?.addEventListener('click', () => this.backToList());
    this._container?.querySelector('#mb-btn-back')?.addEventListener('click', () => this.backToList());
    this._container?.querySelector('#mb-btn-save')?.addEventListener('click', () => {
      this.saveForm().catch((err) => F.toast(err.message || 'Error', 'error'));
    });

    this._container?.querySelectorAll('.mb-btn-view').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openDetail(btn.getAttribute('data-id'));
      });
    });
    this._container?.querySelectorAll('.mb-btn-edit').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openEdit(btn.getAttribute('data-id'));
      });
    });
    this._container?.querySelector('#mb-btn-edit-from-detail')?.addEventListener('click', (e) => {
      this.openEdit(e.currentTarget.getAttribute('data-id'));
    });
    this._container?.querySelectorAll('.mb-btn-del').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteMovimiento(btn.getAttribute('data-id'));
      });
    });
    this._container?.querySelector('#mb-btn-del-from-detail')?.addEventListener('click', (e) => {
      this.deleteMovimiento(e.currentTarget.getAttribute('data-id'));
    });

    this._container?.querySelectorAll('.mb-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        this.openDetail(row.getAttribute('data-id'));
      });
    });

    this._container?.querySelector('#mb-coddoc')?.addEventListener('change', () => {
      if (this._editId) return;
      this.readFormFromDom();
      this.refreshCorrelativoPreview().catch(() => {});
    });

    this._container?.querySelector('#mb-pending-btn')?.addEventListener('click', async () => {
      this._pendingQuery = this._container.querySelector('#mb-pending-search')?.value || '';
      this.readFormFromDom();
      try {
        await this.fetchPendientes();
        this._container.innerHTML = this.renderShell();
        this.bindEvents();
      } catch (err) {
        F.toast(err.message || 'Error al buscar documentos', 'error');
      }
    });
    this._container?.querySelector('#mb-pending-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._container.querySelector('#mb-pending-btn')?.click();
      }
    });

    this._container?.querySelectorAll('.mb-add-doc').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key') || '';
        const [cod, corr] = key.split('|');
        this.addPendingDoc(cod, corr);
      });
    });

    this.bindAbonoEvents();
  },

  async load(container) {
    this._container = container;
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add('align-items-stretch', 'justify-content-start', 'p-2', 'p-md-3');
    this._mode = 'list';

    if (!F.getEmpNit()) {
      container.innerHTML = `
        <div class="alert alert-warning m-3 w-100">
          <i class="fa-solid fa-triangle-exclamation me-2"></i>
          No hay empresa activa. Cierre sesión e ingrese de nuevo.
        </div>`;
      return;
    }

    container.innerHTML = `<div class="text-center text-muted py-4 w-100"><i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando movimientos…</div>`;
    try {
      if (!this._filterMes || !this._filterAnio) {
        const period =
          typeof LibroContableCommon !== 'undefined'
            ? LibroContableCommon.defaultPeriod()
            : { mes: new Date().getMonth() + 1, anio: new Date().getFullYear() };
        this._filterMes = period.mes;
        this._filterAnio = period.anio;
      }
      await Promise.all([this.fetchCuentas(), this.fetchList()]);
      container.innerHTML = this.renderShell();
      this.bindEvents();
    } catch (err) {
      container.innerHTML = `
        <div class="alert alert-danger m-3 w-100">
          <i class="fa-solid fa-circle-exclamation me-2"></i>${this.escapeHtml(err.message)}
        </div>`;
    }
  },
};
