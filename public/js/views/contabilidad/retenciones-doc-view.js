/**
 * Factory vista Retenciones (IVA / ISR) emitidas o recibidas —
 * listado + editor con documentos crédito (dual panel como recibos CXC).
 * cfg.side: 'emitida' (proveedor/CXP) | 'recibida' (cliente/CXC)
 */
function createRetencionesDocView(cfg) {
  const P = cfg.prefix;
  const id = (name) => `${P}-${name}`;
  const kind = cfg.kind === 'isr' ? 'isr' : 'iva';
  const isRecibida = cfg.side === 'recibida';
  const partyLabel = isRecibida ? 'Cliente' : 'Proveedor';
  const partyLabelLower = isRecibida ? 'cliente' : 'proveedor';
  const docsLabel = isRecibida ? 'facturas' : 'compras';
  const docsLabelCap = isRecibida ? 'Facturas' : 'Compras';
  const pendingTitle = isRecibida
    ? 'Facturas crédito FEL (FEF/FEC/FES) con saldo'
    : 'Compras crédito con saldo';
  const pendingEmpty = isRecibida
    ? 'Sin facturas FEL a crédito con saldo'
    : 'Sin compras a crédito con saldo';
  const docColLabel = isRecibida ? 'Factura' : 'Compra';
  const cuentaLabel = isRecibida ? 'cuentas por cobrar' : 'cuentas por pagar';
  const partyCodeField = isRecibida ? 'CODCLIENTE' : 'CODPROV';
  const partyApiSeg = isRecibida ? 'clientes' : 'proveedores';
  const pendingApiSeg = isRecibida ? 'facturas-pendientes' : 'compras-pendientes';
  const partyCodeAttr = 'data-party-code';

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
    _setup: null,
    _parties: [],
    _provQuery: '',
    _pendingDocs: [],
    _pendingQuery: '',
    _pendingDiag: null,
    _abonos: [],
    _calc: { ivaFactor: 1.12, retencionPorcentaje: kind === 'isr' ? 5 : 15 },

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

    roundMoney(n) {
      return Math.round(Number(n) * 1000) / 1000;
    },

    /** Hasta 2 centavos extra sobre el saldo para cerrar por redondeo de retención. */
    maxAbonoRetencion(saldo) {
      return this.roundMoney((Number(saldo) || 0) + 0.02);
    },

    formatDate(value) {
      return LibroContableCommon.formatDate(value);
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

    docEditable(doc) {
      return DocFecha.editableStatus(doc?.STATUS) && !doc?.FINALIZADO;
    },

    calcRetencion(totalPrecio) {
      const total = Number(totalPrecio) || 0;
      const factor = Number(this._calc?.ivaFactor) > 0 ? Number(this._calc.ivaFactor) : 1.12;
      const pct = Number(this._calc?.retencionPorcentaje) || 0;
      const base = this.roundMoney(total / factor);
      // ISR: % sobre base gravada. IVA: % sobre el IVA (total − base).
      const montoBase = kind === 'iva' ? this.roundMoney(Math.max(0, total - base)) : base;
      const retencion = this.roundMoney((montoBase * pct) / 100);
      return { base, iva: this.roundMoney(Math.max(0, total - base)), montoBase, retencion, pct, factor };
    },

    calcLineaRetencion(a) {
      const total = Number(a?.FAC_TOTALPRECIO) || 0;
      const fromTotal = this.calcRetencion(total);
      const baseStored = Number(a?.BASE) || 0;
      const baseInv = Number(a?.FAC_TOTALSINIVA) || 0;
      const ivaInv = Number(a?.FAC_TOTALIVA) || 0;
      const base = baseStored > 0 ? this.roundMoney(baseStored) : baseInv > 0 ? this.roundMoney(baseInv) : fromTotal.base;
      const iva = ivaInv > 0 ? this.roundMoney(ivaInv) : this.roundMoney(Math.max(0, total - base));
      const montoBase = kind === 'iva' ? iva : base;
      const pct = fromTotal.pct;
      const calculado = this.roundMoney((montoBase * pct) / 100);
      return {
        total,
        base,
        iva,
        montoBase,
        pct,
        factor: fromTotal.factor,
        calculado,
        aplicado: this.roundMoney(Number(a?.ABONO) || 0),
      };
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

    async fetchParties(q = '') {
      const params = new URLSearchParams({
        empnit: F.getEmpNit(),
        q: String(q || '').trim(),
        limit: '80',
        _: String(Date.now()),
      });
      const data = await F.fetchJson(`${cfg.apiPath}/${partyApiSeg}?${params}`, { cache: 'no-store' });
      this._parties = data.rows || [];
      return this._parties;
    },

    async fetchPendientes(partyCode, q = '') {
      if (!partyCode) {
        this._pendingDocs = [];
        this._pendingDiag = null;
        return [];
      }
      const params = new URLSearchParams({
        empnit: F.getEmpNit(),
        q: String(q || '').trim(),
        _: String(Date.now()),
      });
      const data = await F.fetchJson(
        `${cfg.apiPath}/${partyApiSeg}/${encodeURIComponent(partyCode)}/${pendingApiSeg}?${params}`,
        { cache: 'no-store' }
      );
      this._pendingDocs = data.rows || [];
      this._pendingDiag = data.diag || null;
      if (data.calc) this._calc = data.calc;
      return this._pendingDocs;
    },

    pendingEmptyHtml() {
      const diag = this._pendingDiag;
      if (!diag) {
        return `<tr><td colspan="7" class="text-center text-muted py-5">${pendingEmpty}</td></tr>`;
      }
      const tips = (diag.tipodocsConSaldo || [])
        .map((t) => `${t.TIPODOC}: ${t.CNT}`)
        .join(', ');
      const hints = [];
      if (diag.facCreSaldo > 0) {
        hints.push(
          `Hay <strong>${diag.facCreSaldo}</strong> factura(s) FAC a crédito con saldo (no se listan; solo FEF/FEC/FES).`
        );
      }
      if (diag.felCre > 0 && diag.felOk === 0) {
        hints.push(
          `Hay <strong>${diag.felCre}</strong> FEL a crédito, pero ninguna con DOC_SALDO &gt; 0.`
        );
      }
      if (!hints.length && diag.anyCreSaldo === 0) {
        hints.push('Este cliente no tiene documentos a crédito con saldo en la empresa activa.');
      }
      if (tips) hints.push(`Tipos con saldo: ${this.escapeHtml(tips)}.`);
      return `<tr><td colspan="7" class="text-center text-muted py-4">
        <div class="mb-2">${pendingEmpty}</div>
        <div class="small text-start mx-auto" style="max-width:28rem">${hints.join('<br>')}</div>
        <div class="small mt-2">Cliente #${this.escapeHtml(this.partyCodeOf() || '')}</div>
      </td></tr>`;
    },

    partyCodeOf(doc = this._doc) {
      if (!doc) return null;
      return doc[partyCodeField] ?? doc.CODCLIENTE ?? doc.CODPROV ?? null;
    },

    filteredRows() {
      const q = this._listFilter.trim().toLowerCase();
      if (!q) return this._rows;
      return this._rows.filter((r) => {
        const hay = [r.CODDOC, r.CORRELATIVO, r.DOC_NOMCLIE, r.DOC_NIT, r.SERIEFAC, r.NOFAC]
          .map((v) => String(v ?? '').toLowerCase())
          .join(' ');
        return hay.includes(q);
      });
    },

    abonosSum() {
      return this.roundMoney(this._abonos.reduce((s, a) => s + (Number(a.ABONO) || 0), 0));
    },

    abonosBaseSum() {
      return this.roundMoney(this._abonos.reduce((s, a) => s + (Number(a.BASE) || 0), 0));
    },

    partyLabelText(code) {
      const p = this._parties.find((x) => String(x[partyCodeField] ?? x.CODCLIENTE ?? x.CODPROV) === String(code));
      if (!p) return this._doc?.DOC_NOMCLIE || '';
      if (isRecibida) {
        const nom = String(p.NOMBRECLIENTE || p.NEGOCIO || '').trim();
        const nit = String(p.NIT || '').trim();
        return nit ? `${nom} (${nit})` : nom;
      }
      const nom = String(p.EMPRESA || p.RAZONSOCIAL || '').trim();
      const nit = String(p.NIT || '').trim();
      return nit ? `${nom} (${nit})` : nom;
    },

    renderListCardsHtml() {
      const rows = this.filteredRows();
      if (!rows.length) {
        return `<p class="text-center text-muted py-4 mb-0">Sin retenciones en este período</p>`;
      }
      return rows
        .map((r) => {
          const estado = r.FINALIZADO
            ? '<span class="badge text-bg-success">Finalizada</span>'
            : '<span class="badge text-bg-secondary">Borrador</span>';
          return `
        <div class="pos-pedido-card inv-doc-card" data-coddoc="${this.escapeHtml(r.CODDOC)}" data-correlativo="${this.escapeHtml(r.CORRELATIVO)}">
          <div class="pos-pedido-card-top">
            <span class="pos-pedido-card-doc">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</span>
            <span class="pos-pedido-card-total">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</span>
          </div>
          <div class="pos-pedido-card-meta small text-muted mb-1">
            ${this.escapeHtml(this.formatDate(r.FECHA))} · ${this.escapeHtml(r.CONCRE === 'CRE' ? 'Crédito' : 'Contado')} · ${estado}
          </div>
          <div class="pos-pedido-card-cliente">${this.escapeHtml(r.DOC_NOMCLIE || '—')}</div>
          <div class="inv-card-actions">
            <button type="button" class="btn btn-sm btn-outline-primary inv-card-btn" data-action="editar">
              <i class="fa-solid fa-pen me-1"></i>${r.FINALIZADO ? 'Ver' : 'Editar'}
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary inv-card-btn" data-action="imprimir">
              <i class="fa-solid fa-print me-1"></i>Imprimir
            </button>
            <button type="button" class="btn btn-sm btn-outline-danger inv-card-btn" data-action="eliminar">
              <i class="fa-solid fa-trash me-1"></i>Eliminar
            </button>
          </div>
        </div>`;
        })
        .join('');
    },

    renderListScreen() {
      const p = LibroContableCommon;
      return `
        <div class="pos-list-wrap ret-doc-list-wrap">
          <div class="pos-list-header">
            <h2 class="pos-list-title">${this.escapeHtml(cfg.title)}</h2>
            <p class="pos-list-sub text-muted mb-0">${this.filteredRows().length} retención(es) · ${p.mesLabel(this._mes)} ${this._anio}</p>
          </div>
          <div class="pos-list-toolbar mb-3 d-flex flex-wrap align-items-end gap-2">
            ${p.periodSelectsHtml(P, this._mes, this._anio)}
            <button type="button" class="btn btn-sm btn-outline-primary" id="btn-${P}-recargar">
              <i class="fa-solid fa-rotate me-1"></i>Actualizar
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-${P}-setup" title="Configurar tipo y formatos contables">
              <i class="fa-solid fa-gears me-1"></i>Configurar ${cfg.setupCode}
            </button>
            <div class="pos-list-search flex-grow-1">
              <input type="search" class="form-control form-control-sm pos-search-glow" id="${id('list-search')}"
                placeholder="Buscar ${partyLabelLower}…" value="${this.escapeHtml(this._listFilter)}">
            </div>
          </div>
          <p class="small text-muted mb-2">
            Formato contado: <code>${cfg.formatoCon}</code> · crédito: <code>${cfg.formatoCre}</code>
            · retención ${this.escapeHtml(String(this._calc.retencionPorcentaje))}% sobre
            ${kind === 'iva' ? `IVA (Total − Total/${this.escapeHtml(String(this._calc.ivaFactor))})` : `base (Total / ${this.escapeHtml(String(this._calc.ivaFactor))})`}
          </p>
          <div class="pos-pedido-cards" id="${id('list-cards')}">${this.renderListCardsHtml()}</div>
          <button type="button" class="btn-onneb-nuevo-fab pos-list-fab-nuevo" id="btn-${P}-list-nuevo"
            aria-label="Nueva retención" title="Nueva retención">
            <i class="fa-solid fa-plus"></i>
          </button>
        </div>`;
    },

    renderPartyItemHtml(p) {
      const cod = String(p[partyCodeField] ?? p.CODCLIENTE ?? p.CODPROV ?? '');
      if (isRecibida) {
        const nom = String(p.NOMBRECLIENTE || p.NEGOCIO || '').trim();
        const negocio = String(p.NEGOCIO || '').trim();
        const nit = String(p.NIT || '').trim();
        return `<button type="button" class="list-group-item list-group-item-action small ret-prov-pick"
          ${partyCodeAttr}="${this.escapeHtml(cod)}">
          <strong>${this.escapeHtml(nom || negocio || cod)}</strong>
          <span class="text-muted d-block">${this.escapeHtml([negocio && negocio !== nom ? negocio : '', nit].filter(Boolean).join(' · '))}</span>
        </button>`;
      }
      const nom = String(p.EMPRESA || p.RAZONSOCIAL || '').trim();
      const razon = String(p.RAZONSOCIAL || '').trim();
      const nit = String(p.NIT || '').trim();
      return `<button type="button" class="list-group-item list-group-item-action small ret-prov-pick"
        ${partyCodeAttr}="${this.escapeHtml(cod)}">
        <strong>${this.escapeHtml(nom || razon || cod)}</strong>
        <span class="text-muted d-block">${this.escapeHtml([razon && razon !== nom ? razon : '', nit].filter(Boolean).join(' · '))}</span>
      </button>`;
    },

    renderPartyPickerHtml(editable) {
      const sel = this.partyCodeOf();
      const label = sel ? this.partyLabelText(sel) : '';
      const dis = editable ? '' : 'disabled';
      return `
        <label class="form-label small mb-1">${partyLabel}</label>
        <div class="ret-prov-picker position-relative">
          <div class="input-group input-group-sm">
            <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
            <input type="search" class="form-control pos-search-glow" id="${id('prov-search')}" ${dis}
              placeholder="Buscar ${partyLabelLower}…"
              value="${this.escapeHtml(this._provQuery || label)}"
              autocomplete="off">
          </div>
          <input type="hidden" id="${id('codparty')}" value="${this.escapeHtml(sel || '')}">
          <div class="small text-muted mt-1" id="${id('prov-selected')}">
            ${sel ? `Seleccionado: <strong>${this.escapeHtml(label)}</strong>` : `Sin ${partyLabelLower} seleccionado`}
          </div>
          ${
            editable
              ? `<div class="list-group position-absolute w-100 shadow-sm d-none ret-prov-results"
                  id="${id('prov-results')}" style="z-index: 20; max-height: 200px; overflow-y: auto;"></div>`
              : ''
          }
        </div>`;
    },

    renderPendingHtml() {
      const editable = this.docEditable(this._doc);
      const hasParty = !!this.partyCodeOf();
      const colSpan = 7;
      const body = !hasParty
        ? `<tr><td colspan="${colSpan}" class="text-center text-muted py-5">Seleccione un ${partyLabelLower}</td></tr>`
        : !this._pendingDocs.length
          ? this.pendingEmptyHtml()
          : this._pendingDocs
              .map((d) => {
                const already = this._abonos.some(
                  (a) =>
                    String(a.CODDOC_FAC) === String(d.CODDOC) &&
                    String(a.CORRELATIVO_FAC) === String(d.CORRELATIVO)
                );
                return `<tr>
          <td class="fw-semibold text-nowrap small">${this.escapeHtml(d.CODDOC)} #${this.escapeHtml(d.CORRELATIVO)}</td>
          <td class="small text-nowrap">${this.escapeHtml(d.SERIEFAC || '—')}</td>
          <td class="small text-nowrap">${this.escapeHtml(d.NOFAC || '—')}</td>
          <td class="small text-nowrap">${this.escapeHtml(this.formatDate(d.FECHA))}</td>
          <td class="text-end small text-muted">${this.escapeHtml(this.formatMoney(d.TOTALPRECIO))}</td>
          <td class="text-end fw-semibold small text-primary">${this.escapeHtml(this.formatMoney(d.DOC_SALDO))}</td>
          <td class="text-end">
            <button type="button" class="btn btn-sm btn-outline-success ret-add-fac"
              data-coddoc="${this.escapeHtml(d.CODDOC)}" data-corr="${this.escapeHtml(d.CORRELATIVO)}"
              ${!editable || already ? 'disabled' : ''}>
              <i class="fa-solid fa-plus"></i>
            </button>
          </td>
        </tr>`;
              })
              .join('');
      return `
      <div class="card shadow-sm prc-editor-panel h-100">
        <div class="card-header py-2">
          <strong class="small"><i class="fa-solid fa-file-invoice-dollar me-1"></i>${pendingTitle}</strong>
          <div class="input-group input-group-sm mt-2">
            <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
            <input type="search" class="form-control" id="${id('pending-search')}"
              placeholder="Buscar ${docsLabel.slice(0, -1)}, serie o número…" value="${this.escapeHtml(this._pendingQuery)}"
              ${hasParty && editable ? '' : 'disabled'}>
          </div>
        </div>
        <div class="card-body">
          <div class="table-responsive prc-panel-scroll">
            <table class="table table-sm table-striped mb-0">
              <thead class="table-light sticky-top">
                <tr>
                  <th>${docColLabel}</th>
                  <th>Serie</th>
                  <th>Número</th>
                  <th>Fecha</th>
                  <th class="text-end">Total</th>
                  <th class="text-end">Saldo</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    },

    renderAbonosHtml() {
      const editable = this.docEditable(this._doc);
      const rows = this._abonos;
      const colSpan = 7;
      const body = !rows.length
        ? `<tr><td colspan="${colSpan}" class="text-center text-muted py-5">Sin ${docsLabel}. Agregue de la izquierda.</td></tr>`
        : rows
            .map((a, idx) => {
              const monto = editable
                ? `<input type="number" class="form-control form-control-sm text-end ret-abono-monto" data-idx="${idx}"
                    min="0.01" step="0.001" value="${this.escapeHtml(a.ABONO)}"
                    max="${this.escapeHtml(this.maxAbonoRetencion(a.FAC_DOC_SALDO))}">`
                : this.escapeHtml(this.formatMoney(a.ABONO));
              const remove = editable
                ? `<button type="button" class="btn btn-sm btn-outline-danger ret-abono-remove" data-idx="${idx}"><i class="fa-solid fa-xmark"></i></button>`
                : '';
              return `<tr>
          <td class="fw-semibold text-nowrap small">${this.escapeHtml(a.CODDOC_FAC)} #${this.escapeHtml(a.CORRELATIVO_FAC)}</td>
          <td class="small text-nowrap">${this.escapeHtml(a.FAC_SERIEFAC || '—')}</td>
          <td class="small text-nowrap">${this.escapeHtml(a.FAC_NOFAC || '—')}</td>
          <td class="small text-nowrap">${this.escapeHtml(this.formatDate(a.FAC_FECHA))}</td>
          <td class="text-end small text-muted">${this.escapeHtml(this.formatMoney(a.FAC_TOTALPRECIO))}</td>
          <td class="text-end" style="min-width:6.5rem">${monto}</td>
          <td class="text-end">${remove}</td>
        </tr>`;
            })
            .join('');
      return `
      <div class="card shadow-sm prc-editor-panel h-100">
        <div class="card-header py-2 d-flex justify-content-between align-items-center">
          <strong class="small"><i class="fa-solid fa-list-check me-1"></i>Facturas en retención</strong>
          <span class="fw-bold text-success">${this.escapeHtml(this.formatMoney(this.abonosSum()))}</span>
        </div>
        <div class="card-body">
          <div class="table-responsive prc-panel-scroll">
            <table class="table table-sm table-striped mb-0">
              <thead class="table-light sticky-top">
                <tr>
                  <th>${docColLabel}</th>
                  <th>Serie</th>
                  <th>Número</th>
                  <th>Fecha</th>
                  <th class="text-end">Total</th>
                  <th class="text-end">A retener</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    },

    renderEditorForm() {
      const d = this._doc || {};
      const editable = this.docEditable(d);
      const dis = editable ? '' : 'disabled';
      const base = this.abonosBaseSum() || Number(d.TOTALSINIVA) || 0;
      const ret = this.abonosSum() || Number(d.TOTALIVA) || Number(d.TOTALPRECIO) || 0;
      return `
        <div class="row g-3 align-items-start mb-3">
          <div class="col-md-8">
            <div class="card shadow-sm h-100">
              <div class="card-header py-2 px-3 small fw-semibold bg-light border-0">
                <i class="fa-solid fa-file-lines me-1 text-primary"></i>Documento
              </div>
              <div class="card-body">
                <div class="row g-2 mb-2">
                  <div class="col-sm-6">
                    <label class="form-label small mb-0">Documento</label>
                    <input type="text" class="form-control form-control-sm" readonly
                      value="${this.escapeHtml(`${d.CODDOC || ''} #${d.CORRELATIVO || ''}`)}">
                  </div>
                  <div class="col-sm-6">
                    <label class="form-label small mb-0" for="${id('fecha')}">Fecha</label>
                    <input type="date" class="form-control form-control-sm" id="${id('fecha')}" ${dis}
                      value="${this.escapeHtml(String(d.FECHA || '').slice(0, 10))}">
                  </div>
                </div>
                <div class="mb-3">${this.renderPartyPickerHtml(editable)}</div>
                <div class="mb-2">
                  <label class="form-label small mb-0" for="${id('obs')}">Observaciones</label>
                  <textarea class="form-control form-control-sm" id="${id('obs')}" rows="2" ${dis}>${this.escapeHtml(d.OBS || '')}</textarea>
                </div>
                ${
                  editable
                    ? `<div class="d-flex flex-wrap gap-2">
                        <button type="button" class="btn btn-sm btn-primary" id="btn-${P}-guardar">
                          <i class="fa-solid fa-floppy-disk me-1"></i>Guardar
                        </button>
                      </div>`
                    : ''
                }
              </div>
            </div>
          </div>
          <div class="col-md-4">
            <div class="card shadow-sm h-100 ret-doc-montos-card">
              <div class="card-header py-2 px-3 small fw-semibold bg-light border-0">
                <i class="fa-solid fa-coins me-1 text-success"></i>Montos
              </div>
              <div class="card-body">
                <div class="mb-3">
                  <label class="form-label small mb-0">${cfg.baseLabel}</label>
                  <input type="text" class="form-control form-control-sm fw-semibold" readonly id="${id('base-display')}"
                    value="${this.escapeHtml(this.formatMoney(base))}">
                </div>
                <div class="row g-2 mb-0">
                  <div class="col-7">
                    <label class="form-label small mb-0">${cfg.retencionLabel}</label>
                    <input type="text" class="form-control form-control-sm fw-semibold text-success" readonly id="${id('ret-display')}"
                      value="${this.escapeHtml(this.formatMoney(ret))}">
                  </div>
                  <div class="col-5">
                    <label class="form-label small mb-0">${docsLabelCap}</label>
                    <input type="text" class="form-control form-control-sm text-end" readonly id="${id('fac-count')}"
                      value="${this._abonos.length}">
                  </div>
                </div>
              </div>
            </div>
            ${
              editable
                ? `<button type="button" class="btn btn-sm btn-outline-primary w-100 mt-2" id="btn-${P}-buscar-factura">
                    <i class="fa-solid fa-file-invoice me-1"></i>Buscar Factura
                  </button>`
                : ''
            }
          </div>
        </div>
        <div class="prc-editor-main ret-doc-dual mb-0">
          ${this.renderPendingHtml()}
          ${this.renderAbonosHtml()}
        </div>`;
    },

    renderEditorShell() {
      const d = this._doc;
      const editable = this.docEditable(d);
      return `
        <div class="pos-vista-wrap ret-doc-editor-wrap">
          <div class="pos-header card shadow-sm mb-2 flex-shrink-0">
            <div class="card-body py-2 d-flex align-items-center gap-2">
              <button type="button" class="btn btn-sm btn-outline-secondary pos-btn-atras" id="btn-${P}-atras">
                <i class="fa-solid fa-arrow-left me-1"></i>Atrás
              </button>
              <span class="pos-header-doc-label fw-semibold">${this.escapeHtml(cfg.title)} · ${this.escapeHtml(d?.CODDOC || '')} #${this.escapeHtml(d?.CORRELATIVO || '')}</span>
              ${d?.FINALIZADO ? '<span class="badge text-bg-success ms-auto">Finalizada</span>' : ''}
              <button type="button" class="btn btn-sm btn-outline-secondary ms-auto" id="btn-${P}-imprimir">
                <i class="fa-solid fa-print me-1"></i>Imprimir
              </button>
            </div>
          </div>
          <div class="ret-doc-editor-scroll mx-2" id="${id('editor-body')}">${this.renderEditorForm()}</div>
          ${editable ? `
            <div class="pos-fab-bar" id="${id('fab-bar')}">
              <button type="button" class="pos-fab-finalizar" id="btn-${P}-finalizar">
                <i class="fa-solid fa-check me-2"></i>Finalizar
              </button>
            </div>` : ''}
        </div>`;
    },

    refreshTotalsDisplay() {
      const baseEl = document.getElementById(id('base-display'));
      const retEl = document.getElementById(id('ret-display'));
      const facEl = document.getElementById(id('fac-count'));
      if (baseEl) baseEl.value = this.formatMoney(this.abonosBaseSum());
      if (retEl) retEl.value = this.formatMoney(this.abonosSum());
      if (facEl) facEl.value = String(this._abonos.length);
    },

    refreshDualPanels() {
      const body = this._container?.querySelector(`#${id('editor-body')}`);
      if (!body) return;
      const dual = body.querySelector('.ret-doc-dual');
      if (!dual) return;
      dual.innerHTML = `${this.renderPendingHtml()}${this.renderAbonosHtml()}`;
      this.bindDualPanelEvents();
      this.refreshTotalsDisplay();
    },

    readEditorPayload() {
      const partyCode = document.getElementById(id('codparty'))?.value || null;
      return {
        FECHA: document.getElementById(id('fecha'))?.value || null,
        [partyCodeField]: partyCode,
        CONCRE: this._doc?.CONCRE || 'CON',
        OBS: document.getElementById(id('obs'))?.value?.trim() || '',
        TOTALSINIVA: this.abonosBaseSum(),
        TOTALIVA: this.abonosSum(),
        TOTALPRECIO: this.abonosSum(),
        abonos: this._abonos.map((a) => ({
          CODDOC_FAC: a.CODDOC_FAC,
          CORRELATIVO_FAC: a.CORRELATIVO_FAC,
          ABONO: Number(a.ABONO) || 0,
          BASE: Number(a.BASE) || 0,
        })),
      };
    },

    addPendingDoc(coddoc, correlativo) {
      const d = this._pendingDocs.find(
        (x) => String(x.CODDOC) === String(coddoc) && String(x.CORRELATIVO) === String(correlativo)
      );
      if (!d) return;
      const exists = this._abonos.some(
        (a) => String(a.CODDOC_FAC) === String(coddoc) && String(a.CORRELATIVO_FAC) === String(correlativo)
      );
      if (exists) return;
      const { base, retencion } = this.calcRetencion(d.TOTALPRECIO);
      const maxSaldo = Number(d.DOC_SALDO) || 0;
      const abono = Math.min(retencion, this.maxAbonoRetencion(maxSaldo));
      this._abonos.push({
        CODDOC_FAC: d.CODDOC,
        CORRELATIVO_FAC: d.CORRELATIVO,
        ABONO: abono,
        BASE: base,
        FAC_FECHA: d.FECHA,
        FAC_TOTALPRECIO: d.TOTALPRECIO,
        FAC_DOC_SALDO: d.DOC_SALDO,
        FAC_SERIEFAC: d.SERIEFAC || null,
        FAC_NOFAC: d.NOFAC || null,
      });
      this.refreshDualPanels();
    },

    removeAbono(idx) {
      this._abonos.splice(idx, 1);
      this.refreshDualPanels();
    },

    refreshListDom() {
      const grid = this._container?.querySelector(`#${id('list-cards')}`);
      if (grid) grid.innerHTML = this.renderListCardsHtml();
    },

    async showList() {
      this._screen = 'list';
      this._doc = null;
      this._abonos = [];
      this._pendingDocs = [];
      await this.fetchList();
      this._container.innerHTML = this.renderListScreen();
      this.bindListEvents();
    },

    async showEditor(coddoc, correlativo) {
      this._screen = 'editor';
      this._doc = await F.fetchJson(this.apiBase(`/${encodeURIComponent(coddoc)}/${correlativo}`), {
        cache: 'no-store',
      });
      if (this._doc.calc) this._calc = this._doc.calc;
      this._abonos = (this._doc.abonos || []).map((a) => ({
        CODDOC_FAC: a.CODDOC_FAC,
        CORRELATIVO_FAC: a.CORRELATIVO_FAC,
        ABONO: Number(a.ABONO) || 0,
        BASE: this.calcRetencion(a.FAC_TOTALPRECIO).base,
        FAC_FECHA: a.FAC_FECHA,
        FAC_TOTALPRECIO: a.FAC_TOTALPRECIO,
        FAC_DOC_SALDO: a.FAC_DOC_SALDO,
        FAC_SERIEFAC: a.FAC_SERIEFAC || null,
        FAC_NOFAC: a.FAC_NOFAC || null,
      }));
      this._provQuery = this.partyLabelText(this.partyCodeOf(this._doc));
      if (this.partyCodeOf(this._doc) && this.docEditable(this._doc)) {
        await this.fetchPendientes(this.partyCodeOf(this._doc));
      } else {
        this._pendingDocs = [];
      }
      this._container.innerHTML = this.renderEditorShell();
      this.bindEditorEvents();
    },

    async reloadListOnly() {
      await this.fetchList();
      this.refreshListDom();
    },

    async runSetup() {
      const data = await F.fetchJson(this.apiBase('/setup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      this._setup = data;
      const warns = (data.warnings || []).join(' ');
      F.toast(
        warns ? `${cfg.setupCode} configurado. ${warns}` : `Tipo ${cfg.setupCode} y formatos contables listos`,
        'success'
      );
    },

    async onNuevo() {
      const user = F.session('user');
      const doc = await F.fetchJson(this.apiBase(''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ USUARIO: user?.usuario || user?.nombre || 'SISTEMA' }),
      });
      await this.showEditor(doc.CODDOC, doc.CORRELATIVO);
      F.toast(`${cfg.labelNueva} creada`, 'success');
    },

    async onGuardar() {
      if (!this._doc || this._saving) return;
      this._saving = true;
      try {
        const payload = this.readEditorPayload();
        if (!payload[partyCodeField]) {
          F.toast(`Seleccione un ${partyLabelLower}`, 'warning');
          return;
        }
        const { CODDOC, CORRELATIVO } = this._doc;
        const doc = await F.fetchJson(
          this.apiBase(`/${encodeURIComponent(CODDOC)}/${CORRELATIVO}`),
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }
        );
        this._doc = { ...doc, abonos: doc.abonos || this._abonos };
        F.toast('Retención guardada', 'success');
      } finally {
        this._saving = false;
      }
    },

    async onFinalizar() {
      if (!this._doc || this._saving) return;
      if (!this._abonos.length) {
        F.toast(`Agregue al menos una ${docsLabel.slice(0, -1)} a la retención`, 'warning');
        return;
      }
      if (this.abonosSum() <= 0) {
        F.toast('El monto de retención debe ser mayor a cero', 'warning');
        return;
      }
      await this.onGuardar();
      this._saving = true;
      try {
        const payload = this.readEditorPayload();
        const { CODDOC, CORRELATIVO } = this._doc;
        await F.fetchJson(
          this.apiBase(`/${encodeURIComponent(CODDOC)}/${CORRELATIVO}/finalizar`),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }
        );
        F.toast(`Retención finalizada — abonos aplicados a ${cuentaLabel}`, 'success');
        this._doc = null;
        await this.showList();
      } finally {
        this._saving = false;
      }
    },

    async eliminarRetencion(coddoc, correlativo) {
      const label = `${coddoc} #${correlativo}`;
      const pass = await CatalogosUI.confirmEliminarDocumento({
        label,
        tipo: cfg.labelSingular,
      });
      if (!pass) return;
      const url = `/api/documentos/${encodeURIComponent(coddoc)}/${correlativo}?empnit=${encodeURIComponent(F.getEmpNit())}`;
      await F.fetchJson(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: String(pass) }),
      });
      F.toast('Retención eliminada', 'success');
      if (
        this._doc &&
        String(this._doc.CODDOC) === String(coddoc) &&
        Number(this._doc.CORRELATIVO) === Number(correlativo)
      ) {
        await this.showList();
      } else {
        await this.reloadListOnly();
      }
    },

    async imprimirRetencion(coddoc, correlativo) {
      const sameEditor =
        this._doc &&
        String(this._doc.CODDOC) === String(coddoc) &&
        Number(this._doc.CORRELATIVO) === Number(correlativo);
      if (sameEditor && this.docEditable(this._doc) && this._abonos.length) {
        try {
          await this.onGuardar();
        } catch (err) {
          F.toast(err.message || 'No se pudieron guardar las facturas antes de imprimir', 'warning');
        }
      }
      const doc = await F.fetchJson(this.apiBase(`/${encodeURIComponent(coddoc)}/${correlativo}`), {
        cache: 'no-store',
      });
      if (doc.calc) this._calc = { ...this._calc, ...doc.calc };
      const abonosApi = Array.isArray(doc.abonos)
        ? doc.abonos
        : Array.isArray(doc.ABONOS)
          ? doc.ABONOS
          : [];
      const abonos =
        abonosApi.length > 0
          ? abonosApi
          : sameEditor && this._abonos.length
            ? this._abonos
            : [];
      const lineas = abonos.map((a) => ({ a, c: this.calcLineaRetencion(a) }));
      const totTotal = this.roundMoney(lineas.reduce((s, x) => s + x.c.total, 0));
      const totBase = this.roundMoney(lineas.reduce((s, x) => s + x.c.base, 0));
      const totIva = this.roundMoney(lineas.reduce((s, x) => s + x.c.iva, 0));
      const totRet = this.roundMoney(lineas.reduce((s, x) => s + x.c.aplicado, 0));
      const pct = Number(this._calc?.retencionPorcentaje) || 0;
      const factor = Number(this._calc?.ivaFactor) > 0 ? Number(this._calc.ivaFactor) : 1.12;
      const formula =
        kind === 'iva'
          ? `Retención IVA = (Total − Total/${factor}) × ${pct}%`
          : `Retención ISR = (Total / ${factor}) × ${pct}%`;
      const headerCols = kind === 'iva'
        ? `<th>${docColLabel}</th><th>Serie</th><th>Número</th><th>Fecha</th>
           <th class="text-end">Total</th><th class="text-end">Base gravada</th>
           <th class="text-end">IVA</th><th class="text-end">%</th><th class="text-end">Retención</th>`
        : `<th>${docColLabel}</th><th>Serie</th><th>Número</th><th>Fecha</th>
           <th class="text-end">Total</th><th class="text-end">Base gravada</th>
           <th class="text-end">%</th><th class="text-end">Retención</th>`;
      const colCount = kind === 'iva' ? 9 : 8;
      const money = (n) => PrintReport.escapeHtml(this.formatMoney(n));
      const abonosHtml = lineas
        .map(({ a, c }) => {
          const docLbl = `${a.CODDOC_FAC || ''} #${a.CORRELATIVO_FAC ?? ''}`;
          const ivaCols =
            kind === 'iva' ? `<td class="text-end">${money(c.iva)}</td>` : '';
          return `<tr>
            <td>${PrintReport.escapeHtml(docLbl)}</td>
            <td>${PrintReport.escapeHtml(a.FAC_SERIEFAC || '—')}</td>
            <td>${PrintReport.escapeHtml(a.FAC_NOFAC || '—')}</td>
            <td>${PrintReport.escapeHtml(this.formatDate(a.FAC_FECHA))}</td>
            <td class="text-end">${money(c.total)}</td>
            <td class="text-end">${money(c.base)}</td>
            ${ivaCols}
            <td class="text-end">${PrintReport.escapeHtml(String(c.pct))}%</td>
            <td class="text-end fw-semibold">${money(c.aplicado)}</td>
          </tr>`;
        })
        .join('');
      const ivaFoot = kind === 'iva' ? `<td class="text-end">${money(totIva)}</td>` : '';
      const tfoot = lineas.length
        ? `<tfoot>
            <tr>
              <td colspan="4"><strong>Totales</strong></td>
              <td class="text-end"><strong>${money(totTotal)}</strong></td>
              <td class="text-end"><strong>${money(totBase)}</strong></td>
              ${ivaFoot}
              <td></td>
              <td class="text-end"><strong>${money(totRet)}</strong></td>
            </tr>
          </tfoot>`
        : '';
      const headerRet = Number(doc.TOTALIVA) || Number(doc.TOTALPRECIO) || totRet;
      const headerBase = Number(doc.TOTALSINIVA) || totBase;
      if (typeof PrintReport.ensureLogo === 'function') {
        await PrintReport.ensureLogo();
      }
      await PrintReport.openAndPrint(
        () =>
          PrintReport.wrapDocument({
            title: cfg.title,
            extraStyles: `
              .ret-print-table{font-size:11px;width:100%;border-collapse:collapse;margin-top:.5rem}
              .ret-print-table th,.ret-print-table td{padding:5px 6px;border:1px solid #ccc}
              .ret-print-table thead th{background:#f3f3f3}
              .ret-print-table tfoot td{background:#f0f0f0;border-top:2px solid #999}
              .ret-print-formula{font-size:11px;color:#444;margin:.4rem 0 .8rem}
            `,
            bodyHtml: `
              ${PrintReport.reportHeaderHtml({
                title: cfg.title,
                subtitleHtml: `
                  <p><strong>${PrintReport.escapeHtml(doc.CODDOC)} #${doc.CORRELATIVO}</strong>
                    · ${PrintReport.escapeHtml(this.formatDate(doc.FECHA))}
                    · ${doc.CONCRE === 'CRE' ? 'Crédito' : 'Contado'}</p>
                  <p><strong>${partyLabel}:</strong> ${PrintReport.escapeHtml(doc.DOC_NOMCLIE || '—')}
                    · NIT ${PrintReport.escapeHtml(doc.DOC_NIT || '—')}</p>
                `,
              })}
              <p class="ret-print-formula"><strong>Cálculo:</strong> ${PrintReport.escapeHtml(formula)}</p>
              <table class="table table-sm ret-print-table">
                <thead><tr>${headerCols}</tr></thead>
                <tbody>${
                  abonosHtml ||
                  `<tr><td colspan="${colCount}" class="text-muted">Sin ${docsLabel} en esta retención</td></tr>`
                }</tbody>
                ${tfoot}
              </table>
              <table class="table table-sm mt-3" style="max-width:22rem;margin-left:auto">
                <tbody>
                  <tr><td>${PrintReport.escapeHtml(cfg.baseLabel)}</td><td class="text-end">${money(headerBase)}</td></tr>
                  <tr><td>${PrintReport.escapeHtml(cfg.retencionLabel)}</td>
                    <td class="text-end fw-bold">${money(headerRet)}</td></tr>
                </tbody>
              </table>
              ${doc.OBS ? `<p><em>${PrintReport.escapeHtml(doc.OBS)}</em></p>` : ''}
            `,
          }),
        'width=900,height=700'
      );
    },

    bindListEvents() {
      const c = this._container;
      c?.querySelector(`#${P}-mes`)?.addEventListener('change', (e) => {
        this._mes = Number(e.target.value);
        this.reloadListOnly().catch((err) => F.toast(err.message, 'error'));
      });
      c?.querySelector(`#${P}-anio`)?.addEventListener('change', (e) => {
        this._anio = Number(e.target.value);
        this.reloadListOnly().catch((err) => F.toast(err.message, 'error'));
      });
      c?.querySelector(`#btn-${P}-recargar`)?.addEventListener('click', () => {
        this.reloadListOnly().catch((err) => F.toast(err.message, 'error'));
      });
      c?.querySelector(`#btn-${P}-setup`)?.addEventListener('click', () => {
        this.runSetup().catch((err) => F.toast(err.message, 'error'));
      });
      c?.querySelector(`#btn-${P}-list-nuevo`)?.addEventListener('click', () => {
        this.onNuevo().catch((err) => F.toast(err.message, 'error'));
      });
      c?.querySelector(`#${id('list-search')}`)?.addEventListener('input', (e) => {
        this._listFilter = e.target.value;
        this.refreshListDom();
      });
      c?.querySelector(`#${id('list-cards')}`)?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.inv-card-btn');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const card = btn.closest('.inv-doc-card');
        const coddoc = card?.getAttribute('data-coddoc');
        const correlativo = card?.getAttribute('data-correlativo');
        const action = btn.getAttribute('data-action');
        if (!coddoc || !correlativo) return;
        try {
          if (action === 'editar') await this.showEditor(coddoc, correlativo);
          else if (action === 'imprimir') await this.imprimirRetencion(coddoc, correlativo);
          else if (action === 'eliminar') await this.eliminarRetencion(coddoc, correlativo);
        } catch (err) {
          F.toast(err.message, 'error');
        }
      });
    },

    bindDualPanelEvents() {
      const c = this._container;
      c?.querySelectorAll('.ret-add-fac').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.addPendingDoc(btn.dataset.coddoc, btn.dataset.corr);
        });
      });
      c?.querySelectorAll('.ret-abono-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.removeAbono(Number(btn.dataset.idx));
        });
      });
      c?.querySelectorAll('.ret-abono-monto').forEach((inp) => {
        inp.addEventListener('change', () => {
          const idx = Number(inp.dataset.idx);
          const a = this._abonos[idx];
          if (!a) return;
          let val = this.roundMoney(inp.value);
          const max = this.maxAbonoRetencion(a.FAC_DOC_SALDO);
          if (val < 0) val = 0;
          if (val > max) {
            val = max;
            F.toast(`Máximo saldo: ${this.formatMoney(max)}`, 'info');
          }
          a.ABONO = val;
          inp.value = val;
          this.refreshTotalsDisplay();
          const sumEl = c?.querySelector('.ret-doc-dual .text-success.fw-bold');
          if (sumEl) sumEl.textContent = this.formatMoney(this.abonosSum());
        });
      });
      const pendingSearch = c?.querySelector(`#${id('pending-search')}`);
      if (pendingSearch && !pendingSearch.dataset.bound) {
        pendingSearch.dataset.bound = '1';
        const run = F.debounce(async () => {
          this._pendingQuery = pendingSearch.value;
          try {
            await this.fetchPendientes(this.partyCodeOf(), this._pendingQuery);
            this.refreshDualPanels();
          } catch (err) {
            F.toast(err.message, 'error');
          }
        }, 250);
        pendingSearch.addEventListener('input', run);
      }
    },

    bindEditorEvents() {
      const c = this._container;
      c?.querySelector(`#btn-${P}-atras`)?.addEventListener('click', () => this.showList());
      c?.querySelector(`#btn-${P}-imprimir`)?.addEventListener('click', () => {
        const d = this._doc;
        if (!d?.CODDOC) return;
        this.imprimirRetencion(d.CODDOC, d.CORRELATIVO).catch((err) => F.toast(err.message, 'error'));
      });
      c?.querySelector(`#btn-${P}-guardar`)?.addEventListener('click', () => {
        this.onGuardar().catch((err) => F.toast(err.message, 'error'));
      });
      c?.querySelector(`#btn-${P}-finalizar`)?.addEventListener('click', () => {
        this.onFinalizar().catch((err) => F.toast(err.message, 'error'));
      });
      c?.querySelector(`#btn-${P}-buscar-factura`)?.addEventListener('click', () => {
        this.onBuscarFactura().catch((err) => F.toast(err.message, 'error'));
      });

      const provSearch = c?.querySelector(`#${id('prov-search')}`);
      const provList = c?.querySelector(`#${id('prov-results')}`);
      if (provSearch && provList) {
        const hideProvList = () => provList.classList.add('d-none');
        const runSearch = F.debounce(async () => {
          const q = provSearch.value.trim();
          this._provQuery = provSearch.value;
          if (q.length < 2) {
            hideProvList();
            return;
          }
          try {
            await this.fetchParties(q);
            const rows = this._parties || [];
            if (!rows.length) {
              provList.innerHTML = '<div class="list-group-item small text-muted">Sin resultados</div>';
            } else {
              provList.innerHTML = rows.slice(0, 15).map((p) => this.renderPartyItemHtml(p)).join('');
            }
            provList.classList.remove('d-none');
          } catch (err) {
            provList.innerHTML = `<div class="list-group-item text-danger small">${this.escapeHtml(err.message)}</div>`;
            provList.classList.remove('d-none');
          }
        }, 350);
        provSearch.addEventListener('input', runSearch);
        provList.addEventListener('click', (e) => {
          const btn = e.target.closest(`[${partyCodeAttr}]`);
          if (!btn) return;
          hideProvList();
          const code =
            btn.getAttribute('data-party-code') ||
            btn.getAttribute('data-codcliente') ||
            btn.getAttribute('data-codprov') ||
            btn.dataset.partyCode ||
            btn.dataset.codcliente ||
            btn.dataset.codprov;
          if (!code) {
            F.toast(`No se pudo leer el código de ${partyLabelLower}`, 'error');
            return;
          }
          this.onSelectParty(code).catch((err) => F.toast(err.message, 'error'));
        });
        if (typeof PosProductKeyboardUI !== 'undefined') {
          PosProductKeyboardUI.bindPartyResultsKeyboard(provSearch, provList, {
            itemSelector: `button[${partyCodeAttr}]`,
          });
        }
        document.addEventListener('click', (e) => {
          if (!provSearch.contains(e.target) && !provList.contains(e.target)) hideProvList();
        });
      }

      this.bindDualPanelEvents();
    },

    async onSelectParty(code) {
      if (!this.docEditable(this._doc)) return;
      const hidden = document.getElementById(id('codparty'));
      if (hidden) hidden.value = code;
      if (this._doc) this._doc[partyCodeField] = Number(code) || code;
      const p = (this._parties || []).find(
        (x) => String(x[partyCodeField] ?? x.CODCLIENTE ?? x.CODPROV) === String(code)
      );
      if (p) {
        if (isRecibida) {
          this._doc.DOC_NOMCLIE = String(p.NOMBRECLIENTE || p.NEGOCIO || '').trim();
        } else {
          this._doc.DOC_NOMCLIE = String(p.EMPRESA || p.RAZONSOCIAL || '').trim();
        }
        this._doc.DOC_NIT = String(p.NIT || '').trim();
      }
      this._provQuery = this.partyLabelText(code);
      const search = document.getElementById(id('prov-search'));
      if (search) search.value = this._provQuery;
      const selLabel = document.getElementById(id('prov-selected'));
      if (selLabel) {
        selLabel.innerHTML = `Seleccionado: <strong>${this.escapeHtml(this._provQuery)}</strong>`;
      }
      document.getElementById(id('prov-results'))?.classList.add('d-none');
      this._abonos = [];
      this._pendingQuery = '';
      try {
        await this.fetchPendientes(code);
        this.refreshDualPanels();
      } catch (err) {
        F.toast(err.message, 'error');
      }
    },

    async onBuscarFactura() {
      if (!this.docEditable(this._doc)) return;
      if (typeof Swal === 'undefined') {
        F.toast('No se pudo abrir el diálogo de búsqueda', 'error');
        return;
      }
      const serieId = `${P}-fel-serie`;
      const numeroId = `${P}-fel-numero`;
      const { isConfirmed, value } = await Swal.fire({
        ...(typeof CatalogosUI !== 'undefined' ? CatalogosUI.modalBase() : {}),
        title: 'Buscar Factura',
        html: `
          <p class="small text-muted text-start mb-2">Indique FEL_SERIE y FEL_NUMERO de la factura.</p>
          <label class="form-label small mb-0 text-start d-block" for="${serieId}">FEL_SERIE</label>
          <input id="${serieId}" class="form-control form-control-sm mb-2" autocomplete="off">
          <label class="form-label small mb-0 text-start d-block" for="${numeroId}">FEL_NUMERO</label>
          <input id="${numeroId}" class="form-control form-control-sm" autocomplete="off">
        `,
        showCancelButton: true,
        confirmButtonText:
          typeof CatalogosUI !== 'undefined' ? CatalogosUI.guardarButtonHtml('Buscar') : 'Buscar',
        cancelButtonText:
          typeof CatalogosUI !== 'undefined' ? CatalogosUI.cancelButtonHtml('Cancelar') : 'Cancelar',
        focusConfirm: false,
        preConfirm: () => {
          const serie = String(document.getElementById(serieId)?.value || '').trim();
          const numero = String(document.getElementById(numeroId)?.value || '').trim();
          if (!serie) {
            Swal.showValidationMessage('Indique FEL_SERIE');
            return false;
          }
          if (!numero) {
            Swal.showValidationMessage('Indique FEL_NUMERO');
            return false;
          }
          return { serie, numero };
        },
      });
      if (!isConfirmed || !value) return;

      const params = new URLSearchParams({
        empnit: F.getEmpNit(),
        serie: value.serie,
        numero: value.numero,
        _: String(Date.now()),
      });
      const data = await F.fetchJson(`${cfg.apiPath}/factura-por-fel?${params}`, { cache: 'no-store' });
      const rows = data.rows || [];
      if (!rows.length) {
        F.toast('No se encontró factura con esos datos FEL', 'info');
        return;
      }

      const pickHtml = rows
        .map((r, idx) => {
          const partyCode = isRecibida ? r.CODCLIENTE : r.CODPROV;
          const partyName = isRecibida
            ? String(r.NOMBRECLIENTE || r.DOC_NOMCLIE || '').trim()
            : String(r.EMPRESA || r.DOC_NOMCLIE || '').trim();
          const nit = String(r.NIT || r.DOC_NIT || '').trim();
          const serie = String(r.FEL_SERIE || r.SERIEFAC || '').trim();
          const numero = String(r.FEL_NUMERO || r.NOFAC || '').trim();
          const doc = `${r.CODDOC || ''} #${r.CORRELATIVO || ''}`;
          return `
            <button type="button" class="list-group-item list-group-item-action text-start py-2"
              data-pick-idx="${idx}">
              <div class="fw-semibold">${this.escapeHtml(partyName || `${partyLabel} ${partyCode || ''}`)}</div>
              <div class="small text-muted">
                NIT ${this.escapeHtml(nit || '—')} · ${this.escapeHtml(doc)} ·
                FEL ${this.escapeHtml(serie)}-${this.escapeHtml(numero)} ·
                ${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}
              </div>
            </button>`;
        })
        .join('');

      let selectedIdx = null;
      await Swal.fire({
        ...(typeof CatalogosUI !== 'undefined' ? CatalogosUI.modalBase() : {}),
        title: `Seleccionar ${partyLabelLower}`,
        html: `<div class="list-group text-start" id="${P}-fel-pick-list">${pickHtml}</div>`,
        showCancelButton: true,
        showConfirmButton: false,
        cancelButtonText:
          typeof CatalogosUI !== 'undefined' ? CatalogosUI.cancelButtonHtml('Cancelar') : 'Cancelar',
        didOpen: () => {
          document.getElementById(`${P}-fel-pick-list`)?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-pick-idx]');
            if (!btn) return;
            selectedIdx = Number(btn.getAttribute('data-pick-idx'));
            Swal.close();
          });
        },
      });

      if (selectedIdx == null || Number.isNaN(selectedIdx)) return;
      const row = rows[selectedIdx];
      if (!row) return;

      const code = isRecibida ? row.CODCLIENTE : row.CODPROV;
      if (!code) {
        F.toast(`La factura no tiene ${partyLabelLower} asociado`, 'error');
        return;
      }

      const party = isRecibida
        ? {
            CODCLIENTE: code,
            NOMBRECLIENTE: String(row.NOMBRECLIENTE || row.DOC_NOMCLIE || '').trim(),
            NEGOCIO: String(row.NEGOCIO || '').trim(),
            NIT: String(row.NIT || row.DOC_NIT || '').trim(),
          }
        : {
            CODPROV: code,
            EMPRESA: String(row.EMPRESA || row.DOC_NOMCLIE || '').trim(),
            RAZONSOCIAL: String(row.RAZONSOCIAL || '').trim(),
            NIT: String(row.NIT || row.DOC_NIT || '').trim(),
          };

      const existing = (this._parties || []).find(
        (x) => String(x[partyCodeField] ?? x.CODCLIENTE ?? x.CODPROV) === String(code)
      );
      if (!existing) this._parties = [party, ...(this._parties || [])];
      else Object.assign(existing, party);

      await this.onSelectParty(code);
      F.toast(`${partyLabel} cargado desde factura`, 'success');
    },

    async load(container) {
      this._container = container;
      const period = this.defaultPeriod();
      this._mes = period.mes;
      this._anio = period.anio;
      container.classList.remove('align-items-center', 'justify-content-center');
      container.classList.add('align-items-stretch', 'justify-content-start', 'ret-doc-main-host');
      container.innerHTML = `<div class="text-center text-muted py-4 w-100"><i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando…</div>`;
      try {
        const config = await F.fetchJson(this.apiBase('/config'), { cache: 'no-store' });
        this._setup = config.setup;
        if (config.calc) this._calc = config.calc;
        await this.showList();
      } catch (err) {
        container.innerHTML = `<div class="alert alert-danger m-3">${this.escapeHtml(err.message)}</div>`;
        F.toast(err.message, 'error');
      }
    },
  };
}
