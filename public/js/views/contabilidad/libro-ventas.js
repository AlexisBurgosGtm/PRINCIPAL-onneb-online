/**
 * Vista Libro Ventas — registro contable SAT Guatemala (FEF, FEC, FES, FNC).
 */
const LIBRO_VENTAS_MESES = [
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

const LIBRO_VENTAS_ANIOS = [];
for (let y = 2020; y <= new Date().getFullYear() + 1; y += 1) {
  LIBRO_VENTAS_ANIOS.push({ value: y, label: String(y) });
}

function libroVentasFormatDate(value) {
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

const LibroVentasView = {
  _container: null,
  _rows: [],
  _totals: null,
  _mes: null,
  _anio: null,
  _loading: false,
  _exporting: false,
  _filterQuery: '',
  _comparing: false,
  _satCompare: null,

  tableColumns: [
    { key: 'LINEA', label: 'No.', align: 'center' },
    { key: 'FEL_FECHA', label: 'Fecha', type: 'date' },
    { key: 'FEL_SERIE', label: 'Serie' },
    { key: 'FEL_NUMERO', label: 'Número' },
    { key: 'TIPODOC', label: 'Tipo' },
    { key: 'DOC_NIT', label: 'NIT' },
    { key: 'DOC_NOMCLIE', label: 'Nombre proveedor', cellClass: 'libro-ventas-col-nombre' },
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
    return LIBRO_VENTAS_MESES.find((m) => m.value === Number(mes))?.label || String(mes);
  },

  formatMoney(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '—';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  fechaDisplay(row) {
    const fel = String(row?.FEL_FECHA ?? '').trim();
    if (fel) return libroVentasFormatDate(fel);
    return libroVentasFormatDate(row?.FECHA);
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
      return `<button type="button" class="btn btn-sm btn-outline-secondary libro-ventas-print-btn" data-action="imprimir-doc" title="Imprimir documento" ${hasDoc ? '' : 'disabled'}>
        <i class="fa-solid fa-print"></i>
      </button>`;
    }
    const value = row[key];
    if (value === null || value === undefined || value === '') return '—';
    if (col.type === 'money') {
      return `<span class="libro-ventas-money">${this.escapeHtml(this.formatMoney(value))}</span>`;
    }
    return this.escapeHtml(value);
  },

  rowClass(row) {
    const classes = [];
    if (row.ANULADO) classes.push('libro-ventas-row-anulado');
    else if (row.ES_NOTA_CREDITO) classes.push('libro-ventas-row-nc');
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
    return `/api/libro-ventas?${params.toString()}`;
  },

  badgeText() {
    const all = this._rows.length;
    const rows = this.filteredRows();
    const t = this.footerTotals();
    const filtering = Boolean(String(this._filterQuery || '').trim());
    const parts = [
      filtering ? `${rows.length} de ${all} registro(s)` : `${all} registro(s)`,
      `${this.mesLabel(this._mes)} ${this._anio}`,
      `Ventas: ${t.ventas ?? 0}`,
      `Notas crédito: ${t.notasCredito ?? 0}`,
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
      ventas: 0,
      notasCredito: 0,
    };
    rows.forEach((r) => {
      if (r.ANULADO) {
        t.anulados += 1;
        return;
      }
      if (r.ES_NOTA_CREDITO) t.notasCredito += 1;
      else t.ventas += 1;
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
    const mesOpts = LIBRO_VENTAS_MESES.map(
      (m) =>
        `<option value="${m.value}"${Number(this._mes) === m.value ? ' selected' : ''}>${m.label}</option>`
    ).join('');
    const anioOpts = LIBRO_VENTAS_ANIOS.map(
      (a) =>
        `<option value="${a.value}"${Number(this._anio) === a.value ? ' selected' : ''}>${a.label}</option>`
    ).join('');

    return `
      <div class="card libro-ventas-filters-card shadow-sm mb-3">
        <div class="card-body">
          <div class="d-flex flex-wrap align-items-end gap-2 libro-ventas-filters-row">
            <div class="libro-ventas-filter-mes">
              <label for="libro-ventas-mes" class="form-label small mb-1">Mes</label>
              <select class="form-select form-select-sm" id="libro-ventas-mes">
                ${mesOpts}
              </select>
            </div>
            <div class="libro-ventas-filter-anio">
              <label for="libro-ventas-anio" class="form-label small mb-1">Año</label>
              <select class="form-select form-select-sm" id="libro-ventas-anio">
                ${anioOpts}
              </select>
            </div>
            ${LibroContableCommon.searchInputHtml(
              'libro-ventas',
              this._filterQuery,
              'NIT, cliente, serie, número, tipo…'
            )}
            <div class="libro-ventas-actions d-flex gap-2">
              <button type="button" class="btn btn-sm btn-outline-primary" id="btn-libro-ventas-recargar">
                <i class="fa-solid fa-rotate me-1"></i>Actualizar
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-libro-ventas-imprimir">
                <i class="fa-solid fa-print me-1"></i>Imprimir
              </button>
              <button type="button" class="btn btn-sm btn-outline-success" id="btn-libro-ventas-export">
                <i class="fa-solid fa-file-excel me-1"></i>Exportar (xlsx)
              </button>
              <button type="button" class="btn btn-sm btn-outline-warning" id="btn-libro-ventas-sat">
                <i class="fa-solid fa-file-import me-1"></i>Comparar SAT
              </button>
              <input type="file" id="libro-ventas-sat-file" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
            </div>
          </div>
          <div class="libro-ventas-badge small text-muted mt-2" id="libro-ventas-count">${this.escapeHtml(this.badgeText())}</div>
          <div class="small text-muted mt-1">
            Documentos contables (<strong>CONTABLE = SI</strong>): ventas FEF, FEC, FES y notas de crédito FNC.
            Serie, número y fecha provienen de FEL. Los documentos con estado <strong>A</strong> se marcan como anulados.
            Use <strong>Comparar SAT</strong> para cruzar el Excel de Ventas SAT (<em>Serie</em> / <em>Número del DTE</em>) con el sistema (FEF, FEC, FES, FNC, FNA) del mes.
          </div>
        </div>
      </div>
    `;
  },

  statusCellHtml(status, { anulado = false } = {}) {
    const st = String(status || '').trim().toUpperCase();
    const isA = st === 'A' || anulado === true;
    if (!st && !isA) return '<span class="text-muted">—</span>';
    const label = isA ? 'A' : st;
    const cls = isA ? 'libro-ventas-status-a fw-semibold' : '';
    return `<span class="${cls}">${this.escapeHtml(label)}</span>`;
  },

  renderSatCompareCard() {
    const cmp = this._satCompare;
    if (!cmp) return '';

    const fmtMoney = (v) => this.escapeHtml(this.formatMoney(v));
    const satRows = (cmp.enSatNoSistema || [])
      .map((r) => {
        const statusSat = r.ANULADO ? 'A' : String(r.ESTADO || '').trim() || '—';
        return `<tr class="${r.ANULADO ? 'libro-ventas-row-anulado' : ''}">
          <td>${this.escapeHtml(r.TIPO || '—')}</td>
          <td>${this.escapeHtml(r.SERIE || '—')}</td>
          <td>${this.escapeHtml(r.NUMERO || '—')}</td>
          <td class="text-end libro-ventas-money">${fmtMoney(r.TOTAL)}</td>
          <td>${this.statusCellHtml(statusSat, { anulado: r.ANULADO })}</td>
          <td>${this.escapeHtml(r.RECEPTOR || '—')}</td>
        </tr>`;
      })
      .join('');
    const sysRows = (cmp.enSistemaNoSat || [])
      .map((r) => {
        const hasUuid = Boolean(String(r.FEL_UUDI || '').trim());
        const hasDoc = r.CODDOC != null && r.CORRELATIVO != null && r.CORRELATIVO !== '';
        const anulado = String(r.STATUS || '').toUpperCase() === 'A' || r.ANULADO;
        return `<tr class="${anulado ? 'libro-ventas-row-anulado' : ''}" data-coddoc="${this.escapeHtml(r.CODDOC || '')}" data-correlativo="${this.escapeHtml(r.CORRELATIVO ?? '')}" data-fel-uudi="${this.escapeHtml(r.FEL_UUDI || '')}" data-desdoc="${this.escapeHtml(r.DESDOC || '')}" data-tipodoc="${this.escapeHtml(r.TIPODOC || '')}">
          <td>${this.escapeHtml(r.TIPODOC || '—')}</td>
          <td>${this.escapeHtml(r.FEL_SERIE || '—')}</td>
          <td>${this.escapeHtml(r.FEL_NUMERO || '—')}</td>
          <td class="text-end libro-ventas-money">${fmtMoney(r.TOTALPRECIO)}</td>
          <td>${this.statusCellHtml(r.STATUS, { anulado })}</td>
          <td>${this.escapeHtml(r.DOC_NOMCLIE || '—')}</td>
          <td class="text-nowrap">
            <button type="button" class="btn btn-sm btn-outline-info libro-ventas-sat-btn" data-action="fel-online" title="Ver en Infile (UUID)" ${hasUuid ? '' : 'disabled'}>
              <i class="fa-solid fa-globe"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary libro-ventas-sat-btn" data-action="imprimir" title="Imprimir documento interno" ${hasDoc ? '' : 'disabled'}>
              <i class="fa-solid fa-print"></i>
            </button>
          </td>
        </tr>`;
      })
      .join('');

    const montoRows = (cmp.discrepanciasMonto || [])
      .map((r) => {
        const hasUuid = Boolean(String(r.FEL_UUDI || '').trim());
        const hasDoc = r.CODDOC != null && r.CORRELATIVO != null && r.CORRELATIVO !== '';
        const anulado = String(r.STATUS || '').toUpperCase() === 'A' || r.ANULADO;
        const diffCls = Number(r.DIFERENCIA) > 0 ? 'text-danger' : 'text-success';
        return `<tr class="${anulado ? 'libro-ventas-row-anulado' : ''}" data-coddoc="${this.escapeHtml(r.CODDOC || '')}" data-correlativo="${this.escapeHtml(r.CORRELATIVO ?? '')}" data-fel-uudi="${this.escapeHtml(r.FEL_UUDI || '')}" data-desdoc="${this.escapeHtml(r.DESDOC || '')}" data-tipodoc="${this.escapeHtml(r.TIPODOC || '')}">
          <td>${this.escapeHtml(r.TIPODOC || r.TIPO_SAT || '—')}</td>
          <td>${this.escapeHtml(r.SERIE || '—')}</td>
          <td>${this.escapeHtml(r.NUMERO || '—')}</td>
          <td class="text-end libro-ventas-money">${fmtMoney(r.TOTAL_SAT)}</td>
          <td class="text-end libro-ventas-money">${fmtMoney(r.TOTAL_SISTEMA)}</td>
          <td class="text-end libro-ventas-money ${diffCls}">${fmtMoney(r.DIFERENCIA)}</td>
          <td>${this.statusCellHtml(r.STATUS, { anulado })}</td>
          <td>${this.escapeHtml(r.DOC_NOMCLIE || '—')}</td>
          <td class="text-nowrap">
            <button type="button" class="btn btn-sm btn-outline-info libro-ventas-sat-btn" data-action="fel-online" title="Ver en Infile (UUID)" ${hasUuid ? '' : 'disabled'}>
              <i class="fa-solid fa-globe"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary libro-ventas-sat-btn" data-action="imprimir" title="Imprimir documento interno" ${hasDoc ? '' : 'disabled'}>
              <i class="fa-solid fa-print"></i>
            </button>
          </td>
        </tr>`;
      })
      .join('');

    return `
      <div class="card libro-ventas-sat-card shadow-sm mb-3">
        <div class="card-body">
          <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
            <div>
              <h6 class="mb-1">
                <i class="fa-solid fa-scale-balanced me-1"></i>Comparación SAT vs sistema
              </h6>
              <p class="small text-muted mb-0">
                Archivo: <strong>${this.escapeHtml(cmp.archivo || '—')}</strong>
                · ${this.mesLabel(cmp.mes)} ${cmp.anio}
                · Coincidentes (serie/núm.): <strong>${cmp.coincidentes ?? 0}</strong>
                · Montos OK: <strong>${cmp.coincidentesMontoOk ?? 0}</strong>
                · Diff. monto: <strong>${(cmp.discrepanciasMonto || []).length}</strong>
                · SAT: <strong>${cmp.sat?.totalConSerieNumero ?? 0}</strong>
                · Sistema: <strong>${cmp.sistema?.totalDocumentos ?? 0}</strong>
              </p>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-libro-ventas-sat-cerrar">
              <i class="fa-solid fa-xmark me-1"></i>Cerrar comparación
            </button>
          </div>
          <div class="row g-3 mb-3">
            <div class="col-lg-6">
              <div class="libro-ventas-sat-panel">
                <div class="libro-ventas-sat-panel-title text-danger">
                  En SAT, no en el sistema (${(cmp.enSatNoSistema || []).length})
                </div>
                <div class="table-responsive">
                  <table class="table table-sm table-striped mb-0">
                    <thead><tr>
                      <th>Tipo</th><th>Serie</th><th>Número</th><th class="text-end">Monto</th><th>Status</th><th>Receptor</th>
                    </tr></thead>
                    <tbody>
                      ${satRows || '<tr><td colspan="6" class="text-center text-muted py-3">Sin diferencias</td></tr>'}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div class="col-lg-6">
              <div class="libro-ventas-sat-panel">
                <div class="libro-ventas-sat-panel-title text-primary">
                  En el sistema, no en SAT (${(cmp.enSistemaNoSat || []).length})
                </div>
                <div class="table-responsive">
                  <table class="table table-sm table-striped mb-0">
                    <thead><tr>
                      <th>Tipo</th><th>FEL Serie</th><th>FEL Número</th><th class="text-end">Monto</th><th>Status</th><th>Cliente</th><th></th>
                    </tr></thead>
                    <tbody>
                      ${sysRows || '<tr><td colspan="7" class="text-center text-muted py-3">Sin diferencias</td></tr>'}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
          <div class="libro-ventas-sat-panel">
            <div class="libro-ventas-sat-panel-title text-warning">
              Discrepancias de monto — Gran Total SAT vs TOTALPRECIO (${(cmp.discrepanciasMonto || []).length})
            </div>
            <div class="table-responsive">
              <table class="table table-sm table-striped mb-0">
                <thead><tr>
                  <th>Tipo</th><th>Serie</th><th>Número</th>
                  <th class="text-end">Monto SAT</th><th class="text-end">Monto sistema</th><th class="text-end">Diferencia</th>
                  <th>Status</th><th>Cliente</th><th></th>
                </tr></thead>
                <tbody>
                  ${montoRows || '<tr><td colspan="9" class="text-center text-muted py-3">Sin discrepancias de monto</td></tr>'}
                </tbody>
              </table>
            </div>
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
          <td class="text-end libro-ventas-money">${this.escapeHtml(this.formatMoney(t.total))}</td>
          <td class="text-end libro-ventas-money">${this.escapeHtml(this.formatMoney(t.totalServicios))}</td>
          <td class="text-end libro-ventas-money">${this.escapeHtml(this.formatMoney(t.exento))}</td>
          <td class="text-end libro-ventas-money">${this.escapeHtml(this.formatMoney(t.gravado))}</td>
          <td class="text-end libro-ventas-money">${this.escapeHtml(this.formatMoney(t.baseServicios))}</td>
          <td class="text-end libro-ventas-money">${this.escapeHtml(this.formatMoney(t.iva))}</td>
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
      <div class="card libro-ventas-table-card shadow-sm">
        <div class="table-responsive">
          <table class="table table-sm table-hover table-striped mb-0">
            <thead class="table-light sticky-top">
              <tr>${headers}</tr>
            </thead>
            <tbody id="libro-ventas-tbody">${this.renderTableBodyHtml(this.filteredRows())}</tbody>
            ${this.renderTableFooterHtml()}
          </table>
        </div>
      </div>
    `;
  },

  render() {
    return `
      <div class="libro-ventas-wrap">
        ${this.renderFiltersCard()}
        <div id="libro-ventas-sat-slot">${this.renderSatCompareCard()}</div>
        ${this.renderTableCard()}
      </div>
    `;
  },

  refreshSatCompareDom() {
    const slot = this._container?.querySelector('#libro-ventas-sat-slot');
    if (slot) {
      slot.innerHTML = this.renderSatCompareCard();
      this.bindSatCompareClose();
    }
  },

  bindSatCompareClose() {
    this._container?.querySelector('#btn-libro-ventas-sat-cerrar')?.addEventListener('click', () => {
      this._satCompare = null;
      this.refreshSatCompareDom();
    });
  },

  bindSatCompareRowActions() {
    if (this._satActionsBound) return;
    this._satActionsBound = true;
    this._container?.addEventListener('click', (e) => {
      const btn = e.target.closest('#libro-ventas-sat-slot [data-action]');
      if (!btn || btn.disabled) return;
      const tr = btn.closest('tr');
      if (!tr) return;
      const action = btn.dataset.action;
      const coddoc = tr.dataset.coddoc;
      const correlativo = tr.dataset.correlativo;
      const felUudi = tr.dataset.felUudi;
      const row = {
        CODDOC: coddoc,
        CORRELATIVO: correlativo,
        FEL_UUDI: felUudi,
        DESDOC: tr.dataset.desdoc,
        TIPODOC: tr.dataset.tipodoc,
      };
      if (action === 'fel-online') {
        this.abrirFelOnline(felUudi).catch((err) => F.toast(err.message || 'No se pudo abrir FEL', 'error'));
      } else if (action === 'imprimir') {
        this.imprimirDocumentoSat(coddoc, correlativo, row).catch((err) =>
          F.alert('Error', err.message || 'No se pudo imprimir', 'error')
        );
      }
    });
  },

  async abrirFelOnline(felUudi) {
    const fel = String(felUudi || '').trim();
    if (!fel) {
      F.toast('El documento no tiene UUID FEL', 'warning');
      return;
    }
    if (typeof DocOpciones === 'undefined') {
      F.toast('Componente DocOpciones no disponible', 'error');
      return;
    }
    let baseUrl = this._urlFel;
    if (!baseUrl) {
      baseUrl = await DocOpciones.fetchUrlFel();
      this._urlFel = baseUrl;
    }
    if (!baseUrl) {
      F.toast('Configure la URL FEL en Config general', 'warning');
      return;
    }
    const url = DocOpciones.joinFelUrl(baseUrl, fel);
    if (!url) {
      F.toast('No se pudo construir la URL del documento FEL', 'warning');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  async imprimirDocumentoSat(coddoc, correlativo, row) {
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

  refreshDom() {
    const countEl = this._container?.querySelector('#libro-ventas-count');
    if (countEl) countEl.textContent = this.badgeText();
    const tbody = this._container?.querySelector('#libro-ventas-tbody');
    if (tbody) tbody.innerHTML = this.renderTableBodyHtml(this.filteredRows());
    const table = this._container?.querySelector('.libro-ventas-table-card table');
    if (table) {
      table.querySelector('tfoot')?.remove();
      const footer = this.renderTableFooterHtml();
      if (footer) table.insertAdjacentHTML('beforeend', footer);
    }
  },

  bindEvents() {
    this._container?.querySelector('#libro-ventas-mes')?.addEventListener('change', (e) => {
      this._mes = Number(e.target.value);
      this._satCompare = null;
      this.refreshSatCompareDom();
      this.reload().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#libro-ventas-anio')?.addEventListener('change', (e) => {
      this._anio = Number(e.target.value);
      this._satCompare = null;
      this.refreshSatCompareDom();
      this.reload().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#btn-libro-ventas-recargar')?.addEventListener('click', () => {
      this.reload().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#btn-libro-ventas-imprimir')?.addEventListener('click', () => {
      this.imprimir().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#btn-libro-ventas-export')?.addEventListener('click', () => {
      this.exportExcel().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#btn-libro-ventas-sat')?.addEventListener('click', () => {
      this._container?.querySelector('#libro-ventas-sat-file')?.click();
    });
    this._container?.querySelector('#libro-ventas-sat-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      this.compararSat(file).catch((err) => F.alert('Error', err.message || 'No se pudo comparar', 'error'));
    });
    this.bindSatCompareClose();
    this.bindSatCompareRowActions();
    this.bindPrintActions();
    LibroContableCommon.bindSearch(this._container, 'libro-ventas', this);
  },

  bindPrintActions() {
    if (this._printBound || !this._container) return;
    this._printBound = true;
    this._container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="imprimir-doc"]');
      if (!btn || !this._container.contains(btn)) return;
      const tr = btn.closest('tr');
      if (!tr || !tr.closest('#libro-ventas-tbody')) return;
      const coddoc = tr.dataset.coddoc;
      const correlativo = tr.dataset.correlativo;
      const row = {
        CODDOC: coddoc,
        CORRELATIVO: correlativo,
        DESDOC: tr.dataset.desdoc,
        TIPODOC: tr.dataset.tipodoc,
      };
      this.imprimirDocumentoSat(coddoc, correlativo, row).catch((err) =>
        F.alert('Error', err.message || 'No se pudo imprimir', 'error')
      );
    });
  },

  async compararSat(file) {
    if (this._comparing) return;
    const name = String(file.name || '').toLowerCase();
    if (!name.endsWith('.xls') && !name.endsWith('.xlsx')) {
      F.toast('Seleccione un archivo .xls o .xlsx', 'warning');
      return;
    }
    this._comparing = true;
    const btn = this._container?.querySelector('#btn-libro-ventas-sat');
    if (btn) btn.disabled = true;
    try {
      const empNit = F.getEmpNit();
      if (!empNit) throw new Error('No hay empresa activa');
      const params = new URLSearchParams({
        empnit: empNit,
        mes: String(this._mes),
        anio: String(this._anio),
      });
      const form = new FormData();
      form.append('archivo', file);
      const res = await fetch(`/api/libro-ventas/comparar-sat?${params}`, {
        method: 'POST',
        body: form,
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText || 'Error al comparar');
      this._satCompare = data;
      this.refreshSatCompareDom();
      const satMiss = (data.enSatNoSistema || []).length;
      const sysMiss = (data.enSistemaNoSat || []).length;
      const montoMiss = (data.discrepanciasMonto || []).length;
      F.toast(
        `Comparación lista: ${satMiss} solo SAT · ${sysMiss} solo sistema · ${montoMiss} diff. monto · ${data.coincidentes ?? 0} coincidentes`,
        satMiss || sysMiss || montoMiss ? 'warning' : 'success'
      );
    } finally {
      this._comparing = false;
      if (btn) btn.disabled = false;
    }
  },

  async exportExcel() {
    if (this._exporting) return;
    this._exporting = true;
    const btn = this._container?.querySelector('#btn-libro-ventas-export');
    try {
      const url = LibroContableCommon.buildExportUrl('/api/libro-ventas', this._mes, this._anio);
      await LibroContableCommon.downloadExport(url, btn, `libro_ventas_${this._mes}_${this._anio}.xlsx`);
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
    const title = 'Libro de Ventas y Servicios Prestados';
    const subtitleHtml = `
      <p><strong>Período:</strong> ${PrintReport.escapeHtml(this.mesLabel(this._mes))} ${PrintReport.escapeHtml(String(this._anio))}</p>
      <p class="meta">Documentos contables FEF, FEC, FES y FNC · Serie/Número/Fecha FEL</p>
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
    this._satCompare = null;
    this._satActionsBound = false;
    this._printBound = false;
    this._urlFel = null;
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add('align-items-stretch', 'justify-content-start');
    container.innerHTML = this.render();
    this.bindEvents();
    await this.reload();
  },
};
