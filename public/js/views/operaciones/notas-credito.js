/**
 * Vista Notas de Crédito (clientes) — documentos DEV y FNC.
 * Basada en la UX de facturación, pero usando factura referencia.
 */
const NotasCreditoView = {
  _container: null,
  _config: null,
  _pedido: null,
  _pedidosList: [],
  _lineasDisponibles: [],
  _listFilter: '',
  _listFecha: null,
  _screen: 'list',
  _selectedCoddoc: '',
  _loadingDisponibles: false,
  _cartBusy: false,
  _cajas: [],
  _cajaDefault: null,
  _selectedCodcaja: null,
  _urlFel: '',

  FEL_TIPOS_CERTIFICABLES: ['FNC'],
  FEL_URL_OPCION: 'URL FEL',

  escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  apiUrl(path, extraParams = {}) {
    const emp = F.getEmpNit();
    if (!emp) throw new Error('No hay empresa activa');
    const segment = path ? (path.startsWith('/') ? path : `/${path}`) : '';
    const params = new URLSearchParams({ empnit: emp, ...extraParams });
    return `/api/notas-credito${segment}?${params}`;
  },

  todayIsoDate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  formatMoney(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return 'Q 0.00';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  formatFechaPedido(row) {
    return DocFecha.formatDisplay(row);
  },

  formatHoraPedido(row) {
    if (row?.HORA == null || row?.HORA === '') return '—';
    const h = String(Number(row.HORA)).padStart(2, '0');
    const m = String(Number(row.MINUTO ?? 0)).padStart(2, '0');
    return `${h}:${m}`;
  },

  rowFechaIso(row) {
    return DocFecha.fechaIsoFromHeader(row);
  },

  listFechaLabel() {
    const s = String(this._listFecha || '').slice(0, 10);
    const [y, m, d] = s.split('-');
    if (d && m && y) return `${d}/${m}/${y}`;
    return s || '—';
  },

  activeCoddoc() {
    return DocTipoSelect.active(this);
  },

  activeNotaTipodoc() {
    const cod = this.activeCoddoc();
    if (!cod) return '';
    const tipo = (this._config?.tiposDocumento || []).find((t) => String(t.CODDOC) === String(cod));
    return String(tipo?.TIPODOC || '').trim().toUpperCase();
  },

  refFacturaHint() {
    const t = this.activeNotaTipodoc();
    if (t === 'DEV') return 'Solo facturas tipo FAC';
    if (t === 'FNC') return 'Documentos fiscales FEF, FEC o FES (no FAC)';
    return '';
  },

  cantidadDisponible(row) {
    const base = Number(row?.cantDisponible ?? row?.CANT_DISPONIBLE ?? row?.CANTDISP ?? 0);
    return Math.max(0, base - this.cantidadEnCarrito(row));
  },

  productLineKey(row) {
    return [
      String(row?.CODPROD || '').trim(),
      String(row?.CODMEDIDA || '').trim(),
      String(Number(row?.EQUIVALE) || 1),
      String(Number(row?.PRECIO) || 0),
    ].join('|');
  },

  cantidadEnCarrito(row) {
    const key = this.productLineKey(row);
    return (this._pedido?.lines || []).reduce((sum, ln) => {
      if (this.productLineKey(ln) !== key) return sum;
      return sum + (Number(ln.CANTIDAD) || 0);
    }, 0);
  },

  findCartLineForProduct(row) {
    const key = this.productLineKey(row);
    return (this._pedido?.lines || []).find((ln) => this.productLineKey(ln) === key) || null;
  },

  lineaDisponibleKey(row, idx = 0) {
    return [
      String(row?.CODPROD || '').trim(),
      String(row?.CODMEDIDA || '').trim(),
      String(Number(row?.EQUIVALE) || 1),
      String(Number(row?.PRECIO) || 0),
      idx,
    ].join('|');
  },

  usuario() {
    const u = F.session('user');
    return u?.username || 'NC';
  },

  docKey() {
    if (!this._pedido?.header) return null;
    const h = this._pedido.header;
    return { coddoc: h.CODDOC, correlativo: Number(h.CORRELATIVO) };
  },

  docLabel() {
    const h = this._pedido?.header;
    if (!h) return 'Sin documento';
    return `${h.CODDOC} #${h.CORRELATIVO}`;
  },

  lineId(ln) {
    return ln?.ID ?? ln?.Id ?? null;
  },

  findLineById(id) {
    const n = Number(id);
    if (Number.isNaN(n)) return null;
    return (this._pedido?.lines || []).find((l) => Number(this.lineId(l)) === n) || null;
  },

  docEditable(header) {
    return (
      DocFecha.editableStatus(header?.STATUS) &&
      String(header?.CORTE || 'NO').trim().toUpperCase() !== 'SI'
    );
  },

  async guardarFechaDocumento(fecha) {
    const key = this.docKey();
    if (!key || !this.docEditable(this._pedido?.header)) return;
    const actual = DocFecha.inputValueFromHeader(this._pedido.header);
    if (fecha === actual) return;
    const url = this.apiUrl(`/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}`);
    this._pedido = await F.fetchJson(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FECHA: fecha }),
    });
    this._listFecha = String(fecha).slice(0, 10);
    F.toast('Fecha actualizada', 'success');
  },

  felUudiValue(row) {
    return String(row?.FEL_UUDI ?? row?.FEL ?? '').trim();
  },

  needsCertificar(row) {
    if (this.felUudiValue(row)) return false;
    const tipodoc = String(row?.TIPODOC || '').trim().toUpperCase();
    return this.FEL_TIPOS_CERTIFICABLES.includes(tipodoc);
  },

  formatFelCell(row) {
    const v = this.felUudiValue(row);
    if (!v) return '—';
    const label =
      v.length <= 16 ? this.escapeHtml(v) : this.escapeHtml(`${v.slice(0, 8)}…${v.slice(-4)}`);
    return `<button type="button" class="btn btn-link btn-sm p-0 nc-fel-link text-start"
      data-action="fel-open" data-fel-uudi="${this.escapeHtml(v)}"
      title="Abrir documento FEL (${this.escapeHtml(v)})">${label}</button>`;
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
    this._urlFel = String(data.pass ?? '').trim();
    return this._urlFel;
  },

  async abrirFelDocumento(felValue) {
    const fel = String(felValue ?? '').trim();
    if (!fel) return;
    if (!this._urlFel) {
      try {
        await this.fetchUrlFel();
      } catch (err) {
        F.toast(err.message || 'No se pudo leer la URL FEL', 'error');
        return;
      }
    }
    if (!this._urlFel) {
      F.toast('Configure la URL FEL en Config general', 'warning');
      return;
    }
    const url = this.joinFelUrl(this._urlFel, fel);
    if (!url) {
      F.toast('No se pudo construir la URL del documento FEL', 'warning');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  async fetchConfig() {
    return F.fetchJson(this.apiUrl('/config', { _: Date.now() }));
  },

  async fetchCajasAbiertas() {
    const codempleado = F.sessionCodEmpleado();
    const data = await F.fetchJson(
      this.apiUrl('/cajas-abiertas', {
        _: Date.now(),
        ...(codempleado != null ? { codempleado: String(codempleado) } : {}),
      })
    );
    this._cajas = data.rows || [];
    this._cajaDefault = data.cajaDefault ?? data.preferredCaja ?? null;
    return this._cajas;
  },

  resolveInitialCodcaja(header) {
    const stored = header?.CODCAJA;
    if (stored != null && stored !== '' && Number(stored) > 0) return String(stored);
    const preferred = F.pickCajaDefault(this._cajas, this._cajaDefault);
    if (preferred) return preferred;
    return '';
  },

  resolveCodcajaSelectValue(header) {
    if (this._selectedCodcaja !== null) return this._selectedCodcaja;
    return this.resolveInitialCodcaja(header);
  },

  readCodcajaForFinalizar() {
    const sel = this._container?.querySelector('#nc-doc-caja');
    const raw = sel?.value?.trim();
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  },

  renderCajaField() {
    const h = this._pedido?.header;
    const codcaja = this.resolveCodcajaSelectValue(h);
    const disabled = !this.docEditable(h) ? ' disabled' : '';
    const opts = (this._cajas || [])
      .map(
        (c) =>
          `<option value="${c.CODCAJA}"${String(c.CODCAJA) === codcaja ? ' selected' : ''}>${this.escapeHtml(c.DESCAJA)}</option>`
      )
      .join('');
    return `
      <div class="pos-header-caja-wrap">
        <label class="form-label small mb-0" for="nc-doc-caja">Caja</label>
        <select class="form-select form-select-sm" id="nc-doc-caja"${disabled}>
          <option value="">— Sin caja —</option>
          ${opts}
        </select>
      </div>`;
  },

  async fetchPedidosList() {
    const fecha = String(this._listFecha || this.todayIsoDate()).slice(0, 10);
    this._listFecha = fecha;
    const data = await F.fetchJson(this.apiUrl('/pedidos', { fecha, _: Date.now() }));
    this._pedidosList = data.rows || [];
    if (data.fecha) this._listFecha = String(data.fecha).slice(0, 10);
    return this._pedidosList;
  },

  pedidosForSelectedDate() {
    return this._pedidosList || [];
  },

  filteredPedidosList() {
    const base = this.pedidosForSelectedDate();
    const q = this._listFilter.trim().toLowerCase();
    if (!q) return base;
    return base.filter((r) => {
      const hay = [
        r.CODDOC,
        r.CORRELATIVO,
        r.SERIEFAC,
        r.NOFAC,
        r.DOC_NOMCLIE,
        r.NEGOCIO,
        r.FEL_UUDI,
        r.OBS,
      ]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      return hay.includes(q);
    });
  },

  async loadPedido(coddoc, correlativo, opts = {}) {
    this._pedido = await F.fetchJson(this.apiUrl(`/pedidos/${encodeURIComponent(coddoc)}/${correlativo}`, { _: Date.now() }));
    if (this._screen === 'editor' && !opts.skipRender) this.renderAll();
  },

  async fetchLineasDisponibles() {
    const h = this._pedido?.header || {};
    const serie = String(h.SERIEFAC || '').trim();
    const nofac = String(h.NOFAC || '').trim();
    if (!serie || !nofac) {
      this._lineasDisponibles = [];
      return [];
    }
    const key = this.docKey();
    const data = await F.fetchJson(this.apiUrl(
      `/facturas-referencia/${encodeURIComponent(serie)}/${encodeURIComponent(nofac)}/disponibles`,
      {
        exclude_coddoc: key?.coddoc || '',
        exclude_correlativo: key?.correlativo || '',
        _: Date.now(),
      },
    ));
    this._lineasDisponibles = data.rows || [];
    return this._lineasDisponibles;
  },

  async crearPedidoDesdeFactura(referencia, coddocDestino) {
    const fecha = String(referencia?.FECHA || this.todayIsoDate()).slice(0, 10);
    const body = {
      SERIEFAC: referencia.SERIEFAC,
      NOFAC: referencia.NOFAC,
      CODDOC: coddocDestino,
      USUARIO: this.usuario(),
      FECHA: fecha,
    };
    const pedido = await F.fetchJson(this.apiUrl('/pedidos'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    this._pedido = pedido;
    this._listFecha = fecha;
    return pedido;
  },

  async buscarFacturasReferencia(q) {
    const coddocNota = this.activeCoddoc();
    return F.fetchJson(this.apiUrl('/facturas-referencia', {
      q,
      coddoc_nota: coddocNota || '',
      _: Date.now(),
    }));
  },

  async confirmarFacturaReferencia(referencia, coddocDestino) {
    await this.crearPedidoDesdeFactura(referencia, coddocDestino);
    const key = this.docKey();
    F.toast('Nota de crédito creada', 'success');
    if (key) await this.showEditor(key.coddoc, key.correlativo);
  },

  async onNuevoPedido() {
    const coddocDestino = this.activeCoddoc();
    if (!coddocDestino) {
      F.toast('Seleccione una serie (DEV/FNC)', 'warning');
      return;
    }
    const hint = this.refFacturaHint();
    const modal = await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Factura referencia',
      width: '52rem',
      html: `
        <div class="text-start">
          <p class="small text-muted mb-1">Busque la factura que servirá de referencia para la devolución.</p>
          ${hint ? `<p class="small fw-semibold text-primary mb-2">${this.escapeHtml(hint)}</p>` : ''}
          <p class="small text-muted mb-2"><i class="fa-solid fa-hand-pointer me-1"></i>Doble clic en la factura para crear la nota.</p>
          <div class="input-group input-group-sm mb-2">
            <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
            <input type="search" id="nc-ref-search" class="form-control" placeholder="Serie, número, cliente, NIT…" autocomplete="off">
          </div>
          <div id="nc-ref-results" class="border rounded" style="max-height: 320px; overflow-y: auto;"></div>
        </div>
      `,
      showConfirmButton: false,
      showCancelButton: true,
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
      focusConfirm: false,
      didOpen: () => {
        const qInp = document.getElementById('nc-ref-search');
        const box = document.getElementById('nc-ref-results');

        const renderRows = (rows) => {
          if (!box) return;
          if (!rows.length) {
            box.innerHTML = '<p class="small text-muted text-center py-3 mb-0">Sin resultados</p>';
            return;
          }
          box.innerHTML = rows.map((r) => `
            <div class="list-group-item list-group-item-action border-0 border-bottom rounded-0 nc-ref-row"
              role="option"
              style="cursor: pointer;"
              data-serie="${this.escapeHtml(r.CODDOC || '')}"
              data-corr="${this.escapeHtml(r.CORRELATIVO || '')}"
              data-tipodoc="${this.escapeHtml(r.TIPODOC || '')}"
              title="Doble clic para crear la nota">
              <div class="d-flex justify-content-between align-items-start gap-2">
                <div>
                  <strong>${this.escapeHtml(r.CODDOC || '')}-${this.escapeHtml(r.CORRELATIVO || '')}</strong>
                  <span class="badge bg-secondary ms-1">${this.escapeHtml(r.TIPODOC || '')}</span>
                  <div class="small text-muted">${this.escapeHtml(r.DOC_NOMCLIE || 'Sin cliente')}</div>
                </div>
                <div class="text-end small">
                  <div>${this.escapeHtml(this.formatFechaPedido(r))}</div>
                  <div class="fw-semibold">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</div>
                </div>
              </div>
            </div>
          `).join('');
        };

        const fetchRows = F.debounce(async () => {
          const q = qInp?.value?.trim() || '';
          if (!box) return;
          box.innerHTML = '<p class="small text-muted text-center py-3 mb-0"><i class="fa-solid fa-spinner fa-spin me-1"></i>Buscando…</p>';
          try {
            const data = await this.buscarFacturasReferencia(q);
            renderRows(data.rows || []);
          } catch (err) {
            box.innerHTML = `<p class="small text-danger text-center py-3 mb-0">${this.escapeHtml(err.message || 'Error al buscar facturas')}</p>`;
          }
        }, 300);

        box?.addEventListener('dblclick', (e) => {
          const row = e.target.closest('.nc-ref-row');
          if (!row) return;
          const ref = {
            SERIEFAC: row.getAttribute('data-serie') || '',
            NOFAC: row.getAttribute('data-corr') || '',
          };
          if (!ref.SERIEFAC || !ref.NOFAC) return;
          Swal.close({ isConfirmed: true, value: ref });
        });

        qInp?.addEventListener('input', fetchRows);
        fetchRows();
        qInp?.focus();
      },
    });

    if (!modal.isConfirmed || !modal.value) return;
    try {
      await this.confirmarFacturaReferencia(modal.value, coddocDestino);
    } catch (err) {
      F.toast(err.message || 'No se pudo crear la nota de crédito', 'error');
    }
  },

  async agregarLineaConCantidad(row, cantidad, opts = {}) {
    const key = this.docKey();
    if (!key) return false;
    if (!this.docEditable(this._pedido?.header)) {
      const msg = 'El documento no está en edición';
      if (opts.skipRender) throw new Error(msg);
      F.toast(msg, 'warning');
      return false;
    }
    const disponible = this.cantidadDisponible(row);
    const cant = Number(cantidad);
    if (!cant || cant <= 0) {
      const msg = 'Indique una cantidad a devolver mayor a cero';
      if (opts.skipRender) throw new Error(msg);
      F.toast(msg, 'warning');
      return false;
    }
    if (cant > disponible + 0.0001) {
      const msg = `La cantidad excede lo disponible (${disponible})`;
      if (opts.skipRender) throw new Error(msg);
      F.toast(msg, 'warning');
      return false;
    }

    const existing = this.findCartLineForProduct(row);
    let res;
    if (existing) {
      const lineId = this.lineId(existing);
      const nuevaCant = (Number(existing.CANTIDAD) || 0) + cant;
      res = await F.fetchJson(
        this.apiUrl(`/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/lineas/${lineId}`),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ CANTIDAD: nuevaCant }),
        },
      );
    } else {
      res = await F.fetchJson(this.apiUrl(`/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/lineas`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          CODPROD: row.CODPROD,
          CODMEDIDA: row.CODMEDIDA,
          CANTIDAD: cant,
          EQUIVALE: row.EQUIVALE,
          PRECIO: row.PRECIO,
        }),
      });
    }
    this._pedido = res?.pedido || res;
    if (!this._pedido?.header) {
      throw new Error('Respuesta inválida del servidor al agregar la línea');
    }
    if (!opts.skipRender) {
      await this.fetchLineasDisponibles();
      this.renderAll();
    }
    return true;
  },

  async agregarLineaDisponible(row, cantidadOverride) {
    if (cantidadOverride != null) {
      await this.agregarLineaConCantidad(row, cantidadOverride);
      return;
    }
    const disponible = this.cantidadDisponible(row);
    if (disponible <= 0) {
      F.toast('No hay cantidad disponible', 'warning');
      return;
    }
    const picked = await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Cantidad a devolver',
      html: `
        <div class="text-start">
          <div class="small mb-2"><strong>${this.escapeHtml(row.CODPROD || '')}</strong> · ${this.escapeHtml(row.DESPROD || '')}</div>
          <label class="form-label small mb-0" for="nc-swal-cant">Cantidad (máximo ${this.escapeHtml(String(disponible))})</label>
          <input type="number" id="nc-swal-cant" class="form-control form-control-sm" min="0.01" max="${this.escapeHtml(String(disponible))}" step="any" value="${disponible >= 1 ? 1 : disponible}">
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: CatalogosUI.guardarButtonHtml('Agregar'),
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
      focusConfirm: false,
      preConfirm: () => {
        const cant = Number(document.getElementById('nc-swal-cant')?.value);
        if (!cant || cant <= 0) {
          Swal.showValidationMessage('Cantidad inválida');
          return false;
        }
        if (cant > disponible) {
          Swal.showValidationMessage('La cantidad excede lo disponible');
          return false;
        }
        return cant;
      },
    });
    if (!picked.isConfirmed) return;
    await this.agregarLineaConCantidad(row, picked.value);
    F.toast('Línea agregada', 'success');
  },

  async agregarTodasLineas() {
    if (this._cartBusy) return;
    if (!this.docEditable(this._pedido?.header)) {
      F.toast('El documento no está en edición', 'warning');
      return;
    }
    const items = (this._lineasDisponibles || [])
      .map((row, idx) => {
        const input = this._container?.querySelector(`#nc-dev-qty-${idx}`);
        const cant = Number(input?.value);
        const disp = this.cantidadDisponible(row);
        return { row, cant, disp };
      })
      .filter((it) => it.cant > 0 && it.cant <= it.disp);

    if (!items.length) {
      F.toast('Indique cantidades a devolver en al menos una línea', 'warning');
      return;
    }

    this.setCartBusy(true);
    try {
      let addedCount = 0;
      for (const { row, cant } of items) {
        const ok = await this.agregarLineaConCantidad(row, cant, { skipRender: true });
        if (ok) addedCount += 1;
      }
      if (addedCount === 0) {
        throw new Error('No se pudo agregar ninguna línea');
      }
      await this.fetchLineasDisponibles();
      this.renderAll();
      F.toast(`${addedCount} línea(s) agregada(s)`, 'success');
    } catch (err) {
      await this.fetchLineasDisponibles().catch(() => {});
      this.renderAll();
      F.toast(err.message || 'Error al agregar líneas', 'error');
    } finally {
      this.setCartBusy(false);
    }
  },

  async agregarLineaDescuento() {
    if (this._cartBusy) return;
    if (!this.docEditable(this._pedido?.header)) {
      F.toast('El documento no está en edición', 'warning');
      return;
    }
    const key = this.docKey();
    if (!key) return;
    if (typeof DocLineaDescuentoUi === 'undefined') {
      F.toast('No se pudo abrir el formulario de descuento', 'error');
      return;
    }

    const payload = await DocLineaDescuentoUi.prompt(this);
    if (!payload) return;

    this.setCartBusy(true);
    try {
      const res = await F.fetchJson(
        this.apiUrl(`/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/lineas`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(DocLineaDescuentoUi.postBody(payload)),
        },
      );
      this._pedido = res?.pedido || res;
      if (!this._pedido?.header) {
        throw new Error('Respuesta inválida del servidor al agregar el descuento');
      }
      this.renderAll();
      F.toast('Descuento agregado', 'success');
    } catch (err) {
      F.toast(err.message || 'No se pudo agregar el descuento', 'error');
    } finally {
      this.setCartBusy(false);
    }
  },

  async actualizarCantidad(lineId, cantidad) {
    const key = this.docKey();
    if (!key) return;
    const res = await F.fetchJson(this.apiUrl(`/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/lineas/${lineId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CANTIDAD: cantidad }),
    });
    this._pedido = res.pedido;
    await this.fetchLineasDisponibles();
    this.renderAll();
  },

  async eliminarLinea(lineId) {
    const key = this.docKey();
    if (!key) return;
    const res = await F.fetchJson(this.apiUrl(`/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/lineas/${lineId}`), {
      method: 'DELETE',
    });
    this._pedido = res.pedido;
    await this.fetchLineasDisponibles();
    this.renderAll();
  },

  docTotalPrecio(header) {
    const n = Number(header?.TOTALPRECIO ?? 0);
    return Number.isFinite(n) ? n : 0;
  },

  fpagoInputValue(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return '0';
    return String(Math.round(n * 100) / 100);
  },

  renderFinalizarFpagoCardHtml(totalPrecio) {
    const total = this.fpagoInputValue(totalPrecio);
    return `
          <div class="card nc-finalizar-fpago-card h-100" id="nc-finalizar-fpago-card">
            <div class="card-header py-2 px-3 small fw-semibold bg-light border-0">
              <i class="fa-solid fa-wallet me-1 text-primary"></i>Formas de pago
            </div>
            <div class="card-body py-2 px-3 d-flex flex-column">
              <p class="small text-muted mb-2">Distribuya el total <strong>${this.escapeHtml(this.formatMoney(totalPrecio))}</strong> entre los medios de pago (contado).</p>
              <div class="row g-2 flex-grow-1">
                <div class="col-6">
                  <label class="form-label small mb-0" for="nc-finalizar-fpago-efectivo">Efectivo</label>
                  <input type="number" id="nc-finalizar-fpago-efectivo" class="form-control form-control-sm nc-fpago-input"
                    min="0" step="0.01" value="${total}">
                </div>
                <div class="col-6">
                  <label class="form-label small mb-0" for="nc-finalizar-fpago-tarjeta">Tarjeta</label>
                  <input type="number" id="nc-finalizar-fpago-tarjeta" class="form-control form-control-sm nc-fpago-input"
                    min="0" step="0.01" value="0">
                </div>
                <div class="col-6">
                  <label class="form-label small mb-0" for="nc-finalizar-fpago-deposito">Depósito</label>
                  <input type="number" id="nc-finalizar-fpago-deposito" class="form-control form-control-sm nc-fpago-input"
                    min="0" step="0.01" value="0">
                </div>
                <div class="col-6">
                  <label class="form-label small mb-0" for="nc-finalizar-fpago-cheque">Cheque</label>
                  <input type="number" id="nc-finalizar-fpago-cheque" class="form-control form-control-sm nc-fpago-input"
                    min="0" step="0.01" value="0">
                </div>
              </div>
              <div class="mt-2 small text-end text-muted" id="nc-finalizar-fpago-sum">Suma: ${this.escapeHtml(this.formatMoney(totalPrecio))} / ${this.escapeHtml(total)}</div>
              <div class="mt-2 mb-0">
                <label class="form-label small mb-0" for="nc-finalizar-fpago-desc">Detalles del pago</label>
                <input type="text" id="nc-finalizar-fpago-desc" class="form-control form-control-sm"
                  placeholder="No. boleta, cheque o tarjeta (opcional)" maxlength="200">
              </div>
            </div>
          </div>`;
  },

  sumFinalizarFpagoInputs() {
    const ids = [
      'nc-finalizar-fpago-efectivo',
      'nc-finalizar-fpago-tarjeta',
      'nc-finalizar-fpago-deposito',
      'nc-finalizar-fpago-cheque',
    ];
    return ids.reduce((acc, id) => acc + (Number(document.getElementById(id)?.value ?? 0) || 0), 0);
  },

  validateFinalizarFpago(totalPrecio) {
    const sum = Math.round(this.sumFinalizarFpagoInputs() * 1000) / 1000;
    const total = Math.round(Number(totalPrecio) * 1000) / 1000;
    if (sum <= 0) return 'Indique la forma de pago por el monto total de la nota';
    if (Math.abs(sum - total) > 0.001) {
      return `La suma (${this.formatMoney(sum)}) debe ser igual al total (${this.formatMoney(total)})`;
    }
    return null;
  },

  bindFinalizarFpagoRefresh(totalPrecio) {
    const sumEl = document.getElementById('nc-finalizar-fpago-sum');
    const ids = [
      'nc-finalizar-fpago-efectivo',
      'nc-finalizar-fpago-tarjeta',
      'nc-finalizar-fpago-deposito',
      'nc-finalizar-fpago-cheque',
    ];
    const refreshSum = () => {
      if (!sumEl) return;
      const sum = this.sumFinalizarFpagoInputs();
      sumEl.textContent = `Suma: ${this.formatMoney(sum)} / ${this.formatMoney(totalPrecio)}`;
    };
    ids.forEach((id) => {
      document.getElementById(id)?.addEventListener('input', refreshSum);
    });
    refreshSum();
  },

  readFinalizarFpagoFromDom() {
    return {
      FPAGO_EFECTIVO: Number(document.getElementById('nc-finalizar-fpago-efectivo')?.value ?? 0),
      FPAGO_TARJETA: Number(document.getElementById('nc-finalizar-fpago-tarjeta')?.value ?? 0),
      FPAGO_DEPOSITO: Number(document.getElementById('nc-finalizar-fpago-deposito')?.value ?? 0),
      FPAGO_CHEQUE: Number(document.getElementById('nc-finalizar-fpago-cheque')?.value ?? 0),
      FPAGO_DESCRIPCION: document.getElementById('nc-finalizar-fpago-desc')?.value?.trim() || '',
    };
  },

  async finalizarPedido() {
    const key = this.docKey();
    if (!key) return;
    const h = this._pedido?.header;
    if (!this.docEditable(h)) {
      F.toast('La nota no está operada', 'warning');
      return;
    }
    if (!(this._pedido?.lines || []).length) {
      F.toast('Agregue al menos una línea', 'warning');
      return;
    }
    const obsVal = this.escapeHtml(h.OBS || '');
    const totalPrecio = this.docTotalPrecio(h);
    const ok = await Swal.fire({
      ...CatalogosUI.modalBase({
        customClass: { popup: 'modal-catalogo nc-finalizar-modal' },
      }),
      title: 'Finalizar nota de crédito',
      width: '52rem',
      html: `
        <p class="small text-muted mb-2">${this.escapeHtml(this.docLabel())} · Total: <strong>${this.escapeHtml(this.formatMoney(totalPrecio))}</strong></p>
        <div class="text-start nc-finalizar-modal-body">
          <div class="row g-3 align-items-stretch">
            <div class="col-md-6">
              <label class="form-label small mb-0" for="nc-finalizar-obs">Motivo de la devolución</label>
              <input type="text" id="nc-finalizar-obs" class="form-control form-control-sm"
                value="${obsVal}" placeholder="Motivo de la devolución" maxlength="500" autocomplete="off">
            </div>
            <div class="col-md-6" id="nc-finalizar-fpago-col">
              ${this.renderFinalizarFpagoCardHtml(totalPrecio)}
            </div>
          </div>
        </div>
      `,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: CatalogosUI.guardarButtonHtml('Finalizar'),
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
      didOpen: () => {
        this.bindFinalizarFpagoRefresh(totalPrecio);
      },
      preConfirm: () => {
        const fpagoErr = this.validateFinalizarFpago(totalPrecio);
        if (fpagoErr) {
          Swal.showValidationMessage(fpagoErr);
          return false;
        }
        return {
          OBS: document.getElementById('nc-finalizar-obs')?.value?.trim() || '',
          CONCRE: 'CON',
          CODCAJA: this.readCodcajaForFinalizar(),
          ...this.readFinalizarFpagoFromDom(),
        };
      },
    });
    if (!ok.isConfirmed) return;

    const tipodocFinalizar = String(h?.TIPODOC || '').trim().toUpperCase() || 'FNC';
    const coddocFinalizar = key.coddoc;
    const correlativoFinalizar = key.correlativo;

    await F.fetchJson(this.apiUrl(`/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/finalizar`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ok.value || {}),
    });
    F.toast('Nota de crédito finalizada', 'success');
    this._pedido = null;
    await this.showList();
    const cert = await this.maybeAutoCertificarTrasFinalizar(
      coddocFinalizar,
      correlativoFinalizar,
      tipodocFinalizar
    );
    if (typeof DocOpciones !== 'undefined' && DocOpciones.maybeImprimirTicketTrasFinalizar) {
      await DocOpciones.maybeImprimirTicketTrasFinalizar({
        tipodoc: tipodocFinalizar,
        alreadyPrintedSistema: !!(cert && cert.printedSistema),
        onImprimir: () => this.imprimirPedido(coddocFinalizar, correlativoFinalizar),
      });
    }
  },

  async maybeAutoCertificarTrasFinalizar(coddoc, correlativo, tipodoc) {
    const tipo = String(tipodoc || '').trim().toUpperCase();
    if (typeof DocOpciones === 'undefined' || !DocOpciones.esTipoCertificableFel(tipo)) {
      return { certifico: false, printedSistema: false };
    }
    let auto = false;
    try {
      auto = await DocOpciones.fetchCertificaAlFinalizar();
    } catch (_) {
      return { certifico: false, printedSistema: false };
    }
    if (!auto) return { certifico: false, printedSistema: false };
    let printedSistema = false;
    try {
      await DocOpciones.certificarYMostrarFormatos(coddoc, correlativo, {
        onImprimirSistema: async () => {
          printedSistema = true;
          await this.imprimirPedido(coddoc, correlativo);
        },
      });
      await this.fetchPedidosList();
      this.refreshListDom();
      return { certifico: true, printedSistema };
    } catch (err) {
      F.alert('Error FEL', err.message || 'No se pudo certificar automáticamente', 'error');
      await this.fetchPedidosList().catch(() => {});
      this.refreshListDom();
      return { certifico: false, printedSistema: false };
    }
  },

  renderListActionsHtml(row) {
    const certBtn = this.needsCertificar(row)
      ? `<button type="button" class="btn btn-sm btn-outline-success inv-card-btn" data-action="certificar" title="Certificar FEL">
          <i class="fa-solid fa-certificate me-1"></i>CERTIFICAR
        </button>`
      : '';
    return `
      <button type="button" class="btn btn-sm btn-outline-primary inv-card-btn" data-action="editar" title="Editar">
        <i class="fa-solid fa-pen"></i>
      </button>
      <button type="button" class="btn btn-sm btn-outline-secondary inv-card-btn" data-action="imprimir" title="Imprimir">
        <i class="fa-solid fa-print"></i>
      </button>
      ${certBtn}
      <button type="button" class="btn btn-sm btn-outline-danger inv-card-btn" data-action="eliminar" title="Eliminar">
        <i class="fa-solid fa-trash"></i>
      </button>`;
  },

  renderListTableBodyHtml() {
    const rows = this.filteredPedidosList();
    if (!rows.length) {
      return `<tr><td colspan="10" class="text-center text-muted py-4">No hay notas de crédito en esta fecha</td></tr>`;
    }
    return rows.map((r) => `
      <tr class="nc-list-row" data-coddoc="${this.escapeHtml(r.CODDOC)}" data-correlativo="${r.CORRELATIVO}">
        <td class="fw-semibold text-nowrap">${this.escapeHtml(r.CODDOC)} #${this.escapeHtml(r.CORRELATIVO)}</td>
        <td class="text-nowrap">${this.escapeHtml(r.SERIEFAC || '')}-${this.escapeHtml(r.NOFAC || '')}</td>
        <td>${this.escapeHtml(r.DOC_NOMCLIE || r.NEGOCIO || 'Sin cliente')}</td>
        <td class="text-center">${Number(r.LINEAS) || 0}</td>
        <td class="text-end fw-semibold">${this.escapeHtml(this.formatMoney(r.TOTALPRECIO))}</td>
        <td class="nc-fel-col">${this.formatFelCell(r)}</td>
        <td>${this.escapeHtml(this.formatFechaPedido(r))}</td>
        <td>${this.escapeHtml(this.formatHoraPedido(r))}</td>
        <td class="small">${this.escapeHtml(r.USUARIO || '—')}</td>
        <td class="text-end text-nowrap">${this.renderListActionsHtml(r)}</td>
      </tr>
    `).join('');
  },

  renderListTableHtml() {
    return `
      <div class="card fac-list-table-card shadow-sm">
        <div class="table-responsive fac-list-table-scroll">
          <table class="table table-sm table-hover table-striped mb-0">
            <thead class="table-light sticky-top">
              <tr>
                <th>Documento</th>
                <th>Factura referencia</th>
                <th>Cliente</th>
                <th class="text-center">Líneas</th>
                <th class="text-end">Total</th>
                <th>FEL</th>
                <th>Fecha</th>
                <th>Hora</th>
                <th>Usuario</th>
                <th class="text-end">Acciones</th>
              </tr>
            </thead>
            <tbody id="nc-list-tbody">${this.renderListTableBodyHtml()}</tbody>
          </table>
        </div>
      </div>`;
  },

  renderListScreen() {
    const count = this.filteredPedidosList().length;
    return `
      <div class="pos-list-wrap">
        <div class="pos-list-header">
          <h2 class="pos-list-title">Notas de crédito</h2>
          <p class="pos-list-sub text-muted mb-0">${count} nota(s) · ${this.escapeHtml(this.listFechaLabel())}</p>
        </div>
        <div class="fac-list-toolbar mb-3">
          <div class="fac-list-toolbar-fecha">
            <label class="form-label small mb-1" for="nc-list-fecha">Fecha</label>
            <input type="date" class="form-control form-control-sm" id="nc-list-fecha"
              value="${this.escapeHtml(this._listFecha || this.todayIsoDate())}">
          </div>
          ${DocTipoSelect.renderSelectHtml({
            selectId: 'nc-list-coddoc',
            tipos: this._config?.tiposDocumento,
            selected: this.activeCoddoc(),
            label: 'Serie',
            className: 'doc-tipo-select-wrap fac-list-toolbar-serie',
          })}
          <div class="fac-list-toolbar-search flex-grow-1">
            <label class="form-label small mb-1" for="nc-list-search">Buscar</label>
            <div class="input-group input-group-sm">
              <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
              <input type="search" class="form-control pos-search-glow" id="nc-list-search"
                placeholder="Documento, factura, cliente…"
                value="${this.escapeHtml(this._listFilter)}" autocomplete="off">
            </div>
          </div>
        </div>
        ${this.renderListTableHtml()}
        <button type="button" class="btn-onneb-nuevo-fab pos-list-fab-nuevo" id="btn-nc-list-nuevo"
          aria-label="Nueva nota de crédito" title="Nueva nota de crédito"${this.activeCoddoc() ? '' : ' disabled'}>
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
        </button>
      </div>`;
  },

  refLabel() {
    const h = this._pedido?.header || {};
    const serie = String(h.SERIEFAC || '').trim();
    const nofac = String(h.NOFAC || '').trim();
    const cliente = String(h.DOC_NOMCLIE || h.CLI_NOMBRE || h.CLIENTE || '').trim();
    const doc = serie && nofac ? `${serie}-${nofac}` : 'Sin referencia';
    return { doc, cliente: cliente || 'Sin cliente' };
  },

  renderLineasDisponibles() {
    const target = this._container?.querySelector('#nc-product-list');
    if (!target) return;
    const editable = this.docEditable(this._pedido?.header);
    if (this._loadingDisponibles) {
      target.innerHTML = '<p class="text-muted small text-center py-3 mb-0"><i class="fa-solid fa-spinner fa-spin me-1"></i>Cargando líneas disponibles…</p>';
      return;
    }
    if (!this._lineasDisponibles.length) {
      target.innerHTML = '<p class="text-muted small text-center py-3 mb-0">No hay líneas disponibles para devolver</p>';
      return;
    }
    const rows = this._lineasDisponibles.map((ln, idx) => {
      const disp = this.cantidadDisponible(ln);
      const fact = Number(ln.cantFacturada ?? ln.CANT_FACTURADA ?? disp);
      const dev = Number(ln.cantDevuelta ?? ln.CANT_DEVUELTA ?? 0);
      const defaultQty = disp > 0 ? disp : 0;
      const canAdd = editable && disp > 0 && !this._cartBusy;
      const addBtn = editable
        ? `<button type="button" class="btn btn-sm btn-outline-primary" data-action="nc-add-line" data-idx="${idx}" title="Agregar"${canAdd ? '' : ' disabled'}>
            <i class="fa-solid fa-plus"></i>
          </button>`
        : '';
      return `<tr>
        <td class="small">
          <div class="fw-semibold">${this.escapeHtml(ln.CODPROD || '')}</div>
          <div class="text-muted">${this.escapeHtml(ln.DESPROD || '')}</div>
          <div class="text-muted">${this.escapeHtml(ln.CODMEDIDA || '')}</div>
        </td>
        <td class="text-end small">${this.escapeHtml(String(fact))}</td>
        <td class="text-end small">${this.escapeHtml(String(dev))}</td>
        <td class="text-end small fw-semibold">${this.escapeHtml(String(disp))}</td>
        <td class="text-end" style="width: 6rem">
          ${editable
            ? `<input type="number" class="form-control form-control-sm text-end nc-dev-qty-input" id="nc-dev-qty-${idx}"
                min="0" max="${this.escapeHtml(String(disp))}" step="any" value="${defaultQty}" data-idx="${idx}"${disp <= 0 ? ' disabled' : ''}>`
            : '—'}
        </td>
        <td class="text-end">${addBtn}</td>
      </tr>`;
    }).join('');

    target.innerHTML = `
      ${editable ? `
        <div class="d-flex justify-content-end gap-2 mb-2">
          <button type="button" class="btn btn-sm btn-outline-secondary" id="btn-nc-add-descuento"${this._cartBusy ? ' disabled' : ''}>
            <i class="fa-solid fa-tag me-1"></i>Agregar Descuento
          </button>
          <button type="button" class="btn btn-sm btn-primary" id="btn-nc-add-all"${this._cartBusy ? ' disabled' : ''}>
            <i class="fa-solid fa-list-check me-1"></i>Agregar todos
          </button>
        </div>` : ''}
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0 nc-disp-table">
          <thead class="table-light">
            <tr>
              <th>Producto</th>
              <th class="text-end">Fact.</th>
              <th class="text-end">Dev.</th>
              <th class="text-end">Disp.</th>
              <th class="text-end">A devolver</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  },

  renderCart() {
    const tbody = this._container?.querySelector('#nc-cart-tbody');
    if (!tbody) return;
    const lines = this._pedido?.lines || [];
    const editable = this.docEditable(this._pedido?.header);
    if (!lines.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">Sin líneas en la nota de crédito</td></tr>';
      return;
    }
    tbody.innerHTML = lines.map((ln) => {
      const id = this.lineId(ln);
      const qty = Number(ln.CANTIDAD) || 0;
      const isDescuento = typeof DocLineaDescuentoUi !== 'undefined' && DocLineaDescuentoUi.isLinea(ln);
      const qtyInner = editable && !isDescuento
        ? `<button type="button" class="btn btn-outline-secondary btn-sm pos-qty-btn" data-action="qty-minus" data-id="${id}"${this._cartBusy ? ' disabled' : ''}>−</button>
           <span class="px-1">${qty}</span>
           <button type="button" class="btn btn-outline-secondary btn-sm pos-qty-btn" data-action="qty-plus" data-id="${id}"${this._cartBusy ? ' disabled' : ''}>+</button>`
        : `<span>${isDescuento ? '—' : qty}</span>`;
      const delBtn = editable
        ? `<button type="button" class="btn btn-sm btn-outline-danger" data-action="line-del" data-id="${id}" title="Quitar"${this._cartBusy ? ' disabled' : ''}><i class="fa-solid fa-trash"></i></button>`
        : '';
      return `<tr>
        <td class="small">${this.escapeHtml(ln.CODPROD)}</td>
        <td class="small">${this.escapeHtml(ln.DESPROD)}<br><span class="text-muted">${this.escapeHtml(ln.CODMEDIDA || '')}</span></td>
        <td class="text-center">${qtyInner}</td>
        <td class="text-end">${this.escapeHtml(this.formatMoney(ln.TOTALPRECIO))}</td>
        <td class="text-end">${delBtn}</td>
      </tr>`;
    }).join('');
  },

  renderOrderSummary() {
    const h = this._pedido?.header || {};
    const lines = this._pedido?.lines || [];
    const totalEl = this._container?.querySelector('#nc-header-total');
    const itemsEl = this._container?.querySelector('#nc-header-items');
    const docEl = this._container?.querySelector('#nc-header-doc');
    const total = Number(h.TOTALPRECIO) || 0;
    const items = lines.reduce((sum, ln) => sum + (Number(ln.CANTIDAD) || 0), 0);
    if (totalEl) totalEl.textContent = this.formatMoney(total);
    if (itemsEl) itemsEl.textContent = items === 1 ? '1 item' : `${items} items`;
    if (docEl) docEl.textContent = this.docLabel();
  },

  renderEditorShell() {
    const editable = this.docEditable(this._pedido?.header);
    const ref = this.refLabel();
    return `
      <div class="pos-vista-wrap">
        <div class="pos-header card shadow-sm">
          <div class="card-body pos-header-body">
            <div class="pos-header-top d-flex flex-wrap align-items-center gap-2">
              <button type="button" class="btn btn-sm btn-outline-secondary pos-btn-atras" id="btn-nc-atras">
                <i class="fa-solid fa-arrow-left me-1"></i>Atrás
              </button>
              <div class="pos-header-brand">
                ${typeof EmpresaLogo !== 'undefined' ? EmpresaLogo.posHeaderLogoHtml() : '<img src="/icons/icon-72.png" width="40" height="40" alt="OnneB" class="pos-header-logo">'}
              </div>
              <div class="pos-header-doc-label small fw-semibold" id="nc-header-doc">${this.escapeHtml(this.docLabel())}</div>
              <div class="d-flex flex-wrap align-items-end gap-2">
                ${this.renderCajaField()}
                ${DocFecha.renderField('nc-doc-fecha', this._pedido?.header)}
              </div>
              <div class="ms-auto text-end">
                <h3 class="pos-header-total mb-0" id="nc-header-total">Q 0.00</h3>
                <div class="pos-header-items" id="nc-header-items">0 items</div>
              </div>
            </div>
            <div class="alert alert-info py-2 px-3 mt-2 mb-0">
              <div class="small mb-0"><strong>Factura referencia:</strong> ${this.escapeHtml(ref.doc)} · ${this.escapeHtml(ref.cliente)}</div>
            </div>
          </div>
        </div>
        <div class="pos-main">
          <div class="pos-panel pos-panel-search card shadow-sm">
            <div class="card-header py-2 d-flex align-items-center gap-2">
              <i class="fa-solid fa-file-circle-minus"></i>
              <span class="fw-semibold">Líneas disponibles</span>
            </div>
            <div class="card-body">
              <p class="small text-muted mb-2">Indique la cantidad a devolver por producto. Use el botón + en cada fila o <strong>Agregar todos</strong>.</p>
              <div id="nc-product-list"></div>
            </div>
          </div>
          <div class="pos-panel pos-panel-cart card shadow-sm">
            <div class="card-header py-2 d-flex align-items-center gap-2">
              <i class="fa-solid fa-receipt"></i>
              <span class="fw-semibold">Nota de crédito actual</span>
            </div>
            <div class="card-body">
              <div class="small text-muted mb-2">Cliente: <strong>${this.escapeHtml(ref.cliente)}</strong></div>
              <div class="pos-cart-table flex-grow-1 d-flex flex-column">
                <div class="table-responsive">
                  <table class="table table-sm table-hover mb-0">
                    <thead class="table-light">
                      <tr>
                        <th>Cód.</th>
                        <th>Producto</th>
                        <th class="text-center">Cant.</th>
                        <th class="text-end">Total</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody id="nc-cart-tbody"></tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
        ${editable ? `
          <div class="pos-fab-bar">
            <button type="button" class="btn btn-success pos-fab-btn" id="btn-nc-finalizar">
              <i class="fa-solid fa-circle-check me-1"></i>FINALIZAR
            </button>
          </div>` : ''}
      </div>
    `;
  },

  renderAll() {
    this.renderLineasDisponibles();
    this.renderCart();
    this.renderOrderSummary();
    const editable = this.docEditable(this._pedido?.header);
    const fab = this._container?.querySelector('#btn-nc-finalizar');
    if (fab) fab.style.display = editable ? '' : 'none';
  },

  refreshListDom() {
    const tbody = this._container?.querySelector('#nc-list-tbody');
    if (tbody) tbody.innerHTML = this.renderListTableBodyHtml();
    const sub = this._container?.querySelector('.pos-list-sub');
    if (sub) sub.textContent = `${this.filteredPedidosList().length} nota(s) · ${this.listFechaLabel()}`;
  },

  async certificarPedido(coddoc, correlativo) {
    const label = `${coddoc} #${correlativo}`;
    const confirm = await CatalogosUI.fireConfirm({
      title: 'Certificar nota de crédito',
      html: `<p class="mb-0">¿Certificar la nota <strong>${this.escapeHtml(label)}</strong> ante SAT (Infile)?</p>`,
      icon: 'question',
      confirmText: 'CERTIFICAR',
      confirmClass: 'btn-catalogo-guardar',
    });
    if (!confirm) return;
    try {
      await DocOpciones.certificarYMostrarFormatos(coddoc, correlativo, {
        onImprimirSistema: () => this.imprimirPedido(coddoc, correlativo),
      });
      await this.fetchPedidosList();
      this.refreshListDom();
    } catch (err) {
      F.alert('Error FEL', err.message || 'No se pudo certificar', 'error');
    }
  },

  async eliminarPedido(coddoc, correlativo) {
    const label = `${coddoc} #${correlativo}`;
    const pass = await CatalogosUI.confirmEliminarDocumento({ label, tipo: 'pedido' });
    if (!pass) return;
    await F.fetchJson(this.apiUrl(`/pedidos/${encodeURIComponent(coddoc)}/${correlativo}`), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pass: String(pass) }),
    });
    F.toast('Nota eliminada', 'success');
    await this.fetchPedidosList();
    this.refreshListDom();
  },

  async imprimirPedido(coddoc, correlativo) {
    try {
      const pedido = await F.fetchJson(this.apiUrl(`/pedidos/${encodeURIComponent(coddoc)}/${correlativo}`, { _: Date.now() }));
      const h = pedido.header || {};
      const lines = pedido.lines || [];
      const rows = lines.map((ln) => `<tr>
          <td>${this.escapeHtml(ln.CODPROD)}</td>
          <td>${this.escapeHtml(ln.DESPROD)}</td>
          <td>${this.escapeHtml(ln.CODMEDIDA)}</td>
          <td class="text-end">${Number(ln.CANTIDAD) || 0}</td>
          <td class="text-end">${this.escapeHtml(this.formatMoney(ln.TOTALPRECIO))}</td>
        </tr>`).join('');
      await PrintReport.openAndPrint(
        () =>
          PrintReport.wrapDocument({
            title: 'Nota de crédito',
            bodyHtml: `
          ${PrintReport.reportHeaderHtml({
            title: 'Nota de crédito',
            subtitleHtml: `
              <p><strong>${this.escapeHtml(h.CODDOC)} #${this.escapeHtml(h.CORRELATIVO)}</strong> · ${this.escapeHtml(this.formatFechaPedido(h))} · ${PrintReport.escapeHtml(h.USUARIO || '')}</p>
              ${h.FEL_SERIE || h.FEL_NUMERO ? `<p><strong>Serie:</strong> ${PrintReport.escapeHtml(h.FEL_SERIE || '')} · <strong>Número:</strong> ${PrintReport.escapeHtml(h.FEL_NUMERO || '')}</p>` : ''}
              <p><strong>Factura referencia:</strong> ${PrintReport.escapeHtml(h.SERIEFAC || '')}-${PrintReport.escapeHtml(h.NOFAC || '')}</p>
              <p><strong>Cliente:</strong> ${PrintReport.escapeHtml(h.DOC_NOMCLIE || h.CLI_NOMBRE || '—')}</p>
              ${h.OBS ? `<p><em>${PrintReport.escapeHtml(h.OBS)}</em></p>` : ''}
            `,
          })}
          <table>
            <thead><tr><th>Cód.</th><th>Producto</th><th>Medida</th><th class="text-end">Cant.</th><th class="text-end">Total</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5">Sin líneas</td></tr>'}</tbody>
          </table>
          <p class="text-end"><strong>Total: ${PrintReport.escapeHtml(this.formatMoney(h.TOTALPRECIO))}</strong></p>
        `,
          }),
        'width=800,height=600'
      );
    } catch (err) {
      F.toast(err.message || 'Error al imprimir', 'error');
    }
  },

  bindListEvents() {
    const search = this._container?.querySelector('#nc-list-search');
    search?.addEventListener('input', () => {
      this._listFilter = search.value;
      this.refreshListDom();
    });

    const fechaInp = this._container?.querySelector('#nc-list-fecha');
    fechaInp?.addEventListener('change', async () => {
      const val = fechaInp.value?.trim();
      if (!val || val === this._listFecha) return;
      this._listFecha = val;
      this._listFilter = search?.value || '';
      try {
        await this.fetchPedidosList();
        this.refreshListDom();
      } catch (err) {
        F.toast(err.message || 'Error al cargar notas de crédito', 'error');
      }
    });

    DocTipoSelect.bind(this._container, 'nc-list-coddoc', this);

    this._container?.querySelector('#nc-list-tbody')?.addEventListener('click', async (e) => {
      const felLink = e.target.closest('[data-action="fel-open"]');
      if (felLink) {
        e.preventDefault();
        e.stopPropagation();
        const fel = felLink.getAttribute('data-fel-uudi');
        await this.abrirFelDocumento(fel);
        return;
      }

      const btn = e.target.closest('.inv-card-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const row = btn.closest('.nc-list-row');
      if (!row) return;
      const coddoc = row.getAttribute('data-coddoc');
      const correlativo = row.getAttribute('data-correlativo');
      const action = btn.getAttribute('data-action');
      try {
        if (action === 'editar') await this.showEditor(coddoc, correlativo);
        else if (action === 'imprimir') await this.imprimirPedido(coddoc, correlativo);
        else if (action === 'certificar') await this.certificarPedido(coddoc, correlativo);
        else if (action === 'eliminar') await this.eliminarPedido(coddoc, correlativo);
      } catch (err) {
        F.toast(err.message || 'Error', 'error');
      }
    });

    this._container?.querySelector('#btn-nc-list-nuevo')?.addEventListener('click', () => {
      this.onNuevoPedido().catch((err) => F.toast(err.message || 'Error al crear nota', 'error'));
    });
  },

  setCartBusy(busy) {
    this._cartBusy = busy;
    const tbody = this._container?.querySelector('#nc-cart-tbody');
    tbody?.classList.toggle('pos-cart-busy', busy);
    const fab = this._container?.querySelector('#btn-nc-finalizar');
    if (fab) fab.disabled = busy;
    const addAll = this._container?.querySelector('#btn-nc-add-all');
    if (addAll) addAll.disabled = busy;
    const addDescuento = this._container?.querySelector('#btn-nc-add-descuento');
    if (addDescuento) addDescuento.disabled = busy;
    this._container?.querySelectorAll('[data-action="nc-add-line"]').forEach((btn) => {
      btn.disabled = busy;
    });
    this._container?.querySelectorAll('#nc-cart-tbody [data-action]').forEach((btn) => {
      btn.disabled = busy;
    });
  },

  bindEditorEvents() {
    this._container?.querySelector('#btn-nc-atras')?.addEventListener('click', () => this.showList());
    this._container?.querySelector('#nc-doc-caja')?.addEventListener('change', (e) => {
      if (e.target.disabled) return;
      this._selectedCodcaja = e.target.value?.trim() || '';
    });
    const fechaInp = this._container?.querySelector('#nc-doc-fecha');
    if (fechaInp) {
      fechaInp.addEventListener('change', () => {
        if (fechaInp.disabled) return;
        const val = fechaInp.value?.trim();
        if (!val) return;
        this.guardarFechaDocumento(val).catch((err) => F.toast(err.message, 'error'));
      });
    }
    this._container?.querySelector('#btn-nc-finalizar')?.addEventListener('click', () => {
      this.finalizarPedido().catch((err) => F.toast(err.message || 'Error al finalizar', 'error'));
    });

    this._container?.querySelector('#nc-product-list')?.addEventListener('click', async (e) => {
      const descuentoBtn = e.target.closest('#btn-nc-add-descuento');
      if (descuentoBtn) {
        e.preventDefault();
        if (this._cartBusy || descuentoBtn.disabled) return;
        await this.agregarLineaDescuento();
        return;
      }
      const addAllBtn = e.target.closest('#btn-nc-add-all');
      if (addAllBtn) {
        e.preventDefault();
        if (this._cartBusy || addAllBtn.disabled) return;
        await this.agregarTodasLineas();
        return;
      }
      const btn = e.target.closest('[data-action="nc-add-line"]');
      if (!btn || btn.disabled || this._cartBusy) return;
      e.preventDefault();
      const idx = Number(btn.getAttribute('data-idx'));
      const row = this._lineasDisponibles[idx];
      if (!row) return;
      const input = this._container?.querySelector(`#nc-dev-qty-${idx}`);
      const cant = Number(input?.value);
      this.setCartBusy(true);
      try {
        const added = await this.agregarLineaConCantidad(row, cant, { skipRender: true });
        if (added) {
          await this.fetchLineasDisponibles();
          F.toast('Línea agregada', 'success');
        }
      } catch (err) {
        F.toast(err.message || 'No se pudo agregar línea', 'error');
      } finally {
        this.setCartBusy(false);
        this.renderAll();
      }
    });

    this._container?.querySelector('#nc-product-list')?.addEventListener('input', (e) => {
      const inp = e.target.closest('.nc-dev-qty-input');
      if (!inp) return;
      const idx = Number(inp.getAttribute('data-idx'));
      const row = this._lineasDisponibles[idx];
      if (!row) return;
      const max = this.cantidadDisponible(row);
      let val = Number(inp.value);
      if (!Number.isFinite(val) || val < 0) val = 0;
      if (val > max) val = max;
      const next = val <= 0 ? '' : String(val);
      if (inp.value !== next) inp.value = next;
    });

    this._container?.querySelector('#nc-cart-tbody')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled || this._cartBusy) return;
      e.preventDefault();
      const id = Number(btn.getAttribute('data-id'));
      const line = this.findLineById(id);
      if (!line) return;
      const action = btn.getAttribute('data-action');
      if (typeof DocLineaDescuentoUi !== 'undefined' && DocLineaDescuentoUi.isLinea(line) && action !== 'line-del') {
        return;
      }
      this.setCartBusy(true);
      this.renderCart();
      try {
        if (action === 'line-del') {
          await this.eliminarLinea(id);
          return;
        }
        const qty = Number(line.CANTIDAD) || 1;
        if (action === 'qty-plus') await this.actualizarCantidad(id, qty + 1);
        else if (action === 'qty-minus') {
          if (qty <= 1) await this.eliminarLinea(id);
          else await this.actualizarCantidad(id, qty - 1);
        }
      } catch (err) {
        F.toast(err.message || 'Error al actualizar líneas', 'error');
      } finally {
        this.setCartBusy(false);
        this.renderCart();
      }
    });
  },

  async showList() {
    this._screen = 'list';
    this._pedido = null;
    this._lineasDisponibles = [];
    try {
      await DocTipoSelect.reloadTiposDocumento(this);
    } catch (err) {
      console.warn('[NotasCredito] reload tipodocumentos:', err?.message || err);
      if (this._config) DocTipoSelect.initView(this);
    }
    await this.fetchPedidosList();
    this._container.innerHTML = this.renderListScreen();
    this.bindListEvents();
  },

  async showEditor(coddoc, correlativo) {
    this._screen = 'editor';
    this._selectedCodcaja = null;
    await this.fetchCajasAbiertas();
    if (coddoc && correlativo) await this.loadPedido(coddoc, correlativo, { skipRender: true });
    this._container.innerHTML = this.renderEditorShell();
    this.bindEditorEvents();
    this._loadingDisponibles = true;
    this.renderLineasDisponibles();
    try {
      await this.fetchLineasDisponibles();
    } finally {
      this._loadingDisponibles = false;
      this.renderAll();
    }
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

    container.innerHTML = '<div class="text-center text-muted py-4 w-100"><i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando Notas de crédito…</div>';
    try {
      const [config] = await Promise.all([this.fetchConfig(), this.fetchUrlFel().catch(() => '')]);
      this._config = config;
      DocTipoSelect.initView(this);
      if (!this._config?.coddocDefault) {
        container.innerHTML = `
          <div class="alert alert-warning m-3 w-100">
            Configure un tipo de documento de nota de crédito activo (<strong>DEV</strong> o <strong>FNC</strong>) para esta empresa.
          </div>`;
        return;
      }
      this._listFecha = this.todayIsoDate();
      this._listFilter = '';
      this._pedidosList = [];
      await this.showList();
    } catch (err) {
      container.innerHTML = `
        <div class="alert alert-danger m-3 w-100">
          <i class="fa-solid fa-circle-exclamation me-2"></i>${this.escapeHtml(err.message)}
        </div>`;
    }
  },
};
