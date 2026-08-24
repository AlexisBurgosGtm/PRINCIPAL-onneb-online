/**
 * Archivo → Promociones — campañas (PROMOCIONES) y registros asociados.
 * El ID es IDENTITY: no se muestra ni se envía al crear.
 */
const PromocionesView = {
  _container: null,
  _rows: [],
  _filterQuery: '',
  _registros: [],
  _editRegId: null,
  _promoModal: null,

  escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  apiBase(path = '') {
    const empNit = F.getEmpNit();
    if (!empNit) throw new Error('No hay empresa activa. Cierre sesión e ingrese de nuevo.');
    const base = `/api/promociones${path}`;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}empnit=${encodeURIComponent(empNit)}`;
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

  toDateInput(value) {
    if (!value) return '';
    const s = String(value).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  },

  truncate(text, max = 80) {
    const s = String(text || '').trim();
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  },

  findRow(id) {
    return this._rows.find((r) => String(r.ID) === String(id));
  },

  getFilteredRows() {
    const q = this._filterQuery.trim().toLowerCase();
    if (!q) return this._rows;
    return this._rows.filter((r) =>
      [r.NOMBRE, r.STATUS, this.formatFecha(r.FECHA_INICIO), this.formatFecha(r.FECHA_FIN)]
        .map((v) => String(v ?? '').toLowerCase())
        .some((v) => v.includes(q))
    );
  },

  statusBadgeHtml(row) {
    const status = String(row.STATUS || '').toUpperCase() === 'FINALIZADA' ? 'FINALIZADA' : 'ACTIVA';
    const cls = status === 'ACTIVA' ? 'text-bg-success' : 'text-bg-danger';
    return `<button type="button" class="badge ${cls} border-0 promo-status-badge"
      data-id="${this.escapeHtml(row.ID)}" title="Cambiar estado">${this.escapeHtml(status)}</button>`;
  },

  renderTableBodyHtml(rows) {
    if (!rows.length) {
      const msg = this._filterQuery.trim()
        ? 'Ningún registro coincide con la búsqueda'
        : 'Sin campañas de promociones';
      return `<tr><td colspan="5" class="text-center text-muted py-4">${msg}</td></tr>`;
    }
    return rows
      .map((row) => {
        const nombre = this.escapeHtml(this.truncate(row.NOMBRE, 90));
        const nombreFull = this.escapeHtml(row.NOMBRE || '');
        return `<tr>
          <td title="${nombreFull}">${nombre}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(row.FECHA_INICIO))}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(row.FECHA_FIN))}</td>
          <td class="text-center">${this.statusBadgeHtml(row)}</td>
          <td class="text-end">
            <div class="catalogo-acciones">
              <button type="button" class="btn btn-sm btn-outline-primary promo-btn-registros"
                data-id="${this.escapeHtml(row.ID)}" title="Registros de la promoción">
                <i class="fa-solid fa-list"></i> Registros
              </button>
              ${CatalogosUI.btnEditar(row.ID, 'id')}
              ${CatalogosUI.btnEliminar(row.ID, 'id')}
            </div>
          </td>
        </tr>`;
      })
      .join('');
  },

  badgeText(filteredCount, totalCount) {
    const empNombre = F.getEmpNitNombre() || '';
    const extra = empNombre ? ` · ${this.escapeHtml(empNombre)}` : '';
    const q = this._filterQuery.trim();
    const countLabel =
      q && filteredCount !== totalCount
        ? `${filteredCount} de ${totalCount} promocion(es)`
        : `${totalCount} promocion(es)`;
    return `<i class="fa-solid fa-tags me-1"></i>${countLabel}${extra}`;
  },

  updateTableView() {
    const filtered = this.getFilteredRows();
    const tbody = this._container?.querySelector('#promociones-tbody');
    const badge = this._container?.querySelector('#promociones-count');
    if (tbody) {
      tbody.innerHTML = this.renderTableBodyHtml(filtered);
      this.bindRowActions();
    }
    if (badge) badge.innerHTML = this.badgeText(filtered.length, this._rows.length);
  },

  renderTable() {
    const filtered = this.getFilteredRows();
    return `
      <div class="catalogo-empresa-panel catalogo-vista-wrap">
        <h2 class="catalogo-vista-title h5 mb-2 px-1">Promociones</h2>
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2 px-1">
          <span class="catalogo-empresa-badge" id="promociones-count">${this.badgeText(
            filtered.length,
            this._rows.length
          )}</span>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-promociones-refresh">
            <i class="fa-solid fa-rotate-right me-1"></i>Actualizar
          </button>
        </div>
        <div class="catalogo-empresa-search-wrap px-1 mb-2">
          <div class="input-group input-group-sm catalogo-empresa-search">
            <span class="input-group-text" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></span>
            <input type="search" class="form-control" id="promociones-search"
              placeholder="Buscar por nombre, estado o fecha…" value="${this.escapeHtml(this._filterQuery)}"
              autocomplete="off" spellcheck="false">
            <button type="button" class="btn btn-outline-secondary" id="btn-promociones-search-clear"
              title="Limpiar búsqueda" aria-label="Limpiar búsqueda">
              <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
          </div>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-hover table-striped">
            <thead>
              <tr>
                <th>Nombre / descripción</th>
                <th>Fecha inicio</th>
                <th>Fecha fin</th>
                <th class="text-center">Estado</th>
                <th class="text-end">Acciones</th>
              </tr>
            </thead>
            <tbody id="promociones-tbody">${this.renderTableBodyHtml(filtered)}</tbody>
          </table>
        </div>
        ${CatalogosUI.btnNuevoFab('btn-promociones-nuevo')}
      </div>`;
  },

  formHtml(row = {}) {
    return `
      <div class="mb-2 text-start">
        <label class="form-label small mb-0" for="promo-nombre">Nombre / descripción</label>
        <textarea id="promo-nombre" class="form-control form-control-sm" rows="4"
          required placeholder="Descripción larga de la campaña">${this.escapeHtml(row.NOMBRE || '')}</textarea>
      </div>
      <div class="row g-2">
        <div class="col-12 col-sm-6">
          <label class="form-label small mb-0" for="promo-fecha-inicio">Fecha inicio</label>
          <input type="date" id="promo-fecha-inicio" class="form-control form-control-sm"
            value="${this.escapeHtml(this.toDateInput(row.FECHA_INICIO))}">
        </div>
        <div class="col-12 col-sm-6">
          <label class="form-label small mb-0" for="promo-fecha-fin">Fecha fin</label>
          <input type="date" id="promo-fecha-fin" class="form-control form-control-sm"
            value="${this.escapeHtml(this.toDateInput(row.FECHA_FIN))}">
        </div>
      </div>`;
  },

  readPromoForm() {
    const NOMBRE = document.getElementById('promo-nombre')?.value?.trim() || '';
    const FECHA_INICIO = document.getElementById('promo-fecha-inicio')?.value || '';
    const FECHA_FIN = document.getElementById('promo-fecha-fin')?.value || '';
    if (!NOMBRE) {
      Swal.showValidationMessage('El nombre / descripción es obligatorio');
      return false;
    }
    if (FECHA_INICIO && FECHA_FIN && FECHA_FIN < FECHA_INICIO) {
      Swal.showValidationMessage('La fecha fin no puede ser anterior a la fecha inicio');
      return false;
    }
    return {
      NOMBRE,
      FECHA_INICIO: FECHA_INICIO || null,
      FECHA_FIN: FECHA_FIN || null,
    };
  },

  async showForm(title, row = {}, isEdit = false) {
    return CatalogosUI.fireForm({
      title,
      html: this.formHtml(row),
      width: 560,
      didOpen: () => document.getElementById('promo-nombre')?.focus(),
      preConfirm: () => this.readPromoForm(),
    });
  },

  async onNuevo() {
    const data = await this.showForm('Nueva promoción');
    if (!data) return;
    try {
      await F.fetchJson(this.apiBase(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      F.toast('Promoción creada', 'success');
      await this.load(this._container);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  async onEditar(id) {
    const row = this.findRow(id);
    if (!row) return;
    const data = await this.showForm('Editar promoción', row, true);
    if (!data) return;
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(id)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      F.toast('Promoción actualizada', 'success');
      await this.load(this._container);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  async onEliminar(id) {
    const row = this.findRow(id);
    const nombre = this.truncate(row?.NOMBRE || `promoción #${id}`, 60);
    const auth = await CatalogosUI.authorizeEliminarRegistro({
      label: nombre,
      tipo: 'promoción',
      kind: 'registro',
      title: '¿Eliminar promoción?',
      html: `<p class="mb-0">Se eliminará <strong>${this.escapeHtml(nombre)}</strong> y sus registros asociados.</p>`,
      confirmText: 'Eliminar',
    });
    if (!auth) return;
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(id)}`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: auth.pass != null ? String(auth.pass) : '__AUTORIZADO__' }),
      });
      F.toast('Promoción eliminada', 'success');
      await this.load(this._container);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  async onToggleStatus(id) {
    const row = this.findRow(id);
    if (!row) return;
    const current = String(row.STATUS || '').toUpperCase() === 'FINALIZADA' ? 'FINALIZADA' : 'ACTIVA';
    const next = current === 'ACTIVA' ? 'FINALIZADA' : 'ACTIVA';
    const ok = await CatalogosUI.fireConfirm({
      title: 'Cambiar estado',
      html: `<p class="mb-0">¿Pasar de <strong>${this.escapeHtml(current)}</strong> a <strong>${this.escapeHtml(
        next
      )}</strong>?</p>`,
      icon: 'question',
      confirmText: 'Cambiar',
    });
    if (!ok) return;
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(id)}/status`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ STATUS: next }),
      });
      F.toast(`Estado: ${next}`, 'success');
      await this.load(this._container);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  registroFormHtml(row = {}) {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate()
    ).padStart(2, '0')}`;
    return `
      <input type="hidden" id="promo-reg-id" value="${this.escapeHtml(row.ID || '')}">
      <div class="mb-2 text-start">
        <label class="form-label small mb-0" for="promo-reg-fecha">Fecha</label>
        <input type="date" id="promo-reg-fecha" class="form-control form-control-sm"
          value="${this.escapeHtml(this.toDateInput(row.FECHA) || iso)}" required>
      </div>
      <div class="mb-2 text-start">
        <label class="form-label small mb-0" for="promo-reg-codigo">Código</label>
        <input type="number" id="promo-reg-codigo" class="form-control form-control-sm" step="1"
          value="${this.escapeHtml(row.CODIGO ?? '')}">
      </div>
      <div class="mb-2 text-start">
        <label class="form-label small mb-0" for="promo-reg-tipo">Tipo</label>
        <input type="text" id="promo-reg-tipo" class="form-control form-control-sm" maxlength="50"
          value="${this.escapeHtml(row.TIPO || '')}" required>
      </div>
      <div class="mb-2 text-start">
        <label class="form-label small mb-0" for="promo-reg-valor">Valor</label>
        <input type="text" id="promo-reg-valor" class="form-control form-control-sm" maxlength="200"
          value="${this.escapeHtml(row.VALOR || '')}">
      </div>
      <div class="d-flex flex-wrap gap-2">
        <button type="button" class="btn btn-sm btn-primary" id="promo-reg-guardar">
          <i class="fa-solid fa-floppy-disk me-1"></i><span id="promo-reg-guardar-label">Agregar</span>
        </button>
        <button type="button" class="btn btn-sm btn-outline-secondary d-none" id="promo-reg-cancelar">
          Cancelar edición
        </button>
      </div>`;
  },

  registrosListHtml() {
    if (!this._registros.length) {
      return '<p class="text-muted small mb-0 text-center py-3">Sin registros en esta promoción.</p>';
    }
    const body = this._registros
      .map(
        (r) => `<tr>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
          <td class="text-end">${this.escapeHtml(r.CODIGO ?? '—')}</td>
          <td>${this.escapeHtml(r.TIPO || '—')}</td>
          <td>${this.escapeHtml(r.VALOR || '—')}</td>
          <td class="text-end text-nowrap">
            <button type="button" class="btn btn-sm btn-outline-secondary promo-reg-editar" data-id="${this.escapeHtml(
              r.ID
            )}" title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>
            <button type="button" class="btn btn-sm btn-outline-danger promo-reg-eliminar" data-id="${this.escapeHtml(
              r.ID
            )}" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>`
      )
      .join('');
    return `
      <div class="table-responsive" style="max-height: 22rem;">
        <table class="table table-sm table-hover align-middle mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>Fecha</th>
              <th class="text-end">Código</th>
              <th>Tipo</th>
              <th>Valor</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  },

  registrosModalHtml(promo) {
    return `
      <div class="row g-3 text-start promo-registros-modal">
        <div class="col-12 col-lg-4">
          <div class="card h-100">
            <div class="card-header py-2 small fw-semibold">Nuevo registro</div>
            <div class="card-body" id="promo-reg-form">${this.registroFormHtml()}</div>
          </div>
        </div>
        <div class="col-12 col-lg-8">
          <div class="card h-100">
            <div class="card-header py-2 small fw-semibold">
              ${this.escapeHtml(this.truncate(promo.NOMBRE || 'Promoción', 70))}
            </div>
            <div class="card-body p-2" id="promo-reg-list">${this.registrosListHtml()}</div>
          </div>
        </div>
      </div>`;
  },

  refreshRegistrosPanel() {
    const list = document.getElementById('promo-reg-list');
    if (list) list.innerHTML = this.registrosListHtml();
    this.bindRegistroListEvents();
  },

  setRegistroForm(row) {
    const form = document.getElementById('promo-reg-form');
    if (!form) return;
    form.innerHTML = this.registroFormHtml(row || {});
    const editing = Boolean(row?.ID);
    this._editRegId = editing ? row.ID : null;
    const label = document.getElementById('promo-reg-guardar-label');
    const cancel = document.getElementById('promo-reg-cancelar');
    const head = form.closest('.card')?.querySelector('.card-header');
    if (label) label.textContent = editing ? 'Guardar' : 'Agregar';
    if (cancel) cancel.classList.toggle('d-none', !editing);
    if (head) head.textContent = editing ? 'Editar registro' : 'Nuevo registro';
    this.bindRegistroFormEvents();
  },

  readRegistroForm() {
    const FECHA = document.getElementById('promo-reg-fecha')?.value || '';
    const codigoRaw = document.getElementById('promo-reg-codigo')?.value;
    const TIPO = document.getElementById('promo-reg-tipo')?.value?.trim() || '';
    const VALOR = document.getElementById('promo-reg-valor')?.value?.trim() || '';
    if (!FECHA) {
      F.toast('La fecha es obligatoria', 'warning');
      return null;
    }
    if (!TIPO) {
      F.toast('El tipo es obligatorio', 'warning');
      return null;
    }
    let CODIGO = null;
    if (codigoRaw !== undefined && String(codigoRaw).trim() !== '') {
      CODIGO = parseInt(codigoRaw, 10);
      if (!Number.isFinite(CODIGO)) {
        F.toast('El código debe ser un entero', 'warning');
        return null;
      }
    }
    return { FECHA, CODIGO, TIPO, VALOR };
  },

  bindRegistroFormEvents() {
    document.getElementById('promo-reg-guardar')?.addEventListener('click', () => {
      this.saveRegistro().catch((err) => F.toast(err.message || 'No se pudo guardar', 'error'));
    });
    document.getElementById('promo-reg-cancelar')?.addEventListener('click', () => this.setRegistroForm(null));
  },

  bindRegistroListEvents() {
    document.querySelectorAll('.promo-reg-editar').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-id'));
        const row = this._registros.find((r) => Number(r.ID) === id);
        if (row) this.setRegistroForm(row);
      });
    });
    document.querySelectorAll('.promo-reg-eliminar').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-id'));
        this.deleteRegistro(id).catch((err) => F.toast(err.message || 'No se pudo eliminar', 'error'));
      });
    });
  },

  async fetchRegistros(idPromo) {
    const data = await F.fetchJson(this.apiBase(`/${encodeURIComponent(idPromo)}/registros`));
    this._registros = data.rows || [];
    return data;
  },

  async saveRegistro() {
    const promo = this._promoModal;
    if (!promo) return;
    const payload = this.readRegistroForm();
    if (!payload) return;
    const editId = this._editRegId;
    if (editId) {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(promo.ID)}/registros/${encodeURIComponent(editId)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      F.toast('Registro actualizado', 'success');
    } else {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(promo.ID)}/registros`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      F.toast('Registro creado', 'success');
    }
    await this.fetchRegistros(promo.ID);
    this.setRegistroForm(null);
    this.refreshRegistrosPanel();
  },

  async deleteRegistro(id) {
    const promo = this._promoModal;
    if (!promo || !id) return;
    const promoId = promo.ID;
    const row = this._registros.find((r) => Number(r.ID) === Number(id));
    const label = `${this.formatFecha(row?.FECHA)} · ${row?.TIPO || 'registro'}`;
    const auth = await CatalogosUI.authorizeEliminarRegistro({
      label,
      tipo: 'registro de promoción',
      kind: 'registro',
      title: '¿Eliminar registro?',
      html: `<p class="mb-0">Se eliminará <strong>${this.escapeHtml(label)}</strong>.</p>`,
      confirmText: 'Eliminar',
    });
    if (!auth) {
      await this.onRegistros(promoId);
      return;
    }
    await F.fetchJson(this.apiBase(`/${encodeURIComponent(promoId)}/registros/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pass: auth.pass != null ? String(auth.pass) : '__AUTORIZADO__' }),
    });
    F.toast('Registro eliminado', 'success');
    await this.onRegistros(promoId);
  },

  async onRegistros(id) {
    const promo = this.findRow(id);
    if (!promo) return;
    this._promoModal = promo;
    this._editRegId = null;
    try {
      await this.fetchRegistros(id);
    } catch (err) {
      F.toast(err.message || 'No se pudieron cargar los registros', 'error');
      return;
    }
    await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Registros de la promoción',
      width: '72rem',
      html: this.registrosModalHtml(promo),
      showConfirmButton: false,
      showCancelButton: true,
      allowOutsideClick: false,
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cerrar'),
      didOpen: () => {
        this.bindRegistroFormEvents();
        this.bindRegistroListEvents();
      },
      didClose: () => {
        this._promoModal = null;
        this._registros = [];
        this._editRegId = null;
      },
    });
  },

  bindRowActions() {
    this._container?.querySelectorAll('.btn-catalogo-editar').forEach((btn) => {
      btn.addEventListener('click', () => this.onEditar(btn.dataset.id));
    });
    this._container?.querySelectorAll('.btn-catalogo-eliminar').forEach((btn) => {
      btn.addEventListener('click', () => this.onEliminar(btn.dataset.id));
    });
    this._container?.querySelectorAll('.promo-status-badge').forEach((btn) => {
      btn.addEventListener('click', () => this.onToggleStatus(btn.getAttribute('data-id')));
    });
    this._container?.querySelectorAll('.promo-btn-registros').forEach((btn) => {
      btn.addEventListener('click', () => this.onRegistros(btn.getAttribute('data-id')));
    });
  },

  bindSearch() {
    const search = document.getElementById('promociones-search');
    const clearBtn = document.getElementById('btn-promociones-search-clear');
    if (!search) return;
    const applyFilter = F.debounce(() => {
      this._filterQuery = search.value;
      this.updateTableView();
    }, 200);
    search.addEventListener('input', applyFilter);
    search.addEventListener('search', applyFilter);
    clearBtn?.addEventListener('click', () => {
      search.value = '';
      this._filterQuery = '';
      this.updateTableView();
      search.focus();
    });
  },

  bindEvents() {
    document.getElementById('btn-promociones-refresh')?.addEventListener('click', () => {
      this._filterQuery = '';
      this.load(this._container);
    });
    document.getElementById('btn-promociones-nuevo')?.addEventListener('click', () => this.onNuevo());
    this.bindSearch();
    this.bindRowActions();
  },

  async load(container) {
    const navToken =
      typeof F !== 'undefined' && typeof F.getMenuNavToken === 'function' ? F.getMenuNavToken() : 0;
    this._container = container;
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add('align-items-stretch', 'justify-content-start', 'p-3');

    if (!F.getEmpNit()) {
      container.innerHTML = `
        <div class="alert alert-warning m-3 w-100" role="alert">
          <i class="fa-solid fa-triangle-exclamation me-2"></i>
          No hay empresa activa. Cierre sesión e ingrese seleccionando una empresa.
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="text-center text-muted py-4 w-100">
        <i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando promociones…
      </div>`;

    try {
      const data = await F.fetchJson(`${this.apiBase()}&_=${Date.now()}`, { cache: 'no-store' });
      if (typeof F.isMenuNavigationCurrent === 'function' && !F.isMenuNavigationCurrent(navToken)) return;
      this._rows = data.rows || [];
      container.innerHTML = this.renderTable();
      this.bindEvents();
    } catch (err) {
      if (typeof F.isMenuNavigationCurrent === 'function' && !F.isMenuNavigationCurrent(navToken)) return;
      container.innerHTML = `
        <div class="alert alert-danger m-3 w-100" role="alert">
          <i class="fa-solid fa-circle-exclamation me-2"></i>
          No se pudo cargar: ${this.escapeHtml(err.message)}
        </div>`;
      F.toast('Error al cargar promociones', 'error');
    }
  },
};
