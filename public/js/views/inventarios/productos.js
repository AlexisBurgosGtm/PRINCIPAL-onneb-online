/**
 * Vista Productos — CRUD PRODUCTOS + PRECIOS por producto.
 */
const ProductosView = {
  _container: null,
  _rows: [],
  _totalCount: 0,
  _listTruncated: false,
  _filterQuery: '',
  _filterHabilitado: '',
  _filterMarca: '',
  _stats: { habilitados: 0, no_habilitados: 0, total: 0 },
  _lookups: null,
  _lookupsEmpNit: '',
  _muestraDesprod2: false,
  _screen: 'list',
  _formMode: 'new',
  _formRow: {},
  _formCodprod: null,
  _selectedCodprod: null,
  _pendingFotoFile: null,
  _fotoUrl: null,
  _precios: [],
  _loadingList: false,
  _loadingPrecios: false,
  _savingForm: false,
  _preciosModalCodprod: null,
  _preciosPanelRoot: null,
  _suppressPreciosModalClear: false,

  tableColumns: [
    { key: 'CODPROD', label: 'Código' },
    { key: 'CODPROD2', label: 'Cód. alt.' },
    { key: 'DESPROD', label: 'Descripción', cellClass: 'productos-col-desc' },
    { key: 'DESPROD2', label: 'Descripción 2', cellClass: 'productos-col-desc', desprod2Only: true },
    { key: 'DESMARCA', label: 'Marca' },
    { key: 'COSTO', label: 'Costo', type: 'money' },
    { key: 'HABILITADO', label: 'Habilitado', toggle: true },
  ],

  getVisibleColumns() {
    return this.tableColumns.filter((c) => !c.desprod2Only || this._muestraDesprod2);
  },

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
    const base = `/api/productos${path}`;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}empnit=${encodeURIComponent(empNit)}`;
  },

  formatMoney(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '—';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  formatQty(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('es-GT', { maximumFractionDigits: 4 });
  },

  formatHoraDoc(hora, minuto) {
    const h = Number(hora);
    const m = Number(minuto);
    if (!Number.isFinite(h)) return '—';
    const mm = Number.isFinite(m) ? m : 0;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  },

  formatFecha(value) {
    if (!value) return '—';
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  calcMargenUtilidad(precio, costo) {
    const p = Number(precio);
    const c = Number(costo);
    if (!Number.isFinite(p) || p <= 0) return 0;
    if (!Number.isFinite(c)) return 0;
    return Math.round((((p - c) / p) * 100) * 100) / 100;
  },

  formatMargenPct(precio, costo) {
    return `${this.calcMargenUtilidad(precio, costo).toFixed(2)}%`;
  },

  opcionesRowHtml(codprod) {
    return `
      <button type="button" class="btn btn-sm btn-outline-secondary btn-productos-opciones"
        data-codprod="${this.escapeHtml(codprod)}" data-stop-row="1"
        title="Opciones del producto" aria-label="Opciones">
        <i class="fa-solid fa-cog" aria-hidden="true"></i>
      </button>`;
  },

  preciosRowHtml(codprod) {
    return `
      <button type="button" class="btn btn-sm btn-outline-primary btn-productos-precios"
        data-codprod="${this.escapeHtml(codprod)}" data-stop-row="1"
        title="Precios" aria-label="Precios">
        <i class="fa-solid fa-dollar-sign me-1" aria-hidden="true"></i>Precios
      </button>`;
  },

  accionesRowHtml(codprod) {
    return `<div class="catalogo-acciones d-inline-flex flex-wrap gap-1 justify-content-end">
      ${this.preciosRowHtml(codprod)}
      ${CatalogosUI.btnEditar(codprod, 'codprod')}
      ${CatalogosUI.btnEliminar(codprod, 'codprod')}
    </div>`;
  },

  sumMovimientos(rows) {
    let entradas = 0;
    let salidas = 0;
    (rows || []).forEach((r) => {
      if (r.ENTRADAS != null) entradas += Number(r.ENTRADAS) || 0;
      if (r.SALIDAS != null) salidas += Number(r.SALIDAS) || 0;
    });
    return {
      entradas,
      salidas,
      existencia: entradas - salidas,
    };
  },

  sumDocLineas(rows) {
    let unidades = 0;
    let totalPrecio = 0;
    (rows || []).forEach((r) => {
      unidades += Number(r.TOTALUNIDADES) || 0;
      totalPrecio += Number(r.TOTALPRECIO) || 0;
    });
    return { unidades, totalPrecio };
  },

  movQtyCell(value) {
    if (value == null || value === '') return '';
    return `<span class="fw-bold">${this.escapeHtml(this.formatQty(value))}</span>`;
  },

  precioUnitarioLabelHtml(precio, equivale) {
    const eq = Number(equivale);
    const pr = Number(precio);
    if (!Number.isFinite(eq) || eq <= 0 || Number.isNaN(pr)) return '';
    const unit = Math.round((pr / eq) * 10000) / 10000;
    return `<span class="productos-precio-unit small text-muted">(${this.escapeHtml(this.formatMoney(unit))})</span>`;
  },

  normalizeHabilitado(value) {
    return String(value ?? 'NO').trim().toUpperCase() === 'SI' ? 'SI' : 'NO';
  },

  habilitadoButtonHtml(row) {
    const hab = this.normalizeHabilitado(row.HABILITADO);
    const cls = hab === 'SI' ? 'btn-empleado-activo--si' : 'btn-empleado-activo--no';
    return `
      <button type="button" class="btn btn-sm btn-empleado-activo ${cls}"
        data-codprod="${this.escapeHtml(row.CODPROD)}"
        data-habilitado="${hab}"
        data-stop-row="1"
        aria-label="Habilitado: ${hab}. Clic para cambiar"
        title="Clic para cambiar a ${hab === 'SI' ? 'NO' : 'SI'}">
        ${hab}
      </button>
    `;
  },

  setScreen(html, goingForward = true) {
    const host = this._container;
    if (!host) return Promise.resolve();
    host.classList.add('productos-screen-host');
    const from = host.querySelector('.productos-screen-active');
    if (!from) {
      host.innerHTML = `<div class="productos-screen-layer productos-screen-active">${html}</div>`;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const to = document.createElement('div');
      to.className = 'productos-screen-layer';
      to.innerHTML = html;
      if (goingForward) {
        from.classList.remove('productos-screen-active');
        from.classList.add('productos-screen-exit-left');
        to.classList.add('productos-screen-next');
      } else {
        from.classList.remove('productos-screen-active');
        from.classList.add('productos-screen-exit-right');
        to.classList.add('productos-screen-start-left');
      }
      host.appendChild(to);
      requestAnimationFrame(() => {
        if (goingForward) {
          to.classList.remove('productos-screen-next');
          to.classList.add('productos-screen-enter-from-right');
        } else {
          to.classList.remove('productos-screen-start-left');
          to.classList.add('productos-screen-enter-from-left');
        }
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        from.remove();
        to.classList.remove(
          'productos-screen-enter-from-right',
          'productos-screen-enter-from-left',
          'productos-screen-start-left'
        );
        to.classList.add('productos-screen-active');
        resolve();
      };
      const onEnd = (e) => {
        if (e.propertyName !== 'transform') return;
        to.removeEventListener('transitionend', onEnd);
        finish();
      };
      to.addEventListener('transitionend', onEnd);
      setTimeout(finish, 480);
    });
  },

  async loadLookups() {
    const empNit = F.getEmpNit() || '';
    if (this._lookups && this._lookupsEmpNit === empNit) return this._lookups;
    const data = await F.fetchJson(`${this.apiBase('/lookups')}&_=${Date.now()}`, { cache: 'no-store' });
    const mapOpts = (rows, codeKey, labelKey) =>
      (rows || []).map((r) => ({
        value: String(r[codeKey] ?? ''),
        label: String(r[labelKey] ?? r[codeKey] ?? '').trim(),
      }));
    this._lookups = {
      marcas: mapOpts(data.marcas, 'CODMARCA', 'DESMARCA'),
      fabricantes: mapOpts(data.fabricantes, 'CODCLAUNO', 'DESCLAUNO'),
      proveedores: mapOpts(data.proveedores, 'CODPROV', 'EMPRESA'),
      ubicaciones: mapOpts(data.ubicaciones, 'CODCLATRES', 'DESCLATRES'),
      medidas: (data.medidas || []).map((r) => {
        const code = String(r.CODMEDIDA ?? '').trim();
        const tipo = String(r.TIPOPRECIO ?? '').trim();
        return {
          value: code,
          label: tipo ? `${code} — ${tipo}` : code,
        };
      }),
    };
    this._lookupsEmpNit = empNit;
    return this._lookups;
  },

  listApiUrl() {
    const params = new URLSearchParams();
    const q = this._filterQuery.trim();
    if (q) params.set('q', q);
    if (this._filterHabilitado) params.set('habilitado', this._filterHabilitado);
    if (this._filterMarca) params.set('codmarca', this._filterMarca);
    params.set('_', String(Date.now()));
    const qs = params.toString();
    return qs ? `${this.apiBase()}&${qs}` : `${this.apiBase()}&_=${Date.now()}`;
  },

  async fetchStats() {
    const data = await F.fetchJson(`${this.apiBase('/stats')}&_=${Date.now()}`, { cache: 'no-store' });
    this._stats = {
      habilitados: data.habilitados ?? 0,
      no_habilitados: data.no_habilitados ?? 0,
      total: data.total ?? 0,
    };
  },

  renderStatsCards() {
    const el = this._container?.querySelector('#productos-stats');
    if (!el) return;
    el.innerHTML = `
      <div class="productos-stat-card card shadow-sm stat--si">
        <div class="card-body">
          <div class="small text-muted">Habilitados</div>
          <div class="stat-value">${this.escapeHtml(String(this._stats.habilitados))}</div>
        </div>
      </div>
      <div class="productos-stat-card card shadow-sm stat--no">
        <div class="card-body">
          <div class="small text-muted">No habilitados</div>
          <div class="stat-value">${this.escapeHtml(String(this._stats.no_habilitados))}</div>
        </div>
      </div>
      <div class="productos-stat-card card shadow-sm">
        <div class="card-body">
          <div class="small text-muted">Total productos</div>
          <div class="stat-value text-primary">${this.escapeHtml(String(this._stats.total))}</div>
        </div>
      </div>
    `;
  },

  formatCell(value, col) {
    if (value === null || value === undefined || value === '') return '—';
    if (col?.type === 'money') {
      return `<span class="productos-money">${this.escapeHtml(this.formatMoney(value))}</span>`;
    }
    if (col?.type === 'num') {
      const n = Number(value);
      return Number.isNaN(n) ? '—' : this.escapeHtml(n.toLocaleString('es-GT'));
    }
    if (col?.toggle) return '';
    return this.escapeHtml(value);
  },

  renderTableBodyHtml(rows) {
    const cols = this.getVisibleColumns();
    const colSpan = cols.length + 2;
    if (!rows.length) {
      const msg = this._filterQuery.trim()
        ? 'Ningún producto coincide con la búsqueda'
        : 'Sin productos';
      return `<tr><td colspan="${colSpan}" class="text-center text-muted py-4">${msg}</td></tr>`;
    }
    return rows
      .map((row) => {
        const selected = this._selectedCodprod === row.CODPROD ? ' productos-row-selected' : '';
        const cells = cols
          .map((c) => {
            if (c.toggle) {
              return `<td data-stop-row="1">${this.habilitadoButtonHtml(row)}</td>`;
            }
            const align = c.type === 'money' || c.type === 'num' ? ' text-end' : '';
            const extra = c.cellClass ? ` ${c.cellClass}` : '';
            return `<td class="${`${align}${extra}`.trim()}">${this.formatCell(row[c.key], c)}</td>`;
          })
          .join('');
        return `<tr class="productos-row${selected}" data-codprod="${this.escapeHtml(row.CODPROD)}" role="button" tabindex="0">
          <td class="productos-row-menu" data-stop-row="1">${this.opcionesRowHtml(row.CODPROD)}</td>
          ${cells}
          <td class="text-end" data-stop-row="1">${this.accionesRowHtml(row.CODPROD)}</td>
        </tr>`;
      })
      .join('');
  },

  badgeText() {
    const empNombre = F.getEmpNitNombre();
    const extra = empNombre ? ` · ${empNombre}` : '';
    const shown = this._rows.length;
    const total = this._totalCount;
    const countLabel =
      this._listTruncated && shown < total ? `Mostrando ${shown} de ${total}` : `${total}`;
    return `<i class="fa-solid fa-box me-1"></i>${countLabel} producto(s) en lista${this.escapeHtml(extra)}`;
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
        <option value="">—</option>
        ${optsHtml}
      </select>
    `;
  },

  selectFieldFixed(name, label, options, value) {
    const allowed = (options || []).map((o) => String(o.value));
    let strVal = value !== null && value !== undefined ? String(value).trim().toUpperCase() : '';
    if (!allowed.includes(strVal) && options?.length) {
      strVal = String(options[0].value);
    }
    const optsHtml = (options || [])
      .map(
        (o) =>
          `<option value="${this.escapeHtml(o.value)}"${strVal === String(o.value) ? ' selected' : ''}>${this.escapeHtml(o.label)}</option>`
      )
      .join('');
    return `
      <label class="form-label small mb-0">${this.escapeHtml(label)}</label>
      <select class="form-select form-select-sm" name="${name}" required>
        ${optsHtml}
      </select>
    `;
  },

  normalizeFacturar(value) {
    return String(value ?? 'SI').trim().toUpperCase() === 'NO' ? 'NO' : 'SI';
  },

  normalizeTipoProd(value) {
    const v = String(value ?? 'P').trim().toUpperCase();
    return v === 'S' ? 'S' : 'P';
  },

  normalizeExento(value) {
    const n = Number(value);
    return n === 1 ? 1 : 0;
  },

  todayDateInputValue() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  facturarToggleField(value) {
    const val = this.normalizeFacturar(value);
    const cls = val === 'SI' ? 'btn-empleado-activo--si' : 'btn-empleado-activo--no';
    return `
      <label class="form-label small mb-0 d-block">Facturar</label>
      <input type="hidden" name="FACTURAR" value="${val}">
      <button type="button" class="btn btn-sm btn-empleado-activo ${cls} btn-producto-facturar"
        data-facturar="${val}"
        aria-label="Facturar: ${val}. Clic para cambiar"
        title="Clic para cambiar a ${val === 'SI' ? 'NO' : 'SI'}">
        ${val}
      </button>
    `;
  },

  inputField(name, label, value, opts = {}) {
    const { type = 'text', readonly = false, required = false, step = '', min = '' } = opts;
    const ro = readonly ? 'readonly' : '';
    const req = required ? 'required' : '';
    const stepAttr = step ? `step="${step}"` : '';
    const minAttr = min !== '' && min !== undefined ? `min="${min}"` : '';
    return `
      <label class="form-label small mb-0">${this.escapeHtml(label)}</label>
      <input type="${type}" class="form-control form-control-sm" name="${name}"
        value="${this.escapeHtml(value ?? '')}" ${ro} ${req} ${stepAttr} ${minAttr}>
    `;
  },

  row2(c1, c2) {
    return `<div class="row g-2 mb-1"><div class="col-sm-6">${c1}</div><div class="col-sm-6">${c2}</div></div>`;
  },

  dateField(name, label, value, { defaultToday = false } = {}) {
    let v = '';
    if (value) {
      const s = String(value);
      v = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
      if (!v) {
        const d = new Date(s);
        if (!Number.isNaN(d.getTime())) {
          v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }
      }
    }
    if (!v && defaultToday) v = this.todayDateInputValue();
    return this.inputField(name, label, v, { type: 'date' });
  },

  formFieldCol(html) {
    return `<div class="col-md-6 col-lg-4 col-form">${html}</div>`;
  },

  formFieldColFull(html) {
    return `<div class="col-12 col-form">${html}</div>`;
  },

  formFieldRow3(c1, c2, c3) {
    return `<div class="row g-2"><div class="col-4 col-form">${c1}</div><div class="col-4 col-form">${c2}</div><div class="col-4 col-form">${c3}</div></div>`;
  },

  btnGuardarFab() {
    return `
      <button type="button" class="btn-productos-guardar-fab" id="btn-productos-form-guardar"
        aria-label="Guardar producto" title="Guardar">
        <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>
      </button>
    `;
  },

  renderFotoSelectorHtml(codprod) {
    const preview = this._fotoUrl
      ? `<img src="${this.escapeHtml(this._fotoUrl)}" alt="Foto producto" class="productos-foto-preview-img" id="productos-foto-preview-img">`
      : `<div class="productos-foto-placeholder" id="productos-foto-placeholder">
          <i class="fa-solid fa-camera" aria-hidden="true"></i>
          <span>Sin foto</span>
        </div>`;
    return `
      <div class="card productos-glass-card productos-foto-card mb-3">
        <div class="card-body productos-foto-card-body">
          <div class="productos-foto-preview" id="productos-foto-preview">${preview}</div>
          <div class="productos-foto-actions">
            <div class="fw-semibold mb-1"><i class="fa-solid fa-image me-1"></i>Foto del producto</div>
            <p class="small text-muted mb-2 mb-md-3">LOCAL: Fotos_productos. HOST: WebDAV (STORAGE_SERVER).</p>
            <div class="d-flex flex-wrap gap-2">
              <label class="btn btn-sm btn-outline-primary mb-0" for="productos-foto-input">
                <i class="fa-solid fa-upload me-1"></i>Seleccionar imagen
              </label>
              <input type="file" id="productos-foto-input" accept="image/jpeg,image/png,image/webp,image/gif" class="d-none">
              <button type="button" class="btn btn-sm btn-outline-danger" id="btn-productos-foto-quitar"${this._fotoUrl || this._pendingFotoFile ? '' : ' disabled'}>
                <i class="fa-solid fa-trash me-1"></i>Quitar
              </button>
            </div>
            ${codprod ? `<div class="small text-muted mt-2">Producto: ${this.escapeHtml(codprod)}</div>` : '<div class="small text-muted mt-2">La foto se subirá al guardar el producto nuevo.</div>'}
          </div>
        </div>
      </div>`;
  },

  fotoApiUrl(codprod, extra = {}) {
    const params = new URLSearchParams({ empnit: F.getEmpNit(), ...extra, _: String(Date.now()) });
    return `/api/productos/${encodeURIComponent(codprod)}/foto?${params}`;
  },

  setFotoPreview(url) {
    this._fotoUrl = url || null;
    const wrap = this._container?.querySelector('#productos-foto-preview');
    if (!wrap) return;
    if (this._fotoUrl) {
      wrap.innerHTML = `<img src="${this.escapeHtml(this._fotoUrl)}" alt="Foto producto" class="productos-foto-preview-img" id="productos-foto-preview-img">`;
    } else {
      wrap.innerHTML = `<div class="productos-foto-placeholder" id="productos-foto-placeholder">
          <i class="fa-solid fa-camera" aria-hidden="true"></i>
          <span>Sin foto</span>
        </div>`;
    }
    const quitar = this._container?.querySelector('#btn-productos-foto-quitar');
    if (quitar) quitar.disabled = !(this._fotoUrl || this._pendingFotoFile);
  },

  async loadProductoFoto(codprod) {
    this._pendingFotoFile = null;
    this._fotoUrl = null;
    if (!codprod) return;
    try {
      const data = await F.fetchJson(this.fotoApiUrl(codprod, { meta: '1' }), {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      this._fotoUrl = data?.url || null;
    } catch (_) {
      this._fotoUrl = null;
    }
  },

  async uploadProductoFoto(codprod, file) {
    if (!codprod || !file) return null;
    const body = new FormData();
    body.append('foto', file);
    const res = await fetch(this.fotoApiUrl(codprod), {
      method: 'POST',
      body,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo guardar la foto');
    return data;
  },

  buildProductFormPageHtml(row = {}, isEdit = false) {
    const L = this._lookups || {};
    const r = row || {};
    const pageClass = isEdit ? 'productos-form-page' : 'productos-form-page productos-form-page--new';
    const title = isEdit ? `Editar producto — ${r.CODPROD || ''}` : 'Nuevo producto';
    const codField = isEdit
      ? this.inputField('CODPROD', 'Código', r.CODPROD, { readonly: true })
      : this.inputField('CODPROD', 'Código', r.CODPROD, { required: true });

    const datosGenerales = `
      <div class="productos-form-grid">
        <div class="row g-2">
          ${this.formFieldCol(codField)}
          ${this.formFieldCol(this.inputField('CODPROD2', 'Código alterno', r.CODPROD2))}
        </div>
        <div class="col-form">${this.inputField('DESPROD', 'Descripción', r.DESPROD, { required: true })}</div>
        <div class="col-form">${this.inputField('DESPROD2', 'Descripción 2', r.DESPROD2)}</div>
        <div class="col-form">${this.inputField('DESPROD3', 'Descripción 3', r.DESPROD3)}</div>
        ${this.formFieldRow3(
          this.selectField('CODMEDIDACOMPRA', 'Medida compra', L.medidas, r.CODMEDIDACOMPRA),
          this.inputField('UXC', 'UXC', r.UXC, { type: 'number', step: '1' }),
          this.inputField('COSTO', 'Costo', r.COSTO, { type: 'number', step: '0.001' })
        )}
        <div class="row g-2">
          ${this.formFieldCol(this.inputField('INVMINIMO', 'Inv. mínimo', r.INVMINIMO, { type: 'number', step: '1' }))}
          ${this.formFieldCol(this.inputField('INVMAXIMO', 'Inv. máximo', r.INVMAXIMO, { type: 'number', step: '1' }))}
        </div>
      </div>
    `;

    const tipoProdOpts = [
      { value: 'P', label: 'BIEN' },
      { value: 'S', label: 'SERVICIO' },
    ];
    const exentoOpts = [
      { value: '0', label: 'AFECTO' },
      { value: '1', label: 'EXENTO' },
    ];
    const opcionesVenta = `
      <div class="productos-form-grid">
        ${this.row2(
          this.selectFieldFixed('TIPOPROD', 'Tipo producto', tipoProdOpts, this.normalizeTipoProd(r.TIPOPROD)),
          this.facturarToggleField(r.FACTURAR)
        )}
        ${this.row2(
          this.selectFieldFixed('EXENTO', 'Exento', exentoOpts, this.normalizeExento(r.EXENTO)),
          this.dateField('VENCIMIENTO', 'Vencimiento', r.VENCIMIENTO, { defaultToday: true })
        )}
      </div>
    `;

    const clasificaciones = `
      <div class="row productos-form-grid g-2">
        ${this.formFieldColFull(this.selectField('CODMARCA', 'Marca', L.marcas, r.CODMARCA))}
        ${this.formFieldColFull(this.selectField('CODCLADOS', 'Proveedor', L.proveedores, r.CODCLADOS))}
        ${this.formFieldColFull(this.selectField('CODCLAUNO', 'Fabricante', L.fabricantes, r.CODCLAUNO))}
        ${this.formFieldColFull(this.selectField('CODCLATRES', 'Ubicación', L.ubicaciones, r.CODCLATRES))}
      </div>
    `;

    const deleteBtn = isEdit
      ? `<button type="button" class="btn btn-sm btn-outline-danger" id="btn-productos-form-eliminar">
          <i class="fa-solid fa-trash me-1"></i>Eliminar
        </button>`
      : '';
    const opcionesBtn = isEdit
      ? `<button type="button" class="btn btn-sm btn-outline-secondary" id="btn-productos-form-opciones">
          <i class="fa-solid fa-cog me-1" aria-hidden="true"></i>Opciones
        </button>`
      : '';

    return `
      <div class="${pageClass}" id="productos-form">
        <div class="productos-form-toolbar">
          <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-productos-form-volver">
            <i class="fa-solid fa-arrow-left me-1"></i>Volver al listado
          </button>
          <span class="productos-form-title">${this.escapeHtml(title)}</span>
          <div class="d-flex flex-wrap gap-2 ms-auto">${opcionesBtn}${deleteBtn}</div>
        </div>
        ${this.renderFotoSelectorHtml(isEdit ? r.CODPROD : null)}
        <div class="row g-3">
          <div class="col-lg-7">
            <div class="card productos-glass-card productos-form-card h-100">
              <div class="card-header"><i class="fa-solid fa-box me-1"></i>Datos generales</div>
              <div class="card-body">${datosGenerales}</div>
            </div>
          </div>
          <div class="col-lg-5 d-flex flex-column gap-3">
            <div class="card productos-glass-card productos-form-card">
              <div class="card-header"><i class="fa-solid fa-sliders me-1"></i>Opciones</div>
              <div class="card-body">${opcionesVenta}</div>
            </div>
            <div class="card productos-glass-card productos-form-card">
              <div class="card-header"><i class="fa-solid fa-layer-group me-1"></i>Clasificaciones</div>
              <div class="card-body">${clasificaciones}</div>
            </div>
          </div>
        </div>
        ${isEdit ? `<div id="productos-form-precios-wrap" class="productos-form-precios-section">
          <div id="productos-form-precios-panel"></div>
        </div>` : ''}
        ${this.btnGuardarFab()}
      </div>
    `;
  },

  readProductForm() {
    const root = this._container?.querySelector('#productos-form');
    if (!root) return {};
    const get = (name) => root.querySelector(`[name="${name}"]`)?.value?.trim() ?? '';
    const num = (name) => {
      const v = get(name);
      return v === '' ? null : Number(v);
    };
    return {
      CODPROD: get('CODPROD'),
      CODPROD2: get('CODPROD2') || null,
      DESPROD: get('DESPROD'),
      DESPROD2: get('DESPROD2') || null,
      DESPROD3: get('DESPROD3') || null,
      UXC: num('UXC'),
      CODMEDIDACOMPRA: get('CODMEDIDACOMPRA') || null,
      COSTO: num('COSTO'),
      CODMARCA: num('CODMARCA'),
      CODCLAUNO: num('CODCLAUNO'),
      CODCLADOS: num('CODCLADOS'),
      CODCLATRES: num('CODCLATRES'),
      VENCIMIENTO: get('VENCIMIENTO') || null,
      INVMINIMO: num('INVMINIMO'),
      INVMAXIMO: num('INVMAXIMO'),
      EXENTO: this.normalizeExento(get('EXENTO')),
      TIPOPROD: this.normalizeTipoProd(get('TIPOPROD')),
      FACTURAR: this.normalizeFacturar(get('FACTURAR')),
    };
  },

  validateProductForm(data, isEdit) {
    if (!isEdit && !data.CODPROD) return 'El código de producto es obligatorio';
    if (!data.DESPROD) return 'La descripción es obligatoria';
    const costo = Number(data.COSTO);
    if (!Number.isFinite(costo) || costo <= 0) {
      return 'El costo debe ser mayor a cero';
    }
    return null;
  },

  activeCodprod() {
    if (this._preciosModalCodprod) return this._preciosModalCodprod;
    if (this._screen === 'form') return this._formCodprod;
    return this._selectedCodprod;
  },

  getPreciosPanelElement() {
    if (this._preciosPanelRoot) return this._preciosPanelRoot;
    if (this._screen === 'form') {
      return this._container?.querySelector('#productos-form-precios-panel') || null;
    }
    return null;
  },

  async showList() {
    this._screen = 'list';
    this._formCodprod = null;
    this._formRow = {};
    if (!this._container) return;
    try {
      await Promise.all([this.fetchStats(), this.fetchList()]);
    } catch (err) {
      F.toast(err.message, 'error');
    }
    await this.setScreen(this.renderShell(), false);
    this.renderStatsCards();
    this.bindListEvents();
    this.updateTableView();
  },

  async showListWithProduct(codprod) {
    this._screen = 'list';
    this._formCodprod = null;
    this._formRow = {};
    this._selectedCodprod = codprod || null;
    if (!this._container) return;

    if (codprod) this._filterQuery = String(codprod);

    try {
      await Promise.all([this.fetchStats(), this.fetchList()]);
      if (codprod && !this.findRow(codprod)) {
        const row = await this.fetchProductDetail(codprod);
        if (row) {
          this._rows = [row, ...this._rows.filter((r) => String(r.CODPROD) !== String(codprod))];
        }
      }
    } catch (err) {
      F.toast(err.message, 'error');
    }

    await this.setScreen(this.renderShell(), false);
    this.renderStatsCards();
    this.bindListEvents();
    this.updateTableView();
    if (codprod) {
      requestAnimationFrame(() => {
        this._container
          ?.querySelector('.productos-row-selected')
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  },

  async showForm(codprod = null) {
    this._screen = 'form';
    await this.loadLookups();
    const isEdit = Boolean(codprod);
    this._formMode = isEdit ? 'edit' : 'new';
    this._formCodprod = codprod;
    this._pendingFotoFile = null;
    this._fotoUrl = null;

    if (isEdit) {
      let row = this.findRow(codprod);
      try {
        row = (await this.fetchProductDetail(codprod)) || row;
      } catch (err) {
        F.alert('Error', err.message, 'error');
        await this.showList();
        return;
      }
      this._formRow = row || {};
      await this.loadProductoFoto(codprod);
    } else {
      this._formRow = {
        HABILITADO: 'SI',
        TIPOPROD: 'P',
        FACTURAR: 'SI',
        EXENTO: 0,
        VENCIMIENTO: this.todayDateInputValue(),
      };
    }

    if (!this._container) return;
    await this.setScreen(this.buildProductFormPageHtml(this._formRow, isEdit), true);
    this.bindFormEvents();

    if (isEdit) {
      this._selectedCodprod = codprod;
      await this.loadPrecios(codprod);
      this.renderPreciosPanel();
    }
  },

  bindFormEvents() {
    document.getElementById('btn-productos-form-volver')?.addEventListener('click', () => this.showList());
    document.getElementById('btn-productos-form-guardar')?.addEventListener('click', () => this.onFormGuardar());
    document.getElementById('btn-productos-form-eliminar')?.addEventListener('click', () => {
      if (this._formCodprod) this.onEliminar(this._formCodprod, true);
    });
    document.getElementById('btn-productos-form-opciones')?.addEventListener('click', () => {
      if (this._formCodprod) this.showOpcionesProducto(this._formCodprod);
    });
    this._container?.querySelectorAll('.btn-producto-facturar').forEach((btn) => {
      btn.addEventListener('click', () => {
        const root = this._container?.querySelector('#productos-form');
        const hidden = root?.querySelector('[name="FACTURAR"]');
        const actual = this.normalizeFacturar(btn.dataset.facturar);
        const siguiente = actual === 'SI' ? 'NO' : 'SI';
        btn.dataset.facturar = siguiente;
        btn.textContent = siguiente;
        btn.classList.remove('btn-empleado-activo--si', 'btn-empleado-activo--no');
        btn.classList.add(siguiente === 'SI' ? 'btn-empleado-activo--si' : 'btn-empleado-activo--no');
        btn.setAttribute('aria-label', `Facturar: ${siguiente}. Clic para cambiar`);
        btn.title = `Clic para cambiar a ${siguiente === 'SI' ? 'NO' : 'SI'}`;
        if (hidden) hidden.value = siguiente;
      });
    });
    this.bindFotoEvents();
  },

  bindFotoEvents() {
    const input = document.getElementById('productos-foto-input');
    input?.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!/^image\/(jpeg|jpg|png|webp|gif)$/i.test(file.type)) {
        F.toast('Formato no válido. Use jpg, png, webp o gif', 'warning');
        input.value = '';
        return;
      }
      if (this._formMode === 'edit' && this._formCodprod) {
        try {
          const data = await this.uploadProductoFoto(this._formCodprod, file);
          this._pendingFotoFile = null;
          this.setFotoPreview(data.url);
          F.toast('Foto guardada', 'success');
        } catch (err) {
          F.toast(err.message || 'Error al guardar foto', 'error');
        } finally {
          input.value = '';
        }
        return;
      }
      this._pendingFotoFile = file;
      const localUrl = URL.createObjectURL(file);
      this.setFotoPreview(localUrl);
      input.value = '';
    });

    document.getElementById('btn-productos-foto-quitar')?.addEventListener('click', async () => {
      if (this._formMode === 'edit' && this._formCodprod && this._fotoUrl && !this._pendingFotoFile) {
        const ok = await CatalogosUI.fireConfirm({
          title: '¿Quitar foto?',
          html: '<p class="mb-0">Se eliminará la foto del producto.</p>',
          icon: 'warning',
          confirmText: 'Quitar',
        });
        if (!ok) return;
        try {
          await F.fetchJson(this.fotoApiUrl(this._formCodprod), { method: 'DELETE' });
          this._pendingFotoFile = null;
          this.setFotoPreview(null);
          F.toast('Foto eliminada', 'success');
        } catch (err) {
          F.toast(err.message || 'Error al quitar foto', 'error');
        }
        return;
      }
      this._pendingFotoFile = null;
      this.setFotoPreview(null);
    });
  },

  precioFormRowFull(html) {
    return `<div class="mb-2">${html}</div>`;
  },

  calcPrecioCosto(costoUnitario, equivalente) {
    const unit = Number(costoUnitario) || 0;
    const eq = parseInt(equivalente, 10) || 0;
    return unit * eq;
  },

  formatPrecioCostoValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    const rounded = Math.round(n * 10000) / 10000;
    return String(rounded);
  },

  async getProductoCostoUnitarioAsync(codprod) {
    let row =
      this._formRow?.CODPROD === codprod
        ? this._formRow
        : this.findRow(codprod) || this._formRow;
    if (row && (row.COSTOUNITARIO != null || row.COSTO != null)) {
      return Number(row.COSTOUNITARIO ?? row.COSTO) || 0;
    }
    try {
      const detail = await this.fetchProductDetail(codprod);
      if (detail) {
        if (this._formRow?.CODPROD === codprod) {
          this._formRow = { ...this._formRow, ...detail };
        }
        return Number(detail.COSTOUNITARIO ?? detail.COSTO) || 0;
      }
    } catch {
      /* usar 0 */
    }
    return 0;
  },

  normalizePrecioEquivalente(value) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return n;
  },

  bindPrecioFormCostCalc(costoUnitario) {
    const root = document.querySelector('.swal2-html-container .productos-precio-form');
    if (!root) return;
    const equiv = root.querySelector('[name="EQUIVALE"]');
    const costo = root.querySelector('[name="COSTO"]');
    const precio = root.querySelector('[name="PRECIO"]');
    const margenEl = root.querySelector('#productos-precio-margen');
    const applyEquiv = () => {
      if (!equiv) return 1;
      const normalized = this.normalizePrecioEquivalente(equiv.value);
      if (String(equiv.value) !== String(normalized)) equiv.value = String(normalized);
      return normalized;
    };
    const updateMargen = () => {
      if (!margenEl) return;
      const p = Number(precio?.value);
      const c = Number(costo?.value);
      margenEl.textContent = this.formatMargenPct(p, c);
    };
    const update = () => {
      const eq = applyEquiv();
      const total = this.calcPrecioCosto(costoUnitario, eq);
      if (costo) costo.value = this.formatPrecioCostoValue(total);
      updateMargen();
    };
    equiv?.addEventListener('input', update);
    equiv?.addEventListener('change', update);
    equiv?.addEventListener('blur', update);
    precio?.addEventListener('input', updateMargen);
    precio?.addEventListener('change', updateMargen);
    update();
  },

  buildPrecioFormHtml(row = {}, isEdit = false, costoUnitario = 0) {
    const L = this._lookups || {};
    const r = row || {};
    const equiv = this.normalizePrecioEquivalente(r.EQUIVALE ?? 1);
    const costoCalc = this.formatPrecioCostoValue(
      isEdit && r.COSTO != null ? r.COSTO : this.calcPrecioCosto(costoUnitario, equiv)
    );
    const margenInicial = this.formatMargenPct(r.PRECIO ?? 0, costoCalc);
    const medidaField = isEdit
      ? this.inputField('CODMEDIDA', 'Medida', r.CODMEDIDA, { readonly: true })
      : this.selectField('CODMEDIDA', 'Medida', L.medidas, r.CODMEDIDA, true);
    return `
      <div class="text-start productos-precio-form" data-costo-unitario="${this.escapeHtml(String(costoUnitario))}">
        <div class="mb-2">${medidaField}</div>
        ${this.row2(
          this.inputField('EQUIVALE', 'Equivalente', equiv, { type: 'number', step: '1', required: true, min: '1' }),
          this.inputField('COSTO', 'Costo', costoCalc, { type: 'number', step: '0.0001', readonly: true })
        )}
        ${this.precioFormRowFull(`
          <div class="d-flex align-items-end gap-2 flex-wrap">
            <div class="flex-grow-1" style="min-width: 8rem;">
              ${this.inputField('PRECIO', 'Precio', r.PRECIO ?? 0, { type: 'number', step: '0.0001', required: true })}
            </div>
            <div class="productos-precio-margen-wrap text-end">
              <label class="form-label small mb-0 d-block">Margen</label>
              <span id="productos-precio-margen" class="productos-precio-margen fw-semibold text-primary">${this.escapeHtml(margenInicial)}</span>
            </div>
          </div>
        `)}
        ${this.precioFormRowFull(
          this.inputField('MAYOREOC', 'Mayoreo C', r.MAYOREOC ?? 0, { type: 'number', step: '0.0001' })
        )}
        ${this.precioFormRowFull(
          this.inputField('MAYOREOB', 'Mayoreo B', r.MAYOREOB ?? 0, { type: 'number', step: '0.0001' })
        )}
        ${this.precioFormRowFull(
          this.inputField('MAYOREOA', 'Mayoreo A', r.MAYOREOA ?? 0, { type: 'number', step: '0.0001' })
        )}
        ${this.precioFormRowFull(
          this.inputField('PESO', 'Peso', r.PESO ?? 0, { type: 'number', step: '0.0001' })
        )}
      </div>
    `;
  },

  readPrecioForm() {
    const root = document.querySelector('.swal2-html-container .productos-precio-form');
    if (!root) return {};
    const get = (name) => root.querySelector(`[name="${name}"]`)?.value?.trim() ?? '';
    const num = (name) => {
      const v = get(name);
      return v === '' ? 0 : Number(v);
    };
    const costoUnitario = Number(root.getAttribute('data-costo-unitario')) || 0;
    const equivalente = this.normalizePrecioEquivalente(get('EQUIVALE'));
    return {
      CODMEDIDA: get('CODMEDIDA'),
      EQUIVALE: equivalente,
      COSTO: this.calcPrecioCosto(costoUnitario, equivalente),
      PRECIO: num('PRECIO'),
      MAYOREOA: num('MAYOREOA'),
      MAYOREOB: num('MAYOREOB'),
      MAYOREOC: num('MAYOREOC'),
      PESO: num('PESO'),
    };
  },

  validatePrecioFormData(data, medidasCount = 0) {
    if (!data.CODMEDIDA) return 'La medida es obligatoria';
    if (medidasCount === 0) return 'No hay medidas registradas para esta empresa';
    const eq = parseInt(data.EQUIVALE, 10);
    if (!Number.isFinite(eq) || eq <= 0) return 'El equivalente debe ser mayor a cero';
    return null;
  },

  async showPrecioForm(title, row = {}, isEdit = false) {
    await this.loadLookups();
    const cod = this.activeCodprod();
    const costoUnitario = cod ? await this.getProductoCostoUnitarioAsync(cod) : 0;
    const medidasCount = (this._lookups?.medidas || []).length;
    return CatalogosUI.fireForm({
      title,
      html: this.buildPrecioFormHtml(row, isEdit, costoUnitario),
      width: 420,
      didOpen: () => this.bindPrecioFormCostCalc(costoUnitario),
      preConfirm: () => {
        const data = this.readPrecioForm();
        const errMsg = this.validatePrecioFormData(data, medidasCount);
        if (errMsg) {
          Swal.showValidationMessage(errMsg);
          return false;
        }
        if (!data.PRECIO && data.PRECIO !== 0) {
          Swal.showValidationMessage('El precio es obligatorio');
          return false;
        }
        return data;
      },
    });
  },

  productoLabel(codprod) {
    const row = this.findRow(codprod) || (this._formRow?.CODPROD === codprod ? this._formRow : null);
    const desc = row?.DESPROD || '';
    return desc ? `${codprod} — ${desc}` : codprod;
  },

  opcionPickBtn(opcion, iconClass, label) {
    return `
      <button type="button" class="btn btn-outline-secondary productos-opcion-pick" data-opcion="${this.escapeHtml(opcion)}">
        <i class="${iconClass}" aria-hidden="true"></i>
        <span>${this.escapeHtml(label)}</span>
      </button>`;
  },

  async showOpcionesProducto(codprod) {
    const label = this.productoLabel(codprod);
    await Swal.fire({
      ...CatalogosUI.modalBase({ customClass: { popup: 'modal-catalogo productos-opciones-modal' } }),
      title: 'Opciones del producto',
      html: `
        <p class="small text-muted mb-3 text-start">${this.escapeHtml(label)}</p>
        <div class="productos-opciones-grid w-100">
          ${this.opcionPickBtn('movimientos', 'fa-solid fa-arrows-rotate', 'Movimientos')}
          ${this.opcionPickBtn('movimientos-fiscales', 'fa-solid fa-file-invoice', 'Movimientos Fiscales')}
          ${this.opcionPickBtn('ventas', 'fa-solid fa-cart-shopping', 'Ventas')}
          ${this.opcionPickBtn('compras', 'fa-solid fa-truck', 'Compras')}
          ${this.opcionPickBtn('copiar', 'fa-solid fa-copy', 'Copiar Producto')}
        </div>`,
      showCancelButton: true,
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cerrar'),
      showConfirmButton: false,
      didOpen: (popup) => {
        popup.querySelectorAll('.productos-opcion-pick').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const opcion = btn.getAttribute('data-opcion');
            Swal.close();
            if (opcion === 'movimientos') await this.showReporteMovimientos(codprod);
            else if (opcion === 'movimientos-fiscales') await this.showReporteMovimientos(codprod, { fiscal: true });
            else if (opcion === 'ventas') await this.showReporteVentas(codprod);
            else if (opcion === 'compras') await this.showReporteCompras(codprod);
            else if (opcion === 'copiar') await this.onCopiarProducto(codprod);
          });
        });
      },
    });
  },

  async onCopiarProducto(codprod) {
    const label = this.productoLabel(codprod);
    const ok = await CatalogosUI.fireConfirm({
      title: '¿Copiar producto?',
      html: `<p class="mb-0">¿Desea crear otro producto con las mismas características de <strong>${this.escapeHtml(label)}</strong>?</p>
        <p class="small text-muted mt-2 mb-0">Se copiarán los datos excepto el código, el código alterno y los precios.</p>`,
      icon: 'question',
      confirmText: 'Sí, copiar',
      confirmClass: 'btn-catalogo-guardar',
    });
    if (!ok) return;
    await this.showFormCopyFrom(codprod);
  },

  /**
   * Abre el formulario de nuevo producto con datos del origen (sin códigos ni precios).
   */
  async showFormCopyFrom(sourceCodprod) {
    this._screen = 'form';
    await this.loadLookups();
    this._formMode = 'new';
    this._formCodprod = null;
    this._selectedCodprod = null;
    this._pendingFotoFile = null;
    this._fotoUrl = null;
    this._precios = [];

    let row = this.findRow(sourceCodprod);
    try {
      row = (await this.fetchProductDetail(sourceCodprod)) || row;
    } catch (err) {
      F.alert('Error', err.message || 'No se pudo cargar el producto a copiar', 'error');
      return;
    }
    if (!row) {
      F.alert('Error', 'Producto no encontrado', 'error');
      return;
    }

    this._formRow = {
      ...row,
      CODPROD: '',
      CODPROD2: null,
    };

    if (!this._container) return;
    await this.setScreen(this.buildProductFormPageHtml(this._formRow, false), true);
    this.bindFormEvents();
    const codInput = this._container?.querySelector('#productos-form [name="CODPROD"]');
    if (codInput) {
      codInput.focus();
      try {
        codInput.select();
      } catch (_) {
        /* ignore */
      }
    }
  },

  reporteModalBase(title, html) {
    return {
      ...CatalogosUI.modalBase({
        customClass: { popup: 'modal-catalogo productos-reporte-modal modal-xl' },
      }),
      title,
      html,
      width: 'min(1140px, 96vw)',
      showConfirmButton: false,
      showCancelButton: true,
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cerrar'),
    };
  },

  renderMovimientosTableHtml(rows, { emptyMsg } = {}) {
    if (!rows?.length) {
      const msg = emptyMsg || 'Sin movimientos de entrada o salida';
      return `<p class="text-muted small text-center mb-0 py-3">${this.escapeHtml(msg)}</p>`;
    }
    const totals = this.sumMovimientos(rows);
    const body = rows
      .map(
        (r) => `<tr>
          <td class="text-nowrap">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatHoraDoc(r.HORA, r.MINUTO))}</td>
          <td>${this.escapeHtml(r.DOC_NOMCLIE || '')}</td>
          <td class="text-end text-success">${this.movQtyCell(r.ENTRADAS)}</td>
          <td class="text-end text-danger">${this.movQtyCell(r.SALIDAS)}</td>
        </tr>`
      )
      .join('');
    return `
      <div class="table-responsive productos-reporte-table-wrap">
        <table class="table table-sm table-striped table-hover mb-0 productos-reporte-table">
          <thead class="table-light sticky-top">
            <tr>
              <th>Documento</th>
              <th>Fecha</th>
              <th>Hora</th>
              <th>Nombre</th>
              <th class="text-end">Entradas</th>
              <th class="text-end">Salidas</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot class="table-light">
            <tr>
              <td colspan="4" class="text-end fw-semibold">Totales</td>
              <td class="text-end text-success">${this.movQtyCell(totals.entradas)}</td>
              <td class="text-end text-danger">${this.movQtyCell(totals.salidas)}</td>
            </tr>
            <tr>
              <td colspan="4" class="text-end fw-semibold">Existencia:</td>
              <td colspan="2" class="text-end">${this.movQtyCell(totals.existencia)}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  },

  renderDocLineasTableHtml(rows, { tipo = 'venta' } = {}) {
    if (!rows?.length) {
      const msg = tipo === 'compra' ? 'Sin compras registradas' : 'Sin ventas registradas';
      return `<p class="text-muted small text-center mb-0 py-3">${msg}</p>`;
    }
    const totals = this.sumDocLineas(rows);
    const body = rows
      .map(
        (r) => `<tr>
          <td class="text-nowrap">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatHoraDoc(r.HORA, r.MINUTO))}</td>
          <td class="text-nowrap">${this.escapeHtml(r.TIPODOC || '')}</td>
          <td>${this.escapeHtml(r.DOC_NOMCLIE || '')}</td>
          <td class="text-nowrap">${this.escapeHtml(r.CODMEDIDA || '')}</td>
          <td class="text-end">${this.escapeHtml(this.formatQty(r.TOTALUNIDADES))}</td>
          <td class="text-end">${this.escapeHtml(this.formatMoney(r.PRECIO))}</td>
          <td class="text-end">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
        </tr>`
      )
      .join('');
    return `
      <div class="table-responsive productos-reporte-table-wrap">
        <table class="table table-sm table-striped table-hover mb-0 productos-reporte-table">
          <thead class="table-light sticky-top">
            <tr>
              <th>Documento</th>
              <th>Fecha</th>
              <th>Hora</th>
              <th>Tipo</th>
              <th>Nombre</th>
              <th>Medida</th>
              <th class="text-end">Unidades</th>
              <th class="text-end">Precio</th>
              <th class="text-end">Total</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot class="table-light">
            <tr>
              <td colspan="6" class="text-end fw-semibold">Totales</td>
              <td class="text-end fw-bold">${this.escapeHtml(this.formatQty(totals.unidades))}</td>
              <td></td>
              <td class="text-end fw-bold">${this.escapeHtml(this.formatMoney(totals.totalPrecio))}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  },

  async fetchReporteMovimientos(codprod, q = '') {
    const params = new URLSearchParams({ _: String(Date.now()) });
    if (q) params.set('q', q);
    return F.fetchJson(
      `${this.apiBase(`/${encodeURIComponent(codprod)}/reporte/movimientos`)}&${params}`,
      { cache: 'no-store' }
    );
  },

  async fetchReporteMovimientosFiscales(codprod, q = '') {
    const params = new URLSearchParams({ _: String(Date.now()) });
    if (q) params.set('q', q);
    return F.fetchJson(
      `${this.apiBase(`/${encodeURIComponent(codprod)}/reporte/movimientos-fiscales`)}&${params}`,
      { cache: 'no-store' }
    );
  },

  async fetchReporteVentas(codprod) {
    return F.fetchJson(
      `${this.apiBase(`/${encodeURIComponent(codprod)}/reporte/ventas`)}&_=${Date.now()}`,
      { cache: 'no-store' }
    );
  },

  async fetchReporteCompras(codprod) {
    return F.fetchJson(
      `${this.apiBase(`/${encodeURIComponent(codprod)}/reporte/compras`)}&_=${Date.now()}`,
      { cache: 'no-store' }
    );
  },

  async showReporteMovimientos(codprod, { fiscal = false, label: labelOverride } = {}) {
    const label = labelOverride || this.productoLabel(codprod);
    const title = fiscal ? 'Movimientos Fiscales' : 'Movimientos';
    const searchId = fiscal ? 'productos-mov-fiscal-search' : 'productos-mov-search';
    const hostId = fiscal ? 'productos-mov-fiscal-table-host' : 'productos-mov-table-host';
    const emptyMsg = fiscal
      ? 'Sin movimientos fiscales de entrada o salida (FEF, FEC, FES, FNC)'
      : 'Sin movimientos de entrada o salida';
    let rows = [];
    let filterQ = '';
    let searchTimer = null;

    const renderContent = () => `
      <div class="productos-reporte-shell text-start">
        <p class="small text-muted mb-2">${this.escapeHtml(label)}</p>
        ${fiscal ? '<p class="small text-muted mb-2">Documentos: FEF, FEC, FES, FNC</p>' : ''}
        <div class="input-group input-group-sm mb-2">
          <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
          <input type="search" class="form-control" id="${searchId}"
            placeholder="Buscar documento, nombre, tipo…" value="${this.escapeHtml(filterQ)}" autocomplete="off">
        </div>
        <div id="${hostId}">${this.renderMovimientosTableHtml(rows, { emptyMsg })}</div>
        <p class="small text-muted mb-0 mt-2 productos-mov-count">${rows.length} movimiento(s)</p>
      </div>`;

    const reload = async () => {
      const host = document.getElementById(hostId);
      const countEl = document.querySelector('.productos-reporte-shell .productos-mov-count');
      if (host) host.innerHTML = '<p class="small text-muted text-center py-3 mb-0"><i class="fa-solid fa-spinner fa-spin me-1"></i>Cargando…</p>';
      try {
        const data = fiscal
          ? await this.fetchReporteMovimientosFiscales(codprod, filterQ)
          : await this.fetchReporteMovimientos(codprod, filterQ);
        rows = data.rows || [];
        if (host) host.innerHTML = this.renderMovimientosTableHtml(rows, { emptyMsg });
        if (countEl) countEl.textContent = `${rows.length} movimiento(s)`;
      } catch (err) {
        if (host) host.innerHTML = `<p class="small text-danger text-center py-3 mb-0">${this.escapeHtml(err.message)}</p>`;
      }
    };

    await Swal.fire({
      ...this.reporteModalBase(title, renderContent()),
      didOpen: () => {
        const search = document.getElementById(searchId);
        search?.addEventListener('input', () => {
          filterQ = search.value;
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => reload().catch(() => {}), 350);
        });
        reload().catch((err) => F.toast(err.message, 'error'));
      },
    });
  },

  async showReporteVentas(codprod) {
    const label = this.productoLabel(codprod);
    let html = '<p class="small text-muted text-center py-3 mb-0"><i class="fa-solid fa-spinner fa-spin me-1"></i>Cargando…</p>';
    const swalPromise = Swal.fire({
      ...this.reporteModalBase('Ventas', `
        <div class="productos-reporte-shell text-start">
          <p class="small text-muted mb-2">${this.escapeHtml(label)}</p>
          <div id="productos-ventas-host">${html}</div>
        </div>`),
      didOpen: async () => {
        const host = document.getElementById('productos-ventas-host');
        try {
          const data = await this.fetchReporteVentas(codprod);
          const rows = data.rows || [];
          if (host) {
            host.innerHTML = this.renderDocLineasTableHtml(rows, { tipo: 'venta' });
            host.insertAdjacentHTML(
              'afterend',
              `<p class="small text-muted mb-0 mt-2">${rows.length} línea(s)</p>`
            );
          }
        } catch (err) {
          if (host) host.innerHTML = `<p class="small text-danger text-center py-3 mb-0">${this.escapeHtml(err.message)}</p>`;
        }
      },
    });
    await swalPromise;
  },

  async showReporteCompras(codprod) {
    const label = this.productoLabel(codprod);
    let html = '<p class="small text-muted text-center py-3 mb-0"><i class="fa-solid fa-spinner fa-spin me-1"></i>Cargando…</p>';
    await Swal.fire({
      ...this.reporteModalBase('Compras', `
        <div class="productos-reporte-shell text-start">
          <p class="small text-muted mb-2">${this.escapeHtml(label)}</p>
          <div id="productos-compras-host">${html}</div>
        </div>`),
      didOpen: async () => {
        const host = document.getElementById('productos-compras-host');
        try {
          const data = await this.fetchReporteCompras(codprod);
          const rows = data.rows || [];
          if (host) {
            host.innerHTML = this.renderDocLineasTableHtml(rows, { tipo: 'compra' });
            host.insertAdjacentHTML(
              'afterend',
              `<p class="small text-muted mb-0 mt-2">${rows.length} línea(s)</p>`
            );
          }
        } catch (err) {
          if (host) host.innerHTML = `<p class="small text-danger text-center py-3 mb-0">${this.escapeHtml(err.message)}</p>`;
        }
      },
    });
  },

  renderPreciosPanel() {
    const panel = this.getPreciosPanelElement();
    if (!panel) return;
    const cod = this.activeCodprod();
    if (!cod) {
      panel.innerHTML = `<p class="text-muted small mb-0 py-2">Producto no seleccionado</p>`;
      return;
    }
    const rows = this._precios;
    const body = rows.length
      ? rows
          .map(
            (p) => `
        <tr>
          <td>${this.escapeHtml(p.CODMEDIDA)}</td>
          <td class="text-end">${this.escapeHtml(p.EQUIVALE)}</td>
          <td class="text-end">${this.escapeHtml(this.formatMoney(p.COSTO))}</td>
          <td class="text-end productos-money">${this.escapeHtml(this.formatMoney(p.PRECIO))}${this.precioUnitarioLabelHtml(p.PRECIO, p.EQUIVALE)}</td>
          <td class="text-end">
            <button type="button" class="btn btn-sm btn-outline-primary btn-precio-edit" data-id="${p.ID}" title="Editar">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-danger btn-precio-del" data-id="${p.ID}" title="Eliminar">
              <i class="fa-solid fa-trash"></i>
            </button>
          </td>
        </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="text-center text-muted py-3">Sin precios — agregue uno</td></tr>`;

    panel.innerHTML = `
      <div class="productos-precios-panel-header d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
        <span><i class="fa-solid fa-tags me-1"></i><strong>${this.escapeHtml(cod)}</strong></span>
        <button type="button" class="btn btn-sm btn-onneb-nuevo" id="btn-productos-precio-nuevo">
          <i class="fa-solid fa-plus me-1"></i>Agregar
        </button>
      </div>
      <div class="table-responsive">
        <table class="table table-sm table-hover mb-0 productos-precios-table">
          <thead class="table-light">
            <tr>
              <th>Medida</th>
              <th class="text-end">Eq.</th>
              <th class="text-end">Costo</th>
              <th class="text-end">Precio</th>
              <th class="text-end">Acciones</th>
            </tr>
          </thead>
          <tbody id="productos-precios-tbody">${body}</tbody>
        </table>
      </div>`;
    this.bindPreciosPanelEvents(panel);
  },

  bindPreciosPanelEvents(panel) {
    const root = panel || this.getPreciosPanelElement();
    if (!root) return;
    root.querySelector('#btn-productos-precio-nuevo')?.addEventListener('click', () => this.onPrecioNuevo());
    root.querySelectorAll('.btn-precio-edit').forEach((btn) => {
      btn.addEventListener('click', () => this.onPrecioEditar(parseInt(btn.getAttribute('data-id'), 10)));
    });
    root.querySelectorAll('.btn-precio-del').forEach((btn) => {
      btn.addEventListener('click', () => this.onPrecioEliminar(parseInt(btn.getAttribute('data-id'), 10)));
    });
  },

  async openPreciosModal(codprod) {
    if (!codprod) return;
    this._preciosModalCodprod = codprod;
    this._selectedCodprod = codprod;
    await this.loadPrecios(codprod, false);
    const label = this.productoLabel(codprod);

    await Swal.fire({
      ...CatalogosUI.modalBase({
        customClass: { popup: 'modal-catalogo productos-precios-modal' },
      }),
      title: 'Precios',
      html: `
        <div class="productos-precios-modal-body text-start">
          <p class="small text-muted mb-2">${this.escapeHtml(label)}</p>
          <div class="card productos-glass-card productos-precios-card-modal border-0 shadow-sm">
            <div class="card-body p-2">
              <div id="productos-precios-panel"></div>
            </div>
          </div>
        </div>`,
      width: 'min(720px, 96vw)',
      showConfirmButton: false,
      showCancelButton: true,
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cerrar'),
      didOpen: () => {
        const panel = Swal.getHtmlContainer()?.querySelector('#productos-precios-panel');
        this._preciosPanelRoot = panel;
        this.renderPreciosPanel();
      },
      willClose: () => {
        if (!this._suppressPreciosModalClear) {
          this._preciosModalCodprod = null;
          this._preciosPanelRoot = null;
        }
      },
    });
  },

  async loadPrecios(codprod, shouldRender = true) {
    if (!codprod) {
      this._precios = [];
      if (shouldRender) this.renderPreciosPanel();
      return;
    }
    this._loadingPrecios = true;
    try {
      const data = await F.fetchJson(
        `${this.apiBase(`/${encodeURIComponent(codprod)}/precios`)}&_=${Date.now()}`,
        { cache: 'no-store' }
      );
      this._precios = data.rows || [];
    } catch (err) {
      this._precios = [];
      F.toast(err.message, 'error');
    } finally {
      this._loadingPrecios = false;
      if (shouldRender) this.renderPreciosPanel();
    }
  },

  async selectProduct(codprod) {
    this._selectedCodprod = codprod;
    this.updateTableView();
  },

  updateTableView() {
    const tbody = this._container?.querySelector('#productos-tbody');
    const theadRow = this._container?.querySelector('#productos-table thead tr');
    const badge = this._container?.querySelector('#productos-count');
    if (theadRow) {
      theadRow.innerHTML = [
        '<th scope="col" class="productos-th-menu" aria-label="Opciones"></th>',
        ...this.getVisibleColumns().map((c) => {
          const align = c.type === 'money' || c.type === 'num' ? ' text-end' : '';
          return `<th scope="col" class="${align.trim()}">${this.escapeHtml(c.label)}</th>`;
        }),
        '<th scope="col" class="text-end">Acciones</th>',
      ].join('');
    }
    if (tbody) {
      tbody.innerHTML = this.renderTableBodyHtml(this._rows);
      this.bindRowActions();
      this.bindRowSelect();
      this.bindHabilitadoButtons();
    }
    if (badge) badge.innerHTML = this.badgeText();
  },

  async fetchList() {
    const data = await F.fetchJson(this.listApiUrl(), { cache: 'no-store' });
    this._rows = data.rows || [];
    this._totalCount = data.total ?? this._rows.length;
    this._listTruncated = Boolean(data.truncated);
    this._muestraDesprod2 = String(data.muestraDesprod2 || 'NO').trim().toUpperCase() === 'SI';
    return data;
  },

  async reloadList() {
    if (this._loadingList) return;
    this._loadingList = true;
    const tbody = this._container?.querySelector('#productos-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="${this.getVisibleColumns().length + 2}" class="text-center text-muted py-4">
        <i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando…</td></tr>`;
    }
    try {
      await Promise.all([this.fetchStats(), this.fetchList()]);
      this.renderStatsCards();
      this.updateTableView();
      if (this._selectedCodprod && !this._rows.find((r) => r.CODPROD === this._selectedCodprod)) {
        this._selectedCodprod = null;
        this._precios = [];
      }
    } catch (err) {
      F.toast(err.message, 'error');
    } finally {
      this._loadingList = false;
    }
  },

  findRow(codprod) {
    return this._rows.find((r) => String(r.CODPROD) === String(codprod));
  },

  async fetchProductDetail(codprod) {
    const data = await F.fetchJson(`${this.apiBase(`/${encodeURIComponent(codprod)}`)}&_=${Date.now()}`, {
      cache: 'no-store',
    });
    return data.row;
  },

  onNuevo() {
    this.showForm(null);
  },

  onEditar(codprod) {
    this.showForm(codprod);
  },

  async onFormGuardar() {
    if (this._savingForm) return;
    const isEdit = this._formMode === 'edit';
    const data = this.readProductForm();
    const errMsg = this.validateProductForm(data, isEdit);
    if (errMsg) {
      F.alert('Validación', errMsg, 'warning');
      return;
    }
    this._savingForm = true;
    const btn = document.getElementById('btn-productos-form-guardar');
    if (btn) btn.disabled = true;
    try {
      const codprod = isEdit ? this._formCodprod : data.CODPROD;
      if (isEdit) {
        await F.fetchJson(this.apiBase(`/${encodeURIComponent(codprod)}`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        F.toast('Producto actualizado', 'success');
      } else {
        await F.fetchJson(this.apiBase(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        F.toast('Producto creado', 'success');
      }
      if (this._pendingFotoFile) {
        try {
          await this.uploadProductoFoto(codprod, this._pendingFotoFile);
          this._pendingFotoFile = null;
        } catch (fotoErr) {
          F.toast(fotoErr.message || 'Producto guardado, pero falló la foto', 'warning');
        }
      }
      await this.showListWithProduct(codprod);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    } finally {
      this._savingForm = false;
      if (btn) btn.disabled = false;
    }
  },

  async onEliminar(codprod, fromForm = false) {
    const row = this.findRow(codprod) || this._formRow;
    const nombre = row?.DESPROD || codprod;
    try {
      const mov = await F.fetchJson(
        `${this.apiBase(`/${encodeURIComponent(codprod)}/movimientos`)}&_=${Date.now()}`,
        { cache: 'no-store' }
      );
      if (mov.tieneMovimientos) {
        F.alert(
          'No se puede eliminar',
          `El producto tiene ${mov.count} movimiento(s) registrados en documentos (DOCPRODUCTOS).`,
          'warning'
        );
        return;
      }
    } catch (err) {
      F.alert('Error', err.message, 'error');
      return;
    }
    const auth = await CatalogosUI.authorizeEliminarRegistro({
      label: nombre,
      tipo: 'producto',
      kind: 'registro',
      title: '¿Eliminar producto?',
      html: `<p class="mb-0">Se eliminará <strong>${this.escapeHtml(nombre)}</strong> y todos sus precios.</p>`,
      passText: 'Ingrese la clave de administrador para eliminar el producto.',
      confirmText: 'Eliminar',
    });
    if (!auth) return;
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(codprod)}`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: auth.pass != null ? String(auth.pass) : '__AUTORIZADO__' }),
      });
      F.toast('Producto eliminado', 'success');
      if (this._selectedCodprod === codprod) {
        this._selectedCodprod = null;
        this._precios = [];
      }
      await this.reloadList();
      if (fromForm) {
        await this.showList();
      }
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  async onPrecioNuevo() {
    const cod = this.activeCodprod();
    if (!cod) return;
    const backToModal = this._preciosModalCodprod === cod;
    if (backToModal) this._suppressPreciosModalClear = true;

    const data = await this.showPrecioForm('Nuevo precio');
    if (backToModal) this._suppressPreciosModalClear = false;

    if (!data) {
      if (backToModal) await this.openPreciosModal(cod);
      return;
    }
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(cod)}/precios`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      F.toast('Precio agregado', 'success');
      await this.loadPrecios(cod, !backToModal);
      if (backToModal) await this.openPreciosModal(cod);
    } catch (err) {
      F.alert('Error', err.message, 'error');
      if (backToModal) await this.openPreciosModal(cod);
    }
  },

  async onPrecioEditar(id) {
    const cod = this.activeCodprod();
    const row = this._precios.find((p) => p.ID === id);
    if (!row || !cod) return;
    const backToModal = this._preciosModalCodprod === cod;
    if (backToModal) this._suppressPreciosModalClear = true;

    const data = await this.showPrecioForm('Editar precio', row, true);
    if (backToModal) this._suppressPreciosModalClear = false;

    if (!data) {
      if (backToModal) await this.openPreciosModal(cod);
      return;
    }
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(cod)}/precios/${id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      F.toast('Precio actualizado', 'success');
      await this.loadPrecios(cod, !backToModal);
      if (backToModal) await this.openPreciosModal(cod);
    } catch (err) {
      F.alert('Error', err.message, 'error');
      if (backToModal) await this.openPreciosModal(cod);
    }
  },

  async onPrecioEliminar(id) {
    const cod = this.activeCodprod();
    const row = this._precios.find((p) => p.ID === id);
    const backToModal = this._preciosModalCodprod === cod;
    if (backToModal) this._suppressPreciosModalClear = true;

    const ok = await CatalogosUI.fireConfirm({
      title: '¿Eliminar precio?',
      html: `<p class="mb-0">Medida <strong>${this.escapeHtml(row?.CODMEDIDA)}</strong></p>`,
      icon: 'warning',
    });
    if (backToModal) this._suppressPreciosModalClear = false;

    if (!ok) {
      if (backToModal) await this.openPreciosModal(cod);
      return;
    }
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(cod)}/precios/${id}`), {
        method: 'DELETE',
      });
      F.toast('Precio eliminado', 'success');
      await this.loadPrecios(cod, !backToModal);
      if (backToModal) await this.openPreciosModal(cod);
    } catch (err) {
      F.alert('Error', err.message, 'error');
      if (backToModal) await this.openPreciosModal(cod);
    }
  },

  bindHabilitadoButtons() {
    if (!this._container) return;
    this._container.querySelectorAll('.btn-empleado-activo[data-codprod]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onToggleHabilitado(btn.dataset.codprod, btn.dataset.habilitado);
      });
    });
  },

  async onToggleHabilitado(codprod, habilitadoActual) {
    const row = this.findRow(codprod);
    if (!row) return;
    const actual = this.normalizeHabilitado(habilitadoActual);
    const siguiente = actual === 'SI' ? 'NO' : 'SI';
    const nombre = row.DESPROD || codprod;
    const confirm = await CatalogosUI.fireConfirm({
      title: '¿Cambiar estado habilitado?',
      html: `<p class="mb-0">Producto <strong>${this.escapeHtml(nombre)}</strong>: cambiar de <strong>${actual}</strong> a <strong>${siguiente}</strong>.</p>`,
      icon: 'question',
      confirmText: 'Cambiar',
    });
    if (!confirm) return;
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(codprod)}/habilitado`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ HABILITADO: siguiente }),
      });
      row.HABILITADO = siguiente;
      await this.fetchStats();
      this.renderStatsCards();
      this.updateTableView();
      F.toast(`Estado actualizado a ${siguiente}`, 'success');
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  bindRowSelect() {
    this._container?.querySelectorAll('.productos-row').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-stop-row]')) return;
        const cod = tr.getAttribute('data-codprod');
        if (cod) this.selectProduct(cod);
      });
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const cod = tr.getAttribute('data-codprod');
          if (cod) this.selectProduct(cod);
        }
      });
    });
  },

  bindRowActions() {
    this._container?.querySelectorAll('.btn-productos-opciones[data-codprod]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cod = btn.getAttribute('data-codprod');
        if (cod) this.showOpcionesProducto(cod).catch((err) => F.toast(err.message, 'error'));
      });
    });
    this._container?.querySelectorAll('.btn-productos-precios[data-codprod]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cod = btn.getAttribute('data-codprod');
        if (cod) this.openPreciosModal(cod).catch((err) => F.toast(err.message, 'error'));
      });
    });
    this._container?.querySelectorAll('.btn-catalogo-editar[data-codprod]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onEditar(btn.getAttribute('data-codprod'));
      });
    });
    this._container?.querySelectorAll('.btn-catalogo-eliminar[data-codprod]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onEliminar(btn.getAttribute('data-codprod'));
      });
    });
  },

  bindFilters() {
    const hab = document.getElementById('productos-filter-habilitado');
    const marca = document.getElementById('productos-filter-marca');
    const search = document.getElementById('productos-search');
    const clearBtn = document.getElementById('btn-productos-search-clear');
    const refresh = () => this.reloadList();
    hab?.addEventListener('change', () => {
      this._filterHabilitado = hab.value;
      refresh();
    });
    marca?.addEventListener('change', () => {
      this._filterMarca = marca.value;
      refresh();
    });
    if (search) {
      const apply = F.debounce(() => {
        this._filterQuery = search.value;
        refresh();
      }, 350);
      search.addEventListener('input', apply);
      search.addEventListener('search', apply);
    }
    clearBtn?.addEventListener('click', () => {
      search.value = '';
      this._filterQuery = '';
      refresh();
      search.focus();
    });
  },

  renderShell() {
    const habOpts = [
      { value: '', label: 'TODOS' },
      { value: 'SI', label: 'HABILITADOS (SI)' },
      { value: 'NO', label: 'NO HABILITADOS (NO)' },
    ];
    const habSelect = habOpts
      .map(
        (o) =>
          `<option value="${o.value}"${this._filterHabilitado === o.value ? ' selected' : ''}>${o.label}</option>`
      )
      .join('');
    const marcaOpts = (this._lookups?.marcas || [])
      .map(
        (m) =>
          `<option value="${this.escapeHtml(m.value)}"${this._filterMarca === m.value ? ' selected' : ''}>${this.escapeHtml(m.label)}</option>`
      )
      .join('');
    const headers = [
      '<th scope="col" class="productos-th-menu" aria-label="Opciones"></th>',
      ...this.getVisibleColumns().map((c) => {
        const align = c.type === 'money' || c.type === 'num' ? ' text-end' : '';
        return `<th scope="col" class="${align.trim()}">${this.escapeHtml(c.label)}</th>`;
      }),
      '<th scope="col" class="text-end">Acciones</th>',
    ].join('');

    return `
      <div class="productos-vista-wrap catalogo-vista-wrap">
        <div class="productos-stats-row" id="productos-stats"></div>
        <div class="row g-2 productos-list-layout productos-list-layout--full">
          <div class="productos-list-col productos-list-col--full">
            <div class="card productos-glass-card productos-list-card d-flex flex-column">
              <div class="card-body d-flex flex-column min-h-0">
                <div class="productos-list-toolbar d-flex flex-wrap justify-content-between align-items-center gap-2">
                  <span class="marcas-badge" id="productos-count">${this.badgeText()}</span>
                  <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-productos-refresh">
                    <i class="fa-solid fa-rotate-right me-1"></i>Actualizar
                  </button>
                </div>
                <div class="productos-list-filters d-flex flex-wrap align-items-center gap-2">
                  <label class="small text-muted mb-0" for="productos-filter-habilitado">Habilitado:</label>
                  <select class="form-select form-select-sm" id="productos-filter-habilitado" style="max-width: 11rem">${habSelect}</select>
                  <label class="small text-muted mb-0" for="productos-filter-marca">Marca:</label>
                  <select class="form-select form-select-sm" id="productos-filter-marca" style="max-width: 14rem">
                    <option value="">TODAS</option>
                    ${marcaOpts}
                  </select>
                  <span class="small text-muted">Sin búsqueda: 50 registros; escriba para buscar en todos.</span>
                </div>
                <div class="marcas-search-wrap">
                  <div class="input-group input-group-sm marcas-search">
                    <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
                    <input type="search" class="form-control" id="productos-search"
                      placeholder="Código, descripción, marca, fabricante, proveedor…"
                      value="${this.escapeHtml(this._filterQuery)}" autocomplete="off">
                    <button type="button" class="btn btn-outline-secondary" id="btn-productos-search-clear">
                      <i class="fa-solid fa-xmark"></i>
                    </button>
                  </div>
                </div>
                <div class="productos-table-wrap">
                  <table id="productos-table" class="table table-sm table-hover table-striped">
                    <thead><tr>${headers}</tr></thead>
                    <tbody id="productos-tbody">${this.renderTableBodyHtml(this._rows)}</tbody>
                  </table>
                </div>
              </div>
            </div>
            ${CatalogosUI.btnNuevoFab('btn-productos-nuevo')}
          </div>
        </div>
      </div>
    `;
  },

  bindListEvents() {
    document.getElementById('btn-productos-nuevo')?.addEventListener('click', () => this.onNuevo());
    document.getElementById('btn-productos-refresh')?.addEventListener('click', () => this.reloadList());
    this.bindFilters();
    this.bindRowActions();
    this.bindRowSelect();
    this.bindHabilitadoButtons();
  },

  async load(container) {
    this._container = container;
    this._filterQuery = '';
    this._filterHabilitado = '';
    this._filterMarca = '';
    this._selectedCodprod = null;
    this._precios = [];
    const main = document.getElementById('main-content');
    if (main) {
      main.classList.remove('align-items-center', 'justify-content-center');
      main.classList.add('align-items-stretch', 'justify-content-start', 'productos-main-host');
    }
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add(
      'productos-view-root',
      'align-items-stretch',
      'justify-content-start',
      'w-100',
      'min-h-0',
      'overflow-hidden',
      'd-flex',
      'flex-column'
    );

    if (!F.getEmpNit()) {
      container.innerHTML = `
        <div class="alert alert-warning m-3 w-100">
          <i class="fa-solid fa-triangle-exclamation me-2"></i>
          No hay empresa activa. Cierre sesión e ingrese de nuevo.
        </div>`;
      return;
    }

    container.innerHTML = `<div class="text-center text-muted py-4 w-100"><i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando productos…</div>`;

    try {
      await this.loadLookups();
      await this.showList();
    } catch (err) {
      container.innerHTML = `
        <div class="alert alert-danger m-3 w-100">
          <i class="fa-solid fa-circle-exclamation me-2"></i>${this.escapeHtml(err.message)}
        </div>`;
    }
  },
};
