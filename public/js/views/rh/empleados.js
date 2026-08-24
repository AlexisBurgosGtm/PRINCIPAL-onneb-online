/**
 * Vista Empleados — formulario con combos (tipos, municipios, departamentos, rutas).
 */

function empleadosValidateForm(data) {
  if (!data.NOMEMPLEADO) return 'El nombre es obligatorio';
  return null;
}

const EMPLEADOS_CATALOGO_OPTIONS = [
  { value: '0', label: 'TODOS LOS PRODUCTOS' },
  { value: '1', label: 'CATALOGO 1' },
  { value: '2', label: 'CATALOGO 2' },
];

function empleadosMapFormToApi(data, isEdit = false) {
  const num = (v) => (v === '' || v === undefined ? null : Number(v));
  const n = (key) => {
    const x = num(data[key]);
    return Number.isNaN(x) ? null : x;
  };
  const payload = {
    NOMEMPLEADO: data.NOMEMPLEADO,
    CODTIPOEMPLEADO: n('CODTIPOEMPLEADO'),
    DPI: data.DPI || null,
    IGSS: data.IGSS || null,
    DIRECCION: data.DIRECCION || null,
    CODMUNICIPIO: n('CODMUNICIPIO'),
    CODDEPTO: n('CODDEPTO'),
    TELEFONOS: data.TELEFONOS || null,
    WHATSAPP: data.WHATSAPP || null,
    EMAIL: data.EMAIL || null,
    USUARIO: null,
    CLAVE: null,
    LATITUD: data.LATITUD || null,
    LONGITUD: data.LONGITUD || null,
    CODRUTA: n('CODRUTA'),
    CODCATALOGO:
      data.CODCATALOGO !== undefined && data.CODCATALOGO !== ''
        ? String(data.CODCATALOGO)
        : null,
    CODDOC_REC: data.CODDOC_REC || null,
    NIT: data.NIT || null,
    FECHA_INICIO: data.FECHA_INICIO || null,
    FECHA_NACIMIENTO: data.FECHA_NACIMIENTO || null,
  };
  const usuario = String(data.USUARIO || '').trim();
  const clave = String(data.CLAVE || '').trim();
  if (usuario && clave && !/^null$/i.test(usuario) && !/^null$/i.test(clave)) {
    payload.USUARIO = usuario;
    payload.CLAVE = clave;
  } else {
    payload.USUARIO = null;
    payload.CLAVE = null;
  }
  if (!isEdit) {
    payload.ACTIVO = 'SI';
  }
  return payload;
}

const EmpleadosViewBase = createCatalogoEmpresaView({
  slug: 'empleados',
  apiPath: '/api/empleados',
  icon: 'fa-user-tie',
  labelSingular: 'empleado',
  labelPlural: 'empleado(s)',
  idKey: 'CODEMPLEADO',
  dataAttr: 'codempleado',
  formWidth: 960,
  searchPlaceholder: 'Buscar por nombre, DPI, teléfono, tipo…',
  searchKeys: [
    'CODEMPLEADO',
    'NOMEMPLEADO',
    'USUARIO',
    'DPI',
    'TELEFONOS',
    'ACTIVO',
    'CODTIPOEMPLEADO',
    'CODCATALOGO',
  ],
  formFields: [],
  mapFormToApi: empleadosMapFormToApi,
  validateForm: empleadosValidateForm,
  tableColumns: [
    { key: 'CODEMPLEADO', label: 'Código', type: 'number' },
    { key: 'NOMEMPLEADO', label: 'Nombre' },
    { key: 'DPI', label: 'DPI' },
    { key: 'CODTIPOEMPLEADO', label: 'Tipo empleado' },
    { key: 'CODCATALOGO', label: 'Catálogo' },
    { key: 'ACTIVO', label: 'Activo' },
    { key: 'TELEFONOS', label: 'Teléfono' },
    { key: 'WHATSAPP', label: 'Doc. Venta' },
    { key: 'CODRUTA', label: 'Ruta' },
  ],
  getRowLabel(row) {
    return row?.NOMEMPLEADO || '';
  },
});

const EmpleadosView = {
  ...EmpleadosViewBase,
  _lookups: null,
  _filterActivo: '',

  escapeHtml(value) {
    return EmpleadosViewBase.escapeHtml.call(this, value);
  },

  normalizeRowForForm(row = {}) {
    const cat = row.CODCATALOGO;
    const catStr = cat !== null && cat !== undefined && cat !== '' ? String(cat) : '';
    const isoDate = (v) => {
      if (!v) return '';
      if (typeof v === 'string') {
        const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
      }
      try {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return '';
        const y = d.getUTCFullYear();
        const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${mo}-${day}`;
      } catch {
        return '';
      }
    };
    return {
      ...row,
      CODEMPLEADO: row.CODEMPLEADO ?? '',
      CODTIPOEMPLEADO: row.CODTIPOEMPLEADO ?? '',
      NOMEMPLEADO: row.NOMEMPLEADO ?? '',
      DPI: row.DPI ?? '',
      IGSS: row.IGSS ?? '',
      DIRECCION: row.DIRECCION ?? '',
      CODDEPTO: row.CODDEPTO ?? '',
      CODMUNICIPIO: row.CODMUNICIPIO ?? '',
      TELEFONOS: row.TELEFONOS ?? '',
      WHATSAPP: row.WHATSAPP ?? '',
      EMAIL: row.EMAIL ?? '',
      USUARIO: row.USUARIO ?? '',
      CODRUTA: row.CODRUTA ?? '',
      CLAVE: row.CLAVE ?? '',
      CODCATALOGO: catStr,
      CODDOC_REC: row.CODDOC_REC ?? '',
      NIT: row.NIT ?? '',
      FECHA_INICIO: isoDate(row.FECHA_INICIO),
      FECHA_NACIMIENTO: isoDate(row.FECHA_NACIMIENTO),
    };
  },

  tipoEmpleadoLabel(value) {
    const v = String(value ?? '');
    const tipos = this._lookups?.tipos || window._onnebTiposEmpleadoCache || [];
    const found = tipos.find((t) => String(t.value) === v);
    if (found) return found.label;
    const fromJson = (window._onnebTiposEmpleadoCache || []).find(
      (t) => String(t.value) === v
    );
    return fromJson ? fromJson.label || fromJson.code : v || '—';
  },

  catalogoLabel(value) {
    const v = String(value ?? '');
    const found = EMPLEADOS_CATALOGO_OPTIONS.find((o) => o.value === v);
    return found ? found.label : v || '—';
  },

  rutaLabel(value) {
    const v = String(value ?? '').trim();
    if (!v) return '—';
    const rutas = this._lookups?.rutas || [];
    const found = rutas.find((r) => String(r.value) === v);
    return found ? found.label : v;
  },

  normalizeActivo(value) {
    return String(value ?? 'NO').trim().toUpperCase() === 'SI' ? 'SI' : 'NO';
  },

  activoButtonHtml(row) {
    const activo = this.normalizeActivo(row.ACTIVO);
    const cls = activo === 'SI' ? 'btn-empleado-activo--si' : 'btn-empleado-activo--no';
    return `
      <button type="button" class="btn btn-sm btn-empleado-activo ${cls}"
        data-codempleado="${this.escapeHtml(row.CODEMPLEADO)}"
        data-activo="${activo}"
        aria-label="Estado activo: ${activo}. Clic para cambiar"
        title="Clic para cambiar a ${activo === 'SI' ? 'NO' : 'SI'}">
        ${activo}
      </button>
    `;
  },

  formatCell(value, col) {
    if (col?.key === 'CODTIPOEMPLEADO') {
      return this.escapeHtml(this.tipoEmpleadoLabel(value));
    }
    if (col?.key === 'CODCATALOGO') {
      return this.escapeHtml(this.catalogoLabel(value));
    }
    if (col?.key === 'CODRUTA') {
      return this.escapeHtml(this.rutaLabel(value));
    }
    return EmpleadosViewBase.formatCell.call(this, value, col);
  },

  renderTableBodyHtml(rows) {
    const columns = [
      { key: 'CODEMPLEADO', label: 'Código', type: 'number' },
      { key: 'NOMEMPLEADO', label: 'Nombre' },
      { key: 'DPI', label: 'DPI' },
      { key: 'CODTIPOEMPLEADO', label: 'Tipo empleado' },
      { key: 'CODCATALOGO', label: 'Catálogo' },
      { key: 'ACTIVO', label: 'Activo' },
      { key: 'TELEFONOS', label: 'Teléfono' },
      { key: 'WHATSAPP', label: 'Doc. Venta' },
      { key: 'CODRUTA', label: 'Ruta' },
    ];
    if (!rows.length) {
      const msg = this._filterQuery.trim()
        ? 'Ningún registro coincide con la búsqueda'
        : 'Sin registros';
      return `<tr><td colspan="${columns.length + 1}" class="text-center text-muted py-4">${msg}</td></tr>`;
    }
    return rows
      .map((row) => {
        const cells = columns
          .map((c) => {
            if (c.key === 'ACTIVO') {
              return `<td>${this.activoButtonHtml(row)}</td>`;
            }
            return `<td>${this.formatCell(row[c.key], c)}</td>`;
          })
          .join('');
        return `<tr>${cells}<td class="text-end">
          <div class="catalogo-acciones">
            <button type="button" class="btn btn-outline-secondary btn-sm btn-empleado-carne"
              data-codempleado="${this.escapeHtml(row.CODEMPLEADO)}"
              aria-label="Imprimir carné" title="Imprimir carné">
              <i class="fa-solid fa-id-badge" aria-hidden="true"></i>
            </button>
            ${CatalogosUI.btnEditar(row.CODEMPLEADO, 'codempleado')}
            ${CatalogosUI.btnEliminar(row.CODEMPLEADO, 'codempleado')}
          </div>
        </td></tr>`;
      })
      .join('');
  },

  getFilteredRows() {
    let rows = this._rows;
    if (this._filterActivo) {
      rows = rows.filter((r) => this.normalizeActivo(r.ACTIVO) === this._filterActivo);
    }
    const q = this._filterQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const parts = [
        r.CODEMPLEADO,
        r.NOMEMPLEADO,
        r.DPI,
        r.TELEFONOS,
        r.ACTIVO,
        r.CODRUTA,
        this.rutaLabel(r.CODRUTA),
        r.CODTIPOEMPLEADO,
        this.tipoEmpleadoLabel(r.CODTIPOEMPLEADO),
        r.USUARIO,
        r.CODCATALOGO,
        this.catalogoLabel(r.CODCATALOGO),
        r.WHATSAPP,
      ].map((v) => String(v ?? '').toLowerCase());
      return parts.some((p) => p.includes(q));
    });
  },

  renderTable() {
    const headers = [
      { key: 'CODEMPLEADO', label: 'Código', type: 'number' },
      { key: 'NOMEMPLEADO', label: 'Nombre' },
      { key: 'DPI', label: 'DPI' },
      { key: 'CODTIPOEMPLEADO', label: 'Tipo empleado' },
      { key: 'CODCATALOGO', label: 'Catálogo' },
      { key: 'ACTIVO', label: 'Activo' },
      { key: 'TELEFONOS', label: 'Teléfono' },
      { key: 'WHATSAPP', label: 'Doc. Venta' },
      { key: 'CODRUTA', label: 'Ruta' },
    ]
      .map((c) => `<th scope="col">${this.escapeHtml(c.label)}</th>`)
      .concat('<th scope="col" class="text-end">Acciones</th>')
      .join('');
    const filtered = this.getFilteredRows();
    const activoOpts = [
      { value: '', label: 'TODOS' },
      { value: 'SI', label: 'ACTIVOS (SI)' },
      { value: 'NO', label: 'INACTIVOS (NO)' },
    ];
    const activoSelect = activoOpts
      .map(
        (o) =>
          `<option value="${o.value}"${this._filterActivo === o.value ? ' selected' : ''}>${o.label}</option>`
      )
      .join('');

    return `
      <div class="catalogo-empresa-panel catalogo-vista-wrap">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2 px-1">
          <span class="catalogo-empresa-badge" id="empleados-count">${EmpleadosViewBase.badgeText.call(this, filtered.length, this._rows.length)}</span>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-empleados-refresh">
            <i class="fa-solid fa-rotate-right me-1"></i>Actualizar
          </button>
        </div>
        
        <div class="row">
          <div class="col-6">
            <div class="d-flex flex-wrap align-items-center gap-2 px-1 mb-2">
              <label for="empleados-filter-activo" class="small text-muted mb-0">Activo:</label>
              <select class="form-select form-select-sm" id="empleados-filter-activo" style="max-width: 11rem">
                ${activoSelect}
              </select>
            </div>
          </div>
          <div class="col-6">
          
            <div class="catalogo-empresa-search-wrap px-1 mb-2">
              <div class="input-group input-group-sm catalogo-empresa-search">
                  <span class="input-group-text" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></span>
                  <input type="search" class="form-control" id="empleados-search"
                    placeholder="Buscar por nombre, DPI, teléfono, tipo…"
                    value="${this.escapeHtml(this._filterQuery)}" autocomplete="off" spellcheck="false">
                  <button type="button" class="btn btn-outline-secondary" id="btn-empleados-search-clear"
                    title="Limpiar búsqueda" aria-label="Limpiar búsqueda">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                  </button>
              </div>
            </div>
          
          </div>
        </div>
        
        
       
        <div class="table-responsive">
          <table class="table table-sm table-hover table-striped">
            <thead><tr>${headers}</tr></thead>
            <tbody id="empleados-tbody">${this.renderTableBodyHtml(filtered)}</tbody>
          </table>
        </div>
        ${CatalogosUI.btnNuevoFab('btn-empleados-nuevo')}
      </div>
    `;
  },

  bindFilterActivo() {
    const sel = document.getElementById('empleados-filter-activo');
    if (!sel) return;
    sel.addEventListener('change', () => {
      this._filterActivo = sel.value;
      this.updateTableView();
    });
  },

  bindEvents() {
    EmpleadosViewBase.bindEvents.call(this);
    this.bindFilterActivo();
  },

  async loadLookups() {
    const empNit = F.getEmpNit() || '';
    if (this._lookups && this._lookupsEmpNit === empNit) return this._lookups;
    const ts = Date.now();
    if (!empNit) {
      this._lookups = {
        tipos: [],
        municipios: [],
        departamentos: [],
        rutas: [],
        catalogos: EMPLEADOS_CATALOGO_OPTIONS,
        docsWhatsapp: [],
        docsRecibo: [],
      };
      this._lookupsEmpNit = empNit;
      return this._lookups;
    }
    const rutasUrl = `/api/rutas?empnit=${encodeURIComponent(empNit)}&_=${ts}`;

    const tiposDocUrl = `/api/tipo-documentos?empnit=${encodeURIComponent(empNit)}&_=${ts}`;
    const [tiposRes, muniRes, deptRes, rutasRes, tiposDocRes] = await Promise.all([
      F.fetchJson(`/data/tipos-empleado.json?_=${ts}`, { cache: 'no-store' }),
      F.fetchJson(`/api/municipios?_=${ts}`, { cache: 'no-store' }),
      F.fetchJson(`/api/departamentos?_=${ts}`, { cache: 'no-store' }),
      F.fetchJson(rutasUrl, { cache: 'no-store' }),
      F.fetchJson(tiposDocUrl, { cache: 'no-store' }),
    ]);

    const tiposRaw = Array.isArray(tiposRes) ? tiposRes : tiposRes.items || [];
    window._onnebTiposEmpleadoCache = tiposRaw;

    const WHATSAPP_TIPOS = ['FAC', 'ENV', 'FEF'];
    const mapTipoDoc = (row) => {
      const tipodoc = String(row.TIPODOC ?? '').trim().toUpperCase();
      return {
        value: String(row.CODDOC ?? '').trim(),
        label: String(row.DESDOC ?? row.CODDOC ?? '').trim(),
        tipodoc,
      };
    };
    const tipoDocs = (tiposDocRes.rows || []).map(mapTipoDoc).filter((d) => d.value);
    const docsWhatsapp = tipoDocs.filter((d) => WHATSAPP_TIPOS.includes(d.tipodoc));
    const docsRecibo = tipoDocs.filter((d) => d.tipodoc === 'RCC');

    this._lookups = {
      tipos: tiposRaw.map((t) => ({
        value: String(t.value),
        label: String(t.label || t.code || '').trim(),
      })),
      catalogos: EMPLEADOS_CATALOGO_OPTIONS,
      municipios: (muniRes.rows || []).map((m) => ({
        value: String(m.CODMUNICIPIO),
        label: String(m.DESMUNICIPIO || '').trim() || String(m.CODMUNICIPIO),
      })),
      departamentos: (deptRes.rows || []).map((d) => ({
        value: String(d.CODDEPARTAMENTO),
        label: String(d.DESDEPARTAMENTO || '').trim() || String(d.CODDEPARTAMENTO),
      })),
      rutas: (rutasRes.rows || []).map((r) => ({
        value: String(r.CODRUTA),
        label: String(r.DESRUTA || '').trim() || String(r.CODRUTA),
      })),
      docsWhatsapp,
      docsRecibo,
    };
    this._lookupsEmpNit = empNit;
    return this._lookups;
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
        <option value="">— Seleccione —</option>
        ${optsHtml}
      </select>
    `;
  },

  inputField(name, label, value, opts = {}) {
    const {
      type = 'text',
      readonly = false,
      step = '',
      autocomplete = '',
      className = '',
      attrs = '',
    } = opts;
    const ro = readonly ? 'readonly' : '';
    const stepAttr = step ? `step="${step}"` : '';
    const acAttr = autocomplete ? `autocomplete="${this.escapeHtml(autocomplete)}"` : '';
    const extraClass = className ? ` ${className}` : '';
    return `
      <label class="form-label small mb-0">${this.escapeHtml(label)}</label>
      <input type="${type}" class="form-control form-control-sm${extraClass}" name="${name}"
        value="${this.escapeHtml(value ?? '')}" ${ro} ${stepAttr} ${acAttr} ${attrs}>
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

  fieldBlock(html) {
    return `<div class="mb-2">${html}</div>`;
  },

  prepareAccesoFields(isEdit, row) {
    const root = document.querySelector('.swal2-html-container');
    const form = root?.querySelector('.catalogo-form') || root;
    form?.setAttribute('autocomplete', 'off');
    form?.setAttribute('data-lpignore', 'true');
    form?.setAttribute('data-1p-ignore', 'true');
    form?.setAttribute('data-bwignore', 'true');
    form?.setAttribute('data-form-type', 'other');

    const usuario = root?.querySelector('[name="EMP_ACCESO_USUARIO"]');
    const clave = root?.querySelector('[name="EMP_ACCESO_CLAVE"]');
    if (!usuario || !clave) return;

    const unlock = (el) => {
      el.removeAttribute('readonly');
    };
    clave.addEventListener('focus', () => unlock(clave), { once: true });
    usuario.addEventListener('focus', () => unlock(clave), { once: true });
    usuario.addEventListener('focus', () => unlock(usuario), { once: true });

    const applyValues = () => {
      const blankLiteral = (v) => (/^(null|undefined)$/i.test(String(v || '').trim()) ? '' : String(v || '').trim());
      if (isEdit) {
        usuario.value = blankLiteral(row?.USUARIO);
        clave.value = blankLiteral(row?.CLAVE);
        return;
      }
      usuario.value = '';
      clave.value = '';
    };
    applyValues();
    setTimeout(applyValues, 50);
    setTimeout(applyValues, 300);
  },

  accesoAntiAutofillAttrs() {
    return [
      'autocomplete="off"',
      'autocapitalize="off"',
      'autocorrect="off"',
      'spellcheck="false"',
      'data-lpignore="true"',
      'data-1p-ignore="true"',
      'data-bwignore="true"',
      'data-form-type="other"',
      'data-autocomplete="off"',
      'aria-autocomplete="none"',
    ].join(' ');
  },

  accesoCardHtml(r) {
    const anti = this.accesoAntiAutofillAttrs();
    return `
      <div class="card empleados-acceso-card mb-2">
        <div class="card-body py-2 px-2">
          <p class="empleados-acceso-card-title mb-0">
            <i class="fa-solid fa-right-to-bracket me-1" aria-hidden="true"></i>
            Acceso al inicio de sesión
          </p>
          <p class="small text-muted mb-2">Deje usuario y clave vacíos si el empleado no usará el sistema.</p>
          ${this.row2(
            this.inputField('EMP_ACCESO_USUARIO', 'Usuario', r.USUARIO, {
              autocomplete: 'off',
              readonly: true,
              attrs: anti,
            }),
            this.inputField('EMP_ACCESO_CLAVE', 'Clave', r.CLAVE, {
              type: 'text',
              className: 'config-pass-mask',
              autocomplete: 'off',
              readonly: true,
              attrs: `${anti} inputmode="text"`,
            })
          )}
        </div>
      </div>
    `;
  },

  nominaCardHtml(r) {
    return `
      <div class="card empleados-nomina-card mb-0">
        <div class="card-body py-2 px-2">
          <p class="empleados-nomina-card-title mb-1">
            <i class="fa-solid fa-file-invoice-dollar me-1" aria-hidden="true"></i>
            Datos de nómina
          </p>
          <div class="row g-2">
            <div class="col-md-4">${this.inputField('NIT', 'NIT', r.NIT)}</div>
            <div class="col-md-4">${this.inputField('DPI', 'DPI', r.DPI)}</div>
            <div class="col-md-4">${this.inputField('IGSS', 'IGSS', r.IGSS)}</div>
            <div class="col-md-4">${this.inputField('FECHA_INICIO', 'Fecha inicio', r.FECHA_INICIO, { type: 'date' })}</div>
            <div class="col-md-4">${this.inputField('FECHA_NACIMIENTO', 'Fecha nacimiento', r.FECHA_NACIMIENTO, { type: 'date' })}</div>
          </div>
        </div>
      </div>
    `;
  },

  fotoApiUrl(codempleado, extra = {}) {
    const params = new URLSearchParams({ empnit: F.getEmpNit(), ...extra, _: String(Date.now()) });
    return `/api/empleados/${encodeURIComponent(codempleado)}/foto?${params}`;
  },

  renderFotoSelectorHtml(codempleado) {
    const preview = this._fotoUrl
      ? `<img src="${this.escapeHtml(this._fotoUrl)}" alt="Foto empleado" class="empleados-foto-preview-img" id="empleados-foto-preview-img">`
      : `<div class="empleados-foto-placeholder" id="empleados-foto-placeholder">
          <i class="fa-solid fa-user" aria-hidden="true"></i>
          <span>Sin foto</span>
        </div>`;
    return `
      <div class="card empleados-foto-card mb-2">
        <div class="card-body py-2 px-2 d-flex flex-wrap gap-3 align-items-center">
          <div class="empleados-foto-preview" id="empleados-foto-preview">${preview}</div>
          <div class="flex-grow-1">
            <div class="fw-semibold mb-1"><i class="fa-solid fa-image me-1"></i>Foto del empleado</div>
            <p class="small text-muted mb-2">Se guarda en EMPLEADOS como empnit-codempleado.png (LOCAL o HOST según configuración).</p>
            <div class="d-flex flex-wrap gap-2">
              <label class="btn btn-sm btn-outline-primary mb-0" for="empleados-foto-input" id="empleados-foto-label">
                <i class="fa-solid fa-upload me-1"></i>Cargar foto
              </label>
              <input type="file" id="empleados-foto-input" accept="image/jpeg,image/png,image/webp,image/gif" class="d-none">
              <button type="button" class="btn btn-sm btn-outline-danger" id="btn-empleados-foto-quitar"${this._fotoUrl || this._pendingFotoFile ? '' : ' disabled'}>
                <i class="fa-solid fa-trash me-1"></i>Quitar
              </button>
            </div>
            <div class="small mt-2" id="empleados-foto-status" aria-live="polite"></div>
            ${
              codempleado
                ? `<div class="small text-muted mt-1">Archivo: ${this.escapeHtml(F.getEmpNit())}-${this.escapeHtml(codempleado)}.png</div>`
                : '<div class="small text-muted mt-1">La foto se subirá al guardar el empleado nuevo.</div>'
            }
          </div>
        </div>
      </div>`;
  },

  setFotoStatus(message, kind = 'muted') {
    const el = document.getElementById('empleados-foto-status');
    if (!el) return;
    const cls =
      kind === 'success'
        ? 'text-success'
        : kind === 'error'
          ? 'text-danger'
          : kind === 'warning'
            ? 'text-warning'
            : 'text-muted';
    el.className = `small mt-2 ${cls}`;
    el.textContent = message || '';
  },

  setFotoPreview(url) {
    this._fotoUrl = url || null;
    const wrap = document.getElementById('empleados-foto-preview');
    if (!wrap) return;
    if (this._fotoUrl) {
      wrap.innerHTML = `<img src="${this.escapeHtml(this._fotoUrl)}" alt="Foto empleado" class="empleados-foto-preview-img" id="empleados-foto-preview-img">`;
    } else {
      wrap.innerHTML = `<div class="empleados-foto-placeholder" id="empleados-foto-placeholder">
          <i class="fa-solid fa-user" aria-hidden="true"></i>
          <span>Sin foto</span>
        </div>`;
    }
    const quitar = document.getElementById('btn-empleados-foto-quitar');
    if (quitar) quitar.disabled = !(this._fotoUrl || this._pendingFotoFile);
  },

  async loadEmpleadoFoto(codempleado) {
    this._pendingFotoFile = null;
    this._fotoUrl = null;
    if (!codempleado) return;
    try {
      const data = await F.fetchJson(this.fotoApiUrl(codempleado, { meta: '1' }), {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      this._fotoUrl = data?.url || null;
    } catch (_) {
      this._fotoUrl = null;
    }
  },

  async uploadEmpleadoFoto(codempleado, file) {
    if (!codempleado || !file) return null;
    const body = new FormData();
    body.append('foto', file);
    const res = await fetch(this.fotoApiUrl(codempleado), {
      method: 'POST',
      body,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo guardar la foto');
    return data;
  },

  bindFotoEvents(codempleado) {
    const input = document.getElementById('empleados-foto-input');
    const label = document.getElementById('empleados-foto-label');
    const quitar = document.getElementById('btn-empleados-foto-quitar');

    // Evita que el click del file dialog cierre el Swal (click fantasma al overlay).
    const stop = (e) => e.stopPropagation();
    label?.addEventListener('mousedown', stop);
    label?.addEventListener('click', stop);
    input?.addEventListener('mousedown', stop);
    input?.addEventListener('click', stop);
    quitar?.addEventListener('mousedown', stop);

    input?.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!/^image\/(jpeg|jpg|png|webp|gif)$/i.test(file.type)) {
        this.setFotoStatus('Formato no válido. Use jpg, png, webp o gif', 'warning');
        input.value = '';
        return;
      }
      if (codempleado) {
        this.setFotoStatus('Guardando foto…', 'muted');
        try {
          const data = await this.uploadEmpleadoFoto(codempleado, file);
          this._pendingFotoFile = null;
          this.setFotoPreview(data.url);
          this.setFotoStatus('Foto guardada', 'success');
        } catch (err) {
          this.setFotoStatus(err.message || 'Error al guardar foto', 'error');
        } finally {
          input.value = '';
        }
        return;
      }
      this._pendingFotoFile = file;
      this.setFotoPreview(URL.createObjectURL(file));
      this.setFotoStatus('Foto lista; se subirá al guardar', 'success');
      input.value = '';
    });

    quitar?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (codempleado && this._fotoUrl && !this._pendingFotoFile) {
        // No usar otro Swal aquí: cerraría el formulario del empleado.
        if (!window.confirm('¿Quitar la foto del empleado?')) return;
        this.setFotoStatus('Eliminando foto…', 'muted');
        try {
          await F.fetchJson(this.fotoApiUrl(codempleado), { method: 'DELETE' });
          this._pendingFotoFile = null;
          this.setFotoPreview(null);
          this.setFotoStatus('Foto eliminada', 'success');
        } catch (err) {
          this.setFotoStatus(err.message || 'Error al quitar foto', 'error');
        }
        return;
      }
      this._pendingFotoFile = null;
      this.setFotoPreview(null);
      this.setFotoStatus('', 'muted');
    });
  },

  buildFormHtml(row = {}, isEdit = false) {
    const r = this.normalizeRowForForm(row);
    const L = this._lookups || {
      tipos: [],
      municipios: [],
      departamentos: [],
      rutas: [],
      catalogos: EMPLEADOS_CATALOGO_OPTIONS,
      docsWhatsapp: [],
      docsRecibo: [],
    };

    const codigoHtml = isEdit
      ? this.inputField('CODEMPLEADO', 'Código', r.CODEMPLEADO, { type: 'number', readonly: true })
      : '<p class="small text-muted mb-0 py-1">El código se asignará al guardar.</p>';

    const colLeft = [
      this.row2(codigoHtml, this.selectField('CODTIPOEMPLEADO', 'Tipo empleado', L.tipos, r.CODTIPOEMPLEADO)),
      this.fieldBlock(this.inputField('NOMEMPLEADO', 'Nombre completo', r.NOMEMPLEADO)),
      this.accesoCardHtml(r),
      this.fieldBlock(this.inputField('DIRECCION', 'Dirección', r.DIRECCION)),
    ].join('');

    const colRight = [
      this.row2(
        this.selectField('CODDEPTO', 'Departamento', L.departamentos, r.CODDEPTO),
        this.selectField('CODMUNICIPIO', 'Municipio', L.municipios, r.CODMUNICIPIO)
      ),
      this.row2(
        this.selectField('CODRUTA', 'Ruta', L.rutas, r.CODRUTA),
        this.selectField('CODCATALOGO', 'Catálogo', L.catalogos, r.CODCATALOGO)
      ),
      this.row2(
        this.inputField('TELEFONOS', 'Teléfonos', r.TELEFONOS),
        this.inputField('EMAIL', 'Email', r.EMAIL, { type: 'email' })
      ),
      this.row2(
        this.selectField('WHATSAPP', 'Doc. Venta', L.docsWhatsapp, r.WHATSAPP),
        this.selectField('CODDOC_REC', 'Doc. recibo', L.docsRecibo, r.CODDOC_REC)
      ),
    ].join('');

    return `
      <div class="empleados-form-grid">
        ${this.renderFotoSelectorHtml(isEdit ? r.CODEMPLEADO : null)}
        <div class="row g-2">
          <div class="col-md-6">${colLeft}</div>
          <div class="col-md-6">${colRight}</div>
        </div>
        ${this.nominaCardHtml(r)}
      </div>`;
  },

  readFormData() {
    const names = [
      'CODEMPLEADO',
      'CODTIPOEMPLEADO',
      'NOMEMPLEADO',
      'DPI',
      'IGSS',
      'DIRECCION',
      'CODDEPTO',
      'CODMUNICIPIO',
      'TELEFONOS',
      'WHATSAPP',
      'EMAIL',
      'EMP_ACCESO_USUARIO',
      'CODRUTA',
      'EMP_ACCESO_CLAVE',
      'CODCATALOGO',
      'CODDOC_REC',
      'NIT',
      'FECHA_INICIO',
      'FECHA_NACIMIENTO',
    ];
    const data = {};
    names.forEach((name) => {
      const input = document.querySelector(`.swal2-html-container [name="${name}"]`);
      if (!input) return;
      data[name] = input.value.trim();
    });
    data.USUARIO = String(data.EMP_ACCESO_USUARIO || '').trim();
    data.CLAVE = String(data.EMP_ACCESO_CLAVE || '').trim();
    return data;
  },

  async showForm(title, row = {}, isEdit = false) {
    try {
      await this.loadLookups();
    } catch (err) {
      F.alert('Error', `No se pudieron cargar catálogos: ${err.message}`, 'error');
      return null;
    }

    const view = this;
    const codempleado = isEdit ? row.CODEMPLEADO : null;
    this._pendingFotoFile = null;
    if (isEdit && codempleado) {
      await this.loadEmpleadoFoto(codempleado);
    } else {
      this._fotoUrl = null;
    }

    return CatalogosUI.fireForm({
      title,
      html: view.buildFormHtml(row, isEdit),
      width: 960,
      customClass: { popup: 'modal-catalogo empleados-form-modal' },
      allowOutsideClick: false,
      didOpen() {
        view.bindFotoEvents(codempleado);
        view.prepareAccesoFields(isEdit, row);
      },
      preConfirm() {
        try {
          const data = view.readFormData();
          const err = empleadosValidateForm(data);
          if (err) {
            Swal.showValidationMessage(err);
            return false;
          }
          return empleadosMapFormToApi(data, isEdit);
        } catch (e) {
          Swal.showValidationMessage(e.message || 'Error al validar el formulario');
          return false;
        }
      },
    });
  },

  async onNuevo() {
    const data = await this.showForm('Nuevo empleado');
    if (!data) return;
    try {
      const created = await F.fetchJson(this.apiBase(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const newId = created?.CODEMPLEADO ?? created?.row?.CODEMPLEADO;
      if (newId && this._pendingFotoFile) {
        try {
          await this.uploadEmpleadoFoto(newId, this._pendingFotoFile);
        } catch (err) {
          F.toast(err.message || 'Empleado creado, pero no se pudo subir la foto', 'warning');
        }
      }
      this._pendingFotoFile = null;
      F.toast('Empleado creado', 'success');
      await this.load(this._container);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  async onEditar(id) {
    const row = this.findRow(id);
    if (!row) return;
    const data = await this.showForm('Editar empleado', row, true);
    if (!data) return;
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(id)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      F.toast('Empleado actualizado', 'success');
      await this.load(this._container);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  async onEliminar(id) {
    const row = this.findRow(id);
    const nombre = this.rowLabel(row, id);
    const auth = await CatalogosUI.authorizeEliminarRegistro({
      label: nombre,
      tipo: 'empleado',
      kind: 'registro',
      title: '¿Eliminar empleado?',
      html: `<p class="mb-0">Se intentará eliminar a <strong>${this.escapeHtml(nombre)}</strong>.</p>
        <p class="small text-muted mb-0 mt-2">Si tiene documentos asociados (CODVEN), solo se deshabilitará (ACTIVO = NO).</p>`,
      passText: 'Ingrese la clave de administrador para eliminar o deshabilitar al empleado.',
      confirmText: 'Eliminar',
    });
    if (!auth) return;
    try {
      const res = await F.fetchJson(this.apiBase(`/${encodeURIComponent(id)}`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: auth.pass != null ? String(auth.pass) : '__AUTORIZADO__' }),
      });
      if (res?.action === 'disabled') {
        F.toast(res.message || 'Empleado deshabilitado (tiene documentos asociados)', 'warning');
      } else {
        F.toast('Empleado eliminado', 'success');
      }
      await this.load(this._container);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  bindRowActions() {
    EmpleadosViewBase.bindRowActions.call(this);
    this.bindActivoButtons();
    this.bindCarneButtons();
  },

  bindCarneButtons() {
    if (!this._container) return;
    this._container.querySelectorAll('.btn-empleado-carne').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.codempleado;
        this.onImprimirCarne(id);
      });
    });
  },

  async onImprimirCarne(codempleado) {
    const row = this.findRow(codempleado);
    if (!row) {
      F.toast('Empleado no encontrado', 'warning');
      return;
    }
    if (typeof EmpleadoCarne === 'undefined') {
      F.alert('Error', 'Módulo de carné no disponible', 'error');
      return;
    }
    try {
      await EmpleadoCarne.imprimir(row);
    } catch (err) {
      F.alert('Error', err.message || 'No se pudo imprimir el carné', 'error');
    }
  },

  bindActivoButtons() {
    if (!this._container) return;
    this._container.querySelectorAll('.btn-empleado-activo').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.codempleado;
        const activo = btn.dataset.activo;
        this.onToggleActivo(id, activo);
      });
    });
  },

  async onToggleActivo(codempleado, activoActual) {
    const row = this.findRow(codempleado);
    if (!row) return;
    const actual = this.normalizeActivo(activoActual);
    const siguiente = actual === 'SI' ? 'NO' : 'SI';
    const nombre = row.NOMEMPLEADO || codempleado;
    const confirm = await CatalogosUI.fireConfirm({
      title: '¿Cambiar estado activo?',
      html: `<p class="mb-0">Empleado <strong>${this.escapeHtml(nombre)}</strong>: cambiar de <strong>${actual}</strong> a <strong>${siguiente}</strong>.</p>`,
      icon: 'question',
      confirmText: 'Cambiar',
    });
    if (!confirm) return;
    try {
      await F.fetchJson(this.apiBase(`/${encodeURIComponent(codempleado)}/activo`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ACTIVO: siguiente }),
      });
      row.ACTIVO = siguiente;
      this.updateTableView();
      F.toast(`Estado actualizado a ${siguiente}`, 'success');
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  async load(container) {
    try {
      await this.loadLookups();
    } catch (err) {
      container.classList.remove('align-items-center', 'justify-content-center');
      container.classList.add('align-items-stretch', 'justify-content-start', 'p-3');
      container.innerHTML = `
        <div class="alert alert-danger m-3 w-100" role="alert">
          <i class="fa-solid fa-circle-exclamation me-2"></i>
          No se pudieron cargar catálogos: ${this.escapeHtml(err.message)}
        </div>
      `;
      return;
    }
    return EmpleadosViewBase.load.call(this, container);
  },
};

/** Tipos de empleado (para reutilizar en otras vistas). */
window.OnnebTiposEmpleado = {
  async load() {
    const data = await F.fetchJson(`/data/tipos-empleado.json?_=${Date.now()}`, { cache: 'no-store' });
    return Array.isArray(data) ? data : data.items || [];
  },
  label(value) {
    const v = String(value ?? '');
    const found = (window._onnebTiposEmpleadoCache || []).find((t) => String(t.value) === v);
    return found ? found.label : v || '—';
  },
};

window.OnnebTiposEmpleado.load().then((items) => {
  window._onnebTiposEmpleadoCache = items;
}).catch(() => {
  window._onnebTiposEmpleadoCache = [];
});

