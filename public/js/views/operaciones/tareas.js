/**
 * Vista Tareas — CRUD dbo.TASKS (pendientes por empresa).
 */
const TAREAS_PRIORIDAD_OPTS = [
  { value: 'BAJA', label: 'BAJA' },
  { value: 'MEDIA', label: 'MEDIA' },
  { value: 'ALTA', label: 'ALTA' },
];

const TAREAS_ESTADO_OPTS = [
  { value: 'PENDIENTE', label: 'PENDIENTE' },
  { value: 'FINALIZADA', label: 'FINALIZADA' },
];

const TAREAS_TABLE_COLUMNS = [
  { key: 'TAREA', label: 'Tarea', cellClass: 'tareas-col-desc' },
  { key: 'RESPONSABLE', label: 'Responsable' },
  { key: 'PRIORIDAD', label: 'Prioridad' },
  { key: 'DIAS', label: 'Días' },
  { key: 'HORA', label: 'Hora' },
  { key: 'ST', label: 'Estado' },
];

function tareasMapFormToApi(data) {
  const num = (v) => {
    if (v === '' || v === undefined || v === null) return null;
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  };
  return {
    TAREA: String(data.TAREA || '').trim() || null,
    RESPONSABLE: String(data.RESPONSABLE || '').trim() || null,
    PRIORIDAD: String(data.PRIORIDAD || 'BAJA').trim().toUpperCase(),
    ST: String(data.ST || 'PENDIENTE').trim().toUpperCase(),
    HORA: num(data.HORA),
    MINUTO: num(data.MINUTO),
  };
}

function tareasValidateForm(data) {
  if (!String(data.TAREA || '').trim()) return 'Describa la tarea a realizar';
  const prioridad = String(data.PRIORIDAD || '').trim().toUpperCase();
  if (!TAREAS_PRIORIDAD_OPTS.some((o) => o.value === prioridad)) {
    return 'Seleccione una prioridad válida';
  }
  const estado = String(data.ST || '').trim().toUpperCase();
  if (!TAREAS_ESTADO_OPTS.some((o) => o.value === estado)) {
    return 'Seleccione un estado válido';
  }
  const hora = parseInt(data.HORA, 10);
  if (Number.isNaN(hora) || hora < 0 || hora > 23) return 'HORA debe estar entre 0 y 23';
  const minuto = parseInt(data.MINUTO, 10);
  if (Number.isNaN(minuto) || minuto < 0 || minuto > 59) return 'MINUTO debe estar entre 0 y 59';
  return null;
}

const TareasViewBase = createCatalogoEmpresaView({
  slug: 'tareas',
  apiPath: '/api/tareas',
  icon: 'fa-list-check',
  labelSingular: 'tarea',
  labelPlural: 'tarea(s)',
  idKey: 'ID',
  dataAttr: 'id',
  formWidth: 520,
  searchPlaceholder: 'Buscar por tarea, responsable, prioridad…',
  searchKeys: ['TAREA', 'RESPONSABLE', 'PRIORIDAD', 'ST'],
  formFields: [],
  mapFormToApi: tareasMapFormToApi,
  validateForm: tareasValidateForm,
  tableColumns: TAREAS_TABLE_COLUMNS,
  getRowLabel(row) {
    const t = String(row?.TAREA || '').trim();
    return t.length > 60 ? `${t.slice(0, 57)}…` : t || 'Tarea';
  },
});

const TareasView = {
  ...TareasViewBase,
  _filterEstado: '',

  sessionResponsable() {
    const user = F.session('user') || {};
    return String(user.username || user.nomempleado || '').trim();
  },

  normalizeEstado(value) {
    const s = String(value ?? 'PENDIENTE').trim().toUpperCase();
    return s === 'FINALIZADA' ? 'FINALIZADA' : 'PENDIENTE';
  },

  parseFecha(value) {
    if (value === null || value === undefined || value === '') return null;
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const [y, m, d] = s.slice(0, 10).split('-').map(Number);
      if (y && m && d) return new Date(y, m - 1, d);
    }
    const dt = new Date(s);
    return Number.isNaN(dt.getTime()) ? null : dt;
  },

  diasDesdeCreacion(fecha) {
    const created = this.parseFecha(fecha);
    if (!created) return null;
    const today = new Date();
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const c0 = new Date(created.getFullYear(), created.getMonth(), created.getDate());
    return Math.max(0, Math.floor((t0 - c0) / 86400000));
  },

  formatDias(fecha) {
    const n = this.diasDesdeCreacion(fecha);
    if (n === null) return '—';
    return String(n);
  },

  diasCellHtml(fecha) {
    const n = this.diasDesdeCreacion(fecha);
    if (n === null) return '—';
    const cls = n >= 7 ? 'tareas-dias-badge tareas-dias-badge--alert' : 'tareas-dias-badge';
    const title = n === 0 ? 'Creada hoy' : `${n} día(s) desde la creación`;
    return `<span class="badge ${cls}" title="${this.escapeHtml(title)}">${n}</span>`;
  },

  defaultNewRow() {
    const now = new Date();
    return {
      TAREA: '',
      RESPONSABLE: this.sessionResponsable(),
      PRIORIDAD: 'BAJA',
      ST: 'PENDIENTE',
      HORA: now.getHours(),
      MINUTO: now.getMinutes(),
    };
  },

  formatHora(row) {
    const h = Number(row?.HORA);
    const m = Number(row?.MINUTO);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return '—';
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  },

  prioridadBadge(value) {
    const v = String(value ?? '').trim().toUpperCase();
    const cls =
      v === 'ALTA' ? 'tareas-prioridad-alta' : v === 'MEDIA' ? 'tareas-prioridad-media' : 'tareas-prioridad-baja';
    return `<span class="badge tareas-prioridad-badge ${cls}">${this.escapeHtml(v || '—')}</span>`;
  },

  estadoBadgeButton(row) {
    const v = this.normalizeEstado(row?.ST);
    const cls = v === 'FINALIZADA' ? 'tareas-estado-finalizada' : 'tareas-estado-pendiente';
    const title =
      v === 'FINALIZADA' ? 'Clic para reactivar (pendiente)' : 'Clic para marcar como finalizada';
    return `<button type="button" class="tareas-estado-toggle badge tareas-estado-badge ${cls}"
      data-id="${this.escapeHtml(row.ID)}" data-st="${this.escapeHtml(v)}"
      title="${this.escapeHtml(title)}" aria-label="${this.escapeHtml(title)}">${this.escapeHtml(v)}</button>`;
  },

  tableColSpan() {
    return TAREAS_TABLE_COLUMNS.length + 1;
  },

  getFilteredRows() {
    let rows = this._rows;
    if (this._filterEstado) {
      rows = rows.filter((r) => this.normalizeEstado(r.ST) === this._filterEstado);
    }
    const q = this._filterQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const parts = [
        r.TAREA,
        r.RESPONSABLE,
        r.PRIORIDAD,
        r.ST,
        this.formatDias(r.FECHA),
        this.formatHora(r),
      ].map((v) => String(v ?? '').toLowerCase());
      return parts.some((p) => p.includes(q));
    });
  },

  renderTableBodyHtml(rows) {
    const colSpan = this.tableColSpan();
    if (!rows.length) {
      let msg = 'Sin tareas registradas';
      if (this._filterEstado === 'PENDIENTE') msg = 'Sin tareas pendientes';
      else if (this._filterEstado === 'FINALIZADA') msg = 'Sin tareas finalizadas';
      if (this._filterQuery.trim()) msg = 'Ningún registro coincide con la búsqueda';
      return `<tr><td colspan="${colSpan}" class="text-center text-muted py-4">${msg}</td></tr>`;
    }
    return rows
      .map((row) => {
        const cells = TAREAS_TABLE_COLUMNS.map((c) => {
          const extra = c.cellClass ? ` class="${c.cellClass}"` : '';
          let html;
          if (c.key === 'DIAS') html = this.diasCellHtml(row.FECHA);
          else if (c.key === 'HORA') html = this.escapeHtml(this.formatHora(row));
          else if (c.key === 'PRIORIDAD') html = this.prioridadBadge(row.PRIORIDAD);
          else if (c.key === 'ST') html = this.estadoBadgeButton(row);
          else html = TareasViewBase.formatCell.call(this, row[c.key], c);
          const align = c.key === 'DIAS' ? ' text-end' : '';
          const tdClass = `${align}${c.cellClass ? ` ${c.cellClass}` : ''}`.trim();
          return `<td${tdClass ? ` class="${tdClass}"` : ''}>${html}</td>`;
        }).join('');
        return `<tr>${cells}<td class="text-end text-nowrap">
          <button type="button" class="btn btn-sm btn-outline-secondary tareas-print me-1" data-id="${this.escapeHtml(row.ID)}" title="Imprimir">
            <i class="fa-solid fa-print" aria-hidden="true"></i>
          </button>
          ${CatalogosUI.accionesRow(row.ID, 'id')}
        </td></tr>`;
      })
      .join('');
  },

  renderTable() {
    const headers = TAREAS_TABLE_COLUMNS.map(
      (c) => `<th scope="col"${c.key === 'DIAS' ? ' class="text-end"' : ''}>${this.escapeHtml(c.label)}</th>`
    )
      .concat('<th scope="col" class="text-end">Acciones</th>')
      .join('');

    const estadoOpts = [
      { value: '', label: 'TODAS' },
      { value: 'PENDIENTE', label: 'PENDIENTES' },
      { value: 'FINALIZADA', label: 'FINALIZADAS' },
    ];
    const estadoSelect = estadoOpts
      .map(
        (o) =>
          `<option value="${o.value}"${this._filterEstado === o.value ? ' selected' : ''}>${o.label}</option>`
      )
      .join('');

    const filtered = this.getFilteredRows();

    return `
      <div class="catalogo-empresa-panel catalogo-vista-wrap">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2 px-1">
          <span class="catalogo-empresa-badge" id="tareas-count">${this.badgeText(filtered.length, this._rows.length)}</span>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-tareas-refresh">
            <i class="fa-solid fa-rotate-right me-1"></i>Actualizar
          </button>
        </div>
        <div class="d-flex flex-wrap align-items-center gap-2 px-1 mb-2">
          <label for="tareas-filter-estado" class="small text-muted mb-0">Estado:</label>
          <select class="form-select form-select-sm tareas-filter-estado" id="tareas-filter-estado">
            ${estadoSelect}
          </select>
        </div>
        <div class="catalogo-empresa-search-wrap px-1 mb-2">
          <div class="input-group input-group-sm catalogo-empresa-search">
            <span class="input-group-text" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></span>
            <input type="search" class="form-control" id="tareas-search"
              placeholder="Buscar por tarea, responsable, prioridad…"
              value="${this.escapeHtml(this._filterQuery)}" autocomplete="off" spellcheck="false">
            <button type="button" class="btn btn-outline-secondary" id="btn-tareas-search-clear"
              title="Limpiar búsqueda" aria-label="Limpiar búsqueda">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="table-responsive tareas-table-wrap">
          <table class="table table-sm table-hover table-striped">
            <thead><tr>${headers}</tr></thead>
            <tbody id="tareas-tbody">${this.renderTableBodyHtml(filtered)}</tbody>
          </table>
        </div>
        ${CatalogosUI.btnNuevoFab('btn-tareas-nuevo')}
      </div>
    `;
  },

  updateTableView() {
    const filtered = this.getFilteredRows();
    const tbody = this._container?.querySelector('#tareas-tbody');
    const badge = this._container?.querySelector('#tareas-count');
    if (tbody) {
      tbody.innerHTML = this.renderTableBodyHtml(filtered);
      this.bindRowActions();
    }
    if (badge) {
      badge.innerHTML = this.badgeText(filtered.length, this._rows.length);
    }
  },

  bindFilterEstado() {
    const sel = document.getElementById('tareas-filter-estado');
    if (!sel) return;
    sel.addEventListener('change', () => {
      this._filterEstado = sel.value;
      this.updateTableView();
    });
  },

  bindEstadoClickDelegation() {
    if (!this._container) return;
    if (this._estadoClickContainer === this._container && this._estadoClickHandler) return;
    if (this._estadoClickContainer && this._estadoClickHandler) {
      this._estadoClickContainer.removeEventListener('click', this._estadoClickHandler);
    }
    this._estadoClickHandler = (e) => {
      const printBtn = e.target.closest('.tareas-print');
      if (printBtn && this._container?.contains(printBtn)) {
        e.preventDefault();
        e.stopPropagation();
        const id = printBtn.getAttribute('data-id');
        const row = id != null ? this.findRow(id) : null;
        if (row) this.printTarea(row);
        return;
      }
      const btn = e.target.closest('.tareas-estado-toggle');
      if (!btn || !this._container?.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const st = btn.getAttribute('data-st');
      if (id != null) this.onToggleEstado(id, st);
    };
    this._estadoClickContainer = this._container;
    this._container.addEventListener('click', this._estadoClickHandler);
  },

  bindEvents() {
    TareasViewBase.bindEvents.call(this);
    this.bindFilterEstado();
    this.bindEstadoClickDelegation();
  },

  formatFechaPrint(value) {
    const d = this.parseFecha(value);
    if (!d) {
      const s = String(value || '').trim();
      return s ? s.slice(0, 10) : '—';
    }
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  },

  async printTarea(row) {
    if (!row || typeof PrintReport === 'undefined') {
      F.toast('No se puede imprimir en este momento', 'error');
      return;
    }
    try {
      await PrintReport.ensureLogo();
      const id = row.ID ?? '';
      const dias = this.formatDias(row.FECHA);
      const diasLabel =
        dias === '—' ? '—' : dias === '0' ? 'Creada hoy' : `${dias} día(s) desde la creación`;
      const bodyHtml = `
        ${PrintReport.reportHeaderHtml({
          title: 'Tarea',
          subtitleHtml: `
            <p><strong>No.:</strong> ${PrintReport.escapeHtml(id)}</p>
            <p><strong>Fecha:</strong> ${PrintReport.escapeHtml(this.formatFechaPrint(row.FECHA))}</p>
            <p class="small text-muted mb-0">Seguimiento de pendientes · Operaciones</p>
          `,
        })}
        <table class="table table-sm tareas-print-table">
          <tr><td>Tarea</td><td class="fw-semibold">${PrintReport.escapeHtml(row.TAREA || '—')}</td></tr>
          <tr><td>Responsable</td><td class="text-end">${PrintReport.escapeHtml(row.RESPONSABLE || '—')}</td></tr>
          <tr><td>Prioridad</td><td class="text-end">${PrintReport.escapeHtml(String(row.PRIORIDAD || '—').toUpperCase())}</td></tr>
          <tr><td>Estado</td><td class="text-end">${PrintReport.escapeHtml(this.normalizeEstado(row.ST))}</td></tr>
          <tr><td>Hora</td><td class="text-end">${PrintReport.escapeHtml(this.formatHora(row))}</td></tr>
          <tr><td>Antigüedad</td><td class="text-end">${PrintReport.escapeHtml(diasLabel)}</td></tr>
        </table>
        <div class="tareas-print-firmas">
          <div class="tareas-print-firma">Asignó</div>
          <div class="tareas-print-firma">Responsable</div>
        </div>`;
      await PrintReport.openAndPrint(
        () =>
          PrintReport.wrapDocument({
            title: `Tarea #${id}`,
            bodyHtml,
            extraStyles: `
              table.tareas-print-table{font-size:13px;}
              table.tareas-print-table td{padding:8px 10px;vertical-align:top;}
              table.tareas-print-table td:first-child{width:32%;color:#555;}
              .tareas-print-firmas{
                margin-top:5.5rem;
                display:flex;
                justify-content:space-between;
                gap:2.5rem;
              }
              .tareas-print-firma{
                flex:1;
                text-align:center;
                border-top:1px solid #333;
                padding-top:.55rem;
                min-height:3.25rem;
              }
            `,
          }),
        'width=720,height=780'
      );
    } catch (err) {
      F.toast(err.message || 'No se pudo imprimir', 'error');
    }
  },

  async onToggleEstado(id, stActual) {
    const actual = this.normalizeEstado(stActual);
    const siguiente = actual === 'FINALIZADA' ? 'PENDIENTE' : 'FINALIZADA';
    const row = this.findRow(id);
    const label = this.rowLabel(row, id);

    const ok = await CatalogosUI.fireConfirm({
      title: siguiente === 'FINALIZADA' ? '¿Marcar como finalizada?' : '¿Reactivar tarea?',
      html:
        siguiente === 'FINALIZADA'
          ? `<p class="mb-0">¿Desea marcar como <strong>FINALIZADA</strong> la tarea:<br><em>${this.escapeHtml(label)}</em>?</p>`
          : `<p class="mb-0">¿Desea volver a <strong>PENDIENTE</strong> la tarea:<br><em>${this.escapeHtml(label)}</em>?</p>`,
      icon: 'question',
      confirmText: siguiente === 'FINALIZADA' ? 'Finalizar' : 'Reactivar',
      confirmClass: 'btn-catalogo-guardar',
    });
    if (!ok) return;

    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(id)}/estado`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ST: siguiente }),
      });
      if (row) row.ST = siguiente;
      this.updateTableView();
      F.toast(`Tarea marcada como ${siguiente}`, 'success');
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  selectField(name, label, options, value, required = false) {
    const strVal = value !== null && value !== undefined ? String(value) : '';
    const req = required ? 'required' : '';
    const optsHtml = (options || [])
      .map(
        (o) =>
          `<option value="${this.escapeHtml(o.value)}"${strVal === String(o.value) ? ' selected' : ''}>${this.escapeHtml(o.label)}</option>`
      )
      .join('');
    return `
      <label class="form-label small mb-0">${this.escapeHtml(label)}</label>
      <select class="form-select form-select-sm" name="${name}" ${req}>
        ${optsHtml}
      </select>
    `;
  },

  inputField(name, label, value, opts = {}) {
    const { type = 'text', readonly = false, min, max } = opts;
    const ro = readonly ? 'readonly' : '';
    const minAttr = min !== undefined ? `min="${min}"` : '';
    const maxAttr = max !== undefined ? `max="${max}"` : '';
    return `
      <label class="form-label small mb-0">${this.escapeHtml(label)}</label>
      <input type="${type}" class="form-control form-control-sm" name="${name}"
        value="${this.escapeHtml(value ?? '')}" ${ro} ${minAttr} ${maxAttr}>
    `;
  },

  row2(col1, col2) {
    return `
      <div class="row g-2 mb-2">
        <div class="col-6">${col1}</div>
        <div class="col-6">${col2}</div>
      </div>
    `;
  },

  buildFormHtml(row = {}) {
    const r = {
      TAREA: row.TAREA ?? '',
      RESPONSABLE: row.RESPONSABLE ?? this.sessionResponsable(),
      PRIORIDAD: row.PRIORIDAD ?? 'BAJA',
      ST: row.ST ?? 'PENDIENTE',
      HORA: row.HORA ?? '',
      MINUTO: row.MINUTO ?? '',
    };

    return `
      <div class="mb-2">
        <label class="form-label small mb-0" for="tareas-campo-tarea">Tarea</label>
        <textarea class="form-control form-control-sm" name="TAREA" id="tareas-campo-tarea" rows="3"
          required placeholder="Describa la labor a realizar">${this.escapeHtml(r.TAREA)}</textarea>
      </div>
      <div class="mb-2">
        ${this.inputField('RESPONSABLE', 'Responsable', r.RESPONSABLE)}
      </div>
      ${this.row2(
        this.selectField('PRIORIDAD', 'Prioridad', TAREAS_PRIORIDAD_OPTS, r.PRIORIDAD, true),
        this.selectField('ST', 'Estado', TAREAS_ESTADO_OPTS, r.ST, true)
      )}
      ${this.row2(
        this.inputField('HORA', 'Hora', r.HORA, { type: 'number', min: 0, max: 23 }),
        this.inputField('MINUTO', 'Minuto', r.MINUTO, { type: 'number', min: 0, max: 59 })
      )}
    `;
  },

  readFormData() {
    const names = ['TAREA', 'RESPONSABLE', 'PRIORIDAD', 'ST', 'HORA', 'MINUTO'];
    const data = {};
    names.forEach((name) => {
      const input = document.querySelector(`.swal2-html-container [name="${name}"]`);
      if (!input) return;
      data[name] = input.value.trim();
    });
    return data;
  },

  async showForm(title, row = {}) {
    const view = this;
    return CatalogosUI.fireForm({
      title,
      html: view.buildFormHtml(row),
      width: 520,
      preConfirm() {
        const data = view.readFormData();
        const err = tareasValidateForm(data);
        if (err) {
          Swal.showValidationMessage(err);
          return false;
        }
        return tareasMapFormToApi(data);
      },
    });
  },

  async onNuevo() {
    const data = await this.showForm('Nueva tarea', this.defaultNewRow());
    if (!data) return;
    try {
      await F.fetchJson(this.apiBase(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      F.toast('Tarea creada', 'success');
      await this.load(this._container);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  async onEditar(id) {
    const row = this.findRow(id);
    if (!row) return;
    const data = await this.showForm('Editar tarea', row);
    if (!data) return;
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(id)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      F.toast('Tarea actualizada', 'success');
      await this.load(this._container);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },
};

