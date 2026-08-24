/**
 * Acciones comunes sobre documentos (imprimir, editar, eliminar) desde la vista Documentos.
 */
const DocOpciones = {
  FEL_TIPOS_CERTIFICABLES: ['FEF', 'FEC', 'FNC'],
  FEL_URL_OPCION: 'URL FEL',
  CERTIFICA_AL_FINALIZAR_OPCION: 'CERTIFICA AL FINALIZAR',
  FACTURA_SE_PASA_A_FRACCIONAMIENTO_AUTOM_OPCION: 'FACTURA SE PASA A FRACCIONAMIENTO AUTOM',
  PERMITE_FRACCIONAMIENTO_FACTURAS_OPCION: 'PERMITE FRACCIONAMIENTO FACTURAS',
  MUESTRA_FORMATO_FEL_ONLINE_OPCION: 'MUESTRA FORMATO FEL ONLINE',
  IMPRIME_TICKET_AL_GUARDAR_VENTA_OPCION: 'IMPRIME TICKET AL GUARDAR VENTA',

  EDITOR_BY_TIPODOC: {
    ENV: { menu: 'pedidos-mostrador', view: () => PosView },
    CRS: { menu: 'comandas-restaurante', view: () => ComandasRestauranteView },
    COT: { menu: 'cotizaciones', view: () => CotizacionesView },
    FAC: { menu: 'facturacion', view: () => FacturacionView },
    FEF: { menu: 'facturacion', view: () => FacturacionView },
    FEC: { menu: 'facturacion', view: () => FacturacionView },
    FES: { menu: 'facturacion', view: () => FacturacionView },
    DEV: { menu: 'notas-credito', view: () => NotasCreditoView },
    FNC: { menu: 'notas-credito', view: () => NotasCreditoView },
    FNA: { menu: 'notas-abono', view: () => NotasAbonoView },
    DVP: { menu: 'notas-debito', view: () => NotasDebitoView },
    COM: { menu: 'compras', view: () => ComprasView },
    ENT: { menu: 'entradas-inventario', view: () => EntradasInventarioView },
    SAL: { menu: 'salidas-inventario', view: () => SalidasInventarioView },
  },

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

  formatFecha(value) {
    if (!value) return '—';
    if (typeof value === 'object') return DocFecha.formatDisplay(value);
    const s = String(value).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return DocFecha.formatDisplay(`${m[1]}-${m[2]}-${m[3]}`);
    return DocFecha.formatDisplay({ FECHA: s });
  },

  felUudiValue(row) {
    return String(row?.FEL_UUDI ?? row?.FEL ?? '').trim();
  },

  estaCertificadoFel(row) {
    return Boolean(this.felUudiValue(row));
  },

  puedeEditar(row) {
    if (!row) return false;
    if (this.estaCertificadoFel(row)) return false;
    const statusOk = DocFecha.editableStatus(row.STATUS);
    const corte = String(row.CORTE || 'NO').trim().toUpperCase();
    if (corte === 'SI') return false;
    const tipodoc = String(row.TIPODOC || '').trim().toUpperCase();
    return statusOk && Boolean(this.EDITOR_BY_TIPODOC[tipodoc]);
  },

  puedeCambiarFecha(row) {
    if (!row) return false;
    if (this.estaCertificadoFel(row)) return false;
    return DocFecha.editableStatus(row.STATUS);
  },

  puedeCambiarCaja(row) {
    if (!row) return false;
    if (this.estaCertificadoFel(row)) return false;
    if (!DocFecha.editableStatus(row.STATUS)) return false;
    const corte = String(row.CORTE || 'NO').trim().toUpperCase();
    return corte !== 'SI';
  },

  /** Solo operado (no anulado). Permite corte y FEL: solo cambia CODDOC/correlativo interno. */
  puedeCambiarSerieInterna(row) {
    if (!row) return false;
    return DocFecha.editableStatus(row.STATUS);
  },

  /** Solo O ↔ I (anular es proceso aparte). */
  puedeCambiarStatus(row) {
    if (!row) return false;
    const status = String(row.STATUS || '').trim().toUpperCase();
    return status === 'O' || status === 'I';
  },

  patchStatusUrl(coddoc, correlativo) {
    return `/api/documentos/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}/status?empnit=${encodeURIComponent(F.getEmpNit())}`;
  },

  async cambiarStatus(coddoc, correlativo, status) {
    const next = String(status || '').trim().toUpperCase();
    if (next !== 'O' && next !== 'I') {
      throw new Error('STATUS inválido (solo O o I)');
    }
    await F.fetchJson(this.patchStatusUrl(coddoc, correlativo), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ STATUS: next }),
    });
    F.toast(`Status actualizado a ${next}`, 'success');
    return true;
  },

  puedeCertificarFel(row) {
    if (!row || this.estaCertificadoFel(row)) return false;
    const tipodoc = String(row.TIPODOC || '').trim().toUpperCase();
    if (!this.FEL_TIPOS_CERTIFICABLES.includes(tipodoc)) return false;
    return DocFecha.editableStatus(row.STATUS);
  },

  puedeVerFelOnline(row) {
    return this.estaCertificadoFel(row);
  },

  /**
   * Muestra Eliminar en Archivo → Documentos para todo documento no FEL y no anulado.
   * El servidor aplica corte de caja, documentos relacionados y política de eliminación.
   */
  puedeEliminar(row) {
    if (!row) return false;
    if (this.estaCertificadoFel(row)) return false;
    const status = String(row.STATUS || '').trim().toUpperCase();
    return status !== 'A';
  },

  fechaInputFromRow(row) {
    return DocFecha.inputValueFromHeader(row);
  },

  patchFechaUrl(coddoc, correlativo) {
    return `/api/documentos/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}/fecha?empnit=${encodeURIComponent(F.getEmpNit())}`;
  },

  patchCajaUrl(coddoc, correlativo) {
    return `/api/documentos/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}/caja?empnit=${encodeURIComponent(F.getEmpNit())}`;
  },

  async cambiarFecha(coddoc, correlativo, fechaIso) {
    await F.fetchJson(this.patchFechaUrl(coddoc, correlativo), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FECHA: fechaIso }),
    });
    F.toast('Fecha del documento actualizada', 'success');
    return true;
  },

  async fetchCajas() {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/cajas?${params}`);
    return data.rows || [];
  },

  async cambiarCaja(coddoc, correlativo, codcaja) {
    await F.fetchJson(this.patchCajaUrl(coddoc, correlativo), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CODCAJA: codcaja }),
    });
    F.toast('Caja del documento actualizada', 'success');
    return true;
  },

  seriesAlternasUrl(coddoc, correlativo) {
    return (
      `/api/documentos/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}/series-alternas` +
      `?empnit=${encodeURIComponent(F.getEmpNit())}&_=${Date.now()}`
    );
  },

  cambiarSerieUrl(coddoc, correlativo) {
    return (
      `/api/documentos/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}/cambiar-serie` +
      `?empnit=${encodeURIComponent(F.getEmpNit())}`
    );
  },

  async fetchSeriesAlternas(coddoc, correlativo) {
    return F.fetchJson(this.seriesAlternasUrl(coddoc, correlativo));
  },

  async cambiarSerieInterna(coddoc, correlativo, nuevoCoddoc) {
    const data = await F.fetchJson(this.cambiarSerieUrl(coddoc, correlativo), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CODDOC: nuevoCoddoc }),
    });
    const dest = data?.DESTINO || {};
    F.toast(
      `Serie cambiada a ${dest.CODDOC || nuevoCoddoc} · ${dest.CORRELATIVO ?? ''}`,
      'success'
    );
    return data;
  },

  joinFelUrl(baseUrl, felValue) {
    const base = String(baseUrl ?? '').trim();
    const fel = String(felValue ?? '').trim();
    if (!base || !fel) return null;
    if (/^https?:\/\//i.test(fel)) return fel;
    return `${base}${fel}`;
  },

  async fetchUrlFel() {
    const params = new URLSearchParams({
      opcion: this.FEL_URL_OPCION,
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/config/pass?${params}`, { cache: 'no-store' });
    return String(data.pass ?? '').trim();
  },

  async fetchCertificaAlFinalizar() {
    const params = new URLSearchParams({
      opcion: this.CERTIFICA_AL_FINALIZAR_OPCION,
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/config/sino?${params}`, { cache: 'no-store' });
    return String(data.sino ?? 'NO').trim().toUpperCase() === 'SI';
  },

  async fetchPermiteFraccionamientoFacturas() {
    const params = new URLSearchParams({
      opcion: this.PERMITE_FRACCIONAMIENTO_FACTURAS_OPCION,
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/config/sino?${params}`, { cache: 'no-store' });
    return String(data.sino ?? 'SI').trim().toUpperCase() === 'SI';
  },

  async fetchFacturaSePasaAFraccionamientoAutom() {
    const params = new URLSearchParams({
      opcion: this.FACTURA_SE_PASA_A_FRACCIONAMIENTO_AUTOM_OPCION,
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/config/sino?${params}`, { cache: 'no-store' });
    return String(data.sino ?? 'NO').trim().toUpperCase() === 'SI';
  },

  async fetchMuestraFormatoFelOnline() {
    const params = new URLSearchParams({
      opcion: this.MUESTRA_FORMATO_FEL_ONLINE_OPCION,
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/config/muestra-formato-fel?${params}`, { cache: 'no-store' });
    const modo = String(data.modo ?? 'NO').trim().toUpperCase();
    if (modo === 'SI' || modo === 'AMBOS') return modo;
    return 'NO';
  },

  async fetchImprimeTicketAlGuardarVenta() {
    const params = new URLSearchParams({
      opcion: this.IMPRIME_TICKET_AL_GUARDAR_VENTA_OPCION,
      _: String(Date.now()),
    });
    const data = await F.fetchJson(`/api/config/sino?${params}`, { cache: 'no-store' });
    return String(data.sino ?? 'NO').trim().toUpperCase() === 'SI';
  },

  /**
   * Tras finalizar FAC / facturación / DEV / FNC / FNA:
   * si IMPRIME TICKET AL GUARDAR VENTA = SI → muestra formato imprimible del sistema.
   * No consulta MUESTRA FORMATO FEL ONLINE (solo aplica en certificación FEL).
   * @param {{ alreadyPrintedSistema?: boolean, onImprimir?: () => Promise<void>|void }} opts
   */
  async maybeImprimirTicketTrasFinalizar(opts = {}) {
    if (opts.alreadyPrintedSistema) return false;
    let imprime = false;
    try {
      imprime = await this.fetchImprimeTicketAlGuardarVenta();
    } catch (_) {
      return false;
    }
    if (!imprime || typeof opts.onImprimir !== 'function') return false;
    await opts.onImprimir();
    return true;
  },

  esTipoCertificableFel(tipodoc) {
    return this.FEL_TIPOS_CERTIFICABLES.includes(String(tipodoc || '').trim().toUpperCase());
  },

  async abrirFelOnline(felValue) {
    const fel = String(felValue ?? '').trim();
    if (!fel) {
      F.toast('No hay UUID FEL para abrir el documento online', 'warning');
      return false;
    }
    let baseUrl = '';
    try {
      baseUrl = await this.fetchUrlFel();
    } catch (err) {
      F.toast(err.message || 'No se pudo leer la URL FEL', 'error');
      return false;
    }
    if (!baseUrl) {
      F.toast('Configure la URL FEL en Config general', 'warning');
      return false;
    }
    const url = this.joinFelUrl(baseUrl, fel);
    if (!url) {
      F.toast('No se pudo construir la URL del documento FEL', 'warning');
      return false;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  },

  /**
   * Tras certificar: muestra formato según MUESTRA FORMATO FEL ONLINE.
   * @param {{ felUuid?: string, onImprimirSistema?: () => Promise<void>|void }} opts
   */
  async mostrarFormatosTrasCertificar(opts = {}) {
    const modo = await this.fetchMuestraFormatoFelOnline().catch(() => 'NO');
    const felUuid = String(opts.felUuid ?? '').trim();
    const showOnline = modo === 'SI' || modo === 'AMBOS';
    const showSistema = modo === 'NO' || modo === 'AMBOS';

    if (showOnline) {
      await this.abrirFelOnline(felUuid);
    }
    if (showSistema && typeof opts.onImprimirSistema === 'function') {
      await opts.onImprimirSistema();
    }
  },

  async certificar(coddoc, correlativo) {
    const url = `/api/fel/certificar/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}?empnit=${encodeURIComponent(F.getEmpNit())}`;
    const data = await F.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const fel = data.fel || {};
    F.toast(
      `Certificado — UUID ${fel.uuid || ''}${fel.serie ? ` · Serie ${fel.serie}` : ''}${fel.numero ? ` · No. ${fel.numero}` : ''}`,
      'success'
    );
    return data;
  },

  /**
   * Certifica sin confirmación y aplica la visualización de formatos configurada.
   * @param {string} coddoc
   * @param {number|string} correlativo
   * @param {{ onImprimirSistema?: () => Promise<void>|void, silentError?: boolean }} [opts]
   */
  async certificarYMostrarFormatos(coddoc, correlativo, opts = {}) {
    const data = await this.certificar(coddoc, correlativo);
    const fel = data.fel || {};
    const felUuid = String(fel.uuid || fel.UUID || data.FEL_UUDI || '').trim();
    await this.mostrarFormatosTrasCertificar({
      felUuid,
      onImprimirSistema: opts.onImprimirSistema,
    });
    return data;
  },

  buildWhatsappDetalleText(doc, row) {
    const h = doc.header || {};
    const lines = doc.lines || [];
    const titulo = String(row?.DESDOC || h.DESDOC || h.TIPODOC || 'Documento').trim();
    const parts = [];
    parts.push(`*${titulo}*`);
    parts.push(`${h.CODDOC} #${h.CORRELATIVO}`);
    parts.push(`Fecha: ${this.formatFecha(h.FECHA)}`);
    if (h.DOC_NOMCLIE) parts.push(`Cliente: ${h.DOC_NOMCLIE}`);
    if (h.DOC_NIT) parts.push(`NIT: ${h.DOC_NIT}`);
    if (h.FEL_SERIE || h.FEL_NUMERO) {
      parts.push(`FEL: ${[h.FEL_SERIE, h.FEL_NUMERO].filter(Boolean).join(' ')}`);
    }
    parts.push('');
    lines.forEach((ln) => {
      const cant = Number(ln.CANTIDAD) || 0;
      const total = this.formatMoney(ln.TOTALPRECIO);
      parts.push(`• ${ln.CODPROD} ${ln.DESPROD} — ${cant} ${ln.CODMEDIDA || ''} — ${total}`);
    });
    parts.push('');
    parts.push(`*Total: ${this.formatMoney(h.TOTALPRECIO)}*`);
    return parts.join('\n');
  },

  async solicitarTelefonoWhatsapp() {
    const result = await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Enviar por WhatsApp',
      html: `
        <form class="catalogo-form text-start" autocomplete="off" novalidate onsubmit="return false">
          <p class="small text-muted mb-2">Ingrese el número del destinatario (8 dígitos, Guatemala +502).</p>
          <label for="doc-opciones-wa-telefono" class="form-label small mb-0">Teléfono</label>
          <div class="input-group input-group-sm">
            <span class="input-group-text">+502</span>
            <input type="tel" class="form-control" id="doc-opciones-wa-telefono"
              inputmode="numeric" maxlength="8" pattern="[0-9]{8}"
              placeholder="12345678" autocomplete="off">
          </div>
        </form>
      `,
      width: 400,
      showCancelButton: true,
      confirmButtonText: CatalogosUI.guardarButtonHtml('Enviar'),
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
      focusConfirm: false,
      didOpen: () => {
        document.getElementById('doc-opciones-wa-telefono')?.focus();
      },
      preConfirm: () => {
        const raw = String(document.getElementById('doc-opciones-wa-telefono')?.value ?? '').replace(/\D/g, '');
        if (raw.length !== 8) {
          Swal.showValidationMessage('Ingrese exactamente 8 dígitos');
          return false;
        }
        return raw;
      },
    });
    return result.isConfirmed ? result.value : null;
  },

  async enviarWhatsapp(coddoc, correlativo, row) {
    const telefono = await this.solicitarTelefonoWhatsapp();
    if (!telefono) return false;
    const doc = await this.fetchDetalle(coddoc, correlativo);
    const text = this.buildWhatsappDetalleText(doc, row);
    return this.abrirWhatsapp(telefono, text);
  },

  abrirWhatsapp(telefono8, text) {
    const url = `https://wa.me/502${telefono8}?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  },

  async enviarWhatsappTexto(text) {
    const telefono = await this.solicitarTelefonoWhatsapp();
    if (!telefono) return false;
    return this.abrirWhatsapp(telefono, text);
  },

  detalleUrl(coddoc, correlativo) {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      _: String(Date.now()),
    });
    return `/api/documentos/detalle/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}?${params}`;
  },

  deleteUrl(coddoc, correlativo) {
    return `/api/documentos/${encodeURIComponent(coddoc)}/${encodeURIComponent(correlativo)}?empnit=${encodeURIComponent(F.getEmpNit())}`;
  },

  async fetchDetalle(coddoc, correlativo) {
    return F.fetchJson(this.detalleUrl(coddoc, correlativo));
  },

  async imprimir(coddoc, correlativo, row) {
    const doc = await this.fetchDetalle(coddoc, correlativo);
    const h = doc.header || {};
    const lines = doc.lines || [];
    const tipodoc = String(h.TIPODOC || row?.TIPODOC || '').trim().toUpperCase();
    const titulo = String(row?.DESDOC || h.DESDOC || tipodoc || 'Documento').trim();
    const footerNote =
      tipodoc === 'COT' ? 'Cotización — documento sin validez fiscal' : 'Documento generado por POS OnneB';

    await DocPrint.printDocument({
      title: titulo,
      header: h,
      lines,
      footerNote,
    });
  },

  async eliminar(coddoc, correlativo, label, row) {
    const pass = await CatalogosUI.confirmEliminarDocumento({
      label: label || `${coddoc} #${correlativo}`,
      tipo: 'documento',
      kind: 'documento',
      coddoc,
      correlativo,
      tipodoc: row?.TIPODOC || '',
    });
    if (!pass) return false;
    await F.fetchJson(this.deleteUrl(coddoc, correlativo), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pass: String(pass),
        USUARIO: String(F.session('user')?.usuario || '').trim() || undefined,
      }),
    });
    F.toast('Documento eliminado', 'success');
    return true;
  },

  activateMenuLink(menuKey) {
    document.querySelectorAll('.sidebar-link').forEach((l) => l.classList.remove('is-active'));
    const link = document.querySelector(`.sidebar-link[data-menu="${menuKey}"]`);
    link?.classList.add('is-active');
    const mainTitle = document.getElementById('main-title');
    if (mainTitle && link) {
      const label = link.textContent.replace(/\s+/g, ' ').trim();
      if (label) mainTitle.textContent = label;
    }
  },

  async abrirEditor(tipodoc, coddoc, correlativo) {
    const t = String(tipodoc || '').trim().toUpperCase();
    const cfg = this.EDITOR_BY_TIPODOC[t];
    if (!cfg) {
      F.toast('No hay editor disponible para este tipo de documento', 'warning');
      return false;
    }
    const view = cfg.view?.();
    if (!view || typeof view.load !== 'function' || typeof view.showEditor !== 'function') {
      F.toast('Vista de edición no disponible', 'warning');
      return false;
    }

    if (typeof AutorizacionesUI !== 'undefined') {
      const allowed = await AutorizacionesUI.gateAccionDocumento({
        accion: 'editar',
        coddoc,
        correlativo,
        tipodoc: t,
        label: `${coddoc} #${correlativo}`,
      });
      if (!allowed) return false;
    }

    const mainContent = document.getElementById('main-content');
    if (!mainContent) return false;

    this.activateMenuLink(cfg.menu);
    mainContent.className = 'main-content flex-grow-1 d-flex p-2 p-md-3';
    await view.load(mainContent);
    await view.showEditor(coddoc, correlativo, { skipAuth: true });
    return true;
  },
};

if (typeof F !== 'undefined') {
  F.DocOpciones = DocOpciones;
}
