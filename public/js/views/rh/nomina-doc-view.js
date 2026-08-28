/**
 * Factory vista planillas de nómina (interna / IGSS) — listado + editor.
 */
function createNominaDocView(cfg) {
  const P = cfg.prefix;
  const id = (name) => `${P}-${name}`;

  return {
    _container: null,
    _screen: 'list',
    _rows: [],
    _doc: null,
    _mes: null,
    _anio: null,
    _listFilter: '',
    _loading: false,
    _saving: false,
    _lineFilter: '',

    escapeHtml(value) {
      if (value === null || value === undefined) return '';
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    formatMoney(value) {
      const n = Number(value);
      if (Number.isNaN(n)) return 'Q 0.00';
      return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
    },

    moneyPrefix() {
      const sample = this.formatMoney(0);
      const m = sample.match(/^[^\d\-−]+/);
      return m ? m[0].trim() : 'Q';
    },

    statusLabel(code) {
      const map = { B: 'Borrador', C: 'Calculada', F: 'Cerrada', A: 'Anulada' };
      return map[String(code || '').toUpperCase()] || code || '—';
    },

    statusClass(code) {
      const map = { B: 'text-secondary', C: 'text-primary', F: 'text-success', A: 'text-danger' };
      return map[String(code || '').toUpperCase()] || '';
    },

    docEditable(doc) {
      return String(doc?.header?.STATUS || doc?.STATUS || 'B').toUpperCase() !== 'F';
    },

    apiBase(path = '') {
      const emp = F.getEmpNit();
      if (!emp) throw new Error('No hay empresa activa');
      const segment = path ? (path.startsWith('/') ? path : `/${path}`) : '';
      const params = new URLSearchParams({ empnit: emp });
      return `${cfg.apiPath}${segment}?${params}`;
    },

    defaultPeriod() {
      return LibroContableCommon.defaultPeriod();
    },

    async fetchList() {
      const params = new URLSearchParams({
        empnit: F.getEmpNit(),
        mes: String(this._mes),
        anio: String(this._anio),
        _: String(Date.now()),
      });
      const data = await F.fetchJson(`${cfg.apiPath}?${params}`, { cache: 'no-store' });
      this._rows = data.rows || [];
      return data;
    },

    async fetchDoc(planillaId) {
      const data = await F.fetchJson(
        `${cfg.apiPath}/${planillaId}?empnit=${encodeURIComponent(F.getEmpNit())}&_=${Date.now()}`,
        { cache: 'no-store' }
      );
      this._doc = data;
      return data;
    },

    filteredRows() {
      const q = this._listFilter.trim().toLowerCase();
      if (!q) return this._rows;
      return this._rows.filter((r) => {
        const hay = [r.ID, r.DESCRIPCION, r.STATUS, r.PERIODO_TIPO]
          .map((v) => String(v ?? '').toLowerCase())
          .join(' ');
        return hay.includes(q);
      });
    },

    filteredLines() {
      let lines = this._doc?.lines || [];
      if (cfg.requireSalarioBase) {
        lines = lines.filter((l) => Number(l.SALARIO_BASE) > 0);
      }
      const q = this._lineFilter.trim().toLowerCase();
      if (!q) return lines;
      return lines.filter((l) => {
        const hay = [l.CODEMPLEADO, l.NOMEMPLEADO, l.DPI, l.IGSS]
          .map((v) => String(v ?? '').toLowerCase())
          .join(' ');
        return hay.includes(q);
      });
    },

    includedLines() {
      let lines = this._doc?.lines || [];
      if (cfg.requireSalarioBase) {
        lines = lines.filter((l) => Number(l.SALARIO_BASE) > 0);
      }
      return lines.filter((l) => String(l.INCLUIDO || 'SI').toUpperCase() === 'SI');
    },

    renderListCardsHtml() {
      const rows = this.filteredRows();
      if (!rows.length) {
        return `<p class="text-center text-muted py-4 mb-0">Sin planillas en este período</p>`;
      }
      return rows
        .map(
          (r) => `
        <div class="pos-pedido-card nomina-doc-card" data-id="${this.escapeHtml(r.ID)}">
          <div class="pos-pedido-card-top">
            <span class="pos-pedido-card-doc">Planilla #${this.escapeHtml(r.ID)}</span>
            <span class="pos-pedido-card-total">${this.escapeHtml(this.formatMoney(r.TOTAL_NETO))}</span>
          </div>
          <div class="pos-pedido-card-meta small mb-1">
            <span class="${this.statusClass(r.STATUS)} fw-semibold">${this.escapeHtml(this.statusLabel(r.STATUS))}</span>
            · ${this.escapeHtml(r.PERIODO_TIPO || 'MENSUAL')}
          </div>
          <div class="pos-pedido-card-cliente">${this.escapeHtml(r.DESCRIPCION || '—')}</div>
          <div class="small text-muted mb-2">
            Ingresos: ${this.escapeHtml(this.formatMoney(r.TOTAL_INGRESOS))}
            · Deducciones: ${this.escapeHtml(this.formatMoney(r.TOTAL_DEDUCCIONES))}
          </div>
          <div class="inv-card-actions">
            <button type="button" class="btn btn-sm btn-outline-primary inv-card-btn" data-action="editar">
              <i class="fa-solid fa-pen me-1"></i>Abrir
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary inv-card-btn" data-action="imprimir">
              <i class="fa-solid fa-print me-1"></i>Imprimir
            </button>
            ${
              String(r.STATUS) !== 'F'
                ? `<button type="button" class="btn btn-sm btn-outline-danger inv-card-btn" data-action="eliminar">
              <i class="fa-solid fa-trash me-1"></i>Eliminar
            </button>`
                : ''
            }
          </div>
        </div>`
        )
        .join('');
    },

    renderListScreen() {
      const p = LibroContableCommon;
      return `
        <div class="pos-list-wrap nomina-doc-list-wrap w-100">
          <div class="pos-list-header">
            <h2 class="pos-list-title">${this.escapeHtml(cfg.title)}</h2>
            <p class="pos-list-sub text-muted mb-0">${this.filteredRows().length} planilla(s) · ${p.mesLabel(this._mes)} ${this._anio}</p>
          </div>
          <div class="pos-list-toolbar mb-3 d-flex flex-wrap align-items-end gap-2">
            ${p.periodSelectsHtml(P, this._mes, this._anio)}
            <button type="button" class="btn btn-sm btn-outline-primary" id="btn-${P}-recargar">
              <i class="fa-solid fa-rotate me-1"></i>Actualizar
            </button>
            <div class="pos-list-search flex-grow-1">
              <input type="search" class="form-control form-control-sm pos-search-glow" id="${id('list-search')}"
                placeholder="Buscar planilla…" value="${this.escapeHtml(this._listFilter)}">
            </div>
          </div>
          <p class="small text-muted mb-2">
            Solo se incluyen empleados con <code>ACTIVO = SI</code> en la empresa activa.
          </p>
          <div class="pos-pedido-cards" id="${id('list-cards')}">${this.renderListCardsHtml()}</div>
          <button type="button" class="btn-onneb-nuevo-fab pos-list-fab-nuevo" id="btn-${P}-list-nuevo"
            aria-label="Nueva planilla" title="Nueva planilla">
            <i class="fa-solid fa-plus"></i>
          </button>
        </div>`;
    },

    moneyInput(fieldId, value, { readonly = false, extraClass = '' } = {}) {
      const ro = readonly ? 'readonly' : '';
      const cls = extraClass ? ` ${extraClass}` : '';
      return `
        <div class="input-group input-group-sm nomina-money${cls}">
          <span class="input-group-text">Q</span>
          <input type="number" step="0.001" class="form-control form-control-sm" id="${fieldId}"
            value="${value !== '' && value !== null && value !== undefined ? Number(value) : ''}" ${ro}>
        </div>`;
    },

    renderLineRow(line) {
      const h = this._doc?.header || {};
      const editable = this.docEditable({ header: h });
      const incluido = String(line.INCLUIDO || 'SI').toUpperCase() === 'SI';
      const rowClass = incluido ? '' : 'nomina-line-excluded';
      const dis = editable ? '' : 'disabled';
      const salarioQ =
        line.SALARIOQ != null
          ? Number(line.SALARIOQ)
          : (Number(line.SALARIO_BASE) || 0) * ((Number(line.DIAS_LABORADOS) || 0) / 30);
      if (cfg.layoutInterna) {
        return `
        <tr class="nomina-line-row ${rowClass}" data-detalle-id="${this.escapeHtml(line.ID)}"
          data-codemp="${this.escapeHtml(line.CODEMPLEADO)}">
          <td>
            <input type="checkbox" class="form-check-input nomina-inc-check" ${incluido ? 'checked' : ''} ${dis}
              data-field="INCLUIDO" title="Incluir en planilla">
          </td>
          <td>${this.escapeHtml(line.CODEMPLEADO)}</td>
          <td>
            <div>${this.escapeHtml(line.NOMEMPLEADO)}</div>
            ${
              line.DEPARTAMENTO
                ? `<div class="small text-muted">${this.escapeHtml(line.DEPARTAMENTO)}</div>`
                : ''
            }
          </td>
          <td class="nomina-num">${editable ? this.moneyInput(`${id('sal')}-${line.ID}`, line.SALARIO_BASE) : this.escapeHtml(this.formatMoney(line.SALARIO_BASE))}</td>
          <td class="nomina-num">${editable ? `<input type="number" step="0.01" class="form-control form-control-sm" data-field="DIAS_LABORADOS" value="${Number(line.DIAS_LABORADOS ?? 30)}" ${dis}>` : this.escapeHtml(line.DIAS_LABORADOS)}</td>
          <td class="nomina-num text-end fw-semibold nomina-salarioq">${this.escapeHtml(this.formatMoney(salarioQ))}</td>
          <td class="nomina-num">${editable ? this.moneyInput(`${id('bonley')}-${line.ID}`, line.BONO_LEY ?? line.BONIFICACION) : this.escapeHtml(this.formatMoney(line.BONO_LEY ?? line.BONIFICACION))}</td>
          <td class="nomina-num">${editable ? this.moneyInput(`${id('bonadi')}-${line.ID}`, line.BONO_ADICIONAL) : this.escapeHtml(this.formatMoney(line.BONO_ADICIONAL))}</td>
          <td class="nomina-num">${editable ? this.moneyInput(`${id('oing')}-${line.ID}`, line.OTROS_INGRESOS) : this.escapeHtml(this.formatMoney(line.OTROS_INGRESOS))}</td>
          <td class="nomina-num">
            <div class="d-flex align-items-center gap-1">
              ${editable ? this.moneyInput(`${id('oded')}-${line.ID}`, line.OTRAS_DEDUCCIONES, { extraClass: 'flex-grow-1' }) : `<span class="text-end flex-grow-1">${this.escapeHtml(this.formatMoney(line.OTRAS_DEDUCCIONES))}</span>`}
              <button type="button" class="btn btn-sm btn-outline-secondary nomina-line-deducciones" title="Ver deducciones (vales)">
                <i class="fa-solid fa-list"></i>
              </button>
            </div>
          </td>
          <td class="nomina-num text-end">${this.escapeHtml(this.formatMoney(line.IGSS_LABORAL))}</td>
          <td class="nomina-num text-end fw-semibold">${this.escapeHtml(this.formatMoney(line.NETO_PAGAR))}</td>
          <td class="text-nowrap">
            <button type="button" class="btn btn-sm btn-outline-secondary nomina-line-print" title="Recibo">
              <i class="fa-solid fa-receipt"></i>
            </button>
            ${
              editable
                ? `<button type="button" class="btn btn-sm btn-outline-primary nomina-line-save" title="Guardar línea">
              <i class="fa-solid fa-floppy-disk"></i>
            </button>`
                : ''
            }
          </td>
        </tr>`;
      }
      return `
        <tr class="nomina-line-row ${rowClass}" data-detalle-id="${this.escapeHtml(line.ID)}">
          <td>
            <input type="checkbox" class="form-check-input nomina-inc-check" ${incluido ? 'checked' : ''} ${dis}
              data-field="INCLUIDO" title="Incluir en planilla">
          </td>
          <td>${this.escapeHtml(line.CODEMPLEADO)}</td>
          <td>
            <div>${this.escapeHtml(line.NOMEMPLEADO)}</div>
            ${
              line.DEPARTAMENTO
                ? `<div class="small text-muted">${this.escapeHtml(line.DEPARTAMENTO)}</div>`
                : ''
            }
          </td>
          <td class="nomina-num">${editable ? this.moneyInput(`${id('sal')}-${line.ID}`, line.SALARIO_BASE) : this.escapeHtml(this.formatMoney(line.SALARIO_BASE))}</td>
          <td class="nomina-num">${editable ? `<input type="number" step="0.01" class="form-control form-control-sm" data-field="DIAS_LABORADOS" value="${Number(line.DIAS_LABORADOS ?? 30)}" ${dis}>` : this.escapeHtml(line.DIAS_LABORADOS)}</td>
          <td class="nomina-num">${editable ? this.moneyInput(`${id('bonley')}-${line.ID}`, line.BONO_LEY ?? line.BONIFICACION) : this.escapeHtml(this.formatMoney(line.BONO_LEY ?? line.BONIFICACION))}</td>
          <td class="nomina-num">${editable ? this.moneyInput(`${id('bonadi')}-${line.ID}`, line.BONO_ADICIONAL) : this.escapeHtml(this.formatMoney(line.BONO_ADICIONAL))}</td>
          <td class="nomina-num">${editable ? this.moneyInput(`${id('com')}-${line.ID}`, line.COMISION) : this.escapeHtml(this.formatMoney(line.COMISION))}</td>
          <td class="nomina-num">${editable ? this.moneyInput(`${id('oing')}-${line.ID}`, line.OTROS_INGRESOS) : this.escapeHtml(this.formatMoney(line.OTROS_INGRESOS))}</td>
          <td class="nomina-num text-end">${this.escapeHtml(this.formatMoney(line.IGSS_LABORAL))}</td>
          ${
            cfg.showPatronal
              ? `<td class="nomina-num text-end">${this.escapeHtml(this.formatMoney(line.IGSS_PATRONAL))}</td>`
              : ''
          }
          <td class="nomina-num text-end">${this.escapeHtml(this.formatMoney(line.TOTAL_DEDUCCIONES))}</td>
          <td class="nomina-num text-end fw-semibold">${this.escapeHtml(this.formatMoney(line.NETO_PAGAR))}</td>
          <td class="text-nowrap">
            <button type="button" class="btn btn-sm btn-outline-secondary nomina-line-print" title="Recibo">
              <i class="fa-solid fa-receipt"></i>
            </button>
            ${
              editable
                ? `<button type="button" class="btn btn-sm btn-outline-primary nomina-line-save" title="Guardar línea">
              <i class="fa-solid fa-floppy-disk"></i>
            </button>`
                : ''
            }
          </td>
        </tr>`;
    },

    renderLinesTable() {
      const h = this._doc?.header || {};
      const lines = this.filteredLines();
      const editable = this.docEditable({ header: h });
      const rows = lines.map((l) => this.renderLineRow(l)).join('');
      const headInterna = `
                <th>Inc.</th><th>Cód.</th><th>Empleado</th>
                <th>Salario</th><th>Días</th><th>SalarioQ</th>
                <th>Bono ley</th><th>Bono adic.</th><th>Otros ing.</th>
                <th>Deducciones</th><th>IGSS lab.</th><th>Neto</th><th></th>`;
      const headDefault = `
                <th>Inc.</th><th>Cód.</th><th>Empleado</th><th>Salario</th><th>Días</th>
                <th>Bono ley</th><th>Bono adic.</th><th>Com.</th><th>Otros ing.</th><th>IGSS lab.</th>
                ${cfg.showPatronal ? '<th>IGSS pat.</th>' : ''}
                <th>Deducc.</th><th>Neto</th><th></th>`;
      const colSpan = cfg.layoutInterna ? 13 : cfg.showPatronal ? 14 : 13;
      return `
        <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
          <input type="search" class="form-control form-control-sm" style="max-width:280px" id="${id('line-search')}"
            placeholder="Buscar empleado…" value="${this.escapeHtml(this._lineFilter)}">
          ${
            editable
              ? `<button type="button" class="btn btn-sm btn-outline-primary" id="btn-${P}-recalcular">
            <i class="fa-solid fa-calculator me-1"></i>Recalcular todo
          </button>`
              : ''
          }
          <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-${P}-imprimir-resumen">
            <i class="fa-solid fa-print me-1"></i>Imprimir resumen
          </button>
          ${
            cfg.showIgssExport
              ? `<button type="button" class="btn btn-sm btn-outline-success" id="btn-${P}-export-igss">
            <i class="fa-solid fa-file-export me-1"></i>Exportar IGSS
          </button>`
              : ''
          }
        </div>
        <div class="table-responsive nomina-lines-table">
          <table class="table table-sm table-bordered align-middle mb-0">
            <thead>
              <tr>${cfg.layoutInterna ? headInterna : headDefault}</tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="${colSpan}" class="text-center text-muted py-3">Sin líneas</td></tr>`}</tbody>
          </table>
        </div>`;
    },

    renderEditorShell() {
      const h = this._doc?.header || {};
      const editable = this.docEditable({ header: h });
      return `
        <div class="pos-vista-wrap nomina-doc-editor-wrap w-100">
          <div class="pos-header card shadow-sm mb-2">
            <div class="card-body py-2 d-flex flex-wrap align-items-center gap-2">
              <button type="button" class="btn btn-sm btn-outline-secondary pos-btn-atras" id="btn-${P}-atras">
                <i class="fa-solid fa-arrow-left me-1"></i>Atrás
              </button>
              <span class="pos-header-doc-label fw-semibold">
                ${this.escapeHtml(cfg.title)} · #${this.escapeHtml(h.ID)} · ${LibroContableCommon.mesLabel(h.MES)} ${this.escapeHtml(h.ANIO)}
              </span>
              <span class="badge bg-light text-dark border ms-auto ${this.statusClass(h.STATUS)}">${this.escapeHtml(this.statusLabel(h.STATUS))}</span>
            </div>
          </div>
          <div class="card shadow-sm mx-2 mb-2">
            <div class="card-body py-2">
              <div class="row g-2 small">
                <div class="col-md-3"><strong>Descripción:</strong> ${this.escapeHtml(h.DESCRIPCION || '—')}</div>
                <div class="col-md-3"><strong>Total ingresos:</strong> ${this.escapeHtml(this.formatMoney(h.TOTAL_INGRESOS))}</div>
                <div class="col-md-3"><strong>Total deducciones:</strong> ${this.escapeHtml(this.formatMoney(h.TOTAL_DEDUCCIONES))}</div>
                <div class="col-md-3"><strong>Neto:</strong> ${this.escapeHtml(this.formatMoney(h.TOTAL_NETO))}</div>
                ${
                  cfg.showPatronal
                    ? `<div class="col-md-3"><strong>IGSS patronal:</strong> ${this.escapeHtml(this.formatMoney(h.TOTAL_IGSS_PAT))}</div>`
                    : ''
                }
              </div>
            </div>
          </div>
          <div class="card shadow-sm mx-2 mb-5">
            <div class="card-body" id="${id('editor-body')}">${this.renderLinesTable()}</div>
          </div>
          ${
            editable
              ? `<div class="pos-fab-bar" id="${id('fab-bar')}">
            <button type="button" class="pos-fab-finalizar" id="btn-${P}-cerrar">
              <i class="fa-solid fa-lock me-2"></i>Cerrar planilla
            </button>
          </div>`
              : ''
          }
        </div>`;
    },

    readLinePayload(rowEl) {
      const detalleId = rowEl.dataset.detalleId;
      const getNum = (sel) => {
        const el = rowEl.querySelector(sel);
        return el ? Number(el.value) || 0 : 0;
      };
      const inclCheck = rowEl.querySelector('.nomina-inc-check');
      const payload = {
        SALARIO_BASE: getNum(`#${id('sal')}-${detalleId}`),
        DIAS_LABORADOS: getNum('[data-field="DIAS_LABORADOS"]'),
        BONO_LEY: getNum(`#${id('bonley')}-${detalleId}`),
        BONO_ADICIONAL: getNum(`#${id('bonadi')}-${detalleId}`),
        BONIFICACION: getNum(`#${id('bonley')}-${detalleId}`),
        OTROS_INGRESOS: getNum(`#${id('oing')}-${detalleId}`),
        INCLUIDO: inclCheck?.checked ? 'SI' : 'NO',
      };
      if (cfg.layoutInterna) {
        payload.OTRAS_DEDUCCIONES = getNum(`#${id('oded')}-${detalleId}`);
        payload.COMISION = 0;
      } else {
        payload.COMISION = getNum(`#${id('com')}-${detalleId}`);
      }
      return { detalleId, payload };
    },

    todayIso() {
      const d = new Date();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    },

    deduccionesApiUrl(planillaId, detalleId, suffix = '', extraParams = {}) {
      const params = new URLSearchParams({ empnit: F.getEmpNit() || '' });
      Object.entries(extraParams).forEach(([key, value]) => {
        if (value != null && value !== '') params.set(key, String(value));
      });
      return `${cfg.apiPath}/${planillaId}/lineas/${detalleId}/deducciones${suffix}?${params}`;
    },

    async fetchDeduccionesData(line) {
      const planillaId = this._doc?.header?.ID;
      const detalleId = line?.ID;
      if (!planillaId || !detalleId) return null;
      return F.fetchJson(
        this.deduccionesApiUrl(planillaId, detalleId, '', {
          codemp: line.CODEMPLEADO,
          _: Date.now(),
        }),
        { cache: 'no-store' }
      );
    },

    renderDeduccionesValesHtml(vales, deducciones, editable) {
      if (!vales?.length) {
        return '<p class="text-muted small mb-0 text-center py-3">Sin vales pendientes.</p>';
      }
      const abonados = new Set(
        (deducciones || [])
          .filter((d) => d.TIPO === 'VALE' && d.PAGO_VALE_ID && d.REF_ID)
          .map((d) => Number(d.REF_ID))
      );
      const trs = vales
        .map((r) => {
          const yaAbonado = abonados.has(Number(r.ID));
          const btn = editable
            ? `<button type="button" class="btn btn-sm btn-outline-primary nomina-ded-abonar-vale" data-vale-id="${this.escapeHtml(r.ID)}" data-cuota="${Number(r.CUOTA_SUGERIDA) || 0}" data-saldo="${Number(r.SALDO) || 0}" ${yaAbonado ? 'disabled title="Ya abonado en esta nómina"' : ''}>
                <i class="fa-solid fa-hand-holding-dollar"></i>
              </button>`
            : '';
          return `<tr>
            <td class="small">#${this.escapeHtml(r.ID)}</td>
            <td class="text-nowrap small">${this.escapeHtml(r.FECHA ? String(r.FECHA).slice(0, 10) : '—')}</td>
            <td class="small">${this.escapeHtml(r.DESCRIPCION || '—')}</td>
            <td class="text-end small">${this.escapeHtml(this.formatMoney(r.SALDO))}</td>
            <td class="text-end small fw-semibold">${this.escapeHtml(this.formatMoney(r.CUOTA_SUGERIDA))}</td>
            <td class="text-center">${btn}</td>
          </tr>`;
        })
        .join('');
      return `
        <div class="table-responsive nomina-ded-vales-table">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th>#</th><th>Fecha</th><th>Descripción</th>
                <th class="text-end">Saldo</th><th class="text-end">Cuota sug.</th><th></th>
              </tr>
            </thead>
            <tbody>${trs}</tbody>
          </table>
        </div>`;
    },

    renderDeduccionesCargosHtml(deducciones, editable) {
      if (!deducciones?.length) {
        return '<p class="text-muted small mb-0 text-center py-3">Sin deducciones cargadas.</p>';
      }
      const trs = deducciones
        .map((d) => {
          const tipoLabel =
            d.TIPO === 'VALE' ? 'Vale' : d.TIPO === 'MANUAL' ? 'Manual' : this.escapeHtml(d.TIPO || '—');
          const estado =
            d.TIPO === 'VALE' && String(d.ABONO_APLICADO || '').toUpperCase() === 'SI'
              ? '<span class="badge text-bg-success">Abonado</span>'
              : d.TIPO === 'VALE'
                ? '<span class="badge text-bg-warning text-dark">Pend. abono</span>'
                : '<span class="badge text-bg-secondary">Cargo</span>';
          const delBtn = editable
            ? `<button type="button" class="btn btn-sm btn-outline-danger nomina-ded-del-cargo" data-ded-id="${this.escapeHtml(d.ID)}" title="Quitar deducción">
                <i class="fa-solid fa-trash-can"></i>
              </button>`
            : '';
          return `<tr>
            <td class="small">${tipoLabel}</td>
            <td class="small">${this.escapeHtml(d.DESCRIPCION || '—')}</td>
            <td class="text-end small fw-semibold">${this.escapeHtml(this.formatMoney(d.MONTO))}</td>
            <td class="small">${estado}</td>
            <td class="text-center">${delBtn}</td>
          </tr>`;
        })
        .join('');
      return `
        <div class="table-responsive nomina-ded-cargos-table">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th>Tipo</th><th>Descripción</th><th class="text-end">Monto</th><th>Estado</th><th></th>
              </tr>
            </thead>
            <tbody>${trs}</tbody>
          </table>
        </div>`;
    },

    renderDeduccionesModalHtml(data, editable) {
      return `
        <p class="small text-muted mb-2">
          <strong>${this.escapeHtml(data.detalle?.NOMEMPLEADO || '')}</strong>
          · Total a descontar: <strong>${this.escapeHtml(this.formatMoney(data.totalCargos))}</strong>
        </p>
        <div class="row g-3 nomina-ded-modal-panels">
          <div class="col-md-6">
            <div class="nomina-ded-panel border rounded p-2 h-100">
              <div class="small fw-semibold mb-2">Vales pendientes</div>
              <div id="nomina-ded-vales-wrap">${this.renderDeduccionesValesHtml(data.vales, data.deducciones, editable)}</div>
            </div>
          </div>
          <div class="col-md-6">
            <div class="nomina-ded-panel border rounded p-2 h-100">
              <div class="small fw-semibold mb-2">Deducciones en nómina</div>
              <div id="nomina-ded-cargos-wrap">${this.renderDeduccionesCargosHtml(data.deducciones, editable)}</div>
            </div>
          </div>
        </div>`;
    },

    applyDeduccionesModalHtml(container, data, editable) {
      if (!container) return;
      const valesWrap = container.querySelector('#nomina-ded-vales-wrap');
      const cargosWrap = container.querySelector('#nomina-ded-cargos-wrap');
      if (valesWrap) {
        valesWrap.innerHTML = this.renderDeduccionesValesHtml(data.vales, data.deducciones, editable);
      }
      if (cargosWrap) {
        cargosWrap.innerHTML = this.renderDeduccionesCargosHtml(data.deducciones, editable);
      }
      const totalEl = container.querySelector('.nomina-ded-total-label');
      if (totalEl) {
        totalEl.textContent = this.formatMoney(data.totalCargos);
      }
    },

    bindDeduccionesModalEvents(container, line, editable, refreshModal) {
      if (!container || !editable) return;
      container.querySelectorAll('.nomina-ded-abonar-vale').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idVale = btn.dataset.valeId;
          const saldo = Number(btn.dataset.saldo) || 0;
          const cuota = Number(btn.dataset.cuota) || 0;
          await this.showAbonoValeNominaModal(line, { ID: idVale, SALDO: saldo, CUOTA_SUGERIDA: cuota }, refreshModal);
        });
      });
      container.querySelectorAll('.nomina-ded-del-cargo').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const dedId = btn.dataset.dedId;
          const confirm = await Swal.fire({
            ...(typeof CatalogosUI !== 'undefined' ? CatalogosUI.modalBase() : {}),
            icon: 'warning',
            title: 'Quitar deducción',
            text: '¿Quitar esta deducción de la nómina?',
            showCancelButton: true,
            confirmButtonText:
              typeof CatalogosUI !== 'undefined' ? CatalogosUI.guardarButtonHtml('Quitar') : 'Quitar',
            cancelButtonText:
              typeof CatalogosUI !== 'undefined' ? CatalogosUI.cancelButtonHtml('Cancelar') : 'Cancelar',
          });
          if (!confirm.isConfirmed) return;
          try {
            const planillaId = this._doc?.header?.ID;
            const data = await F.fetchJson(this.deduccionesApiUrl(planillaId, line.ID, `/${dedId}`), {
              method: 'DELETE',
            });
            if (data.planilla) this._doc = data.planilla;
            this.refreshEditorBody();
            await refreshModal();
            F.toast('Deducción eliminada', 'success');
          } catch (err) {
            F.alert('Error', err.message || 'No se pudo eliminar', 'error');
          }
        });
      });
    },

    async showAbonoValeNominaModal(line, vale, refreshParent) {
      const planillaId = this._doc?.header?.ID;
      const detalleId = line?.ID;
      const idVale = vale?.ID ?? vale?.id;
      if (!planillaId || !detalleId || idVale == null) return;

      let data;
      try {
        data = await this.fetchDeduccionesData(line);
      } catch {
        data = { deducciones: [] };
      }
      const existing = (data?.deducciones || []).find(
        (d) => d.TIPO === 'VALE' && Number(d.REF_ID) === Number(idVale)
      );
      const saldo = Number(vale.SALDO) || Number(vale.saldo) || 0;
      const sugerido = existing
        ? Number(existing.MONTO) || 0
        : Number(vale.CUOTA_SUGERIDA ?? vale.cuota) || 0;
      const montoDefault = Math.min(sugerido > 0 ? sugerido : saldo, saldo);

      const result = await Swal.fire({
        ...(typeof CatalogosUI !== 'undefined' ? CatalogosUI.modalBase() : {}),
        title: `Abono vale #${idVale}`,
        width: '26rem',
        html: `
          <div class="text-start">
            <p class="small text-muted mb-2">Saldo del vale: <strong>${this.escapeHtml(this.formatMoney(saldo))}</strong></p>
            <label class="form-label small mb-0" for="nomina-abono-fecha">Fecha</label>
            <input type="date" id="nomina-abono-fecha" class="form-control form-control-sm mb-2" value="${this.todayIso()}">
            <label class="form-label small mb-0" for="nomina-abono-monto">Importe a descontar</label>
            <div class="input-group input-group-sm">
              <span class="input-group-text">${this.escapeHtml(this.moneyPrefix())}</span>
              <input type="number" id="nomina-abono-monto" class="form-control text-end" min="0.001" step="0.001" max="${saldo}" value="${montoDefault}">
            </div>
            <p class="small text-muted mt-2 mb-0">Se registrará el abono al vale y el cargo en la nómina.</p>
          </div>`,
        showCancelButton: true,
        confirmButtonText:
          typeof CatalogosUI !== 'undefined' ? CatalogosUI.guardarButtonHtml('Confirmar') : 'Confirmar',
        cancelButtonText:
          typeof CatalogosUI !== 'undefined' ? CatalogosUI.cancelButtonHtml('Cancelar') : 'Cancelar',
        focusConfirm: false,
        preConfirm: () => {
          const FECHA = document.getElementById('nomina-abono-fecha')?.value?.trim();
          const MONTO = Number(document.getElementById('nomina-abono-monto')?.value);
          if (!FECHA) {
            Swal.showValidationMessage('Ingrese la fecha');
            return false;
          }
          if (!Number.isFinite(MONTO) || MONTO <= 0) {
            Swal.showValidationMessage('Ingrese un importe válido');
            return false;
          }
          if (MONTO > saldo + 0.0005) {
            Swal.showValidationMessage(`No puede superar el saldo (${this.formatMoney(saldo)})`);
            return false;
          }
          return { IDVALE: idVale, FECHA, MONTO };
        },
      });

      if (!result.isConfirmed || !result.value) return;
      try {
        const resp = await F.fetchJson(this.deduccionesApiUrl(planillaId, detalleId, '/vale-abono'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result.value),
        });
        if (resp.planilla) this._doc = resp.planilla;
        this.refreshEditorBody();
        if (typeof refreshParent === 'function') await refreshParent();
        F.toast('Abono registrado en nómina', 'success');
      } catch (err) {
        F.alert('Error', err.message || 'No se pudo registrar el abono', 'error');
      }
    },

    async showDeduccionesModal(line) {
      if (!cfg.layoutInterna) return;
      const codemp = line?.CODEMPLEADO;
      const planillaId = this._doc?.header?.ID;
      const detalleId = line?.ID;
      if (codemp == null || !planillaId || !detalleId) return;
      const editable = this.docEditable({ header: this._doc?.header });

      let modalData;
      try {
        modalData = await this.fetchDeduccionesData(line);
      } catch (err) {
        F.alert('Error', err.message || 'No se pudieron cargar las deducciones', 'error');
        return;
      }

      const refreshModal = async () => {
        modalData = await this.fetchDeduccionesData(line);
        const htmlContainer = Swal.getHtmlContainer();
        this.applyDeduccionesModalHtml(htmlContainer, modalData, editable);
        this.bindDeduccionesModalEvents(htmlContainer, line, editable, refreshModal);
      };

      await Swal.fire({
        ...(typeof CatalogosUI !== 'undefined' ? CatalogosUI.modalBase() : {}),
        title: 'Deducciones de nómina',
        width: '56rem',
        html: this.renderDeduccionesModalHtml(modalData, editable),
        confirmButtonText:
          typeof CatalogosUI !== 'undefined' ? CatalogosUI.aceptarButtonHtml('Cerrar') : 'Cerrar',
        showCancelButton: false,
        didOpen: () => {
          const htmlContainer = Swal.getHtmlContainer();
          this.bindDeduccionesModalEvents(htmlContainer, line, editable, refreshModal);
        },
      });
    },

    async saveLine(detalleId, payload) {
      const planillaId = this._doc?.header?.ID;
      if (!planillaId) return;
      this._saving = true;
      try {
        const data = await F.fetchJson(
          `${cfg.apiPath}/${planillaId}/lineas/${detalleId}?empnit=${encodeURIComponent(F.getEmpNit())}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }
        );
        this._doc = data;
        this.refreshEditorBody();
        F.toast('Línea actualizada', 'success');
      } catch (err) {
        F.alert('Error', err.message || 'No se pudo guardar', 'error');
      } finally {
        this._saving = false;
      }
    },

    refreshListCards() {
      const el = this._container?.querySelector(`#${id('list-cards')}`);
      if (el) el.innerHTML = this.renderListCardsHtml();
    },

    refreshEditorBody() {
      const el = this._container?.querySelector(`#${id('editor-body')}`);
      if (el) {
        el.innerHTML = this.renderLinesTable();
        this.bindEditorEvents();
      }
    },

    render() {
      if (this._screen === 'editor') {
        this._container.innerHTML = this.renderEditorShell();
        this.bindEditorEvents();
      } else {
        this._container.innerHTML = this.renderListScreen();
        this.bindListEvents();
      }
    },

    bindPeriodEvents() {
      const mesEl = document.getElementById(`${P}-mes`);
      const anioEl = document.getElementById(`${P}-anio`);
      const reload = async () => {
        this._mes = Number(mesEl?.value) || this._mes;
        this._anio = Number(anioEl?.value) || this._anio;
        await this.fetchList();
        this.refreshListCards();
        const sub = this._container?.querySelector('.pos-list-sub');
        if (sub) {
          sub.textContent = `${this.filteredRows().length} planilla(s) · ${LibroContableCommon.mesLabel(this._mes)} ${this._anio}`;
        }
      };
      mesEl?.addEventListener('change', reload);
      anioEl?.addEventListener('change', reload);
    },

    bindListEvents() {
      this.bindPeriodEvents();
      this._container.querySelector(`#btn-${P}-recargar`)?.addEventListener('click', async () => {
        await this.fetchList();
        this.refreshListCards();
      });
      this._container.querySelector(`#${id('list-search')}`)?.addEventListener('input', (e) => {
        this._listFilter = e.target.value;
        this.refreshListCards();
      });
      this._container.querySelector(`#btn-${P}-list-nuevo`)?.addEventListener('click', () => this.promptNuevaPlanilla());
      this._container.querySelector(`#${id('list-cards')}`)?.addEventListener('click', (e) => {
        const card = e.target.closest('.nomina-doc-card');
        if (!card) return;
        const planillaId = card.dataset.id;
        const btn = e.target.closest('[data-action]');
        const action = btn?.dataset.action;
        if (action === 'editar') this.openEditor(planillaId);
        else if (action === 'imprimir') this.printPlanilla(planillaId);
        else if (action === 'eliminar') this.deletePlanilla(planillaId);
      });
    },

    bindEditorEvents() {
      this._container.querySelector(`#btn-${P}-atras`)?.addEventListener('click', () => {
        this._screen = 'list';
        this._doc = null;
        this.render();
      });
      this._container.querySelector(`#${id('line-search')}`)?.addEventListener('input', (e) => {
        this._lineFilter = e.target.value;
        this.refreshEditorBody();
      });
      this._container.querySelector(`#btn-${P}-recalcular`)?.addEventListener('click', () => this.recalcularPlanilla());
      this._container.querySelector(`#btn-${P}-imprimir-resumen`)?.addEventListener('click', () => this.printPlanilla());
      this._container.querySelector(`#btn-${P}-export-igss`)?.addEventListener('click', () => this.exportIgss());
      this._container.querySelector(`#btn-${P}-cerrar`)?.addEventListener('click', () => this.cerrarPlanilla());
      this._container.querySelector(`#${id('editor-body')}`)?.addEventListener('click', async (e) => {
        const row = e.target.closest('.nomina-line-row');
        if (!row) return;
        if (e.target.closest('.nomina-line-deducciones')) {
          const detalleId = row.dataset.detalleId;
          const line = (this._doc?.lines || []).find((l) => String(l.ID) === String(detalleId));
          if (line) await this.showDeduccionesModal(line);
          return;
        }
        if (e.target.closest('.nomina-line-print')) {
          const detalleId = row.dataset.detalleId;
          const line = (this._doc?.lines || []).find((l) => String(l.ID) === String(detalleId));
          if (line) {
            await NominaPrint.printReciboEmpleado({
              header: this._doc.header,
              line,
              titulo: cfg.reciboTitle || 'Recibo de nómina',
            });
          }
          return;
        }
        if (e.target.closest('.nomina-line-save')) {
          const { detalleId, payload } = this.readLinePayload(row);
          await this.saveLine(detalleId, payload);
        }
      });
      this._container.querySelector(`#${id('editor-body')}`)?.addEventListener('change', async (e) => {
        if (!e.target.classList.contains('nomina-inc-check')) return;
        const row = e.target.closest('.nomina-line-row');
        if (!row) return;
        const { detalleId, payload } = this.readLinePayload(row);
        await this.saveLine(detalleId, payload);
      });
    },

    async promptNuevaPlanilla() {
      const desc = `${cfg.title} ${LibroContableCommon.mesLabel(this._mes)} ${this._anio}`;
      const periodoOptions =
        cfg.periodoOptions ||
        [
          { value: 'MENSUAL', label: 'MENSUAL (mes)' },
          { value: 'QUINCENAL', label: 'QUINCENAL (15 dias)' },
          { value: 'CATORCENAL', label: 'CATORCENAL (14 dias)' },
          { value: 'SEMANAL', label: 'SEMANAL (7 dias)' },
        ];
      const periodoHtml = periodoOptions
        .map(
          (o, i) =>
            `<option value="${this.escapeHtml(o.value)}"${i === 0 ? ' selected' : ''}>${this.escapeHtml(o.label)}</option>`
        )
        .join('');
      const result = await Swal.fire({
        ...CatalogosUI.modalBase(),
        title: 'Nueva planilla',
        html: `
          <label class="form-label small">Descripción</label>
          <input type="text" id="swal-nomina-desc" class="form-control form-control-sm mb-2" value="${this.escapeHtml(desc)}">
          <label class="form-label small">Tipo período</label>
          <select id="swal-nomina-periodo" class="form-select form-select-sm">
            ${periodoHtml}
          </select>`,
        showCancelButton: true,
        confirmButtonText: CatalogosUI.guardarButtonHtml('Crear'),
        cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
        preConfirm: () => ({
          DESCRIPCION: document.getElementById('swal-nomina-desc')?.value?.trim() || desc,
          PERIODO_TIPO: document.getElementById('swal-nomina-periodo')?.value || 'MENSUAL',
          MES: this._mes,
          ANIO: this._anio,
          USUARIO: F.session('user')?.usuario || 'SISTEMA',
        }),
      });
      if (!result.isConfirmed) return;
      try {
        const data = await F.fetchJson(`${cfg.apiPath}?empnit=${encodeURIComponent(F.getEmpNit())}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result.value),
        });
        this._doc = data;
        this._screen = 'editor';
        this.render();
        F.toast('Planilla creada', 'success');
      } catch (err) {
        F.alert('Error', err.message || 'No se pudo crear la planilla', 'error');
      }
    },

    async openEditor(planillaId) {
      try {
        await this.fetchDoc(planillaId);
        this._screen = 'editor';
        this._lineFilter = '';
        this.render();
      } catch (err) {
        F.alert('Error', err.message || 'No se pudo abrir la planilla', 'error');
      }
    },

    async recalcularPlanilla() {
      const planillaId = this._doc?.header?.ID;
      if (!planillaId) return;
      try {
        const data = await F.fetchJson(
          `${cfg.apiPath}/${planillaId}/recalcular?empnit=${encodeURIComponent(F.getEmpNit())}`,
          { method: 'POST' }
        );
        this._doc = data;
        this.refreshEditorBody();
        F.toast('Planilla recalculada', 'success');
      } catch (err) {
        F.alert('Error', err.message || 'No se pudo recalcular', 'error');
      }
    },

    async cerrarPlanilla() {
      const planillaId = this._doc?.header?.ID;
      if (!planillaId) return;
      const ok = await CatalogosUI.confirmSalir({
        title: '¿Cerrar planilla?',
        text: 'No podrá editar las líneas después de cerrar.',
      });
      if (!ok) return;
      try {
        const data = await F.fetchJson(
          `${cfg.apiPath}/${planillaId}/cerrar?empnit=${encodeURIComponent(F.getEmpNit())}`,
          { method: 'POST' }
        );
        this._doc = data;
        this.render();
        F.toast('Planilla cerrada', 'success');
      } catch (err) {
        F.alert('Error', err.message || 'No se pudo cerrar', 'error');
      }
    },

    async deletePlanilla(planillaId) {
      const ok = await CatalogosUI.confirmSalir({
        title: '¿Eliminar planilla?',
        text: 'Esta acción no se puede deshacer.',
      });
      if (!ok) return;
      try {
        await F.fetchJson(
          `${cfg.apiPath}/${planillaId}?empnit=${encodeURIComponent(F.getEmpNit())}`,
          { method: 'DELETE' }
        );
        await this.fetchList();
        this.refreshListCards();
        F.toast('Planilla eliminada', 'success');
      } catch (err) {
        F.alert('Error', err.message || 'No se pudo eliminar', 'error');
      }
    },

    async printPlanilla(planillaId) {
      try {
        if (planillaId) await this.fetchDoc(planillaId);
        if (!this._doc?.header) return;
        await NominaPrint.printPlanillaResumen({
          header: this._doc.header,
          lines: this._doc.lines,
          titulo: cfg.printTitle || cfg.title,
          showPatronal: !!cfg.showPatronal,
        });
      } catch (err) {
        F.alert('Error', err.message || 'No se pudo imprimir', 'error');
      }
    },

    exportIgss() {
      const planillaId = this._doc?.header?.ID;
      if (!planillaId) return;
      const url = `${cfg.apiPath}/${planillaId}/export-igss?empnit=${encodeURIComponent(F.getEmpNit())}`;
      window.open(url, '_blank');
    },

    async load(container) {
      this._container = container;
      container.className = 'main-content flex-grow-1 d-flex p-3 align-items-stretch justify-content-start';
      const period = this.defaultPeriod();
      this._mes = period.mes;
      this._anio = period.anio;
      this._screen = 'list';
      this._listFilter = '';
      container.innerHTML = '<p class="text-muted">Cargando planillas…</p>';
      try {
        await this.fetchList();
        this.render();
      } catch (err) {
        container.innerHTML = `<p class="text-danger">${this.escapeHtml(err.message || 'Error al cargar')}</p>`;
      }
    },
  };
}
