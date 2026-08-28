/**
 * Vista Corte de caja — abrir/cerrar cajas y registrar cortes.
 */
const CorteCajaView = {
  _container: null,
  _cajas: [],
  _selectedCodcaja: null,
  _resumen: null,
  _loading: false,
  _muestraDatos: false,
  _denomCounts: {},

  BILLETES_DENOMS: [
    { value: 200, label: 'Q200' },
    { value: 100, label: 'Q100' },
    { value: 50, label: 'Q50' },
    { value: 20, label: 'Q20' },
    { value: 10, label: 'Q10' },
    { value: 5, label: 'Q5' },
    { value: 1, label: 'Q1', key: 'bill-1' },
  ],

  MONEDAS_DENOMS: [
    { value: 1, label: 'Q1', key: 'coin-1' },
    { value: 0.5, label: 'Q0.50' },
    { value: 0.25, label: 'Q0.25' },
    { value: 0.1, label: 'Q0.10' },
    { value: 0.05, label: 'Q0.05' },
  ],

  escapeHtml(value) {
    if (value == null) return '';
    const div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
  },

  usuario() {
    const u = F.session('user');
    return u?.usuario || u?.username || 'SN';
  },

  usuarioNombre() {
    const u = F.session('user');
    return u?.username || u?.usuario || 'SN';
  },

  apiUrl(path, params = {}) {
    const q = new URLSearchParams({ empnit: F.getEmpNit() || '', ...params, _: String(Date.now()) });
    return `/api/corte-caja${path}?${q.toString()}`;
  },

  formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Q 0.00';
    return `Q ${n.toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  },

  selectedCaja() {
    return (this._cajas || []).find((c) => String(c.CODCAJA) === String(this._selectedCodcaja)) || null;
  },

  isAbierta(caja) {
    return Number(caja?.STATUS) === 1;
  },

  renderStat(label, value, extraClass = '') {
    return `
      <div class="corte-caja-stat ${extraClass}">
        <span class="corte-caja-stat-label">${this.escapeHtml(label)}</span>
        <span class="corte-caja-stat-value">${this.escapeHtml(value)}</span>
      </div>`;
  },

  renderClickableStat(label, value, filtro, extraClass = '') {
    return `
      <button type="button" class="corte-caja-stat corte-caja-stat-clickable ${extraClass}"
        data-corte-filtro="${this.escapeHtml(filtro)}" title="Ver detalle">
        <span class="corte-caja-stat-label">${this.escapeHtml(label)}</span>
        <span class="corte-caja-stat-value">${this.escapeHtml(value)}</span>
      </button>`;
  },

  renderResumenStats(r) {
    if (!this._muestraDatos) return '';

    const statOrClick = (label, value, filtro, extraClass = '') =>
      filtro
        ? this.renderClickableStat(label, value, filtro, extraClass)
        : this.renderStat(label, value, extraClass);

    let html = `
      ${statOrClick('Movimientos', String(r.totalMovimientos), 'todos')}
      ${statOrClick('Ventas brutas', this.formatMoney(r.totalVentasBrutas ?? r.totalVenta), 'ventas')}
      ${statOrClick('Notas de crédito', this.formatMoney(r.totalDevoluciones || 0), 'devoluciones', 'text-danger')}
      ${statOrClick('Total venta (neto)', this.formatMoney(r.totalVenta), 'todos')}
      ${statOrClick('Crédito', this.formatMoney(r.totalCredito), 'credito')}
      ${statOrClick('Recibos RCC/PRC', this.formatMoney(r.totalRecibos || 0), 'recibos', 'text-success')}
      ${this.renderStat('Efectivo inicial', this.formatMoney(r.efectivoInicial))}
      ${statOrClick('Vales de caja (−)', this.formatMoney(r.totalValesCaja || 0), 'vales-caja', 'text-danger')}
      ${statOrClick('Retiros a banco (−)', this.formatMoney(r.totalRetiros || 0), 'retiros', 'text-danger')}
      ${statOrClick('Efectivo esperado', this.formatMoney(r.efectivoEsperado), 'efectivo', 'text-primary')}
      ${statOrClick('Tarjeta', this.formatMoney(r.fpTarjeta), 'tarjeta')}
      ${statOrClick('Depósito', this.formatMoney(r.fpDeposito), 'deposito')}
      ${statOrClick('Cheque', this.formatMoney(r.fpCheque), 'cheque')}
      ${statOrClick('Anuladas (ref.)', this.formatMoney(r.totalAnuladas || 0), 'anuladas', 'text-muted')}`;

    return html;
  },

  denomKey(d) {
    return d.key || String(d.value);
  },

  denomTotal() {
    let total = 0;
    const all = [...this.BILLETES_DENOMS, ...this.MONEDAS_DENOMS];
    for (const d of all) {
      const count = Number(this._denomCounts[this.denomKey(d)]) || 0;
      total += count * d.value;
    }
    return Math.round(total * 100) / 100;
  },

  hasDenomCounts() {
    return Object.values(this._denomCounts).some((n) => Number(n) > 0);
  },

  resetDenomCounts() {
    this._denomCounts = {};
  },

  updateEfectivoFromDenoms() {
    const total = this.denomTotal();
    const totalEl = document.getElementById('corte-denom-total');
    if (totalEl) totalEl.textContent = this.formatMoney(total);
    this._container?.querySelectorAll('.corte-denom-subtotal').forEach((el) => {
      const row = el.closest('.corte-denom-row');
      const inp = row?.querySelector('.corte-denom-qty');
      const denom = Number(inp?.dataset.denomValue);
      const count = Number(inp?.value) || 0;
      if (Number.isFinite(denom)) {
        el.textContent = this.formatMoney(count * denom);
      }
    });
    const cashInp = document.getElementById('corte-total-reportado');
    if (cashInp) cashInp.value = String(total);
  },

  renderDenomRow(d) {
    const key = this.denomKey(d);
    const count = Number(this._denomCounts[key]) || 0;
    const subtotal = count * d.value;
    return `
      <div class="corte-denom-row">
        <span class="corte-denom-label">${this.escapeHtml(d.label)}</span>
        <input type="number" class="form-control form-control-sm corte-denom-qty"
          data-denom-key="${this.escapeHtml(key)}" data-denom-value="${d.value}"
          min="0" step="1" inputmode="numeric"
          value="${count}" aria-label="Cantidad ${this.escapeHtml(d.label)}">
        <span class="corte-denom-subtotal">${this.escapeHtml(this.formatMoney(subtotal))}</span>
      </div>`;
  },

  renderDenominacionesCard() {
    return `
      <div class="card shadow-sm corte-caja-panel-card corte-caja-denom-card h-100">
        <div class="card-body d-flex flex-column">
          <h6 class="card-title mb-2">
            <i class="fa-solid fa-coins me-1 text-warning"></i>Conteo de efectivo
          </h6>
          <div class="corte-denom-section">
            <div class="corte-denom-section-title">Billetes</div>
            ${this.BILLETES_DENOMS.map((d) => this.renderDenomRow(d)).join('')}
          </div>
          <div class="corte-denom-section mt-2">
            <div class="corte-denom-section-title">Monedas</div>
            ${this.MONEDAS_DENOMS.map((d) => this.renderDenomRow(d)).join('')}
          </div>
          <div class="corte-denom-footer mt-auto pt-3">
            <div class="d-flex justify-content-between align-items-center">
              <span class="fw-semibold">Total contado</span>
              <span class="fw-bold text-primary" id="corte-denom-total">${this.escapeHtml(this.formatMoney(this.denomTotal()))}</span>
            </div>
            <button type="button" class="btn btn-outline-secondary btn-sm mt-2 w-100" id="btn-corte-denom-clear">
              <i class="fa-solid fa-eraser me-1"></i>Limpiar conteo
            </button>
          </div>
        </div>
      </div>`;
  },

  renderArqueoInputs(r) {
    const blind = !this._muestraDatos;
    const denomTotal = this.denomTotal();
    const cashVal = this.hasDenomCounts()
      ? String(denomTotal)
      : blind
        ? ''
        : String(r.efectivoEsperado);
    const tarjetaVal = blind ? '' : String(r.fpTarjeta);
    const chequeVal = blind ? '' : String(r.fpCheque);
    const depositoVal = blind ? '' : String(r.fpDeposito);

    return `
      <div class="row g-2">
        <div class="col-md-6">
          <label class="form-label small mb-0" for="corte-total-reportado">Efectivo contado</label>
          <input type="number" id="corte-total-reportado" class="form-control form-control-sm"
            min="0" step="0.01" value="${this.escapeHtml(cashVal)}" placeholder="${blind ? '0.00' : ''}">
        </div>
        <div class="col-md-6">
          <label class="form-label small mb-0" for="corte-reportado-tarjeta">Tarjeta reportada</label>
          <input type="number" id="corte-reportado-tarjeta" class="form-control form-control-sm"
            min="0" step="0.01" value="${this.escapeHtml(tarjetaVal)}" placeholder="${blind ? '0.00' : ''}">
        </div>
        <div class="col-md-6">
          <label class="form-label small mb-0" for="corte-reportado-cheques">Cheques reportados</label>
          <input type="number" id="corte-reportado-cheques" class="form-control form-control-sm"
            min="0" step="0.01" value="${this.escapeHtml(chequeVal)}" placeholder="${blind ? '0.00' : ''}">
        </div>
        <div class="col-md-6">
          <label class="form-label small mb-0" for="corte-reportado-deposito">Depósito reportado</label>
          <input type="number" id="corte-reportado-deposito" class="form-control form-control-sm"
            min="0" step="0.01" value="${this.escapeHtml(depositoVal)}" placeholder="${blind ? '0.00' : ''}">
        </div>
        <div class="col-12">
          <label class="form-label small mb-0" for="corte-obs">Observaciones</label>
          <input type="text" id="corte-obs" class="form-control form-control-sm" maxlength="200" placeholder="Opcional">
        </div>
      </div>`;
  },

  buildCortePrintHtml({ caja, corte, resumen, reportado, faltante, sobrante, obs, usuarioNombre, fechaLabel }) {
    let fecha = fechaLabel;
    if (!fecha) {
      if (corte?.FECHA) {
        const h = Number(corte.HORA);
        const m = Number(corte.MINUTO);
        const horaTxt = Number.isFinite(h)
          ? `${String(h).padStart(2, '0')}:${String(Number.isFinite(m) ? m : 0).padStart(2, '0')}`
          : '';
        fecha = `${this.formatFecha(corte.FECHA)}${horaTxt ? ` ${horaTxt}` : ''}`;
      } else {
        fecha = new Date().toLocaleString('es-GT', {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
      }
    }
    const money = (v) => PrintReport.escapeHtml(this.formatMoney(v));
    const row = (label, value, extraClass = '') =>
      `<tr><td>${PrintReport.escapeHtml(label)}</td><td class="text-end${extraClass ? ` ${extraClass}` : ''}">${value}</td></tr>`;

    const diffRow =
      faltante > 0
        ? row('Faltante', `<strong class="text-danger">${money(faltante)}</strong>`)
        : sobrante > 0
          ? row('Sobrante', `<strong class="text-success">${money(sobrante)}</strong>`)
          : row('Diferencia efectivo', '<strong>Sin diferencia</strong>');

    const bodyHtml = `
      ${PrintReport.reportHeaderHtml({
        title: 'Corte de caja',
        subtitleHtml: `
          <p><strong>Corte #${PrintReport.escapeHtml(corte.CORRELATIVO)}</strong> · ${PrintReport.escapeHtml(fecha)}</p>
          <p><strong>Caja:</strong> ${PrintReport.escapeHtml(caja.DESCAJA)} (${PrintReport.escapeHtml(caja.CODCAJA)})</p>
          <p><strong>Usuario:</strong> ${PrintReport.escapeHtml(usuarioNombre)}</p>
          ${obs ? `<p><strong>Observaciones:</strong> ${PrintReport.escapeHtml(obs)}</p>` : ''}
        `,
      })}
      <h2 class="corte-print-section">Resumen del turno</h2>
      <table>
        <tbody>
          ${row('Movimientos', PrintReport.escapeHtml(String(resumen.totalMovimientos)))}
          ${row('Ventas brutas', money(resumen.totalVentasBrutas ?? resumen.totalVenta))}
          ${row('Notas de crédito (DEV/FNC)', money(resumen.totalDevoluciones || 0))}
          ${row('Total venta (neto)', money(resumen.totalVenta))}
          ${row('Ventas al crédito', money(resumen.totalCredito))}
          ${row('Recibos RCC/PRC', money(resumen.totalRecibos || 0))}
          ${row('Efectivo inicial', money(resumen.efectivoInicial))}
          ${row('Efectivo (neto)', money(resumen.fpEfectivo))}
          ${row('Vales de caja (−)', money(resumen.totalValesCaja || 0))}
          ${row('Retiros a banco (−)', money(resumen.totalRetiros || 0))}
          ${row('Efectivo esperado', money(resumen.efectivoEsperado))}
          ${row('Tarjeta (sistema)', money(resumen.fpTarjeta))}
          ${row('Depósito (sistema)', money(resumen.fpDeposito))}
          ${row('Cheque (sistema)', money(resumen.fpCheque))}
        </tbody>
      </table>
      <h2 class="corte-print-section">Arqueo reportado</h2>
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
      title: `Corte de caja #${corte.CORRELATIVO}`,
      bodyHtml,
      extraStyles: `
        h2.corte-print-section{font-size:.95rem;margin:1rem 0 .35rem;font-weight:600}
        table td:first-child{width:55%}
      `,
    });
  },

  async imprimirCorte(payload) {
    if (typeof PrintReport === 'undefined') {
      F.toast('No se pudo abrir el imprimible', 'warning');
      return;
    }
    await PrintReport.openAndPrint(() => this.buildCortePrintHtml(payload), 'width=800,height=700');
  },

  formatHoraCorte(hora, minuto) {
    const h = Number(hora);
    const m = Number(minuto);
    if (!Number.isFinite(h)) return '—';
    return `${String(h).padStart(2, '0')}:${String(Number.isFinite(m) ? m : 0).padStart(2, '0')}`;
  },

  mesOptionsHtml(selected) {
    const names = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
    ];
    return names
      .map((label, i) => {
        const mes = i + 1;
        const sel = mes === Number(selected) ? ' selected' : '';
        return `<option value="${mes}"${sel}>${label}</option>`;
      })
      .join('');
  },

  anioOptionsHtml(selected) {
    const cur = new Date().getFullYear();
    const years = [];
    for (let y = cur + 1; y >= 2020; y -= 1) years.push(y);
    return years
      .map((y) => {
        const sel = y === Number(selected) ? ' selected' : '';
        return `<option value="${y}"${sel}>${y}</option>`;
      })
      .join('');
  },

  renderHistorialRows(rows) {
    if (!rows.length) {
      return `<tr><td colspan="8" class="text-center text-muted py-4">No hay cortes en el período</td></tr>`;
    }
    return rows
      .map(
        (c) => `
      <tr>
        <td class="text-nowrap fw-semibold">#${this.escapeHtml(c.CORRELATIVO)}</td>
        <td class="text-nowrap">${this.escapeHtml(this.formatFecha(c.FECHA))}</td>
        <td class="text-nowrap">${this.escapeHtml(this.formatHoraCorte(c.HORA, c.MINUTO))}</td>
        <td>${this.escapeHtml(c.DESCAJA || `Caja ${c.CODCAJA}`)}</td>
        <td class="text-end">${this.escapeHtml(c.TOTALMOVIMIENTOS)}</td>
        <td class="text-end">${this.escapeHtml(this.formatMoney(c.TOTALVENTA))}</td>
        <td class="small">${this.escapeHtml(c.USUARIO || '—')}</td>
        <td class="text-end text-nowrap">
          <div class="d-flex flex-wrap gap-1 justify-content-end">
            <button type="button" class="btn btn-sm btn-outline-secondary btn-corte-hist-print"
              data-id="${this.escapeHtml(c.ID)}" title="Reimprimir corte">
              <i class="fa-solid fa-print"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-primary btn-corte-hist-docs"
              data-id="${this.escapeHtml(c.ID)}" title="Documentos del corte">
              <i class="fa-solid fa-list"></i>
            </button>
            <button type="button" class="btn btn-sm btn-outline-primary btn-corte-hist-boleta"
              data-id="${this.escapeHtml(c.ID)}" title="Actualizar boleta de retiro">
              <i class="fa-solid fa-pen-to-square me-1"></i>Actualizar Boleta de Retiro
            </button>
          </div>
        </td>
      </tr>`
      )
      .join('');
  },

  renderHistorialModalHtml(mes, anio, rows, loading = false) {
    const body = loading
      ? `<tr><td colspan="8" class="text-center text-muted py-4">
          <i class="fa-solid fa-spinner fa-spin me-1"></i>Cargando…
        </td></tr>`
      : this.renderHistorialRows(rows);
    return `
      <div class="corte-caja-historial-modal text-start">
        <div class="d-flex flex-wrap align-items-end gap-2 mb-3">
          <div>
            <label class="form-label form-label-sm mb-0" for="corte-hist-mes">Mes</label>
            <select id="corte-hist-mes" class="form-select form-select-sm">${this.mesOptionsHtml(mes)}</select>
          </div>
          <div>
            <label class="form-label form-label-sm mb-0" for="corte-hist-anio">Año</label>
            <select id="corte-hist-anio" class="form-select form-select-sm">${this.anioOptionsHtml(anio)}</select>
          </div>
          <button type="button" class="btn btn-sm btn-primary" id="corte-hist-aplicar">Aplicar</button>
        </div>
        <div class="table-responsive corte-caja-historial-table">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th>No.</th>
                <th>Fecha</th>
                <th>Hora</th>
                <th>Caja</th>
                <th class="text-end">Movs.</th>
                <th class="text-end">Venta</th>
                <th>Usuario</th>
                <th class="text-end"></th>
              </tr>
            </thead>
            <tbody id="corte-hist-tbody">${body}</tbody>
          </table>
        </div>
      </div>`;
  },

  renderHistorialGruposHtml(corte, grupos, totalDocs, totalGeneral) {
    if (!grupos.length) {
      return `
        <p class="small text-muted mb-0">
          Corte #${this.escapeHtml(corte?.CORRELATIVO)} no tiene documentos marcados (NOCORTE).
          Si es un corte antiguo, ejecute la reparación de NOCORTE.
        </p>`;
    }
    const sections = grupos
      .map((g) => {
        const rows = (g.rows || [])
          .map((r) => {
            const anulado = r.STATUS === 'A';
            return `
            <tr class="${anulado ? 'text-muted' : ''}">
              <td class="text-nowrap small">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
              <td class="small fw-semibold text-nowrap">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</td>
              <td class="small">${this.escapeHtml(r.CLIENTE || '—')}</td>
              <td class="text-end small">${this.escapeHtml(this.formatMoney(r.IMPORTE))}</td>
              <td class="text-center small">${this.escapeHtml(r.STATUS)}</td>
            </tr>`;
          })
          .join('');
        return `
          <section class="corte-hist-grupo mb-3">
            <div class="d-flex flex-wrap justify-content-between align-items-baseline gap-2 mb-1">
              <h6 class="mb-0 small fw-semibold">
                ${this.escapeHtml(g.TIPODOC)}
                <span class="text-muted fw-normal">— ${this.escapeHtml(g.DESDOC || '')}</span>
              </h6>
              <span class="small text-muted">${g.count} doc(s)${
                g.anulados ? ` · ${g.anulados} anulado(s)` : ''
              }</span>
            </div>
            <div class="table-responsive">
              <table class="table table-sm table-hover mb-0">
                <thead class="table-light">
                  <tr>
                    <th>Fecha</th>
                    <th>Documento</th>
                    <th>Cliente</th>
                    <th class="text-end">Importe</th>
                    <th class="text-center">St</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
                <tfoot>
                  <tr>
                    <td colspan="3" class="text-end fw-semibold small">Total</td>
                    <td class="text-end fw-semibold small">${this.escapeHtml(this.formatMoney(g.total))}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>`;
      })
      .join('');
    return `
      <div class="corte-caja-hist-docs text-start">
        <p class="small text-muted mb-2">
          Corte #${this.escapeHtml(corte?.CORRELATIVO)} · ${this.escapeHtml(corte?.DESCAJA || '')}
          · ${totalDocs} documento(s) · Total ${this.escapeHtml(this.formatMoney(totalGeneral))}
        </p>
        <div class="corte-caja-hist-docs-scroll">${sections}</div>
      </div>`;
  },

  async fetchHistorialCortes(mes, anio) {
    return F.fetchJson(this.apiUrl('/cortes', { mes: String(mes), anio: String(anio) }));
  },

  async fetchHistorialDetalle(id) {
    return F.fetchJson(this.apiUrl(`/cortes/${encodeURIComponent(id)}`));
  },

  async fetchHistorialRetiros(id) {
    return F.fetchJson(this.apiUrl(`/cortes/${encodeURIComponent(id)}/retiros`));
  },

  async patchRetiroBoleta(movId, nodocumento) {
    return F.fetchJson(this.apiUrl(`/documentos-banco/${encodeURIComponent(movId)}/boleta`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ NODOCUMENTO: nodocumento }),
    });
  },

  renderHistorialRetirosHtml(corte, rows) {
    if (!rows.length) {
      return `
        <p class="small text-muted mb-0">
          Corte #${this.escapeHtml(corte?.CORRELATIVO)} no tiene retiros a banco registrados.
        </p>`;
    }
    const body = rows
      .map((r) => {
        const banco = [r.DESBANCO, r.NOCUENTA].filter(Boolean).join(' · ') || '—';
        return `
        <tr data-retiro-id="${this.escapeHtml(r.ID)}">
          <td class="text-nowrap small">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
          <td class="small text-nowrap">${this.escapeHtml(r.CODDOC || '—')} #${this.escapeHtml(r.CORRELATIVO ?? '—')}</td>
          <td class="small">${this.escapeHtml(banco)}</td>
          <td class="text-end small">${this.escapeHtml(this.formatMoney(r.IMPORTE))}</td>
          <td style="min-width:9rem">
            <input type="text" class="form-control form-control-sm corte-hist-boleta-input"
              maxlength="50" value="${this.escapeHtml(r.NODOCUMENTO || '')}"
              placeholder="No. boleta" autocomplete="off">
          </td>
          <td class="text-end text-nowrap">
            <button type="button" class="btn btn-sm btn-primary corte-hist-boleta-save"
              data-id="${this.escapeHtml(r.ID)}">
              Guardar
            </button>
            <span class="corte-hist-boleta-status small ms-1" aria-live="polite"></span>
          </td>
        </tr>`;
      })
      .join('');
    return `
      <div class="corte-caja-hist-boletas text-start">
        <p class="small text-muted mb-2">
          Corte #${this.escapeHtml(corte?.CORRELATIVO)} · ${this.escapeHtml(corte?.DESCAJA || '')}
          · Solo se actualiza el número de boleta del movimiento de banco.
        </p>
        <div class="table-responsive" style="max-height: 22rem;">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th>Fecha</th>
                <th>Documento</th>
                <th>Banco / Cuenta</th>
                <th class="text-end">Importe</th>
                <th>No. boleta</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>`;
  },

  bindHistorialBoletaActions(root) {
    root?.querySelectorAll('.corte-hist-boleta-save').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = btn.getAttribute('data-id');
        const tr = btn.closest('tr');
        const input = tr?.querySelector('.corte-hist-boleta-input');
        const statusEl = tr?.querySelector('.corte-hist-boleta-status');
        if (!id || !input) return;
        if (statusEl) {
          statusEl.textContent = '';
          statusEl.className = 'corte-hist-boleta-status small ms-1';
        }
        try {
          btn.disabled = true;
          input.disabled = true;
          await this.patchRetiroBoleta(id, String(input.value || '').trim());
          if (statusEl) {
            statusEl.textContent = 'Actualizado';
            statusEl.className = 'corte-hist-boleta-status small text-success ms-1';
          }
        } catch (err) {
          if (statusEl) {
            statusEl.textContent = err.message || 'Error al guardar';
            statusEl.className = 'corte-hist-boleta-status small text-danger ms-1';
          }
        } finally {
          btn.disabled = false;
          input.disabled = false;
        }
      });
    });
  },

  bindHistorialRowActions(ctx) {
    const root = ctx.getRoot?.() || document;
    root.querySelectorAll('.btn-corte-hist-print').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (!id) return;
        try {
          btn.disabled = true;
          const data = await this.fetchHistorialDetalle(id);
          const p = data.print;
          if (!p?.corte) {
            F.toast('No se pudo armar la reimpresión', 'warning');
            return;
          }
          await this.imprimirCorte({
            ...p,
            corte: {
              ...p.corte,
              FECHA: p.corte.FECHA || data.corte?.FECHA,
              HORA: p.corte.HORA ?? data.corte?.HORA,
              MINUTO: p.corte.MINUTO ?? data.corte?.MINUTO,
            },
          });
        } catch (err) {
          F.toast(err.message || 'No se pudo reimprimir', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
    root.querySelectorAll('.btn-corte-hist-docs').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (!id || !ctx.showDocs) return;
        try {
          btn.disabled = true;
          await ctx.showDocs(id);
        } catch (err) {
          F.toast(err.message || 'No se pudo cargar documentos', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
    root.querySelectorAll('.btn-corte-hist-boleta').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (!id || !ctx.showBoletas) return;
        try {
          btn.disabled = true;
          await ctx.showBoletas(id);
        } catch (err) {
          F.toast(err.message || 'No se pudieron cargar los retiros', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  },

  async showHistorialModal() {
    const now = new Date();
    let mes = now.getMonth() + 1;
    let anio = now.getFullYear();

    const hostEl = () => document.getElementById('corte-hist-host');

    const showDocs = async (id) => {
      const host = hostEl();
      if (!host) return;
      host.innerHTML = `
        <div class="text-center text-muted py-4">
          <i class="fa-solid fa-spinner fa-spin me-1"></i>Cargando documentos…
        </div>`;
      const data = await this.fetchHistorialDetalle(id);
      host.innerHTML = `
        <div class="mb-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" id="corte-hist-back">
            <i class="fa-solid fa-arrow-left me-1"></i>Volver al historial
          </button>
        </div>
        ${this.renderHistorialGruposHtml(
          data.corte,
          data.grupos || [],
          data.totalDocs || 0,
          data.totalGeneral || 0
        )}`;
      document.getElementById('corte-hist-back')?.addEventListener('click', () => {
        paintList();
      });
    };

    const showBoletas = async (id) => {
      const host = hostEl();
      if (!host) return;
      host.innerHTML = `
        <div class="text-center text-muted py-4">
          <i class="fa-solid fa-spinner fa-spin me-1"></i>Cargando retiros…
        </div>`;
      const data = await this.fetchHistorialRetiros(id);
      host.innerHTML = `
        <div class="mb-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" id="corte-hist-back">
            <i class="fa-solid fa-arrow-left me-1"></i>Volver al historial
          </button>
        </div>
        ${this.renderHistorialRetirosHtml(data.corte, data.rows || [])}`;
      document.getElementById('corte-hist-back')?.addEventListener('click', () => {
        paintList();
      });
      this.bindHistorialBoletaActions(host);
    };

    const paintList = async () => {
      const host = hostEl();
      if (!host) return;
      host.innerHTML = this.renderHistorialModalHtml(mes, anio, [], true);
      const tbody = document.getElementById('corte-hist-tbody');
      document.getElementById('corte-hist-aplicar')?.addEventListener('click', () => {
        mes = Number(document.getElementById('corte-hist-mes')?.value) || mes;
        anio = Number(document.getElementById('corte-hist-anio')?.value) || anio;
        paintList();
      });
      if (!tbody) return;
      try {
        const data = await this.fetchHistorialCortes(mes, anio);
        mes = Number(data.mes) || mes;
        anio = Number(data.anio) || anio;
        const mesEl = document.getElementById('corte-hist-mes');
        const anioEl = document.getElementById('corte-hist-anio');
        if (mesEl) mesEl.value = String(mes);
        if (anioEl) anioEl.value = String(anio);
        tbody.innerHTML = this.renderHistorialRows(data.rows || []);
        this.bindHistorialRowActions({ getRoot: () => host, showDocs, showBoletas });
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">${this.escapeHtml(
          err.message || 'Error al cargar'
        )}</td></tr>`;
      }
    };

    await Swal.fire({
      ...(typeof CatalogosUI !== 'undefined' ? CatalogosUI.modalBase() : {}),
      title: 'Historial de cortes',
      width: '67.2rem',
      html: '<div id="corte-hist-host" class="corte-caja-historial-modal text-start"></div>',
      confirmButtonText:
        typeof CatalogosUI !== 'undefined' ? CatalogosUI.aceptarButtonHtml('Cerrar') : 'Cerrar',
      showCancelButton: false,
      customClass: {
        ...(typeof CatalogosUI !== 'undefined' ? CatalogosUI.modalBase().customClass : {}),
        popup: 'modal-catalogo corte-caja-historial-swal',
      },
      didOpen: () => {
        paintList();
      },
    });
  },

  async fetchMuestraDatosConfig() {
    try {
      const opcion = encodeURIComponent('MUESTRA DATOS EN CORTE DE CAJA');
      const data = await F.fetchJson(`/api/config/sino?opcion=${opcion}&_=${Date.now()}`);
      this._muestraDatos = String(data.sino || 'NO').trim().toUpperCase() === 'SI';
    } catch {
      this._muestraDatos = false;
    }
  },

  formatFecha(value) {
    if (!value) return '—';
    const s = String(value).slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return '—';
  },

  filtroTitulo(filtro) {
    const map = {
      todos: 'Documentos del corte',
      ventas: 'Ventas brutas (facturas)',
      credito: 'Facturas al crédito',
      contado: 'Ventas al contado',
      recibos: 'Recibos de pago (RCC / PRC)',
      efectivo: 'Documentos con efectivo',
      devoluciones: 'Notas de crédito (DEV, FNC)',
      tarjeta: 'Pagos con tarjeta',
      deposito: 'Pagos con depósito',
      cheque: 'Pagos con cheque',
      anuladas: 'Facturas anuladas (referencia)',
      'vales-caja': 'Vales de caja (−)',
      retiros: 'Retiros de efectivo a banco (−)',
    };
    return map[filtro] || 'Documentos';
  },

  formatFechaCorta(value) {
    return this.formatFecha(value);
  },

  renderValesCajaModalHtml(rows) {
    if (!rows.length) {
      return '<p class="text-muted small mb-0 text-center py-3">Sin vales de caja pendientes en esta sesión.</p>';
    }
    let total = 0;
    const body = rows
      .map((r) => {
        const monto = Number(r.IMPORTE ?? r.MONTO) || 0;
        total += monto;
        return `
        <tr data-row-id="${this.escapeHtml(r.NOVALE || r.ID)}">
          <td>${this.escapeHtml(r.NOVALE || r.ID)}</td>
          <td class="text-nowrap">${this.escapeHtml(this.formatFechaCorta(r.FECHA))}</td>
          <td>${this.escapeHtml(r.TIPO || '—')}</td>
          <td>${this.escapeHtml(r.RECIBE || '—')}</td>
          <td class="small">${this.escapeHtml(r.DESCRIPCION || '—')}</td>
          <td class="text-end text-danger">${this.escapeHtml(this.formatMoney(monto))}</td>
          <td class="text-end">
            <button type="button" class="btn btn-sm btn-outline-secondary corte-vale-caja-print" title="Imprimir">
              <i class="fa-solid fa-print"></i>
            </button>
          </td>
        </tr>`;
      })
      .join('');
    return `
      <div class="table-responsive" style="max-height: 22rem;" id="corte-vales-caja-detalle-wrap">
        <table class="table table-sm table-hover align-middle mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>#</th>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Recibe</th>
              <th>Descripción</th>
              <th class="text-end">Importe</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot class="table-light">
            <tr>
              <th colspan="5" class="text-end">${rows.length} registro(s)</th>
              <th class="text-end text-danger">${this.escapeHtml(this.formatMoney(total))}</th>
              <th></th>
            </tr>
          </tfoot>
        </table>
      </div>`;
  },

  async showValesCajaDetalleModal() {
    const caja = this.selectedCaja();
    if (!caja || !this.isAbierta(caja)) return;
    try {
      const data = await F.fetchJson(this.apiUrl(`/${caja.CODCAJA}/vales-caja-detalle`));
      const rows = data.rows || [];
      await Swal.fire({
        ...CatalogosUI.modalBase(),
        title: this.filtroTitulo('vales-caja'),
        width: '48rem',
        html: this.renderValesCajaModalHtml(rows),
        confirmButtonText: CatalogosUI.guardarButtonHtml('Cerrar'),
        showCancelButton: false,
        didOpen: () => {
          document.getElementById('corte-vales-caja-detalle-wrap')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.corte-vale-caja-print');
            if (!btn) return;
            const tr = btn.closest('tr[data-row-id]');
            const id = tr?.getAttribute('data-row-id');
            const row = rows.find((r) => String(r.NOVALE || r.ID) === String(id));
            if (!row || typeof NominaPrint === 'undefined') {
              F.toast('Impresión no disponible', 'warning');
              return;
            }
            NominaPrint.printValeCaja(row).catch((err) =>
              F.toast(err.message || 'No se pudo imprimir', 'error')
            );
          });
        },
      });
    } catch (err) {
      F.toast(err.message || 'No se pudo cargar el detalle', 'error');
    }
  },

  async showDocumentosModal(filtro) {
    if (filtro === 'vales-caja') {
      return this.showValesCajaDetalleModal();
    }
    if (filtro === 'retiros') {
      return this.showRetirosDetalleModal();
    }
    const caja = this.selectedCaja();
    if (!caja || !this.isAbierta(caja)) return;
    try {
      const data = await F.fetchJson(
        this.apiUrl(`/${caja.CODCAJA}/documentos`, { filtro })
      );
      const rows = data.rows || [];
      await Swal.fire({
        ...CatalogosUI.modalBase(),
        title: this.filtroTitulo(filtro),
        width: '42rem',
        html: this.renderDocumentosModalHtml(filtro, rows),
        confirmButtonText: CatalogosUI.guardarButtonHtml('Cerrar'),
        showCancelButton: false,
        didOpen: () => {
          const input = document.getElementById('corte-docs-search');
          const body = document.getElementById('corte-docs-modal-body');
          if (!input || !body) return;
          input.addEventListener('input', () => {
            const filtered = this.filterDocumentosRows(rows, input.value);
            body.innerHTML = this.renderDocumentosTableHtml(filtro, filtered, {
              emptyMessage: rows.length
                ? 'Ningún documento coincide con la búsqueda.'
                : 'Sin documentos en este filtro.',
            });
          });
          input.focus();
        },
      });
    } catch (err) {
      F.toast(err.message || 'No se pudo cargar el detalle', 'error');
    }
  },

  renderRetirosModalHtml(rows) {
    if (!rows.length) {
      return '<p class="text-muted small mb-0 text-center py-3">Sin retiros de efectivo en esta sesión.</p>';
    }
    const body = rows
      .map(
        (r) => `<tr>
          <td class="text-nowrap small">${this.escapeHtml(this.formatFechaCorta(r.FECHA))}</td>
          <td class="small fw-semibold text-nowrap">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</td>
          <td class="small">${this.escapeHtml(r.DESBANCO || '—')}<div class="text-muted">${this.escapeHtml(r.NOCUENTA || '')}</div></td>
          <td class="small">${this.escapeHtml(r.NODOCUMENTO || '—')}</td>
          <td class="text-end fw-semibold text-danger">${this.escapeHtml(this.formatMoney(Math.abs(Number(r.IMPORTE) || 0)))}</td>
        </tr>`
      )
      .join('');
    return `
      <div class="table-responsive" style="max-height: 22rem;">
        <table class="table table-sm table-hover mb-0">
          <thead class="table-light sticky-top">
            <tr>
              <th>Fecha</th>
              <th>Documento</th>
              <th>Cuenta</th>
              <th>No. boleta</th>
              <th class="text-end">Importe</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  },

  async showRetirosDetalleModal() {
    const caja = this.selectedCaja();
    if (!caja || !this.isAbierta(caja)) return;
    try {
      const data = await F.fetchJson(this.apiUrl(`/${caja.CODCAJA}/retiros-detalle`));
      await Swal.fire({
        ...CatalogosUI.modalBase(),
        title: this.filtroTitulo('retiros'),
        width: '42rem',
        html: this.renderRetirosModalHtml(data.rows || []),
        confirmButtonText: CatalogosUI.guardarButtonHtml('Cerrar'),
        showCancelButton: false,
      });
    } catch (err) {
      F.toast(err.message || 'No se pudo cargar el detalle', 'error');
    }
  },

  cuentaOptionsHtml(cuentas, selected) {
    if (!cuentas?.length) {
      return '<option value="">— Sin cuentas bancarias —</option>';
    }
    return (
      '<option value="">— Seleccione cuenta —</option>' +
      cuentas
        .map((c) => {
          const label = `${c.DESBANCO || 'Banco'} — ${c.NOCUENTA || c.CODCUENTA}`;
          const sel = String(c.CODCUENTA) === String(selected) ? ' selected' : '';
          return `<option value="${this.escapeHtml(c.CODCUENTA)}"${sel}>${this.escapeHtml(label)}</option>`;
        })
        .join('')
    );
  },

  async onRetiroEfectivo() {
    const caja = this.selectedCaja();
    if (!caja || !this.isAbierta(caja) || this._loading) return;

    let cuentas = [];
    try {
      const data = await F.fetchJson(
        `/api/cuentas-bancarias?empnit=${encodeURIComponent(F.getEmpNit())}&_=${Date.now()}`
      );
      cuentas = data.rows || data || [];
      if (!Array.isArray(cuentas)) cuentas = [];
    } catch (err) {
      F.toast(err.message || 'No se pudieron cargar las cuentas', 'error');
      return;
    }
    if (!cuentas.length) {
      F.toast('No hay cuentas bancarias configuradas', 'warning');
      return;
    }

    const descPreview = `RETIRO DE EFECTIVO DE CAJA # ${caja.CODCAJA}`;
    const { isConfirmed, value } = await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Retiro de efectivo',
      width: '28rem',
      html: `
        <p class="small text-muted mb-2 text-start">
          Se registrará un <strong>depósito (entrada)</strong> en banco y se descontará del efectivo esperado de la caja.
        </p>
        <p class="small text-start mb-3"><span class="text-muted">Descripción:</span> ${this.escapeHtml(descPreview)}</p>
        <label class="form-label small mb-0 text-start w-100" for="corte-retiro-cuenta">Cuenta bancaria</label>
        <select id="corte-retiro-cuenta" class="form-select form-select-sm mb-2">
          ${this.cuentaOptionsHtml(cuentas)}
        </select>
        <label class="form-label small mb-0 text-start w-100" for="corte-retiro-importe">Importe a depositar</label>
        <input type="number" id="corte-retiro-importe" class="form-control form-control-sm mb-2" min="0.01" step="0.01" value="">
        <label class="form-label small mb-0 text-start w-100" for="corte-retiro-boleta">No. boleta / documento (opcional)</label>
        <input type="text" id="corte-retiro-boleta" class="form-control form-control-sm" maxlength="50" autocomplete="off">
      `,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: CatalogosUI.guardarButtonHtml('Registrar retiro'),
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
      focusConfirm: false,
      didOpen: () => {
        document.getElementById('corte-retiro-cuenta')?.focus();
      },
      preConfirm: () => {
        const codcuenta = Number(document.getElementById('corte-retiro-cuenta')?.value || 0);
        const importe = Number(document.getElementById('corte-retiro-importe')?.value || 0);
        const nodocumento = document.getElementById('corte-retiro-boleta')?.value?.trim() || '';
        if (!codcuenta) {
          Swal.showValidationMessage('Seleccione la cuenta bancaria');
          return false;
        }
        if (!Number.isFinite(importe) || importe <= 0) {
          Swal.showValidationMessage('Ingrese un importe válido');
          return false;
        }
        return { CODCUENTA: codcuenta, IMPORTE: importe, NODOCUMENTO: nodocumento };
      },
    });
    if (!isConfirmed || !value) return;

    this._loading = true;
    try {
      const url = `/api/corte-caja/${encodeURIComponent(caja.CODCAJA)}/retiro-efectivo?empnit=${encodeURIComponent(F.getEmpNit())}`;
      const res = await F.fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          CODCUENTA: value.CODCUENTA,
          IMPORTE: value.IMPORTE,
          NODOCUMENTO: value.NODOCUMENTO,
          USUARIO: this.usuario(),
        }),
      });
      if (res.resumen) this._resumen = res.resumen;
      F.toast('Retiro registrado como depósito bancario', 'success');
      this.refreshPanels();
    } catch (err) {
      F.toast(err.message || 'No se pudo registrar el retiro', 'error');
    } finally {
      this._loading = false;
    }
  },

  importeColumnLabel(filtro) {
    if (filtro === 'tarjeta') return 'Monto tarjeta';
    if (filtro === 'deposito') return 'Monto depósito';
    if (filtro === 'cheque') return 'Monto cheque';
    if (filtro === 'efectivo') return 'Monto efectivo';
    return 'Importe';
  },

  rowImporte(row, filtro) {
    const raw =
      filtro === 'tarjeta'
        ? row.FPAGO_TARJETA
        : filtro === 'deposito'
          ? row.FPAGO_DEPOSITO
          : filtro === 'cheque'
            ? row.FPAGO_CHEQUE
            : filtro === 'efectivo'
              ? row.FPAGO_EFECTIVO
              : row.TOTALPRECIO;
    const n = Number(raw) || 0;
    return filtro === 'devoluciones' ? Math.abs(n) : n;
  },

  filterDocumentosRows(rows, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return rows;
    return (rows || []).filter((r) => {
      const hay = [
        this.formatFecha(r.FECHA),
        r.CODDOC,
        r.CORRELATIVO,
        r.VENDEDOR,
        r.DOC_NOMCLIE,
        r.TIPODOC,
      ]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      return hay.includes(q);
    });
  },

  renderDocumentosTableHtml(filtro, rows, options = {}) {
    const importeLabel = this.importeColumnLabel(filtro);
    const isDevoluciones = filtro === 'devoluciones';
    const emptyMessage = options.emptyMessage || 'Sin documentos en este filtro.';
    if (!rows.length) {
      return `<p class="text-muted small mb-0 text-center py-3">${this.escapeHtml(emptyMessage)}</p>`;
    }
    let total = 0;
    const body = rows
      .map((r) => {
        const imp = Number(this.rowImporte(r, filtro)) || 0;
        total += imp;
        return `
          <tr>
            <td class="text-nowrap">${this.escapeHtml(this.formatFecha(r.FECHA))}</td>
            <td class="text-nowrap">${this.escapeHtml(r.CODDOC)}${isDevoluciones && r.TIPODOC ? ` <span class="text-muted small">(${this.escapeHtml(r.TIPODOC)})</span>` : ''}</td>
            <td class="text-end">${this.escapeHtml(r.CORRELATIVO)}</td>
            <td>${this.escapeHtml(r.VENDEDOR || '—')}</td>
            <td>${this.escapeHtml(r.DOC_NOMCLIE || '—')}</td>
            <td class="text-end fw-semibold">${this.escapeHtml(this.formatMoney(imp))}</td>
          </tr>`;
      })
      .join('');
    return `
      <div class="table-responsive corte-caja-docs-modal-table">
        <table class="table table-sm table-hover align-middle mb-0">
          <thead class="table-light">
            <tr>
              <th>Fecha</th>
              <th>CODDOC</th>
              <th class="text-end">Correlativo</th>
              <th>Vendedor</th>
              <th>Cliente</th>
              <th class="text-end">${this.escapeHtml(importeLabel)}</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot class="table-light">
            <tr>
              <th colspan="5" class="text-end">${rows.length} documento(s)</th>
              <th class="text-end">${this.escapeHtml(this.formatMoney(total))}</th>
            </tr>
          </tfoot>
        </table>
      </div>`;
  },

  renderDocumentosModalHtml(filtro, rows) {
    return `
      <div class="corte-caja-docs-modal text-start">
        <div class="input-group input-group-sm mb-2">
          <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
          <input type="search" class="form-control" id="corte-docs-search"
            placeholder="Buscar: CODDOC, correlativo, vendedor, cliente…"
            autocomplete="off">
        </div>
        <div id="corte-docs-modal-body">
          ${this.renderDocumentosTableHtml(filtro, rows)}
        </div>
      </div>`;
  },

  renderCajasHtml() {
    if (!this._cajas.length) {
      return `<p class="text-muted small mb-0">No hay cajas registradas para esta empresa.</p>`;
    }
    return `
      <div class="corte-caja-list-stack d-flex flex-column gap-2">
        ${this._cajas
          .map((c) => {
            const abierta = this.isAbierta(c);
            const selected = String(c.CODCAJA) === String(this._selectedCodcaja);
            return `
            <button type="button" class="card corte-caja-caja-card w-100 text-start p-3${selected ? ' is-selected' : ''}"
              data-codcaja="${c.CODCAJA}">
              <div class="d-flex justify-content-between align-items-start mb-1">
                <strong>${this.escapeHtml(c.DESCAJA)}</strong>
                <span class="badge ${abierta ? 'text-bg-success' : 'text-bg-secondary'}">
                  ${abierta ? 'Abierta' : 'Cerrada'}
                </span>
              </div>
              <div class="small text-muted">Código ${this.escapeHtml(c.CODCAJA)}</div>
              ${abierta && this._muestraDatos ? `<div class="small mt-1">Efectivo inicial: <strong>${this.escapeHtml(this.formatMoney(c.EFECTIVOINICIAL))}</strong></div>` : ''}
            </button>`;
          })
          .join('')}
      </div>`;
  },

  renderResumenHtml() {
    const caja = this.selectedCaja();
    if (!caja) {
      return `
        <div class="card shadow-sm corte-caja-panel-card h-100">
          <div class="card-body text-muted text-center py-4">Seleccione una caja</div>
        </div>`;
    }

    if (!this.isAbierta(caja)) {
      return `
        <div class="card shadow-sm corte-caja-panel-card h-100">
          <div class="card-body">
            <h6 class="card-title mb-2">
              <i class="fa-solid fa-lock me-1 text-secondary"></i>${this.escapeHtml(caja.DESCAJA)}
            </h6>
            <p class="small text-muted mb-3">La caja está cerrada. Abra la caja para registrar ventas y realizar el corte al final del turno.</p>
            <button type="button" class="btn btn-success btn-sm" id="btn-corte-abrir">
              <i class="fa-solid fa-lock-open me-1"></i>Abrir caja
            </button>
          </div>
        </div>`;
    }

    const r = this._resumen;
    if (!r) {
      return `
        <div class="card shadow-sm corte-caja-panel-card h-100">
          <div class="card-body text-center text-muted py-4">
            <i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando resumen…
          </div>
        </div>`;
    }

    const statsHtml = this.renderResumenStats(r);
    const blindNotice = !this._muestraDatos
      ? `<div class="alert alert-warning py-2 px-3 small mb-3 corte-caja-blind-notice">
          <i class="fa-solid fa-eye-slash me-1"></i>
          <strong>Arqueo ciego:</strong> ingrese los montos contados. Los totales del sistema no se muestran por seguridad.
        </div>`
      : '';

    return `
      <div class="row g-3 corte-caja-panel-row">
        <div class="col-12 col-xl-8">
          <div class="card shadow-sm corte-caja-panel-card h-100">
            <div class="card-body">
              <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                <h6 class="card-title mb-0">
                  <i class="fa-solid fa-cash-register me-1 text-primary"></i>${this.escapeHtml(caja.DESCAJA)} — turno abierto
                </h6>
                <span class="badge text-bg-success">Abierta</span>
              </div>
              ${blindNotice}
              ${statsHtml ? `<div class="corte-caja-stats mb-3">${statsHtml}</div>` : ''}
              <hr class="my-3">
              <h6 class="small fw-semibold mb-2">Cerrar caja — arqueo</h6>
              ${this.renderArqueoInputs(r)}
              <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mt-3">
                <div class="d-flex flex-wrap gap-2">
                  <button type="button" class="btn btn-danger btn-sm" id="btn-corte-cerrar">
                    <i class="fa-solid fa-lock me-1"></i>Cerrar caja
                  </button>
                  ${this._muestraDatos ? `<button type="button" class="btn btn-outline-secondary btn-sm" id="btn-corte-refrescar">
                    <i class="fa-solid fa-rotate-right me-1"></i>Refrescar
                  </button>` : ''}
                </div>
                <button type="button" class="btn btn-outline-primary btn-sm" id="btn-corte-retiro">
                  <i class="fa-solid fa-building-columns me-1"></i>Retiro de efectivo
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="col-12 col-xl-4">
          ${this.renderDenominacionesCard()}
        </div>
      </div>`;
  },

  renderHtml() {
    return `
      <div class="corte-caja-wrap w-100">
        <div class="card shadow-sm mb-0">
          <div class="card-body">
            <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2">
              <div>
                <h5 class="card-title mb-2">
                  <i class="fa-solid fa-money-check me-1 text-primary"></i>Corte de caja
                </h5>
                <p class="small text-muted mb-0">
                  Abra la caja al iniciar el turno (efectivo inicial). Al cerrarla se genera un registro en
                  <strong>CORTES</strong> con el resumen de movimientos del período.
                </p>
              </div>
              <button type="button" class="btn btn-outline-secondary btn-sm" id="btn-corte-historial">
                <i class="fa-solid fa-clock-rotate-left me-1"></i>Historial de cortes
              </button>
            </div>
            <div class="row g-3 corte-caja-main-row mt-1">
              <div class="col-12 col-lg-3 col-xl-2">
                <h6 class="small fw-semibold mb-2">Cajas</h6>
                <div id="corte-caja-list">${this.renderCajasHtml()}</div>
              </div>
              <div class="col-12 col-lg-9 col-xl-10" id="corte-caja-panel">${this.renderResumenHtml()}</div>
            </div>
          </div>
        </div>
      </div>`;
  },

  bindHeaderEvents() {
    document.getElementById('btn-corte-historial')?.addEventListener('click', () => {
      this.showHistorialModal().catch((err) =>
        F.toast(err.message || 'No se pudo abrir el historial', 'error')
      );
    });
  },

  refreshPanels() {
    const list = this._container?.querySelector('#corte-caja-list');
    const panel = this._container?.querySelector('#corte-caja-panel');
    if (list) list.innerHTML = this.renderCajasHtml();
    if (panel) panel.innerHTML = this.renderResumenHtml();
    this.bindPanelEvents();
  },

  bindCajaSelect() {
    this._container?.querySelectorAll('[data-codcaja]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        this._selectedCodcaja = btn.dataset.codcaja;
        this._resumen = null;
        this.resetDenomCounts();
        this.refreshPanels();
        await this.loadResumen();
        this.refreshPanels();
      });
    });
  },

  bindDenominacionesEvents() {
    this._container?.querySelectorAll('.corte-denom-qty').forEach((inp) => {
      inp.addEventListener('input', () => {
        const key = inp.dataset.denomKey;
        const count = Math.max(0, Math.floor(Number(inp.value) || 0));
        if (count !== Number(inp.value)) inp.value = String(count);
        if (key) this._denomCounts[key] = count;
        this.updateEfectivoFromDenoms();
      });
    });
    document.getElementById('btn-corte-denom-clear')?.addEventListener('click', () => {
      this.resetDenomCounts();
      this._container?.querySelectorAll('.corte-denom-qty').forEach((inp) => {
        inp.value = '0';
      });
      this.updateEfectivoFromDenoms();
    });
  },

  bindPanelEvents() {
    this.bindCajaSelect();
    this.bindDenominacionesEvents();
    document.getElementById('btn-corte-abrir')?.addEventListener('click', () => this.onAbrir());
    document.getElementById('btn-corte-cerrar')?.addEventListener('click', () => this.onCerrar());
    document.getElementById('btn-corte-refrescar')?.addEventListener('click', () => this.refreshResumen());
    document.getElementById('btn-corte-retiro')?.addEventListener('click', () => {
      this.onRetiroEfectivo().catch((err) => F.toast(err.message || 'Error en retiro', 'error'));
    });
    this._container?.querySelectorAll('[data-corte-filtro]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const filtro = btn.getAttribute('data-corte-filtro');
        if (filtro) this.showDocumentosModal(filtro);
      });
    });
    if (this.hasDenomCounts()) this.updateEfectivoFromDenoms();
  },

  async onAbrir() {
    const caja = this.selectedCaja();
    if (!caja || this._loading) return;

    const sugeridoRaw = Number(caja.EFECTIVO_PROXIMA_CAJA);
    const sugerido = Number.isFinite(sugeridoRaw) && sugeridoRaw >= 0 ? sugeridoRaw : 0;
    const sugeridoAttr = String(sugerido);
    const hint =
      sugerido > 0
        ? `<p class="small text-muted mb-2 text-start">Sugerido según efectivo contado del último cierre: <strong>${this.escapeHtml(this.formatMoney(sugerido))}</strong></p>`
        : '';

    const { isConfirmed, value } = await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Abrir caja',
      html: `
        <p class="small text-muted mb-2">${this.escapeHtml(caja.DESCAJA)}</p>
        ${hint}
        <label class="form-label small mb-0 text-start w-100" for="corte-abrir-efectivo">Efectivo inicial en caja</label>
        <input type="number" id="corte-abrir-efectivo" class="form-control" min="0" step="0.01" value="${this.escapeHtml(sugeridoAttr)}">
      `,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: CatalogosUI.guardarButtonHtml('Abrir caja'),
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
      focusConfirm: false,
      didOpen: () => {
        const input = document.getElementById('corte-abrir-efectivo');
        input?.focus();
        input?.select?.();
      },
      preConfirm: () => {
        const v = Number(document.getElementById('corte-abrir-efectivo')?.value ?? 0);
        if (!Number.isFinite(v) || v < 0) {
          Swal.showValidationMessage('Ingrese un monto válido');
          return false;
        }
        return v;
      },
    });
    if (!isConfirmed) return;

    this._loading = true;
    try {
      const url = `/api/corte-caja/${encodeURIComponent(caja.CODCAJA)}/abrir?empnit=${encodeURIComponent(F.getEmpNit())}`;
      await F.fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ EFECTIVOINICIAL: value }),
      });
      F.toast('Caja abierta', 'success');
      await this.reload();
    } catch (err) {
      F.toast(err.message || 'No se pudo abrir la caja', 'error');
    } finally {
      this._loading = false;
    }
  },

  async onCerrar() {
    const caja = this.selectedCaja();
    if (!caja || !this._resumen || this._loading) return;

    const totalReportado = Number(document.getElementById('corte-total-reportado')?.value ?? 0);
    const reportadoTarjeta = Number(document.getElementById('corte-reportado-tarjeta')?.value ?? 0);
    const reportadoCheques = Number(document.getElementById('corte-reportado-cheques')?.value ?? 0);
    const reportadoDeposito = Number(document.getElementById('corte-reportado-deposito')?.value ?? 0);
    const obs = document.getElementById('corte-obs')?.value?.trim() || '';

    if (!Number.isFinite(totalReportado) || totalReportado < 0) {
      F.toast('Ingrese un monto válido de efectivo contado', 'warning');
      return;
    }

    let confirmHtml = '<p class="small mb-2">Se registrará el corte y la caja quedará <strong>cerrada</strong>.</p>';
    if (this._muestraDatos) {
      const diff = Math.round((totalReportado - this._resumen.efectivoEsperado) * 100) / 100;
      const diffTxt =
        diff === 0
          ? 'Sin diferencia en efectivo.'
          : diff < 0
            ? `Faltante: ${this.formatMoney(Math.abs(diff))}`
            : `Sobrante: ${this.formatMoney(diff)}`;
      confirmHtml += `<p class="small text-muted mb-0">${this.escapeHtml(diffTxt)}</p>`;
    } else {
      confirmHtml +=
        '<p class="small text-muted mb-0">Confirme los montos ingresados antes de cerrar.</p>';
    }

    const { isConfirmed } = await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Cerrar caja',
      html: confirmHtml,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: CatalogosUI.guardarButtonHtml('Cerrar caja'),
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
    });
    if (!isConfirmed) return;

    this._loading = true;
    try {
      const url = `/api/corte-caja/${encodeURIComponent(caja.CODCAJA)}/cerrar?empnit=${encodeURIComponent(F.getEmpNit())}`;
      const data = await F.fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          TOTALREPORTADO: totalReportado,
          REPORTADOTARJETA: reportadoTarjeta,
          REPORTADOCHEQUES: reportadoCheques,
          REPORTADO_DEPOSITO: reportadoDeposito,
          OBS: obs,
          USUARIO: this.usuarioNombre(),
        }),
      });
      const msg =
        data.faltante > 0
          ? `Corte #${data.corte.CORRELATIVO} — faltante ${this.formatMoney(data.faltante)}`
          : data.sobrante > 0
            ? `Corte #${data.corte.CORRELATIVO} — sobrante ${this.formatMoney(data.sobrante)}`
            : `Corte #${data.corte.CORRELATIVO} registrado`;
      F.toast(msg, 'success');
      this.imprimirCorte({
        caja,
        corte: data.corte,
        resumen: data.resumen,
        reportado: {
          efectivo: totalReportado,
          tarjeta: reportadoTarjeta,
          cheques: reportadoCheques,
          deposito: reportadoDeposito,
        },
        faltante: data.faltante,
        sobrante: data.sobrante,
        obs,
        usuarioNombre: this.usuarioNombre(),
      });
      await this.reload();
    } catch (err) {
      F.toast(err.message || 'No se pudo cerrar la caja', 'error');
    } finally {
      this._loading = false;
    }
  },

  async loadCajas() {
    const codempleado = F.sessionCodEmpleado();
    const data = await F.fetchJson(
      this.apiUrl('/cajas', {
        ...(codempleado != null ? { codempleado: String(codempleado) } : {}),
      })
    );
    this._cajas = data.rows || [];
    if (!this._selectedCodcaja && this._cajas.length) {
      const preferred = F.pickCajaDefault(this._cajas, data.cajaDefault ?? data.preferredCaja);
      const preferredRow = preferred
        ? this._cajas.find((c) => String(c.CODCAJA) === String(preferred))
        : null;
      const abierta =
        preferredRow && this.isAbierta(preferredRow)
          ? preferredRow
          : this._cajas.find((c) => this.isAbierta(c));
      this._selectedCodcaja = abierta
        ? abierta.CODCAJA
        : preferredRow
          ? preferredRow.CODCAJA
          : this._cajas[0].CODCAJA;
    }
  },

  async loadResumen() {
    const caja = this.selectedCaja();
    if (!caja || !this.isAbierta(caja)) {
      this._resumen = null;
      return;
    }
    const data = await F.fetchJson(this.apiUrl(`/${caja.CODCAJA}/resumen`));
    this._resumen = data.resumen;
  },

  async refreshResumen() {
    try {
      await this.loadResumen();
      this.refreshPanels();
    } catch (err) {
      F.toast(err.message || 'Error al cargar resumen', 'error');
    }
  },

  async reload() {
    await this.fetchMuestraDatosConfig();
    await this.loadCajas();
    await this.loadResumen();
    this.refreshPanels();
  },

  async load(container) {
    this._container = container;
    this._cajas = [];
    this._resumen = null;
    this._selectedCodcaja = null;
    this.resetDenomCounts();
    container.classList.remove('align-items-center', 'justify-content-center');
    container.classList.add('align-items-stretch', 'justify-content-start');
    container.innerHTML = `
      <div class="text-center text-muted py-5 w-100">
        <i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando corte de caja…
      </div>`;

    try {
      await this.fetchMuestraDatosConfig();
      await this.loadCajas();
      await this.loadResumen();
      container.innerHTML = this.renderHtml();
      this.bindHeaderEvents();
      this.bindPanelEvents();
    } catch (err) {
      container.innerHTML = `
        <div class="alert alert-danger mb-0 w-100">
          No se pudo cargar corte de caja: ${this.escapeHtml(err.message)}
        </div>`;
      F.toast('Error al cargar corte de caja', 'error');
    }
  },
};
