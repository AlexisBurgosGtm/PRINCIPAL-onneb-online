/**
 * Vista Cuentas por pagar — compras al crédito con saldo pendiente.
 */
const CuentasPorPagarView = {
  _container: null,
  _rows: [],
  _total: 0,
  _sumSaldo: 0,
  _sumTotal: 0,
  _truncated: false,
  _filterQuery: '',
  _vistaTipo: 'lista',
  _calYear: null,
  _calMonth: null,
  _consolidadoRows: [],
  _consolidadoTotales: null,
  _resumenRows: [],
  _resumenTotales: null,
  _loading: false,
  _guardandoRecibo: false,
  _corregiendoSaldos: false,

  MENU_OPCIONES: [
    { action: 'nuevo-pago', label: 'NUEVO PAGO', icon: 'fa-solid fa-money-bill-transfer', className: 'btn-success text-white' },
    { action: 'historial', label: 'HISTORIAL', icon: 'fa-solid fa-clock-rotate-left', className: 'btn-outline-primary' },
    { action: 'estado-cuenta', label: 'ESTADO CUENTA', icon: 'fa-solid fa-file-invoice', className: 'btn-outline-secondary' },
    { action: 'reimprimir', label: 'REIMPRIMIR', icon: 'fa-solid fa-print', className: 'btn-outline-secondary' },
    { action: 'whatsapp', label: 'WHATSAPP', icon: 'fa-brands fa-whatsapp', className: 'btn-outline-success' },
  ],

  escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  apiUrl(extraParams = {}) {
    const emp = F.getEmpNit();
    if (!emp) throw new Error('No hay empresa activa');
    const params = new URLSearchParams({ empnit: emp, limit: '500', ...extraParams });
    return `/api/cuentas-pagar/documentos?${params}`;
  },

  compraUrl(coddoc, correlativo) {
    const emp = F.getEmpNit();
    return `/api/cuentas-pagar/compras/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}?empnit=${encodeURIComponent(emp)}`;
  },

  pagosUrl(coddoc, correlativo) {
    const emp = F.getEmpNit();
    return `/api/cuentas-pagar/compras/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}/pagos?empnit=${encodeURIComponent(emp)}`;
  },

  async fetchRcpTipos() {
    const emp = F.getEmpNit();
    return F.fetchJson(`/api/cuentas-pagar/rcp/tipos?empnit=${encodeURIComponent(emp)}&_=${Date.now()}`, {
      cache: 'no-store',
    });
  },

  async fetchSiguienteRcp(coddoc) {
    const emp = F.getEmpNit();
    const params = new URLSearchParams({ empnit: emp, _: String(Date.now()) });
    if (coddoc) params.set('coddoc', coddoc);
    return F.fetchJson(`/api/cuentas-pagar/rcp/siguiente?${params}`, { cache: 'no-store' });
  },

  renderRcpCoddocSelectHtml(tipos, selectedCoddoc) {
    if (!tipos?.length) {
      return '<p class="small text-danger mb-0">No hay documentos RCP activos</p>';
    }
    const options = tipos
      .map((t) => {
        const cod = t.CODDOC;
        const label = t.DESDOC ? `${cod} — ${t.DESDOC}` : cod;
        const sel = String(cod) === String(selectedCoddoc) ? ' selected' : '';
        return `<option value="${this.escapeHtml(cod)}"${sel}>${this.escapeHtml(label)}</option>`;
      })
      .join('');
    return `
      <select id="cxp-abono-coddoc" class="form-select form-select-sm fw-semibold">
        ${options}
      </select>`;
  },

  async wireCoddocRcpChange() {
    const select = document.getElementById('cxp-abono-coddoc');
    const corrInp = document.getElementById('cxp-abono-correlativo');
    if (!select || !corrInp) return;

    const loadCorrelativo = async (coddoc) => {
      corrInp.value = '…';
      corrInp.disabled = true;
      try {
        const data = await this.fetchSiguienteRcp(coddoc);
        corrInp.value = String(data.rcp?.CORRELATIVO ?? '');
      } catch (err) {
        corrInp.value = '';
        F.toast(err.message || 'No se pudo cargar el correlativo', 'error');
      } finally {
        corrInp.disabled = false;
      }
    };

    select.addEventListener('change', () => {
      loadCorrelativo(select.value).catch(() => {});
    });
  },

  usuario() {
    const u = F.session('user');
    return u?.username || u?.usuario || 'CXP';
  },

  todayIsoDate() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
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

  abonoSuperaSaldo(abono, saldo) {
    return this.roundCentavos(abono) > this.roundCentavos(saldo);
  },

  formatQty(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '0';
    return n.toLocaleString('es-GT', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  },

  formatFecha(value) {
    if (!value) return '—';
    const s = String(value).slice(0, 10);
    const [y, m, d] = s.split('-');
    if (d && m && y) return `${d}/${m}/${y}`;
    return s;
  },

  fpagoInputValue(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return '0';
    return String(Math.round(n * 100) / 100);
  },

  docLabel(row) {
    return `${row?.CODDOC || ''} #${row?.CORRELATIVO ?? ''}`;
  },

  isVencido(row) {
    const v = String(row?.VENCIMIENTO || '').slice(0, 10);
    if (!v) return false;
    const today = new Date();
    const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    return v < t;
  },

  initCalMonth() {
    const d = new Date();
    if (this._calYear == null) {
      this._calYear = d.getFullYear();
      this._calMonth = d.getMonth();
    }
  },

  vencimientoIso(row) {
    const v = row?.VENCIMIENTO;
    if (!v) return null;
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  },

  aggregateVencimientosPorDia() {
    const map = new Map();
    for (const r of this.filteredRows()) {
      const key = this.vencimientoIso(r);
      if (!key) continue;
      const entry = map.get(key) || { count: 0, total: 0 };
      entry.count += 1;
      entry.total += Number(r.DOC_SALDO) || 0;
      map.set(key, entry);
    }
    return map;
  },

  rowsForVencimiento(isoDate) {
    return this.filteredRows().filter((r) => this.vencimientoIso(r) === isoDate);
  },

  renderCalDayTableHtml(rows) {
    if (!rows.length) {
      return '<p class="text-muted small text-center mb-0 py-3">Sin compras con vencimiento en esta fecha</p>';
    }
    const body = rows
      .map((r) => {
        const vencido = this.isVencido(r);
        return `<tr class="cxp-cal-day-row${vencido ? ' cxp-row-vencido' : ''}" data-coddoc="${this.escapeHtml(r.CODDOC)}" data-correlativo="${this.escapeHtml(r.CORRELATIVO)}" role="button" tabindex="0">
          <td class="fw-semibold text-nowrap">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</td>
          <td>${this.escapeHtml(r.DOC_NOMCLIE || r.NEGOCIO || '—')}</td>
          <td class="small">${this.escapeHtml(r.EMPLEADO || r.VENDEDOR || '—')}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
          <td class="text-end">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
          <td class="text-end fw-semibold text-primary">${this.escapeHtml(this.formatMoney(r.DOC_SALDO))}</td>
        </tr>`;
      })
      .join('');
    const totalSaldo = rows.reduce((s, r) => s + (Number(r.DOC_SALDO) || 0), 0);
    return `
      <div class="table-responsive cxp-cal-day-table" style="max-height: 360px">
        <table class="table table-sm table-hover table-striped mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>Documento</th>
              <th>Proveedor</th>
              <th>Empleado</th>
              <th>Fecha</th>
              <th class="text-end">Total</th>
              <th class="text-end">Doc.Saldo</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot class="table-light">
            <tr>
              <td colspan="5" class="text-end fw-semibold">${rows.length} documento(s)</td>
              <td class="text-end fw-bold text-primary">${this.escapeHtml(this.formatMoney(totalSaldo))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="small text-muted mt-2 mb-0 text-start">Clic en una fila para ver opciones del documento.</p>`;
  },

  async mostrarComprasDelDia(isoDate) {
    const rows = this.rowsForVencimiento(isoDate);
    if (!rows.length) return;
    await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: `Vencimientos — ${this.formatFecha(isoDate)}`,
      html: this.renderCalDayTableHtml(rows),
      width: 720,
      showConfirmButton: false,
      showCancelButton: true,
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cerrar'),
      didOpen: () => {
        const onRowPick = (row) => {
          const coddoc = row.getAttribute('data-coddoc');
          const correlativo = row.getAttribute('data-correlativo');
          if (!coddoc || !correlativo) return;
          Swal.close();
          this.onRowAction(coddoc, correlativo).catch((err) => F.toast(err.message || 'Error', 'error'));
        };
        Swal.getPopup()?.querySelectorAll('.cxp-cal-day-row').forEach((row) => {
          row.addEventListener('click', () => onRowPick(row));
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onRowPick(row);
            }
          });
        });
      },
    });
  },

  renderVistaToggleHtml() {
    const listaActive = this._vistaTipo === 'lista';
    const calActive = this._vistaTipo === 'calendario';
    const resumenActive = this._vistaTipo === 'resumen';
    const consActive = this._vistaTipo === 'consolidado-productos';
    return `
      <div class="cxp-vista-btns btn-group btn-group-sm" role="group" aria-label="Tipo de vista">
        <button type="button" class="btn ${listaActive ? 'btn-primary' : 'btn-outline-secondary'}" id="cxp-vista-lista"
          title="Lista de facturas">
          <i class="fa-solid fa-list me-1"></i>Lista
        </button>
        <button type="button" class="btn ${calActive ? 'btn-primary' : 'btn-outline-secondary'}" id="cxp-vista-calendario"
          title="Calendario de pagos">
          <i class="fa-solid fa-calendar-days me-1"></i>Calendario
        </button>
        <button type="button" class="btn ${resumenActive ? 'btn-primary' : 'btn-outline-secondary'}" id="cxp-vista-resumen"
          title="Resumen por proveedor">
          <i class="fa-solid fa-table-cells me-1"></i>Resumen
        </button>
        <button type="button" class="btn ${consActive ? 'btn-primary' : 'btn-outline-secondary'}" id="cxp-vista-consolidado"
          title="Consolidado de productos en compras con saldo">
          <i class="fa-solid fa-boxes-stacked me-1"></i>Consolidado productos
        </button>
      </div>`;
  },

  renderResumenHtml() {
    const rows = this._resumenRows || [];
    const totals = this._resumenTotales || {
      partes: rows.length,
      documentos: rows.reduce((s, r) => s + (Number(r.documentos) || 0), 0),
      abono: rows.reduce((s, r) => s + (Number(r.abono) || 0), 0),
      saldo: rows.reduce((s, r) => s + (Number(r.saldo) || 0), 0),
    };
    const body = rows.length
      ? rows
          .map((r) => {
            const codigo = Number(r.codigo) > 0 ? String(r.codigo) : '0';
            const codigoLabel = Number(r.codigo) > 0 ? String(r.codigo) : '—';
            return `
        <tr class="cxp-resumen-row" data-codigo="${this.escapeHtml(codigo)}"
          data-nit="${this.escapeHtml(r.nit || '')}" data-nombre-key="${this.escapeHtml(r.nombreKey || '')}"
          data-nombre="${this.escapeHtml(r.nombre || '')}" role="button" tabindex="0">
          <td class="text-nowrap">${this.escapeHtml(codigoLabel)}</td>
          <td>${this.escapeHtml(r.nombre)}</td>
          <td class="text-end">${r.documentos}</td>
          <td class="text-end text-success">${this.escapeHtml(this.formatMoney(r.abono))}</td>
          <td class="text-end fw-semibold text-primary">${this.escapeHtml(this.formatMoney(r.saldo))}</td>
        </tr>`;
          })
          .join('')
      : `<tr><td colspan="5" class="text-center text-muted py-4">Sin proveedores con saldo pendiente</td></tr>`;
    return `
        <div class="card shadow-sm">
          <div class="table-responsive">
            <table class="table table-sm table-hover table-striped mb-0 cxp-table">
              <thead class="table-light sticky-top">
                <tr>
                  <th>Cód. proveedor</th>
                  <th>Proveedor</th>
                  <th class="text-end">Documentos</th>
                  <th class="text-end">Pagos</th>
                  <th class="text-end">Saldo total</th>
                </tr>
              </thead>
              <tbody>${body}</tbody>
              <tfoot class="table-light fw-semibold">
                <tr>
                  <td colspan="2" class="text-end">${totals.partes || rows.length} proveedor(es)</td>
                  <td class="text-end">${totals.documentos || 0}</td>
                  <td class="text-end text-success">${this.escapeHtml(this.formatMoney(totals.abono))}</td>
                  <td class="text-end text-primary">${this.escapeHtml(this.formatMoney(totals.saldo))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <p class="small text-muted mt-2 mb-0">Clic en un proveedor para ver sus documentos con saldo y pago pendientes.</p>`;
  },

  renderResumenDocsTableHtml(rows) {
    if (!rows.length) {
      return '<p class="text-muted small text-center mb-0 py-3">Sin documentos pendientes</p>';
    }
    const body = rows
      .map((r) => {
        const vencido = this.isVencido(r);
        const saldo = Number(r.SALDO_PENDIENTE ?? r.DOC_SALDO) || 0;
        const abono = Number(r.DOC_ABONO) || 0;
        const parte = r.DOC_NOMCLIE || r.NEGOCIO || '—';
        return `<tr class="cxp-cal-day-row${vencido ? ' cxp-row-vencido' : ''}" data-coddoc="${this.escapeHtml(r.CODDOC)}" data-correlativo="${this.escapeHtml(r.CORRELATIVO)}" role="button" tabindex="0">
          <td class="fw-semibold text-nowrap">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</td>
          <td>${this.escapeHtml(parte)}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
          <td class="text-nowrap${vencido ? ' text-danger fw-semibold' : ''}">${this.escapeHtml(this.formatFecha(r.VENCIMIENTO))}</td>
          <td class="text-end">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
          <td class="text-end text-success">${this.escapeHtml(this.formatMoney(abono))}</td>
          <td class="text-end fw-semibold text-primary">${this.escapeHtml(this.formatMoney(saldo))}</td>
        </tr>`;
      })
      .join('');
    const totalAbono = rows.reduce((s, r) => s + (Number(r.DOC_ABONO) || 0), 0);
    const totalSaldo = rows.reduce((s, r) => s + (Number(r.SALDO_PENDIENTE ?? r.DOC_SALDO) || 0), 0);
    return `
      <div class="table-responsive" style="max-height: 420px">
        <table class="table table-sm table-hover table-striped mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>Documento</th>
              <th>Proveedor</th>
              <th>Fecha</th>
              <th>Vence</th>
              <th class="text-end">Total</th>
              <th class="text-end">Pago</th>
              <th class="text-end">Saldo pendiente</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot class="table-light">
            <tr>
              <td colspan="5" class="text-end fw-semibold">${rows.length} documento(s)</td>
              <td class="text-end fw-semibold text-success">${this.escapeHtml(this.formatMoney(totalAbono))}</td>
              <td class="text-end fw-bold text-primary">${this.escapeHtml(this.formatMoney(totalSaldo))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="small text-muted mt-2 mb-0 text-start">Clic en un documento para ver opciones.</p>
      <div class="d-flex flex-wrap gap-2 mt-3">
        <button type="button" class="btn btn-outline-secondary" id="cxp-resumen-print">
          <i class="fa-solid fa-print me-1"></i>Imprimir
        </button>
        <button type="button" class="btn btn-outline-success" id="cxp-resumen-whatsapp">
          <i class="fa-brands fa-whatsapp me-1"></i>WhatsApp
        </button>
      </div>`;
  },

  bindModalDocRows(onPick) {
    Swal.getPopup()?.querySelectorAll('.cxp-cal-day-row').forEach((row) => {
      row.addEventListener('click', () => onPick(row));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(row);
        }
      });
    });
  },

  resumenPendientesTotales(rows) {
    return (rows || []).reduce(
      (acc, r) => {
        acc.importe += Number(r.TOTALPRECIO) || 0;
        acc.abono += Number(r.DOC_ABONO) || 0;
        acc.saldo += Number(r.SALDO_PENDIENTE ?? r.DOC_SALDO) || 0;
        return acc;
      },
      { importe: 0, abono: 0, saldo: 0 }
    );
  },

  docResumenLabel(r) {
    return `${String(r.CODDOC || '').trim()} - ${String(r.CORRELATIVO ?? '').trim()}`;
  },

  bindResumenPendientesActions(ctx) {
    const popup = Swal.getPopup();
    popup?.querySelector('#cxp-resumen-print')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.imprimirResumenPendientes(ctx).catch((err) =>
        F.toast(err.message || 'No se pudo imprimir', 'error')
      );
    });
    popup?.querySelector('#cxp-resumen-whatsapp')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.enviarWhatsappResumenPendientes(ctx).catch((err) =>
        F.toast(err.message || 'No se pudo abrir WhatsApp', 'error')
      );
    });
  },

  buildResumenPendientesWhatsappText(ctx) {
    const { partyKind, partyName, codigoLabel, rows } = ctx;
    const t = this.resumenPendientesTotales(rows);
    const abonoLabel = partyKind === 'proveedor' ? 'Pagos' : 'Abonos';
    const parts = [];
    parts.push(`*Facturas pendientes*`);
    parts.push(`${partyKind === 'proveedor' ? 'Proveedor' : 'Cliente'}: ${partyName || '—'}`);
    parts.push(`Código: ${codigoLabel}`);
    parts.push('');
    (rows || []).forEach((r) => {
      const saldo = Number(r.SALDO_PENDIENTE ?? r.DOC_SALDO) || 0;
      parts.push(this.docResumenLabel(r));
      parts.push(`Importe: ${this.formatMoney(r.TOTALPRECIO)}`);
      parts.push(`${abonoLabel}: ${this.formatMoney(r.DOC_ABONO)}`);
      parts.push(`Saldo: ${this.formatMoney(saldo)}`);
      parts.push('');
    });
    parts.push(`*Total importe: ${this.formatMoney(t.importe)}*`);
    parts.push(`*Total ${abonoLabel.toLowerCase()}: ${this.formatMoney(t.abono)}*`);
    parts.push(`*Total saldo: ${this.formatMoney(t.saldo)}*`);
    return parts.join('\n');
  },

  async imprimirResumenPendientes(ctx) {
    if (typeof PrintReport === 'undefined') {
      F.toast('Impresión no disponible', 'warning');
      return;
    }
    const { partyKind, partyName, codigoLabel, rows } = ctx;
    const t = this.resumenPendientesTotales(rows);
    const abonoLabel = partyKind === 'proveedor' ? 'Pagos' : 'Abonos';
    const partyTitle = partyKind === 'proveedor' ? 'Proveedor' : 'Cliente';
    const nit = String(rows?.[0]?.DOC_NIT || '').trim();
    const hoy = this.formatFecha(this.todayIsoDate());
    const bodyRows = (rows || []).length
      ? rows
          .map((r) => {
            const saldo = Number(r.SALDO_PENDIENTE ?? r.DOC_SALDO) || 0;
            return `<tr>
              <td>${PrintReport.escapeHtml(this.docResumenLabel(r))}</td>
              <td>${PrintReport.escapeHtml(this.formatFecha(r.FECHA))}</td>
              <td>${PrintReport.escapeHtml(this.formatFecha(r.VENCIMIENTO))}</td>
              <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
              <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(r.DOC_ABONO))}</td>
              <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(saldo))}</td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="6" style="text-align:center;color:#666">Sin documentos pendientes</td></tr>';

    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({
        title: 'Facturas pendientes',
        subtitleHtml: `
          <p><strong>${partyTitle}:</strong> ${PrintReport.escapeHtml(partyName || '—')}</p>
          <p><strong>Código:</strong> ${PrintReport.escapeHtml(String(codigoLabel || '—'))}</p>
          ${nit ? `<p><strong>NIT:</strong> ${PrintReport.escapeHtml(nit)}</p>` : ''}
          <p><strong>Fecha:</strong> ${PrintReport.escapeHtml(hoy)}</p>
        `,
      })}
      <table class="ecc-table">
        <thead>
          <tr>
            <th>Documento</th>
            <th>Fecha</th>
            <th>Vence</th>
            <th class="text-end">Importe</th>
            <th class="text-end">${PrintReport.escapeHtml(abonoLabel)}</th>
            <th class="text-end">Saldo</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
        <tfoot>
          <tr class="totals">
            <td colspan="3" class="text-end"><strong>${(rows || []).length} documento(s)</strong></td>
            <td class="text-end"><strong>${PrintReport.escapeHtml(this.formatMoney(t.importe))}</strong></td>
            <td class="text-end"><strong>${PrintReport.escapeHtml(this.formatMoney(t.abono))}</strong></td>
            <td class="text-end"><strong>${PrintReport.escapeHtml(this.formatMoney(t.saldo))}</strong></td>
          </tr>
        </tfoot>
      </table>
    `;

    await PrintReport.openAndPrint(
      () =>
        PrintReport.wrapDocument({
          title: 'Facturas pendientes',
          bodyHtml,
          extraStyles: `
        .ecc-table{font-size:11px}
        .ecc-table th,.ecc-table td{padding:5px 7px}
        .ecc-table tbody tr:nth-child(even){background:#fafafa}
        .ecc-table tfoot td{background:#f0f0f0;border-top:2px solid #999}
      `,
        }),
      'width=900,height=700'
    );
  },

  async enviarWhatsappResumenPendientes(ctx) {
    if (!ctx.rows?.length) {
      F.toast('No hay documentos para enviar', 'warning');
      return;
    }
    if (typeof DocOpciones === 'undefined') {
      F.toast('WhatsApp no disponible', 'warning');
      return;
    }
    const text = this.buildResumenPendientesWhatsappText(ctx);
    await DocOpciones.enviarWhatsappTexto(text);
  },

  async mostrarDocsDeProveedor(codigo, { nit = '', nombreKey = '', nombre = '' } = {}) {
    Swal.fire({
      ...CatalogosUI.modalBase(),
      title: nombre || `Proveedor ${codigo}`,
      html: '<p class="text-muted mb-0"><i class="fa-solid fa-spinner fa-spin me-1"></i>Cargando documentos…</p>',
      showConfirmButton: false,
      showCancelButton: false,
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });
    try {
      const data = await F.fetchJson(this.documentosProveedorUrl({ codigo, nit, nombre: nombreKey }), {
        cache: 'no-store',
      });
      const rows = data.rows || [];
      const titulo = nombre || rows[0]?.DOC_NOMCLIE || rows[0]?.NEGOCIO || `Proveedor ${codigo}`;
      const codigoLabel = Number(codigo) > 0 ? String(codigo) : 'sin código';
      await Swal.fire({
        ...CatalogosUI.modalBase(),
        title: `${titulo}`,
        html: `<p class="small text-muted text-start mb-2">Cód. ${this.escapeHtml(codigoLabel)} · documentos con saldo pendiente</p>${this.renderResumenDocsTableHtml(rows)}`,
        width: 960,
        showConfirmButton: false,
        showCancelButton: true,
        cancelButtonText: CatalogosUI.cancelButtonHtml('Cerrar'),
        didOpen: () => {
          const ctx = {
            partyKind: 'proveedor',
            partyName: titulo,
            codigoLabel,
            rows,
          };
          this.bindModalDocRows((row) => {
            const coddoc = row.getAttribute('data-coddoc');
            const correlativo = row.getAttribute('data-correlativo');
            if (!coddoc || !correlativo) return;
            Swal.close();
            this.onRowAction(coddoc, correlativo).catch((err) => F.toast(err.message || 'Error', 'error'));
          });
          this.bindResumenPendientesActions(ctx);
        },
      });
    } catch (err) {
      Swal.close();
      F.toast(err.message || 'No se pudieron cargar los documentos', 'error');
    }
  },

  monthLabel(year, month) {
    const names = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
    ];
    return `${names[month]} ${year}`;
  },

  renderCalendarHtml() {
    this.initCalMonth();
    const year = this._calYear;
    const month = this._calMonth;
    const byDay = this.aggregateVencimientosPorDia();
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let startWeekday = firstDay.getDay();
    startWeekday = startWeekday === 0 ? 6 : startWeekday - 1;
    const weekDays = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const today = this.todayIsoDate();
    let cells = '';

    for (let i = 0; i < startWeekday; i += 1) {
      cells += '<div class="cxp-cal-cell cxp-cal-cell--muted"></div>';
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const data = byDay.get(iso);
      const hasDue = Boolean(data?.count);
      const isToday = iso === today;
      const vencido = hasDue && iso < today;
      const cls = [
        'cxp-cal-cell',
        isToday ? 'cxp-cal-cell--today' : '',
        hasDue ? 'cxp-cal-cell--due cxp-cal-cell--clickable' : '',
        vencido ? 'cxp-cal-cell--overdue' : '',
      ].filter(Boolean).join(' ');
      cells += `
        <div class="${cls}" data-cal-date="${iso}"${hasDue ? ' role="button" tabindex="0"' : ''}>
          <div class="cxp-cal-day">${day}</div>
          ${hasDue ? `
            <div class="cxp-cal-meta">
              <span class="cxp-cal-count">${data.count} doc.</span>
              <span class="cxp-cal-amount">${this.escapeHtml(this.formatMoney(data.total))}</span>
            </div>` : ''}
        </div>`;
    }

    const totalCells = startWeekday + daysInMonth;
    const trailing = (7 - (totalCells % 7)) % 7;
    for (let i = 0; i < trailing; i += 1) {
      cells += '<div class="cxp-cal-cell cxp-cal-cell--muted"></div>';
    }

    return `
      <div class="cxp-cal-wrap card shadow-sm">
        <div class="card-body">
          <div class="cxp-cal-toolbar d-flex align-items-center justify-content-between gap-2 mb-3">
            <button type="button" class="btn btn-sm btn-outline-secondary" id="cxp-cal-prev" title="Mes anterior">
              <i class="fa-solid fa-chevron-left"></i>
            </button>
            <h3 class="h6 mb-0 fw-semibold text-center flex-grow-1">${this.escapeHtml(this.monthLabel(year, month))}</h3>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="cxp-cal-next" title="Mes siguiente">
              <i class="fa-solid fa-chevron-right"></i>
            </button>
          </div>
          <div class="cxp-cal-grid">
            ${weekDays.map((d) => `<div class="cxp-cal-weekday">${d}</div>`).join('')}
            ${cells}
          </div>
          <p class="small text-muted mt-3 mb-0">
            Días marcados tienen documentos de compra con vencimiento y saldo pendiente. Clic en un día para ver el detalle.
          </p>
        </div>
      </div>`;
  },

  renderListaHtml() {
    return `
        <div class="card shadow-sm">
          <div class="table-responsive">
            <table class="table table-sm table-hover table-striped mb-0 cxp-table">
              <thead class="table-light sticky-top">
                <tr>
                  <th>Empleado</th>
                  <th>Fecha</th>
                  <th>Vence</th>
                  <th>Documento</th>
                  <th>Proveedor</th>
                  <th>Empresa</th>
                  <th class="text-end">Total</th>
                  <th class="text-end">Pagos</th>
                  <th class="text-end">Doc.Saldo</th>
                </tr>
              </thead>
              <tbody id="cxp-tbody">${this.renderTableBodyHtml()}</tbody>
              <tfoot class="table-light">
                <tr>
                  <td colspan="8" class="text-end fw-semibold">Doc. saldo (listado)</td>
                  <td class="text-end fw-bold text-primary">${this.escapeHtml(this.formatMoney(this._sumSaldo))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <p class="small text-muted mt-2 mb-0">Clic en una fila para ver opciones del documento.</p>`;
  },

  filteredRows() {
    return this._rows;
  },

  async fetchDocumentos() {
    const params = { _: String(Date.now()) };
    const q = this._filterQuery.trim();
    if (q) params.q = q;
    const data = await F.fetchJson(this.apiUrl(params), { cache: 'no-store' });
    this._rows = data.rows || [];
    this._total = Number(data.total) || this._rows.length;
    this._sumSaldo = Number(data.sumSaldo) || 0;
    this._sumTotal = Number(data.sumTotal) || 0;
    this._truncated = Boolean(data.truncated);
    return this._rows;
  },

  async refreshVistaData() {
    await this.fetchDocumentos();
    if (this._vistaTipo === 'resumen') await this.fetchResumenProveedores();
    if (this._vistaTipo === 'consolidado-productos') await this.fetchConsolidadoProductos();
  },

  consolidadoProductosUrl() {
    const emp = F.getEmpNit();
    const params = new URLSearchParams({
      empnit: emp,
      _: String(Date.now()),
    });
    return `/api/cuentas-pagar/consolidado-productos?${params}`;
  },

  async fetchConsolidadoProductos() {
    const data = await F.fetchJson(this.consolidadoProductosUrl(), { cache: 'no-store' });
    this._consolidadoRows = data.rows || [];
    this._consolidadoTotales = data.totales || null;
    return this._consolidadoRows;
  },

  consolidadoProductoDetalleUrl(codprod) {
    const emp = F.getEmpNit();
    const params = new URLSearchParams({
      empnit: emp,
      codprod: String(codprod ?? ''),
      _: String(Date.now()),
    });
    return `/api/cuentas-pagar/consolidado-productos/detalle?${params}`;
  },

  resumenProveedoresUrl() {
    const emp = F.getEmpNit();
    const params = new URLSearchParams({
      empnit: emp,
      _: String(Date.now()),
    });
    const q = this._filterQuery.trim();
    if (q) params.set('q', q);
    return `/api/cuentas-pagar/resumen-proveedores?${params}`;
  },

  async fetchResumenProveedores() {
    const data = await F.fetchJson(this.resumenProveedoresUrl(), { cache: 'no-store' });
    this._resumenRows = data.rows || [];
    this._resumenTotales = data.totales || null;
    return this._resumenRows;
  },

  documentosProveedorUrl({ codigo, nit, nombre }) {
    const params = {
      _: String(Date.now()),
      limit: '10000',
      codprov: String(codigo ?? 0),
    };
    if (!(Number(codigo) > 0)) {
      params.nit = nit || '';
      params.nombre = nombre || '';
    }
    const q = this._filterQuery.trim();
    if (q) params.q = q;
    return this.apiUrl(params);
  },

  async corregirSaldos() {
    if (this._corregiendoSaldos) return;
    const ok = await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Corregir saldos',
      html: `
        <p class="small text-muted mb-0 text-start">
          Se recalcularán <strong>abonos</strong> y <strong>saldo</strong> de todas las compras al crédito,
          sumando los pagos a proveedor (RCP) y devoluciones (DVP) asociados a cada compra.
        </p>
      `,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: CatalogosUI.guardarButtonHtml('Corregir'),
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
    });
    if (!ok.isConfirmed) return;

    this._corregiendoSaldos = true;
    const btn = this._container?.querySelector('#cxp-btn-corregir-saldos');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>Corrigiendo…';
    }
    try {
      const emp = F.getEmpNit();
      const data = await F.fetchJson(`/api/cuentas-pagar/corregir-saldos?empnit=${encodeURIComponent(emp)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      F.toast(
        `Saldos corregidos: ${data.actualizadas ?? 0} de ${data.totalCompras ?? 0} compra(s)`,
        'success'
      );
      await this.refreshVistaData();
      this._container.innerHTML = this.renderShell();
      this.bindEvents();
    } catch (err) {
      F.toast(err.message || 'No se pudieron corregir los saldos', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-arrows-rotate me-1"></i>Corregir saldos';
      }
    } finally {
      this._corregiendoSaldos = false;
    }
  },

  renderTableBodyHtml() {
    const rows = this.filteredRows();
    if (!rows.length) {
      return `<tr><td colspan="9" class="text-center text-muted py-4">No hay compras al crédito con saldo pendiente</td></tr>`;
    }
    return rows
      .map((r) => {
        const vencido = this.isVencido(r);
        const rowCls = vencido ? 'cxp-row-vencido' : '';
        return `<tr class="cxp-row ${rowCls}" data-coddoc="${this.escapeHtml(r.CODDOC)}" data-correlativo="${this.escapeHtml(r.CORRELATIVO)}" role="button" tabindex="0">
          <td class="small">${this.escapeHtml(r.EMPLEADO || r.VENDEDOR || '—')}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
          <td class="text-nowrap${vencido ? ' text-danger fw-semibold' : ''}">${this.escapeHtml(this.formatFecha(r.VENCIMIENTO))}</td>
          <td class="fw-semibold text-nowrap">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</td>
          <td>${this.escapeHtml(r.DOC_NOMCLIE || r.NEGOCIO || '—')}</td>
          <td class="small text-muted">${this.escapeHtml(r.NEGOCIO || '—')}</td>
          <td class="text-end">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
          <td class="text-end text-success">${this.escapeHtml(this.formatMoney(r.DOC_ABONO))}</td>
          <td class="text-end fw-semibold text-primary">${this.escapeHtml(this.formatMoney(r.DOC_SALDO))}</td>
        </tr>`;
      })
      .join('');
  },

  renderShell() {
    const count = this.filteredRows().length;
    const truncHint = this._truncated
      ? `<p class="small text-warning mb-0 mt-1"><i class="fa-solid fa-triangle-exclamation me-1"></i>Mostrando ${count} de ${this._total} documento(s). Refine la búsqueda para ver más.</p>`
      : '';
    const showListaTools =
      this._vistaTipo === 'lista' || this._vistaTipo === 'calendario' || this._vistaTipo === 'resumen';
    let contentHtml = this.renderListaHtml();
    if (this._vistaTipo === 'calendario') contentHtml = this.renderCalendarHtml();
    if (this._vistaTipo === 'resumen') contentHtml = this.renderResumenHtml();
    if (this._vistaTipo === 'consolidado-productos') contentHtml = this.renderConsolidadoProductosHtml();

    return `
      <div class="cxp-wrap w-100">
        <div class="d-flex flex-wrap align-items-end justify-content-between gap-2 mb-3">
          <div>
            <h2 class="h5 mb-1"><i class="fa-solid fa-file-invoice me-2 text-primary"></i>Cuentas por pagar</h2>
            <p class="text-muted small mb-0">Compras al crédito (CONCRE = CRE) con saldo pendiente</p>
          </div>
          <div class="cxp-summary card border-0 shadow-sm">
            <div class="card-body py-2 px-3 d-flex flex-wrap gap-3 align-items-center">
              ${this.renderVistaToggleHtml()}
              <div class="small">
                <span class="text-muted">Documentos:</span>
                <strong class="ms-1">${count}</strong>
              </div>
              <div class="small">
                <span class="text-muted">Doc. saldo total:</span>
                <strong class="ms-1 text-primary">${this.escapeHtml(this.formatMoney(this._sumSaldo))}</strong>
              </div>
            </div>
          </div>
        </div>
        ${
          showListaTools
            ? `
        <div class="card shadow-sm mb-3">
          <div class="card-body py-2">
            <div class="d-flex flex-wrap align-items-center gap-2">
              <div class="input-group input-group-sm flex-grow-1" style="min-width: 12rem;">
                <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
                <input type="search" class="form-control" id="cxp-search"
                  placeholder="Buscar documento, proveedor, empleado, NIT… (Enter)"
                  value="${this.escapeHtml(this._filterQuery)}" autocomplete="off">
                <div></div>
                <button type="button" class="btn btn-sm btn-outline-warning text-nowrap" id="cxp-btn-corregir-saldos"
                  title="Recalcular saldos y abonos de compras al crédito">
                  <i class="fa-solid fa-arrows-rotate me-1"></i>Corregir saldos
                </button>
              </div>
              
            </div>
            ${truncHint}
          </div>
        </div>`
            : ''
        }
        ${contentHtml}
      </div>`;
  },

  renderConsolidadoProductosHtml() {
    const totals = this._consolidadoTotales || {
      productos: 0,
      totalUnidades: 0,
      totalPrecio: 0,
    };
    const body =
      this._consolidadoRows.length === 0
        ? `<tr><td colspan="4" class="text-center text-muted py-4">Sin productos en compras con saldo</td></tr>`
        : this._consolidadoRows
            .map(
              (r) => `
        <tr class="cxp-prod-row" data-codprod="${this.escapeHtml(r.CODPROD || '')}" data-desprod="${this.escapeHtml(r.DESPROD || '')}" role="button" tabindex="0">
          <td class="fw-semibold text-nowrap">${this.escapeHtml(r.CODPROD || '—')}</td>
          <td>${this.escapeHtml(r.DESPROD || '—')}</td>
          <td class="text-end">${this.escapeHtml(this.formatQty(r.TOTALUNIDADES))}</td>
          <td class="text-end fw-semibold text-primary">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
        </tr>`
            )
            .join('');
    return `
      <div class="card shadow-sm">
        <div class="card-header bg-white py-2 d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div>
            <span class="fw-semibold"><i class="fa-solid fa-boxes-stacked me-1 text-primary"></i>Consolidado productos</span>
            <span class="small text-muted ms-1">Agrupado por código en compras con saldo pendiente</span>
          </div>
          <div class="d-flex flex-wrap gap-3 small">
            <span><span class="text-muted">Productos:</span> <strong>${totals.productos || 0}</strong></span>
            <span><span class="text-muted">Unidades:</span> <strong>${this.escapeHtml(this.formatQty(totals.totalUnidades))}</strong></span>
            <span><span class="text-muted">Total:</span> <strong class="text-primary">${this.escapeHtml(this.formatMoney(totals.totalPrecio))}</strong></span>
          </div>
        </div>
        <div class="table-responsive" style="max-height: min(70vh, 36rem);">
          <table class="table table-sm table-hover table-striped align-middle mb-0 cxp-table">
            <thead class="table-light sticky-top">
              <tr>
                <th>Código</th>
                <th>Producto</th>
                <th class="text-end">Total unidades</th>
                <th class="text-end">Total precio</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
            <tfoot class="table-light">
              <tr>
                <th colspan="2" class="text-end">${totals.productos || 0} producto(s)</th>
                <th class="text-end">${this.escapeHtml(this.formatQty(totals.totalUnidades))}</th>
                <th class="text-end text-primary">${this.escapeHtml(this.formatMoney(totals.totalPrecio))}</th>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <p class="small text-muted mt-2 mb-0">Clic en un producto para ver las compras al crédito que lo contienen.</p>`;
  },

  renderProductoDocsTableHtml(rows) {
    if (!rows.length) {
      return '<p class="text-muted small text-center mb-0 py-3">Sin compras al crédito con este producto</p>';
    }
    const body = rows
      .map((r) => {
        const parte = r.DOC_NOMCLIE || '—';
        return `<tr class="cxp-cal-day-row" data-coddoc="${this.escapeHtml(r.CODDOC)}" data-correlativo="${this.escapeHtml(r.CORRELATIVO)}" role="button" tabindex="0">
          <td class="fw-semibold text-nowrap">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
          <td>${this.escapeHtml(parte)}</td>
          <td class="text-nowrap">${this.escapeHtml(r.CODMEDIDA || '—')}</td>
          <td class="text-end">${this.escapeHtml(this.formatQty(r.CANTIDAD))}</td>
          <td class="text-end">${this.escapeHtml(this.formatMoney(r.PRECIO))}</td>
          <td class="text-end fw-semibold text-primary">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
        </tr>`;
      })
      .join('');
    const totalPrecio = rows.reduce((s, r) => s + (Number(r.TOTALPRECIO) || 0), 0);
    return `
      <div class="table-responsive" style="max-height: 420px">
        <table class="table table-sm table-hover table-striped mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>Factura</th>
              <th>Fecha</th>
              <th>Proveedor</th>
              <th>Medida</th>
              <th class="text-end">Cantidad</th>
              <th class="text-end">Precio</th>
              <th class="text-end">Total precio</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot class="table-light">
            <tr>
              <td colspan="6" class="text-end fw-semibold">${rows.length} línea(s)</td>
              <td class="text-end fw-bold text-primary">${this.escapeHtml(this.formatMoney(totalPrecio))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="small text-muted mt-2 mb-0 text-start">Clic en una fila para ver opciones del documento.</p>`;
  },

  async mostrarDocsDeProducto(codprod, desprod) {
    Swal.fire({
      ...CatalogosUI.modalBase(),
      title: desprod || codprod || 'Producto',
      html: '<p class="text-muted mb-0"><i class="fa-solid fa-spinner fa-spin me-1"></i>Cargando compras…</p>',
      showConfirmButton: false,
      showCancelButton: false,
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading(),
    });
    try {
      const data = await F.fetchJson(this.consolidadoProductoDetalleUrl(codprod), { cache: 'no-store' });
      const rows = data.rows || [];
      const titulo = desprod || data.CODPROD || 'Producto';
      await Swal.fire({
        ...CatalogosUI.modalBase(),
        title: titulo,
        html: `<p class="small text-muted text-start mb-2">Cód. ${this.escapeHtml(String(codprod || '—'))} · compras al crédito con saldo</p>${this.renderProductoDocsTableHtml(rows)}`,
        width: 980,
        showConfirmButton: false,
        showCancelButton: true,
        cancelButtonText: CatalogosUI.cancelButtonHtml('Cerrar'),
        didOpen: () => {
          this.bindModalDocRows((row) => {
            const coddoc = row.getAttribute('data-coddoc');
            const correlativo = row.getAttribute('data-correlativo');
            if (!coddoc || !correlativo) return;
            Swal.close();
            this.onRowAction(coddoc, correlativo).catch((err) => F.toast(err.message || 'Error', 'error'));
          });
        },
      });
    } catch (err) {
      Swal.close();
      F.toast(err.message || 'No se pudieron cargar las compras del producto', 'error');
    }
  },

  renderMenuOpcionesHtml() {
    return `
      <div class="cxp-menu-grid">
        ${this.MENU_OPCIONES.map(
          (opt) => `
          <button type="button" class="btn cxp-menu-btn ${opt.className}" data-cxp-action="${opt.action}">
            <i class="${opt.icon}"></i>
            <span>${this.escapeHtml(opt.label)}</span>
          </button>`
        ).join('')}
      </div>`;
  },

  renderFpagoCardHtml(saldoMax, prefix = 'cxp-abono-fpago') {
    return `
      <div class="card fac-finalizar-fpago-card mt-2" id="${prefix}-card">
        <div class="card-header py-2 px-3 small fw-semibold bg-light border-0">
          <i class="fa-solid fa-wallet me-1 text-primary"></i>Formas de pago
        </div>
        <div class="card-body py-2 px-3">
          <p class="small text-muted mb-2">El monto del pago es la suma de las formas de pago (máx. ${this.escapeHtml(this.formatMoney(saldoMax))}).</p>
          <div class="row g-2">
            <div class="col-6">
              <label class="form-label small mb-0" for="${prefix}-efectivo">Efectivo</label>
              <input type="number" id="${prefix}-efectivo" class="form-control form-control-sm cxp-fpago-input" min="0" step="0.01" value="0">
            </div>
            <div class="col-6">
              <label class="form-label small mb-0" for="${prefix}-tarjeta">Tarjeta</label>
              <input type="number" id="${prefix}-tarjeta" class="form-control form-control-sm cxp-fpago-input" min="0" step="0.01" value="0">
            </div>
            <div class="col-6">
              <label class="form-label small mb-0" for="${prefix}-deposito">Depósito</label>
              <input type="number" id="${prefix}-deposito" class="form-control form-control-sm cxp-fpago-input" min="0" step="0.01" value="0">
            </div>
            <div class="col-6">
              <label class="form-label small mb-0" for="${prefix}-cheque">Cheque</label>
              <input type="number" id="${prefix}-cheque" class="form-control form-control-sm cxp-fpago-input" min="0" step="0.01" value="0">
            </div>
          </div>
          <div class="mt-2 small text-end fw-semibold text-primary" id="${prefix}-sum">Monto pago: ${this.escapeHtml(this.formatMoney(0))}</div>
          <div class="mt-2 mb-0">
            <label class="form-label small mb-0" for="${prefix}-desc">Detalles del pago</label>
            <input type="text" id="${prefix}-desc" class="form-control form-control-sm" placeholder="No. boleta, cheque o tarjeta (opcional)" maxlength="200">
          </div>
        </div>
      </div>`;
  },

  sumFpagoInputs(prefix = 'cxp-abono-fpago') {
    const ids = [`${prefix}-efectivo`, `${prefix}-tarjeta`, `${prefix}-deposito`, `${prefix}-cheque`];
    return ids.reduce((acc, id) => acc + (Number(document.getElementById(id)?.value ?? 0) || 0), 0);
  },

  bindFpagoRefresh(saldoMax, prefix = 'cxp-abono-fpago') {
    const sumEl = document.getElementById(`${prefix}-sum`);
    const refresh = () => {
      if (!sumEl) return;
      const sum = this.sumFpagoInputs(prefix);
      sumEl.textContent = `Monto pago: ${this.formatMoney(sum)}`;
      if (this.abonoSuperaSaldo(sum, saldoMax)) {
        sumEl.classList.add('text-danger');
        sumEl.classList.remove('text-primary');
      } else {
        sumEl.classList.remove('text-danger');
        sumEl.classList.add('text-primary');
      }
    };
    [`${prefix}-efectivo`, `${prefix}-tarjeta`, `${prefix}-deposito`, `${prefix}-cheque`].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', refresh);
    });
    refresh();
  },

  readFpagoFromDom(prefix = 'cxp-abono-fpago') {
    return {
      FPAGO_EFECTIVO: Number(document.getElementById(`${prefix}-efectivo`)?.value ?? 0),
      FPAGO_TARJETA: Number(document.getElementById(`${prefix}-tarjeta`)?.value ?? 0),
      FPAGO_DEPOSITO: Number(document.getElementById(`${prefix}-deposito`)?.value ?? 0),
      FPAGO_CHEQUE: Number(document.getElementById(`${prefix}-cheque`)?.value ?? 0),
      FPAGO_DESCRIPCION: document.getElementById(`${prefix}-desc`)?.value?.trim() || '',
    };
  },

  renderPagosTableHtml(pagos) {
    if (!pagos?.length) {
      return '<p class="text-muted small text-center mb-0 py-3">Sin pagos ni notas de crédito registrados</p>';
    }
    const rows = pagos
      .map((a) => {
        const tipo = String(a.TIPODOC || '').trim();
        const tipoCls =
          tipo === 'RCP' ? 'bg-success' : tipo === 'DVP' ? 'bg-warning text-dark' : 'bg-secondary';
        const docLabel = a.DESDOC
          ? `${a.CODDOC} — ${a.DESDOC} #${a.CORRELATIVO}`
          : `${a.CODDOC} #${a.CORRELATIVO}`;
        return `<tr>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(a.FECHA))}</td>
          <td><span class="badge ${tipoCls}">${this.escapeHtml(tipo || '—')}</span></td>
          <td class="fw-semibold">${this.escapeHtml(docLabel)}</td>
          <td class="text-end fw-semibold text-success">${this.escapeHtml(this.formatMoney(a.TOTALPRECIO))}</td>
          <td class="small">${this.escapeHtml(a.USUARIO || '—')}</td>
        </tr>`;
      })
      .join('');
    return `
      <div class="table-responsive cxp-historial-table" style="max-height: 360px">
        <table class="table table-sm table-striped mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Documento</th>
              <th class="text-end">Monto</th>
              <th>Usuario</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  findRow(coddoc, correlativo) {
    return this._rows.find(
      (r) => String(r.CODDOC) === String(coddoc) && String(r.CORRELATIVO) === String(correlativo),
    );
  },

  async fetchCompraDetalle(coddoc, correlativo) {
    return F.fetchJson(`${this.compraUrl(coddoc, correlativo)}&_=${Date.now()}`, { cache: 'no-store' });
  },

  estadoCuentaUrl(codprov) {
    const emp = F.getEmpNit();
    return `/api/cuentas-pagar/proveedores/${encodeURIComponent(codprov)}/estado-cuenta?empnit=${encodeURIComponent(emp)}`;
  },

  async fetchEstadoCuentaProveedor(codprov) {
    return F.fetchJson(`${this.estadoCuentaUrl(codprov)}&_=${Date.now()}`, { cache: 'no-store' });
  },

  async resolveCodprov(row) {
    if (row?.CODPROV != null && row.CODPROV !== '') {
      return Number(row.CODPROV);
    }
    const det = await this.fetchCompraDetalle(row.CODDOC, row.CORRELATIVO);
    const cod = det?.compra?.CODPROV ?? det?.compra?.CODCLIENTE;
    return cod != null ? Number(cod) : null;
  },

  renderEstadoCuentaPagosTableHtml(pagos) {
    if (!pagos?.length) {
      return '<p class="text-muted small text-center mb-0 py-2">Sin pagos ni notas de crédito</p>';
    }
    const rows = pagos
      .map((a) => {
        const tipo = String(a.TIPODOC || '').trim();
        const tipoCls =
          tipo === 'RCP' ? 'bg-success' : tipo === 'DVP' ? 'bg-warning text-dark' : 'bg-secondary';
        return `<tr>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(a.FECHA))}</td>
          <td><span class="badge ${tipoCls}">${this.escapeHtml(tipo || '—')}</span></td>
          <td class="fw-semibold text-nowrap">${this.escapeHtml(a.CODDOC)} #${this.escapeHtml(a.CORRELATIVO)}</td>
          <td class="small text-muted">${this.escapeHtml(a.COMPRA_REF || '—')}</td>
          <td class="text-end fw-semibold text-success">${this.escapeHtml(this.formatMoney(a.TOTALPRECIO))}</td>
          <td class="small">${this.escapeHtml(a.USUARIO || '—')}</td>
        </tr>`;
      })
      .join('');
    return `
      <div class="table-responsive" style="max-height: 280px">
        <table class="table table-sm table-striped mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Documento</th>
              <th>Compra ref.</th>
              <th class="text-end">Monto</th>
              <th>Usuario</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  renderEstadoCuentaMovimientosTableHtml(movimientos, totales = {}) {
    if (!movimientos?.length) {
      return '<p class="text-muted small text-center mb-0 py-2">Sin movimientos registrados</p>';
    }
    const rows = movimientos
      .map((m) => {
        const tipo = String(m.TIPODOC || '').trim();
        const docLabel = `${m.CODDOC} #${m.CORRELATIVO}`;
        const ref = m.MOV === 'A' && m.COMPRA_REF
          ? `<div class="text-muted" style="font-size:.72rem">Ref: ${this.escapeHtml(m.COMPRA_REF)}</div>`
          : '';
        return `<tr>
          <td class="text-nowrap">${this.escapeHtml(this.formatFecha(m.FECHA))}</td>
          <td class="text-nowrap">${this.escapeHtml(tipo || '—')}</td>
          <td>${this.escapeHtml(docLabel)}${ref}</td>
          <td class="text-end">${m.CREDITO ? this.escapeHtml(this.formatMoney(m.CREDITO)) : ''}</td>
          <td class="text-end text-success">${m.ABONO ? this.escapeHtml(this.formatMoney(m.ABONO)) : ''}</td>
          <td class="text-end fw-semibold text-primary">${this.escapeHtml(this.formatMoney(m.SALDO))}</td>
        </tr>`;
      })
      .join('');
    return `
      <div class="table-responsive" style="max-height: 360px">
        <table class="table table-sm table-striped mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Documento</th>
              <th class="text-end">Créditos</th>
              <th class="text-end">Pagos</th>
              <th class="text-end">Saldo</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot class="table-light">
            <tr>
              <td colspan="3" class="text-end fw-semibold">Totales</td>
              <td class="text-end fw-bold">${this.escapeHtml(this.formatMoney(totales.totalCreditos))}</td>
              <td class="text-end fw-bold text-success">${this.escapeHtml(this.formatMoney(totales.totalAbonosMov))}</td>
              <td class="text-end fw-bold text-primary">${this.escapeHtml(this.formatMoney(totales.totalSaldo))}</td>
            </tr>
          </tfoot>
        </table>
      </div>`;
  },

  renderEstadoCuentaBodyHtml(data) {
    const p = data.proveedor || {};
    const t = data.totales || {};
    const nombre = p.DOC_NOMCLIE || p.RAZONSOCIAL || p.EMPRESA || '—';
    return `
      <div class="text-start small">
        <p class="mb-1"><strong>Proveedor:</strong> ${this.escapeHtml(nombre)}</p>
        <p class="mb-1"><strong>Empresa:</strong> ${this.escapeHtml(p.EMPRESA || '—')}</p>
        <p class="mb-2"><strong>NIT:</strong> ${this.escapeHtml(p.NIT || '—')}</p>
        <div class="row g-2 mb-3">
          <div class="col-4">
            <div class="border rounded p-2 text-center">
              <div class="text-muted">Total créditos</div>
              <strong>${this.escapeHtml(this.formatMoney(t.totalCreditos))}</strong>
              <div class="text-muted" style="font-size:.75rem">${t.countCompras || 0} doc.</div>
            </div>
          </div>
          <div class="col-4">
            <div class="border rounded p-2 text-center">
              <div class="text-muted">Total pagos</div>
              <strong class="text-success">${this.escapeHtml(this.formatMoney(t.totalAbonosMov))}</strong>
              <div class="text-muted" style="font-size:.75rem">${t.countPagos || 0} mov.</div>
            </div>
          </div>
          <div class="col-4">
            <div class="border rounded p-2 text-center">
              <div class="text-muted">Saldo</div>
              <strong class="text-primary">${this.escapeHtml(this.formatMoney(t.totalSaldo))}</strong>
            </div>
          </div>
        </div>
        <p class="fw-semibold mb-1">Movimientos (orden de ingreso)</p>
        ${this.renderEstadoCuentaMovimientosTableHtml(data.movimientos, t)}
      </div>`;
  },

  async imprimirEstadoCuenta(data) {
    const p = data.proveedor || {};
    const t = data.totales || {};
    const movimientos = data.movimientos || [];
    const nombre = p.DOC_NOMCLIE || p.RAZONSOCIAL || p.EMPRESA || '';
    const hoy = this.formatFecha(this.todayIsoDate());

    const rows = movimientos.length
      ? movimientos
          .map((m) => {
            const tipo = String(m.TIPODOC || '').trim();
            const docLabel = `${m.CODDOC} #${m.CORRELATIVO}`;
            const ref = m.MOV === 'A' && m.COMPRA_REF ? ` (Ref: ${m.COMPRA_REF})` : '';
            return `<tr>
              <td>${PrintReport.escapeHtml(this.formatFecha(m.FECHA))}</td>
              <td>${PrintReport.escapeHtml(tipo || '—')}</td>
              <td>${PrintReport.escapeHtml(docLabel + ref)}</td>
              <td class="text-end">${m.CREDITO ? PrintReport.escapeHtml(this.formatMoney(m.CREDITO)) : ''}</td>
              <td class="text-end">${m.ABONO ? PrintReport.escapeHtml(this.formatMoney(m.ABONO)) : ''}</td>
              <td class="text-end">${PrintReport.escapeHtml(this.formatMoney(m.SALDO))}</td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="6" style="text-align:center;color:#666">Sin movimientos registrados</td></tr>';

    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({
        title: 'Estado de cuenta — proveedor',
        subtitleHtml: `
          <p><strong>Proveedor:</strong> ${PrintReport.escapeHtml(nombre)}</p>
          ${p.EMPRESA ? `<p><strong>Empresa:</strong> ${PrintReport.escapeHtml(p.EMPRESA)}</p>` : ''}
          ${p.NIT ? `<p><strong>NIT:</strong> ${PrintReport.escapeHtml(p.NIT)}</p>` : ''}
          <p><strong>Fecha:</strong> ${PrintReport.escapeHtml(hoy)}</p>
        `,
      })}
      <table class="ecc-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Tipo</th>
            <th>Documento</th>
            <th class="text-end">Créditos</th>
            <th class="text-end">Pagos</th>
            <th class="text-end">Saldo</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr class="totals">
            <td colspan="3" class="text-end"><strong>Totales</strong></td>
            <td class="text-end"><strong>${PrintReport.escapeHtml(this.formatMoney(t.totalCreditos))}</strong></td>
            <td class="text-end"><strong>${PrintReport.escapeHtml(this.formatMoney(t.totalAbonosMov))}</strong></td>
            <td class="text-end"><strong>${PrintReport.escapeHtml(this.formatMoney(t.totalSaldo))}</strong></td>
          </tr>
        </tfoot>
      </table>
    `;

    await PrintReport.openAndPrint(
      () =>
        PrintReport.wrapDocument({
          title: 'Estado de cuenta — proveedor',
          bodyHtml,
          extraStyles: `
        .ecc-table{font-size:11px}
        .ecc-table th,.ecc-table td{padding:5px 7px}
        .ecc-table tbody tr:nth-child(even){background:#fafafa}
        .ecc-table tfoot td{background:#f0f0f0;border-top:2px solid #999}
      `,
        }),
      'width=900,height=700'
    );
  },

  async showMenuDocumento(coddoc, correlativo) {
    const row = this.findRow(coddoc, correlativo);
    if (!row) {
      F.toast('Documento no encontrado en la lista', 'warning');
      return;
    }
    const label = this.docLabel(row);
    await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Opciones del documento',
      html: `
        <p class="small text-muted text-start mb-2">${this.escapeHtml(label)} · ${this.escapeHtml(row.DOC_NOMCLIE || '')}</p>
        ${this.renderMenuOpcionesHtml()}
      `,
      width: 580,
      showConfirmButton: false,
      showCancelButton: true,
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cerrar'),
      didOpen: () => {
        Swal.getPopup()?.querySelectorAll('[data-cxp-action]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const action = btn.getAttribute('data-cxp-action');
            Swal.close();
            await this.handleMenuAction(action, row);
          });
        });
      },
    });
  },

  async handleMenuAction(action, row) {
    const coddoc = row.CODDOC;
    const correlativo = row.CORRELATIVO;
    try {
      if (action === 'nuevo-pago') {
        await this.nuevoPago(row);
        return;
      }
      if (action === 'historial') {
        await this.mostrarHistorial(row);
        return;
      }
      if (action === 'estado-cuenta') {
        await this.mostrarEstadoCuenta(row);
        return;
      }
      if (action === 'reimprimir') {
        if (typeof DocOpciones !== 'undefined') {
          await DocOpciones.imprimir(coddoc, correlativo, row);
        } else {
          F.toast('Impresión no disponible', 'warning');
        }
        return;
      }
      if (action === 'whatsapp') {
        if (typeof DocOpciones !== 'undefined') {
          await DocOpciones.enviarWhatsapp(coddoc, correlativo, row);
        } else {
          F.toast('WhatsApp no disponible', 'warning');
        }
      }
    } catch (err) {
      F.alert('Error', err.message || 'No se pudo completar la acción', 'error');
    }
  },

  async nuevoPago(row) {
    if (this._guardandoRecibo) return;
    const coddoc = row.CODDOC;
    const correlativo = row.CORRELATIVO;
    const fechaHoy = this.todayIsoDate();
    const saldo = Number(row.DOC_SALDO) || 0;
    const totalCompra = Number(row.TOTALPRECIO) || 0;
    const pagosAcum = Number(row.DOC_ABONO) || 0;
    const proveedor = String(row.DOC_NOMCLIE || row.NEGOCIO || '—');

    let rcpTipos;
    let rcpPreview;
    try {
      const tiposData = await this.fetchRcpTipos();
      rcpTipos = tiposData.rows || [];
      if (!rcpTipos.length) {
        F.alert('Error', 'No hay tipo de documento RCP activo', 'error');
        return;
      }
      const firstCoddoc = rcpTipos[0].CODDOC;
      const prevData = await this.fetchSiguienteRcp(firstCoddoc);
      rcpPreview = prevData.rcp;
    } catch (err) {
      F.alert('Error', err.message || 'No se pudo obtener el documento RCP', 'error');
      return;
    }
    if (!rcpPreview?.CODDOC) {
      F.alert('Error', 'No hay tipo de documento RCP activo', 'error');
      return;
    }

    const { isConfirmed, value } = await Swal.fire({
      ...CatalogosUI.modalBase({ customClass: { popup: 'modal-catalogo fac-finalizar-modal' } }),
      title: 'Nuevo pago',
      width: '44rem',
      html: `
        <div class="text-start fac-finalizar-modal-body">
          <p class="small text-muted mb-2">Compra <strong>${this.escapeHtml(coddoc)} #${this.escapeHtml(correlativo)}</strong></p>
          <div class="row g-2 mb-2">
            <div class="col-md-3">
              <label class="form-label small mb-0">Fecha</label>
              <input type="date" id="cxp-abono-fecha" class="form-control form-control-sm" value="${fechaHoy}" disabled>
            </div>
            <div class="col-md-3">
              <label class="form-label small mb-0" for="cxp-abono-coddoc">CODDOC (RCP)</label>
              ${this.renderRcpCoddocSelectHtml(rcpTipos, rcpPreview.CODDOC)}
            </div>
            <div class="col-md-3">
              <label class="form-label small mb-0" for="cxp-abono-correlativo">Correlativo</label>
              <input type="text" id="cxp-abono-correlativo" class="form-control form-control-sm bg-light fw-semibold text-end" value="${this.escapeHtml(rcpPreview.CORRELATIVO)}" readonly>
            </div>
            <div class="col-md-3">
              <label class="form-label small mb-0">Proveedor</label>
              <input type="text" class="form-control form-control-sm bg-light" value="${this.escapeHtml(proveedor)}" readonly title="${this.escapeHtml(proveedor)}">
            </div>
          </div>
          <div class="row g-2 mb-2">
            <div class="col-4">
              <label class="form-label small mb-0">Total compra</label>
              <input type="text" class="form-control form-control-sm bg-light text-end" value="${this.escapeHtml(this.formatMoney(totalCompra))}" readonly>
            </div>
            <div class="col-4">
              <label class="form-label small mb-0">Pagos</label>
              <input type="text" class="form-control form-control-sm bg-light text-end" value="${this.escapeHtml(this.formatMoney(pagosAcum))}" readonly>
            </div>
            <div class="col-4">
              <label class="form-label small mb-0">Saldo</label>
              <input type="text" class="form-control form-control-sm bg-light text-end" value="${this.escapeHtml(this.formatMoney(saldo))}" readonly>
            </div>
          </div>
          ${this.renderFpagoCardHtml(saldo)}
        </div>
      `,
      icon: 'question',
      showCancelButton: true,
      allowEnterKey: false,
      confirmButtonText: CatalogosUI.guardarButtonHtml('Guardar pago'),
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
      focusConfirm: false,
      didOpen: () => {
        this.bindFpagoRefresh(saldo);
        this.wireCoddocRcpChange();
        document.getElementById('cxp-abono-fpago-efectivo')?.focus();
      },
      preConfirm: async () => {
        if (this._guardandoRecibo) return false;
        this._guardandoRecibo = true;
        Swal.getCancelButton()?.setAttribute('disabled', 'true');
        Swal.getConfirmButton()?.setAttribute('disabled', 'true');

        const unlock = () => {
          this._guardandoRecibo = false;
          Swal.hideLoading();
          Swal.getCancelButton()?.removeAttribute('disabled');
          Swal.getConfirmButton()?.removeAttribute('disabled');
        };

        const coddocRcp = document.getElementById('cxp-abono-coddoc')?.value?.trim();
        if (!coddocRcp) {
          unlock();
          Swal.showValidationMessage('Seleccione el documento RCP');
          return false;
        }
        const monto = this.roundCentavos(this.sumFpagoInputs());
        if (!Number.isFinite(monto) || monto <= 0) {
          unlock();
          Swal.showValidationMessage('Indique el monto del pago en las formas de pago');
          return false;
        }
        if (this.abonoSuperaSaldo(monto, saldo)) {
          unlock();
          Swal.showValidationMessage(`El pago no puede superar el saldo (${this.formatMoney(saldo)})`);
          return false;
        }
        const payload = {
          MONTO: monto,
          CODDOC_RCP: coddocRcp,
          ...this.readFpagoFromDom(),
          USUARIO: this.usuario(),
        };
        Swal.showLoading();
        try {
          const res = await F.fetchJson(this.pagosUrl(coddoc, correlativo), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          return res;
        } catch (e) {
          unlock();
          Swal.showValidationMessage(e.message || 'Error al guardar el pago');
          return false;
        }
      },
    });

    this._guardandoRecibo = false;
    if (!isConfirmed || !value) return;

    F.toast(`Pago ${value.pago?.CODDOC}-${value.pago?.CORRELATIVO} registrado`, 'success');
    await this.refreshVistaData();
    this._container.innerHTML = this.renderShell();
    this.bindEvents();
  },

  async mostrarHistorial(row) {
    const data = await this.fetchCompraDetalle(row.CODDOC, row.CORRELATIVO);
    const pagos = data.pagos || [];
    const totalMov = pagos.reduce((s, a) => s + (Number(a.TOTALPRECIO) || 0), 0);
    await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Historial de pagos y notas de crédito',
      html: `
        <p class="small text-muted text-start mb-2">
          Compra <strong>${this.escapeHtml(row.CODDOC)} #${this.escapeHtml(row.CORRELATIVO)}</strong>
          · ${this.escapeHtml(row.DOC_NOMCLIE || '')}
        </p>
        <p class="small text-muted text-start mb-2">RCP y DVP vinculados por SERIEFAC / NOFAC</p>
        ${this.renderPagosTableHtml(pagos)}
        <p class="text-end mt-2 mb-0 small"><strong>Total: ${this.escapeHtml(this.formatMoney(totalMov))}</strong></p>
      `,
      width: 620,
      showConfirmButton: false,
      showCancelButton: true,
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cerrar'),
    });
  },

  async mostrarEstadoCuenta(row) {
    Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Generando estado de cuenta',
      html: '<p class="small text-muted mb-0">Consultando movimientos del proveedor…</p>',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: () => Swal.showLoading(),
    });
    let codprov;
    try {
      codprov = await this.resolveCodprov(row);
      if (!codprov) {
        Swal.close();
        F.alert('Error', 'No se pudo identificar el proveedor del documento', 'error');
        return;
      }
      const data = await this.fetchEstadoCuentaProveedor(codprov);
      Swal.close();
      const bodyHtml = this.renderEstadoCuentaBodyHtml(data);
      await Swal.fire({
        ...CatalogosUI.modalBase(),
        title: 'Estado de cuenta — proveedor',
        html: bodyHtml,
        width: 760,
        showCancelButton: true,
        cancelButtonText: CatalogosUI.cancelButtonHtml('Cerrar'),
        confirmButtonText: '<i class="fa-solid fa-print me-1"></i> Imprimir',
        showConfirmButton: true,
      }).then((result) => {
        if (result.isConfirmed && typeof PrintReport !== 'undefined') {
          this.imprimirEstadoCuenta(data);
        }
      });
    } catch (err) {
      Swal.close();
      F.alert('Error', err.message || 'No se pudo cargar el estado de cuenta', 'error');
    }
  },

  async onRowAction(coddoc, correlativo) {
    await this.showMenuDocumento(coddoc, correlativo);
  },

  bindEvents() {
    const search = this._container?.querySelector('#cxp-search');
    const applySearch = async () => {
      if (!search) return;
      const next = search.value;
      if (next === this._filterQuery && !this._loading) return;
      this._filterQuery = next;
      try {
        this._loading = true;
        await this.fetchDocumentos();
        if (this._vistaTipo === 'resumen') await this.fetchResumenProveedores();
        if (this._vistaTipo === 'consolidado-productos') await this.fetchConsolidadoProductos();
        this._container.innerHTML = this.renderShell();
        this.bindEvents();
        this._container?.querySelector('#cxp-search')?.focus();
      } catch (err) {
        F.toast(err.message || 'Error al buscar', 'error');
      } finally {
        this._loading = false;
      }
    };
    search?.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      applySearch();
    });
    search?.addEventListener('search', () => {
      if (!String(search.value || '').trim()) applySearch();
    });

    const switchVista = async (value) => {
      if (value === this._vistaTipo) return;
      this._vistaTipo = value;
      if (value === 'calendario') this.initCalMonth();
      if (value === 'consolidado-productos') {
        this._container.innerHTML = `<div class="text-center text-muted py-4 w-100"><i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando consolidado de productos…</div>`;
        try {
          await this.fetchConsolidadoProductos();
        } catch (err) {
          F.toast(err.message || 'No se pudo cargar el consolidado', 'error');
        }
      }
      if (value === 'resumen') {
        this._container.innerHTML = `<div class="text-center text-muted py-4 w-100"><i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando resumen por proveedor…</div>`;
        try {
          await this.fetchResumenProveedores();
        } catch (err) {
          F.toast(err.message || 'No se pudo cargar el resumen', 'error');
        }
      }
      this._container.innerHTML = this.renderShell();
      this.bindEvents();
    };

    this._container?.querySelector('#cxp-vista-lista')?.addEventListener('click', () => {
      switchVista('lista');
    });

    this._container?.querySelector('#cxp-vista-calendario')?.addEventListener('click', () => {
      switchVista('calendario');
    });

    this._container?.querySelector('#cxp-vista-resumen')?.addEventListener('click', () => {
      switchVista('resumen');
    });

    this._container?.querySelector('#cxp-vista-consolidado')?.addEventListener('click', () => {
      switchVista('consolidado-productos');
    });

    this._container?.querySelector('#cxp-cal-prev')?.addEventListener('click', () => {
      this.initCalMonth();
      this._calMonth -= 1;
      if (this._calMonth < 0) {
        this._calMonth = 11;
        this._calYear -= 1;
      }
      this._container.innerHTML = this.renderShell();
      this.bindEvents();
    });

    this._container?.querySelector('#cxp-cal-next')?.addEventListener('click', () => {
      this.initCalMonth();
      this._calMonth += 1;
      if (this._calMonth > 11) {
        this._calMonth = 0;
        this._calYear += 1;
      }
      this._container.innerHTML = this.renderShell();
      this.bindEvents();
    });

    const onCalDayPick = (cell) => {
      const iso = cell.getAttribute('data-cal-date');
      if (!iso || !cell.classList.contains('cxp-cal-cell--clickable')) return;
      this.mostrarComprasDelDia(iso).catch((err) => F.toast(err.message || 'Error', 'error'));
    };

    this._container?.querySelectorAll('.cxp-cal-cell--clickable').forEach((cell) => {
      cell.addEventListener('click', () => onCalDayPick(cell));
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onCalDayPick(cell);
        }
      });
    });

    this._container?.querySelector('#cxp-btn-corregir-saldos')?.addEventListener('click', () => {
      this.corregirSaldos().catch((err) => F.toast(err.message || 'Error al corregir saldos', 'error'));
    });

    const onRowPick = (row) => {
      const coddoc = row.getAttribute('data-coddoc');
      const correlativo = row.getAttribute('data-correlativo');
      if (!coddoc || !correlativo) return;
      this.onRowAction(coddoc, correlativo).catch((err) => F.toast(err.message || 'Error', 'error'));
    };

    this._container?.querySelectorAll('.cxp-row').forEach((row) => {
      row.addEventListener('click', () => onRowPick(row));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onRowPick(row);
        }
      });
    });

    const onResumenPick = (row) => {
      const codigo = row.getAttribute('data-codigo');
      if (codigo == null || codigo === '') return;
      this.mostrarDocsDeProveedor(codigo, {
        nit: row.getAttribute('data-nit') || '',
        nombreKey: row.getAttribute('data-nombre-key') || '',
        nombre: row.getAttribute('data-nombre') || '',
      }).catch((err) => F.toast(err.message || 'Error', 'error'));
    };
    this._container?.querySelectorAll('.cxp-resumen-row').forEach((row) => {
      row.addEventListener('click', () => onResumenPick(row));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onResumenPick(row);
        }
      });
    });

    const onProdPick = (row) => {
      const codprod = row.getAttribute('data-codprod');
      const desprod = row.getAttribute('data-desprod') || '';
      if (codprod == null) return;
      this.mostrarDocsDeProducto(codprod, desprod).catch((err) => F.toast(err.message || 'Error', 'error'));
    };
    this._container?.querySelectorAll('.cxp-prod-row').forEach((row) => {
      row.addEventListener('click', () => onProdPick(row));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onProdPick(row);
        }
      });
    });
  },

  async load(container) {
    this._container = container;
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add('align-items-stretch', 'justify-content-start', 'p-2', 'p-md-3');

    if (!F.getEmpNit()) {
      container.innerHTML = `
        <div class="alert alert-warning m-3 w-100">
          <i class="fa-solid fa-triangle-exclamation me-2"></i>
          No hay empresa activa. Cierre sesión e ingrese de nuevo.
        </div>`;
      return;
    }

    container.innerHTML = `<div class="text-center text-muted py-4 w-100"><i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando cuentas por pagar…</div>`;
    try {
      this.initCalMonth();
      await this.fetchDocumentos();
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
