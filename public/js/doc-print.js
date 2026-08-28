/**
 * Impresión profesional de documentos y recibos de pago (CARTA / TICKET).
 * Usa plantillas por EMPNIT + TIPODOC cuando existen; si no, formato built-in.
 */
const DocPrint = {
  FORMATO_OPCION: 'FORMATO IMPRESION C O T',
  _formatoCache: null,

  escapeHtml(value) {
    return PrintReport.escapeHtml(value);
  },

  formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Q 0.00';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  formatFecha(value) {
    if (!value) return '—';
    if (typeof value === 'object') return DocFecha.formatDisplay(value);
    const s = String(value).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return DocFecha.formatDisplay(`${m[1]}-${m[2]}-${m[3]}`);
    return DocFecha.formatDisplay({ FECHA: s });
  },

  normalizeFormato(value) {
    return String(value || 'CARTA').trim().toUpperCase() === 'TICKET' ? 'TICKET' : 'CARTA';
  },

  async fetchFormatoImpresion(force = false) {
    if (!force && this._formatoCache) return this._formatoCache;
    try {
      const params = new URLSearchParams({
        opcion: this.FORMATO_OPCION,
        _: String(Date.now()),
      });
      const data = await F.fetchJson(`/api/config/formato-impresion?${params}`, { cache: 'no-store' });
      this._formatoCache = this.normalizeFormato(data.formato);
    } catch {
      this._formatoCache = 'CARTA';
    }
    return this._formatoCache;
  },

  isTicket(formato) {
    return this.normalizeFormato(formato) === 'TICKET';
  },

  layoutStyles(formato) {
    if (this.isTicket(formato)) {
      return `
        @page { size: 80mm auto; margin: 2mm; }
        html{width:100%;margin:0;padding:0;box-sizing:border-box}
        body{
          font-family:Consolas,Monaco,monospace;
          font-size:11px;color:#111;position:relative;
          width:100%!important;max-width:none!important;
          margin:0!important;padding:2mm 2.5mm!important;
          box-sizing:border-box;
        }
        .doc-print-sheet,.fel-ticket{
          width:100%!important;max-width:none!important;margin:0!important;
          box-sizing:border-box;
        }
        .report-header{margin-bottom:.5rem;border-bottom:1px dashed #999;padding-bottom:.4rem}
        .report-brand{flex-direction:column;align-items:center;text-align:center;gap:.25rem}
        .report-logo{max-height:42px;max-width:68px}
        .report-empresa-nombre{font-size:.85rem}
        .report-title{font-size:.8rem}
        .report-subtitle{font-size:10px}
        .doc-meta-grid{display:block}
        .doc-meta-item{margin-bottom:.15rem;font-size:10px}
        .doc-lines-table th,.doc-lines-table td{font-size:9px;padding:2px 3px}
        .doc-lines-table .col-desc{max-width:none;word-break:break-word}
        .doc-totals{font-size:10px}
        .doc-footer{margin-top:.5rem;font-size:9px;text-align:center;color:#555}
        table{width:100%;border-collapse:collapse;margin-top:.35rem}
        th,td{border:1px solid #ccc}
        th{background:#f3f3f3}
        .text-end{text-align:right}
        @media print{
          html,body{width:100%!important;max-width:none!important;margin:0!important;padding:0!important}
          body{padding:1mm 1.5mm!important;font-size:11px!important}
        }
        @media screen{
          html,body{width:100%!important;max-width:none!important;margin:0!important;box-sizing:border-box}
          body{padding:1.25rem 1.75rem!important;font-size:15px!important;line-height:1.35!important}
          .doc-print-sheet,.fel-ticket{width:100%!important;max-width:none!important;margin:0!important}
          .report-logo{max-height:72px!important;max-width:140px!important}
          .report-empresa-nombre{font-size:1.35rem!important}
          .report-title{font-size:1.1rem!important}
          .report-subtitle,.doc-meta-item{font-size:14px!important}
          .doc-lines-table th,.doc-lines-table td{font-size:13px!important;padding:6px 8px!important}
          .doc-totals,.doc-totals-row{font-size:14px!important}
          .doc-totals-row.grand{font-size:1.15rem!important}
          .doc-footer{font-size:12px!important}
        }
        ${this.prioridadBadgeCss()}
      `;
    }
    return `
      @page { margin: 12mm; }
      body{font-family:Segoe UI,Helvetica,Arial,sans-serif;padding:0;font-size:12px;color:#1a1a1a;background:#fff;position:relative}
      .doc-print-sheet{max-width:210mm;margin:0 auto}
      .report-header{margin-bottom:1rem;border-bottom:2px solid #1e3a5f;padding-bottom:.75rem}
      .report-brand{align-items:center}
      .report-logo{max-height:64px;max-width:150px}
      .report-empresa-nombre{font-size:1.15rem;color:#1e3a5f}
      .report-title{font-size:1rem;color:#333;margin-top:.15rem}
      .report-subtitle{font-size:11px;color:#555}
      .doc-meta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.35rem .75rem;margin:.75rem 0 1rem;padding:.65rem .75rem;background:#f8fafc;border:1px solid #e2e8f0;border-radius:.35rem}
      .doc-meta-item{font-size:11px}
      .doc-meta-item strong{color:#334155}
      .doc-lines-table{margin-top:.5rem}
      .doc-lines-table th{background:#1e3a5f;color:#fff;border-color:#1e3a5f;font-weight:600;font-size:11px}
      .doc-lines-table td{border-color:#d1d5db;font-size:11px}
      .doc-lines-table tbody tr:nth-child(even){background:#f9fafb}
      .doc-totals{margin-top:.75rem;padding:.65rem .75rem;background:#f0f9ff;border:1px solid #bae6fd;border-radius:.35rem}
      .doc-totals-row{display:flex;justify-content:space-between;gap:1rem;font-size:12px;margin:.1rem 0}
      .doc-totals-row.grand{font-size:1rem;font-weight:700;color:#1e3a5f;margin-top:.35rem;padding-top:.35rem;border-top:1px solid #bae6fd}
      .doc-footer{margin-top:1.25rem;padding-top:.5rem;border-top:1px solid #e5e7eb;font-size:10px;color:#6b7280;text-align:center}
      table{width:100%;border-collapse:collapse}
      th,td{padding:5px 8px}
      .text-end{text-align:right}
      ${this.prioridadBadgeCss()}
    `;
  },

  metaItem(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<div class="doc-meta-item"><strong>${this.escapeHtml(label)}:</strong> ${this.escapeHtml(value)}</div>`;
  },

  buildLinesTableHtml(lines, { ticket = false, includePrecio = false } = {}) {
    const rows = (lines || [])
      .map((ln) => {
        const desc = ticket
          ? `<span class="col-desc">${this.escapeHtml(ln.DESPROD || '')}</span>`
          : this.escapeHtml(ln.DESPROD || '');
        const precioCell = includePrecio
          ? `<td class="text-end">${this.escapeHtml(this.formatMoney(ln.PRECIO))}</td>`
          : '';
        return `<tr>
          <td>${this.escapeHtml(ln.CODPROD)}</td>
          <td>${desc}</td>
          <td class="text-end">${this.escapeHtml(ln.CODMEDIDA || '')}</td>
          <td class="text-end">${Number(ln.CANTIDAD) || 0}</td>
          ${precioCell}
          <td class="text-end">${this.escapeHtml(this.formatMoney(ln.TOTALPRECIO))}</td>
        </tr>`;
      })
      .join('');
    const colCount = includePrecio ? 6 : 5;
    const precioHead = includePrecio ? '<th class="text-end">Precio</th>' : '';
    return `
      <table class="doc-lines-table">
        <thead>
          <tr>
            <th>Cód.</th>
            <th>Descripción</th>
            <th class="text-end">Med.</th>
            <th class="text-end">Cant.</th>
            ${precioHead}
            <th class="text-end">Total</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="${colCount}" class="text-center text-muted">Sin líneas</td></tr>`}</tbody>
      </table>`;
  },

  buildDocumentHtml({ title, header, lines, extraMeta = [], footerNote = '' }, formato = 'CARTA') {
    const h = header || {};
    const ticket = this.isTicket(formato);
    const tipodoc = String(h.TIPODOC || '').trim().toUpperCase();
    const esCompra = tipodoc === 'COM' || tipodoc === 'COP';
    const serie = esCompra
      ? String(h.SERIEFAC || '').trim()
      : String(h.FEL_SERIE || '').trim();
    const numero = esCompra
      ? String(h.NOFAC || '').trim()
      : String(h.FEL_NUMERO || '').trim();
    const meta = [
      this.metaItem('Documento', `${h.CODDOC || ''} #${h.CORRELATIVO ?? ''}`),
      this.metaItem('Fecha', this.formatFecha(h.FECHA)),
      this.metaItem('Serie', serie),
      this.metaItem('Número', numero),
      this.metaItem('Usuario', h.USUARIO),
      this.metaItem('Cliente', h.DOC_NOMCLIE),
      this.metaItem('NIT', h.DOC_NIT),
      this.metaItem('Dirección', h.DOC_DIRCLIE),
      this.metaItem('Tipo entrega', h.F_ENTREGA),
      this.metaItem(
        'Dirección de entrega',
        (() => {
          const dir = String(h.DIRENTREGA || '').trim();
          if (!dir || dir.toUpperCase() === 'SN') return '';
          return dir;
        })()
      ),
      this.metaItem('Vendedor', h.VENDEDOR || h.NOMEMPLEADO),
      this.metaItem('Tel. vendedor', h.VENDEDOR_TELEFONO || h.TELEFONOS),
      ...extraMeta.map((m) => this.metaItem(m.label, m.value)).filter(Boolean),
    ]
      .filter(Boolean)
      .join('');

    const obs = h.OBS ? `<p class="doc-obs"><em>${this.escapeHtml(h.OBS)}</em></p>` : '';
    const anulado = this.isAnulado(h) ? this.anuladoStampHtml() : '';
    const prioridadBadge = this.prioridadBadgeHtml(h.PRIORIDAD);

    return `
      <div class="doc-print-sheet">
        ${anulado}
        ${prioridadBadge}
        ${PrintReport.reportHeaderHtml({
          title,
          subtitleHtml: ticket ? '' : `<p class="mb-0">${this.escapeHtml(title)}</p>`,
        })}
        <div class="doc-meta-grid">${meta}</div>
        ${obs}
        ${this.buildLinesTableHtml(lines, { ticket, includePrecio: true })}
        <div class="doc-totals">
          <div class="doc-totals-row grand">
            <span>Total</span>
            <span>${this.escapeHtml(this.formatMoney(h.TOTALPRECIO))}</span>
          </div>
        </div>
        ${footerNote ? `<div class="doc-footer">${footerNote}</div>` : '<div class="doc-footer">Documento generado por POS OnneB</div>'}
      </div>`;
  },

  buildReciboPagoHtml(data, formato = 'CARTA') {
    const ticket = this.isTicket(formato);
    const abono = data.abono || {};
    const factura = data.factura || {};
    const fpago = data.fpago || {};
    const cliente = data.cliente || '—';
    const facturas = Array.isArray(data.facturas) ? data.facturas.filter(Boolean) : null;
    const multi = Boolean(facturas?.length);
    const facturaRef = multi
      ? `${facturas.length} factura(s)`
      : `${abono.SERIEFAC || factura.CODDOC || ''} #${abono.NOFAC || factura.CORRELATIVO || ''}`.trim();

    const fpRows = [
      ['Efectivo', fpago.FPAGO_EFECTIVO],
      ['Tarjeta', fpago.FPAGO_TARJETA],
      ['Depósito', fpago.FPAGO_DEPOSITO],
      ['Cheque', fpago.FPAGO_CHEQUE],
    ]
      .filter(([, v]) => Number(v) > 0)
      .map(
        ([label, v]) =>
          `<div class="doc-totals-row"><span>${this.escapeHtml(label)}</span><span>${this.escapeHtml(this.formatMoney(v))}</span></div>`
      )
      .join('');

    const meta = [
      this.metaItem('Recibo', `${abono.CODDOC || ''} #${abono.CORRELATIVO ?? ''}`),
      this.metaItem('Fecha', this.formatFecha(data.fecha || new Date())),
      this.metaItem('Cliente', cliente),
      this.metaItem(multi ? 'Facturas' : 'Factura', facturaRef),
      this.metaItem('Usuario', data.usuario),
      this.metaItem('NIT', data.nit),
      fpago.FPAGO_DESCRIPCION ? this.metaItem('Detalle pago', fpago.FPAGO_DESCRIPCION) : '',
    ]
      .filter(Boolean)
      .join('');

    let detalleHtml = '';
    if (multi) {
      const rows = facturas
        .map(
          (f) => `<tr>
            <td class="text-nowrap">${this.escapeHtml(f.CODDOC || f.CODDOC_FAC || '')} #${this.escapeHtml(f.CORRELATIVO ?? f.CORRELATIVO_FAC ?? '')}</td>
            <td class="text-end">${this.escapeHtml(this.formatMoney(f.ABONO ?? f.TOTALPRECIO))}</td>
            <td class="text-end">${this.escapeHtml(this.formatMoney(f.DOC_SALDO ?? f.FAC_DOC_SALDO))}</td>
          </tr>`
        )
        .join('');
      detalleHtml = `
        <table class="doc-lines-table" style="margin-top:.5rem">
          <thead>
            <tr>
              <th>Factura</th>
              <th class="text-end">Abono</th>
              <th class="text-end">Saldo</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    } else {
      detalleHtml = `
        <div class="doc-totals-row" style="margin-top:.5rem">
          <span>Saldo factura</span>
          <span>${this.escapeHtml(this.formatMoney(factura.DOC_SALDO))}</span>
        </div>`;
    }

    return `
      <div class="doc-print-sheet">
        ${this.isAnulado(abono) || this.isAnulado(factura) ? this.anuladoStampHtml() : ''}
        ${PrintReport.reportHeaderHtml({
          title: 'Recibo de pago',
          subtitleHtml: ticket
            ? ''
            : `<p class="mb-0">${multi ? 'Recibo de caja CXC' : 'Recibo de pago a cliente'}</p>`,
        })}
        <div class="doc-meta-grid">${meta}</div>
        ${multi ? detalleHtml : ''}
        <div class="doc-totals">
          <div class="doc-totals-row grand">
            <span>Monto recibido</span>
            <span>${this.escapeHtml(this.formatMoney(abono.TOTALPRECIO || data.monto))}</span>
          </div>
          ${fpRows}
          ${multi ? '' : detalleHtml}
        </div>
        ${data.obs ? `<p class="doc-obs"><em>${this.escapeHtml(data.obs)}</em></p>` : ''}
        <div class="doc-footer">${multi ? 'Recibo de caja CXC — cuentas por cobrar' : 'Recibo de pago — cuentas por cobrar'}</div>
      </div>`;
  },

  wrapHtml({ title, bodyHtml, formato, extraCss = '' }) {
    const extra = `${this.layoutStyles(formato)}\n${extraCss || ''}`;
    return PrintReport.wrapDocument({
      title,
      bodyHtml,
      extraStyles: extra,
    });
  },

  windowFeaturesFor(_formato) {
    if (typeof PrintReport !== 'undefined' && PrintReport.maximizedFeatures) {
      return PrintReport.maximizedFeatures();
    }
    const w = Math.max(800, Number(window.screen?.availWidth) || 1200);
    const h = Math.max(600, Number(window.screen?.availHeight) || 800);
    return `left=0,top=0,width=${w},height=${h}`;
  },

  printOptionsFor(formato) {
    return this.isTicket(formato) ? { ticket: true, papel: 'TICKET' } : { ticket: false };
  },

  isAnulado(header) {
    return String(header?.STATUS || '').trim().toUpperCase() === 'A';
  },

  anuladoStampHtml() {
    return `<div class="doc-anulado-stamp" aria-label="Anulado">ANULADO</div>`;
  },

  prioridadBadgeHtml(prioridad) {
    const p = String(prioridad || '').trim().toUpperCase();
    if (p !== 'BAJA' && p !== 'MEDIA' && p !== 'ALTA') return '';
    const cls = p === 'ALTA' ? 'alta' : p === 'MEDIA' ? 'media' : 'baja';
    return `<div class="doc-prioridad-badge doc-prioridad-badge--${cls}" aria-label="Prioridad ${this.escapeHtml(p)}">${this.escapeHtml(p)}</div>`;
  },

  prioridadBadgeCss() {
    return `
      .doc-prioridad-badge{
        position:fixed;top:8px;right:12px;z-index:60;
        padding:5px 12px;font-size:11px;font-weight:800;letter-spacing:.08em;
        text-transform:uppercase;border-radius:4px;line-height:1.2;
        box-shadow:0 1px 3px rgba(0,0,0,.12);
        -webkit-print-color-adjust:exact;print-color-adjust:exact
      }
      .doc-prioridad-badge--baja{background:#86efac;color:#14532d}
      .doc-prioridad-badge--media{background:#facc15;color:#713f12}
      .doc-prioridad-badge--alta{background:#ef4444;color:#fff}
      @media print{
        .doc-prioridad-badge{position:absolute;top:4px;right:6px}
      }
    `;
  },

  /**
   * Intenta imprimir con plantilla de BD (EMPNIT + CODDOC + CORRELATIVO → TIPODOC).
   * @returns {Promise<boolean>} true si se imprimió con plantilla
   */
  async tryPrintWithTemplate({ coddoc, correlativo, title, formato, logoUrl }) {
    const emp = F.getEmpNit();
    if (!emp || !coddoc || correlativo == null || correlativo === '') return false;
    const papel = this.normalizeFormato(formato);
    const params = new URLSearchParams({ empnit: emp });
    const data = await F.fetchJson(`/api/formatos-impresion/render?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coddoc: String(coddoc),
        correlativo: Number(correlativo),
        papel,
        title: title || undefined,
        logoUrl: logoUrl || undefined,
      }),
    });
    if (!data?.html) return false;
    await PrintReport.openAndPrint(data.html, this.windowFeaturesFor(papel), this.printOptionsFor(papel));
    return true;
  },

  async printDocument({ title, header, lines, extraMeta, footerNote, formato }) {
    const fmt = formato || (await this.fetchFormatoImpresion());
    const h = header || {};
    const coddoc = h.CODDOC;
    const correlativo = h.CORRELATIVO;

    if (coddoc != null && correlativo != null && correlativo !== '') {
      try {
        await PrintReport.ensureLogo();
        const used = await this.tryPrintWithTemplate({
          coddoc,
          correlativo,
          title,
          formato: fmt,
          logoUrl: PrintReport.getLogoDataUrl(),
        });
        if (used) return;
      } catch (err) {
        console.warn('[DocPrint] plantilla:', err.message || err);
      }
    }

    await PrintReport.openAndPrint(
      () =>
        this.wrapHtml({
          title,
          bodyHtml: this.buildDocumentHtml({ title, header, lines, extraMeta, footerNote }, fmt),
          formato: fmt,
        }),
      this.windowFeaturesFor(fmt),
      this.printOptionsFor(fmt)
    );
  },

  /**
   * Imprime por llave de documento (carga datos y plantilla en el servidor).
   */
  async printByKey({ coddoc, correlativo, title, formato }) {
    const fmt = formato || (await this.fetchFormatoImpresion());
    await PrintReport.ensureLogo();
    const used = await this.tryPrintWithTemplate({
      coddoc,
      correlativo,
      title,
      formato: fmt,
      logoUrl: PrintReport.getLogoDataUrl(),
    });
    if (used) return;
    throw new Error('No se pudo renderizar el documento');
  },

  async printReciboPagoCliente(data, formato) {
    const fmt = formato || (await this.fetchFormatoImpresion());
    await PrintReport.openAndPrint(
      () =>
        this.wrapHtml({
          title: 'Recibo de pago',
          bodyHtml: this.buildReciboPagoHtml(data, fmt),
          formato: fmt,
        }),
      this.windowFeaturesFor(fmt),
      this.printOptionsFor(fmt)
    );
  },
};

if (typeof F !== 'undefined') {
  F.DocPrint = DocPrint;
}
