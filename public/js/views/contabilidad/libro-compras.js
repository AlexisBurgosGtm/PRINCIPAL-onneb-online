/**
 * Vista Libro Compras — registro contable SAT Guatemala (COM, COP, DVP).
 */
const LIBRO_COMPRAS_MESES = [
  { value: 1, label: 'ENERO' },
  { value: 2, label: 'FEBRERO' },
  { value: 3, label: 'MARZO' },
  { value: 4, label: 'ABRIL' },
  { value: 5, label: 'MAYO' },
  { value: 6, label: 'JUNIO' },
  { value: 7, label: 'JULIO' },
  { value: 8, label: 'AGOSTO' },
  { value: 9, label: 'SEPTIEMBRE' },
  { value: 10, label: 'OCTUBRE' },
  { value: 11, label: 'NOVIEMBRE' },
  { value: 12, label: 'DICIEMBRE' },
];

const LIBRO_COMPRAS_ANIOS = [];
for (let y = 2020; y <= new Date().getFullYear() + 1; y += 1) {
  LIBRO_COMPRAS_ANIOS.push({ value: y, label: String(y) });
}

function libroComprasFormatDate(value) {
  if (value === null || value === undefined || value === '') return '—';
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return '—';
  const day = String(dt.getDate()).padStart(2, '0');
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const year = dt.getFullYear();
  return `${day}/${month}/${year}`;
}

const LibroComprasView = {
  _container: null,
  _rows: [],
  _totals: null,
  _mes: null,
  _anio: null,
  _loading: false,
  _exporting: false,
  _filterQuery: '',

  tableColumns: [
    { key: 'LINEA', label: 'No.', align: 'center' },
    { key: 'FEL_FECHA', label: 'Fecha', type: 'date' },
    { key: 'FEL_SERIE', label: 'Serie' },
    { key: 'FEL_NUMERO', label: 'Número' },
    { key: 'TIPODOC', label: 'Tipo' },
    { key: 'DOC_NIT', label: 'NIT' },
    { key: 'DOC_NOMCLIE', label: 'Nombre proveedor', cellClass: 'libro-compras-col-nombre' },
    { key: 'TOTAL', label: 'Total', type: 'money' },
    { key: 'TOTAL_SERVICIOS', label: 'Total servicios', type: 'money' },
    { key: 'TOTALEXENTO', label: 'Exentas', type: 'money' },
    { key: 'TOTALSINIVA', label: 'Base del total', type: 'money' },
    { key: 'BASE_SERVICIOS', label: 'Base servicios', type: 'money' },
    { key: 'TOTALIVA', label: 'IVA', type: 'money' },
    { key: 'ANULADO', label: 'Anulado', type: 'anulado' },
    { key: 'IMPRIMIR', label: '', type: 'print', align: 'center' },
  ],

  defaultPeriod() {
    const now = new Date();
    return { mes: now.getMonth() + 1, anio: now.getFullYear() };
  },

  escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  mesLabel(mes) {
    return LIBRO_COMPRAS_MESES.find((m) => m.value === Number(mes))?.label || String(mes);
  },

  formatMoney(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '—';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  fechaDisplay(row) {
    const fel = String(row?.FEL_FECHA ?? '').trim();
    if (fel) return libroComprasFormatDate(fel);
    return libroComprasFormatDate(row?.FECHA);
  },

  formatCell(row, col) {
    const key = col.key;
    if (key === 'FEL_FECHA') {
      return this.escapeHtml(this.fechaDisplay(row));
    }
    if (col.type === 'anulado') {
      return row.ANULADO
        ? '<span class="badge text-bg-danger">Sí</span>'
        : '<span class="text-muted">No</span>';
    }
    if (col.type === 'print') {
      const hasDoc = row.CODDOC != null && row.CORRELATIVO != null && row.CORRELATIVO !== '';
      return `<button type="button" class="btn btn-sm btn-outline-secondary libro-compras-print-btn" data-action="imprimir-doc" title="Imprimir documento" ${hasDoc ? '' : 'disabled'}>
        <i class="fa-solid fa-print"></i>
      </button>`;
    }
    const value = row[key];
    if (value === null || value === undefined || value === '') return '—';
    if (col.type === 'money') {
      return `<span class="libro-compras-money">${this.escapeHtml(this.formatMoney(value))}</span>`;
    }
    return this.escapeHtml(value);
  },

  rowClass(row) {
    const classes = [];
    if (row.ANULADO) classes.push('libro-compras-row-anulado');
    else if (row.ES_NOTA_CREDITO) classes.push('libro-compras-row-nc');
    else if (row.ES_PEQ_CONTRIBUYENTE) classes.push('libro-compras-row-peq');
    return classes.join(' ');
  },

  apiUrl() {
    const empNit = F.getEmpNit();
    if (!empNit) throw new Error('No hay empresa activa. Cierre sesión e ingrese de nuevo.');
    const params = new URLSearchParams({
      empnit: empNit,
      mes: String(this._mes),
      anio: String(this._anio),
      _: String(Date.now()),
    });
    return `/api/libro-compras?${params.toString()}`;
  },

  badgeText() {
    const all = this._rows.length;
    const rows = this.filteredRows();
    const t = this.footerTotals();
    const filtering = Boolean(String(this._filterQuery || '').trim());
    const parts = [
      filtering ? `${rows.length} de ${all} registro(s)` : `${all} registro(s)`,
      `${this.mesLabel(this._mes)} ${this._anio}`,
      `COM: ${t.compras ?? 0}`,
      `COP: ${t.peqContribuyente ?? 0}`,
      `DVP: ${t.notasCredito ?? 0}`,
    ];
    if ((t.anulados ?? 0) > 0) parts.push(`Anulados: ${t.anulados}`);
    return parts.join(' · ');
  },

  filteredRows() {
    const q = this._filterQuery;
    if (!String(q || '').trim()) return this._rows;
    return this._rows.filter((row) =>
      LibroContableCommon.rowMatchesSearch(row, q, [this.fechaDisplay(row)])
    );
  },

  footerTotals() {
    const filtering = Boolean(String(this._filterQuery || '').trim());
    const rows = filtering ? this.filteredRows() : this._rows;
    if (!filtering && this._totals) return this._totals;
    const t = {
      total: 0,
      totalServicios: 0,
      exento: 0,
      gravado: 0,
      baseServicios: 0,
      iva: 0,
      documentos: rows.length,
      anulados: 0,
      compras: 0,
      peqContribuyente: 0,
      notasCredito: 0,
    };
    rows.forEach((r) => {
      if (r.ANULADO) {
        t.anulados += 1;
        return;
      }
      const tipo = String(r.TIPODOC || '').trim().toUpperCase();
      if (tipo === 'COP') t.peqContribuyente += 1;
      else if (tipo === 'DVP' || r.ES_NOTA_CREDITO) t.notasCredito += 1;
      else t.compras += 1;
      t.total += Number(r.TOTAL) || 0;
      t.totalServicios += Number(r.TOTAL_SERVICIOS) || 0;
      t.exento += Number(r.TOTALEXENTO) || 0;
      t.gravado += Number(r.TOTALSINIVA) || 0;
      t.baseServicios += Number(r.BASE_SERVICIOS) || 0;
      t.iva += Number(r.TOTALIVA) || 0;
    });
    return t;
  },

  renderFiltersCard() {
    const mesOpts = LIBRO_COMPRAS_MESES.map(
      (m) =>
        `<option value="${m.value}"${Number(this._mes) === m.value ? ' selected' : ''}>${m.label}</option>`
    ).join('');
    const anioOpts = LIBRO_COMPRAS_ANIOS.map(
      (a) =>
        `<option value="${a.value}"${Number(this._anio) === a.value ? ' selected' : ''}>${a.label}</option>`
    ).join('');

    return `
      <div class="card libro-compras-filters-card shadow-sm mb-3">
        <div class="card-body">
          <div class="d-flex flex-wrap align-items-end gap-2 libro-compras-filters-row">
            <div class="libro-compras-filter-mes">
              <label for="libro-compras-mes" class="form-label small mb-1">Mes</label>
              <select class="form-select form-select-sm" id="libro-compras-mes">
                ${mesOpts}
              </select>
            </div>
            <div class="libro-compras-filter-anio">
              <label for="libro-compras-anio" class="form-label small mb-1">Año</label>
              <select class="form-select form-select-sm" id="libro-compras-anio">
                ${anioOpts}
              </select>
            </div>
            ${LibroContableCommon.searchInputHtml(
              'libro-compras',
              this._filterQuery,
              'NIT, proveedor, serie, número, tipo…'
            )}
            <div class="libro-compras-actions d-flex gap-2">
              <button type="button" class="btn btn-sm btn-outline-primary" id="btn-libro-compras-recargar">
                <i class="fa-solid fa-rotate me-1"></i>Actualizar
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-libro-compras-imprimir">
                <i class="fa-solid fa-print me-1"></i>Imprimir
              </button>
              <button type="button" class="btn btn-sm btn-outline-success" id="btn-libro-compras-export">
                <i class="fa-solid fa-file-excel me-1"></i>Exportar (xlsx)
              </button>
            </div>
          </div>
          <div class="libro-compras-badge small text-muted mt-2" id="libro-compras-count">${this.escapeHtml(this.badgeText())}</div>
          <div class="small text-muted mt-1">
            Documentos: <strong>COM</strong> / <strong>COP</strong> (CONTABLE = SI);
            <strong>DVP</strong> (nota crédito proveedor: siempre, resta con IVA).
            Serie/número/fecha: FEL o factura proveedor. Estado <strong>A</strong> = anulado.
          </div>
        </div>
      </div>
    `;
  },

  renderTableBodyHtml(rows) {
    if (!rows.length) {
      const msg = String(this._filterQuery || '').trim()
        ? 'Sin coincidencias para la búsqueda'
        : 'No hay registros para este período';
      return `<tr><td colspan="${this.tableColumns.length}" class="text-center text-muted py-4">${msg}</td></tr>`;
    }
    return rows
      .map((row) => {
        const cls = this.rowClass(row);
        const cells = this.tableColumns
          .map((col) => {
            const align = col.align === 'center' ? ' text-center' : col.type === 'money' ? ' text-end' : '';
            const extra = col.cellClass ? ` ${col.cellClass}` : '';
            return `<td class="${`${align}${extra}`.trim()}">${this.formatCell(row, col)}</td>`;
          })
          .join('');
        return `<tr class="${cls}" data-coddoc="${this.escapeHtml(row.CODDOC || '')}" data-correlativo="${this.escapeHtml(row.CORRELATIVO ?? '')}" data-desdoc="${this.escapeHtml(row.DESDOC || '')}" data-tipodoc="${this.escapeHtml(row.TIPODOC || '')}">${cells}</tr>`;
      })
      .join('');
  },

  renderTableFooterHtml() {
    const rows = this.filteredRows();
    const t = this.footerTotals();
    if (!rows.length) return '';
    const label = String(this._filterQuery || '').trim()
      ? 'Totales (filtro, sin anulados):'
      : 'Totales (sin anulados):';
    return `
      <tfoot>
        <tr>
          <td colspan="7" class="text-end">${label}</td>
          <td class="text-end libro-compras-money">${this.escapeHtml(this.formatMoney(t.total))}</td>
          <td class="text-end libro-compras-money">${this.escapeHtml(this.formatMoney(t.totalServicios))}</td>
          <td class="text-end libro-compras-money">${this.escapeHtml(this.formatMoney(t.exento))}</td>
          <td class="text-end libro-compras-money">${this.escapeHtml(this.formatMoney(t.gravado))}</td>
          <td class="text-end libro-compras-money">${this.escapeHtml(this.formatMoney(t.baseServicios))}</td>
          <td class="text-end libro-compras-money">${this.escapeHtml(this.formatMoney(t.iva))}</td>
          <td></td>
          <td></td>
        </tr>
      </tfoot>
    `;
  },

  renderTableCard() {
    const headers = this.tableColumns
      .map((c) => {
        const align = c.align === 'center' ? ' text-center' : c.type === 'money' ? ' text-end' : '';
        const extra = c.cellClass ? ` ${c.cellClass}` : '';
        return `<th scope="col" class="${`${align}${extra}`.trim()}">${this.escapeHtml(c.label)}</th>`;
      })
      .join('');
    return `
      <div class="card libro-compras-table-card shadow-sm">
        <div class="table-responsive">
          <table class="table table-sm table-hover table-striped mb-0">
            <thead class="table-light sticky-top">
              <tr>${headers}</tr>
            </thead>
            <tbody id="libro-compras-tbody">${this.renderTableBodyHtml(this.filteredRows())}</tbody>
            ${this.renderTableFooterHtml()}
          </table>
        </div>
      </div>
    `;
  },

  render() {
    return `
      <div class="libro-compras-wrap">
        ${this.renderFiltersCard()}
        ${this.renderTableCard()}
      </div>
    `;
  },

  refreshDom() {
    const countEl = this._container?.querySelector('#libro-compras-count');
    if (countEl) countEl.textContent = this.badgeText();
    const tbody = this._container?.querySelector('#libro-compras-tbody');
    if (tbody) tbody.innerHTML = this.renderTableBodyHtml(this.filteredRows());
    const table = this._container?.querySelector('.libro-compras-table-card table');
    if (table) {
      table.querySelector('tfoot')?.remove();
      const footer = this.renderTableFooterHtml();
      if (footer) table.insertAdjacentHTML('beforeend', footer);
    }
  },

  bindEvents() {
    this._container?.querySelector('#libro-compras-mes')?.addEventListener('change', (e) => {
      this._mes = Number(e.target.value);
      this.reload().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#libro-compras-anio')?.addEventListener('change', (e) => {
      this._anio = Number(e.target.value);
      this.reload().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#btn-libro-compras-recargar')?.addEventListener('click', () => {
      this.reload().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#btn-libro-compras-imprimir')?.addEventListener('click', () => {
      this.imprimir().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#btn-libro-compras-export')?.addEventListener('click', () => {
      this.exportExcel().catch((err) => F.toast(err.message, 'error'));
    });
    this.bindPrintActions();
    LibroContableCommon.bindSearch(this._container, 'libro-compras', this);
  },

  bindPrintActions() {
    if (this._printBound || !this._container) return;
    this._printBound = true;
    this._container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="imprimir-doc"]');
      if (!btn || !this._container.contains(btn)) return;
      const tr = btn.closest('tr');
      if (!tr) return;
      const coddoc = tr.dataset.coddoc;
      const correlativo = tr.dataset.correlativo;
      const row = {
        CODDOC: coddoc,
        CORRELATIVO: correlativo,
        DESDOC: tr.dataset.desdoc,
        TIPODOC: tr.dataset.tipodoc,
      };
      this.imprimirDocumento(coddoc, correlativo, row).catch((err) =>
        F.alert('Error', err.message || 'No se pudo imprimir', 'error')
      );
    });
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

  async exportExcel() {
    if (this._exporting) return;
    this._exporting = true;
    const btn = this._container?.querySelector('#btn-libro-compras-export');
    try {
      const url = LibroContableCommon.buildExportUrl('/api/libro-compras', this._mes, this._anio);
      await LibroContableCommon.downloadExport(url, btn, `libro_compras_${this._mes}_${this._anio}.xlsx`);
    } finally {
      this._exporting = false;
    }
  },

  async reload() {
    if (this._loading) return;
    this._loading = true;
    try {
      const data = await F.fetchJson(this.apiUrl(), { cache: 'no-store' });
      this._rows = data.rows || [];
      this._totals = data.totals || null;
      this.refreshDom();
    } finally {
      this._loading = false;
    }
  },

  async imprimir() {
    await PrintReport.ensureLogo();
    const title = 'Libro de Compras y Servicios Adquiridos';
    const subtitleHtml = `
      <p><strong>Período:</strong> ${PrintReport.escapeHtml(this.mesLabel(this._mes))} ${PrintReport.escapeHtml(String(this._anio))}</p>
      <p class="meta">Documentos contables COM, COP y DVP · Serie/Número/Fecha FEL</p>
    `;
    const printCols = this.tableColumns.filter((c) => c.type !== 'print');
    const headCells = printCols.map((c) => `<th>${PrintReport.escapeHtml(c.label)}</th>`).join('');
    const bodyRows = this._rows
      .map((row) => {
        const cells = printCols
          .map((col) => {
            const align = col.type === 'money' ? ' class="text-end"' : '';
            let val;
            if (col.key === 'FEL_FECHA') val = this.fechaDisplay(row);
            else if (col.type === 'anulado') val = row.ANULADO ? 'Sí' : 'No';
            else if (col.type === 'money') val = this.formatMoney(row[col.key]);
            else val = row[col.key] ?? '—';
            return `<td${align}>${PrintReport.escapeHtml(val)}</td>`;
          })
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');
    const t = this._totals || {};
    const footerRow = this._rows.length
      ? `<tr class="totals">
          <td colspan="7" class="text-end">Totales (sin anulados)</td>
          <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(t.total))}</td>
          <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(t.totalServicios))}</td>
          <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(t.exento))}</td>
          <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(t.gravado))}</td>
          <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(t.baseServicios))}</td>
          <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(t.iva))}</td>
          <td></td>
        </tr>`
      : '';
    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({ title, subtitleHtml })}
      <table>
        <thead><tr>${headCells}</tr></thead>
        <tbody>${bodyRows || `<tr><td colspan="${printCols.length}">Sin registros</td></tr>`}</tbody>
        ${footerRow ? `<tfoot>${footerRow}</tfoot>` : ''}
      </table>
    `;
    PrintReport.openAndPrint(
      PrintReport.wrapDocument({
        title,
        bodyHtml,
      })
    );
  },

  async load(container) {
    this._container = container;
    const period = this.defaultPeriod();
    this._mes = period.mes;
    this._anio = period.anio;
    this._rows = [];
    this._totals = null;
    this._filterQuery = '';
    this._printBound = false;
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add('align-items-stretch', 'justify-content-start');
    container.innerHTML = this.render();
    this.bindEvents();
    await this.reload();
  },
};
