/**
 * Comandas Restaurante (TIPODOC CRS) — DOCUMENTOS + DOCPRODUCTOS + mesas.
 */
const ComandasRestauranteView = {
  _container: null,
  _config: null,
  _pedido: null,
  _productos: [],
  _pedidosList: [],
  _mesas: [],
  _listFilter: '',
  _selectedCoddoc: '',
  _screen: 'mesas',
  _loadingProducts: false,
  _searchTimer: null,
  _cartBusy: false,
  _vendedores: [],
  _precioCampo: 'PRECIO',
  PRELOAD_PRODUCTOS: 50,

  PRECIO_CAMPO_OPTIONS: [
    { value: 'PRECIO', label: 'PRECIO PUBLICO' },
    { value: 'MAYOREOC', label: 'MAYORISTA C' },
    { value: 'MAYOREOB', label: 'MAYORISTA B' },
    { value: 'MAYOREOA', label: 'MAYORISTA A' },
  ],

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
    return `/api/comandas-restaurante${segment}?${params}`;
  },

  formatMoney(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return 'Q 0.00';
    return n.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
  },

  formatQty(value) {
    const n = Number(value);
    if (Number.isNaN(n)) return '—';
    return n.toLocaleString('es-GT', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  },

  formatProdLabel(desprod, desmarca) {
    const name = String(desprod ?? '').trim();
    const marca = String(desmarca ?? '').trim();
    if (!marca) return name;
    return `${name} · ${marca}`;
  },

  renderProdNameHtml(desprod, desmarca) {
    const name = this.escapeHtml(String(desprod ?? '').trim());
    const marca = String(desmarca ?? '').trim();
    if (!marca) return name;
    return `${name} · <strong class="pos-prod-marca">${this.escapeHtml(marca)}</strong>`;
  },

  muestraDesprod2() {
    return String(this._config?.muestraDesprod2 || 'NO').trim().toUpperCase() === 'SI';
  },

  renderDesprod2Html(p) {
    if (!this.muestraDesprod2()) return '';
    const des2 = String(p?.DESPROD2 ?? '').trim();
    if (!des2) return '';
    return `<div class="crs-product-sub small text-muted">${this.escapeHtml(des2)}</div>`;
  },

  formatFechaPedido(row) {
    return DocFecha.formatDisplay(row);
  },

  docKey() {
    if (!this._pedido?.header) return null;
    const h = this._pedido.header;
    return { coddoc: h.CODDOC, correlativo: Number(h.CORRELATIVO) };
  },

  docLabel() {
    const h = this._pedido?.header;
    if (!h) return 'Sin comanda';
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

  usuario() {
    const u = F.session('user');
    return u?.username || 'POS';
  },

  clienteTipoNegocio(h) {
    if (!h) return '—';
    const tipo = String(h.CLI_TIPONEGOCIO || h.TIPONEGOCIO || '').trim();
    const neg = String(h.CLI_NEGOCIO || h.NEGOCIO || '').trim();
    if (tipo && neg) return `${tipo} — ${neg}`;
    return tipo || neg || '—';
  },

  hasCliente(h) {
    const cod = h?.CODCLIENTE;
    if (cod == null || cod === '' || Number(cod) <= 0) return false;
    const nom = String(h.DOC_NOMCLIE || h.CLI_NOMBRE || '').trim();
    return nom.length > 0;
  },

  hasVendedor(h) {
    const cod = h?.CODVEN;
    return cod != null && cod !== '' && Number(cod) > 0;
  },

  mesaOcupada(mesa) {
    return String(mesa?.OCUPADA || '').trim().toUpperCase() === 'SI';
  },

  syncClienteSearchEmphasis() {
    const h = this._pedido?.header;
    const inp = this._container?.querySelector('#pos-cliente-search');
    if (!inp) return;
    const highlight = this.docEditable(h) && !this.hasCliente(h);
    inp.classList.toggle('pos-cliente-search-required', highlight);
  },

  syncVendedorEmphasis() {
    const h = this._pedido?.header;
    const sel = this._container?.querySelector('#pos-doc-vendedor');
    if (!sel) return;
    const highlight = this.docEditable(h) && !this.hasVendedor(h);
    sel.classList.toggle('pos-doc-vendedor-required', highlight);
  },

  async fetchConfig() {
    return F.fetchJson(this.apiUrl('/config', { _: Date.now() }));
  },

  async fetchProductos(q) {
    const params = new URLSearchParams({
      empnit: F.getEmpNit(),
      limit: String(this.PRELOAD_PRODUCTOS),
      campoPrecio: this._precioCampo,
    });
    if (q) params.set('q', q);
    params.set('_', String(Date.now()));
    return F.fetchJson(`/api/comandas-restaurante/productos?${params}`);
  },

  activeCoddoc() {
    return DocTipoSelect.active(this);
  },

  async fetchPedidosList() {
    const params = new URLSearchParams({ empnit: F.getEmpNit(), status: 'O' });
    params.set('_', String(Date.now()));
    const data = await F.fetchJson(`/api/comandas-restaurante/pedidos?${params}`);
    this._pedidosList = data.rows || [];
    return this._pedidosList;
  },

  async fetchMesas() {
    const data = await F.fetchJson(this.apiUrl('/mesas', { _: Date.now() }));
    this._mesas = data.rows || data.mesas || [];
    return this._mesas;
  },

  filteredPedidosList() {
    const q = this._listFilter.trim().toLowerCase();
    if (!q) return this._pedidosList;
    return this._pedidosList.filter((r) => {
      const hay = [
        r.CODDOC,
        r.CORRELATIVO,
        r.DOC_NOMCLIE,
        r.NEGOCIO,
        r.TIPONEGOCIO,
        r.OBS,
      ]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      return hay.includes(q);
    });
  },

  async loadPedido(coddoc, correlativo, opts = {}) {
    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(coddoc)}/${correlativo}?empnit=${encodeURIComponent(F.getEmpNit())}&_=${Date.now()}`;
    this._pedido = await F.fetchJson(url);
    if (this._screen === 'editor' && !opts.skipRender) this.renderAll();
  },

  async crearPedido() {
    await this.fetchVendedores();
    const body = {
      CODDOC: this.activeCoddoc(),
      CODCLIENTE: this._config?.clienteDefault?.CODCLIENTE,
      USUARIO: this.usuario(),
    };
    const codven = F.defaultCodvenFromSession(this._vendedores);
    if (codven != null) body.CODVEN = codven;
    const url = `/api/comandas-restaurante/pedidos?empnit=${encodeURIComponent(F.getEmpNit())}`;
    this._pedido = await F.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    F.toast('Nueva comanda creada', 'success');
  },

  docEditable(header) {
    return DocFecha.editableStatus(header?.STATUS);
  },

  permiteCambiarPrecioPedido() {
    return String(this._config?.permiteCambiarPrecio || 'NO').trim().toUpperCase() === 'SI';
  },

  async enviarACocina() {
    const key = this.docKey();
    if (!key) return;
    const h = this._pedido?.header;
    if (!this.docEditable(h)) {
      F.toast('La comanda no está operada', 'warning');
      return;
    }
    const lines = this._pedido?.lines || [];
    if (!lines.length) {
      F.toast('Agregue productos antes de enviar a cocina', 'warning');
      return;
    }
    const pendientes = lines.filter((l) => Number(l.SOLICITADO) === 0);
    if (!pendientes.length) {
      F.toast('Todos los productos ya fueron enviados a cocina', 'info');
      return;
    }
    const ok = await CatalogosUI.fireConfirm({
      title: '¿Enviar a cocina?',
      html: `<p class="mb-0">Se enviarán <strong>${pendientes.length}</strong> producto(s) pendientes a cocina.</p>`,
      icon: 'question',
      confirmText: 'Sí, enviar',
      confirmClass: 'btn-catalogo-guardar',
    });
    if (!ok) return;
    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/enviar-cocina?empnit=${encodeURIComponent(F.getEmpNit())}`;
    try {
      this.setCartBusy(true);
      const res = await F.fetchJson(url, { method: 'POST' });
      this._pedido = res.pedido || this._pedido;
      this.renderCart();
      this.renderOrderSummary();
      const n = Number(res.updated) || 0;
      F.toast(n ? `${n} producto(s) enviados a cocina` : res.message || 'Sin cambios', 'success');
    } catch (err) {
      F.toast(err.message || 'No se pudo enviar a cocina', 'error');
    } finally {
      this.setCartBusy(false);
    }
  },

  async finalizarPedido() {
    const key = this.docKey();
    if (!key) return;
    const h = this._pedido?.header;
    if (!this.docEditable(h)) {
      F.toast('La comanda no está operada', 'warning');
      return;
    }
    if (!(this._pedido?.lines || []).length) {
      F.toast('Agregue al menos un producto', 'warning');
      return;
    }
    if (!this.hasCliente(h)) {
      F.toast('Seleccione un cliente antes de finalizar', 'warning');
      this.syncClienteSearchEmphasis();
      this._container?.querySelector('#pos-cliente-search')?.focus();
      return;
    }

    const solicitaClave = await DocVendedorClave.shouldSolicitarClave();
    if (solicitaClave) {
      const ok = await DocVendedorClave.promptAndApply({
        apiLookupUrl: `/api/comandas-restaurante/vendedores/por-clave?empnit=${encodeURIComponent(F.getEmpNit())}`,
        vendedorSelectId: '#pos-doc-vendedor',
        view: this,
      });
      if (!ok) return;
    } else if (!this.hasVendedor(h)) {
      F.toast('Seleccione un vendedor antes de finalizar', 'warning');
      this.syncVendedorEmphasis();
      this._container?.querySelector('#pos-doc-vendedor')?.focus();
      return;
    }

    const tipoNeg = this.escapeHtml(this.clienteTipoNegocio(h));
    const nomRaw = (h.DOC_NOMCLIE || h.CLI_NOMBRE || '').trim();
    const dirRaw = (h.DOC_DIRCLIE || h.CLI_DIR || '').trim();
    const obsVal = this.escapeHtml(h.OBS || '');

    const { isConfirmed, value } = await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: 'Finalizar comanda',
      html: `
        <p class="small text-muted mb-3">${this.escapeHtml(this.docLabel())}</p>
        <div class="text-start">
          <div class="mb-2">
            <label class="form-label small mb-0">Tipo negocio — Negocio</label>
            <div class="form-control form-control-sm bg-light">${tipoNeg}</div>
          </div>
          <div class="mb-2">
            <label class="form-label small mb-0" for="pos-finalizar-nomclie">Nombre cliente</label>
            <input type="text" id="pos-finalizar-nomclie" class="form-control form-control-sm"
              value="${this.escapeHtml(nomRaw)}" autocomplete="off">
          </div>
          <div class="mb-2">
            <label class="form-label small mb-0" for="pos-finalizar-dirclie">Dirección cliente</label>
            <input type="text" id="pos-finalizar-dirclie" class="form-control form-control-sm"
              value="${this.escapeHtml(dirRaw)}" autocomplete="off">
          </div>
          <div class="mb-0">
            <label class="form-label small mb-0" for="pos-finalizar-obs">Observaciones</label>
            <textarea id="pos-finalizar-obs" class="form-control form-control-sm" rows="3"
              placeholder="Observaciones de la comanda…">${obsVal}</textarea>
          </div>
        </div>
      `,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: CatalogosUI.guardarButtonHtml('Finalizar'),
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
      focusConfirm: false,
      didOpen: () => document.getElementById('pos-finalizar-nomclie')?.focus(),
      preConfirm: () => {
        const nom = document.getElementById('pos-finalizar-nomclie')?.value?.trim() || '';
        if (!nom) {
          Swal.showValidationMessage('Ingrese el nombre del cliente');
          return false;
        }
        return {
          OBS: document.getElementById('pos-finalizar-obs')?.value?.trim() || '',
          DOC_NOMCLIE: nom,
          DOC_DIRCLIE: document.getElementById('pos-finalizar-dirclie')?.value?.trim() || '',
        };
      },
    });

    if (!isConfirmed) return;

    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/finalizar?empnit=${encodeURIComponent(F.getEmpNit())}`;
    await F.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    F.toast('Comanda finalizada', 'success');
    this._pedido = null;
    await this.showMesas();
  },

  async agregarLinea(codprod, codmedida, cantidad = 1, precio = undefined, obs = '') {
    const key = this.docKey();
    if (!key) {
      F.toast('No hay comanda activa', 'warning');
      return;
    }
    if (!this.docEditable(this._pedido?.header)) {
      F.toast('La comanda no está en edición', 'warning');
      return;
    }
    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/lineas?empnit=${encodeURIComponent(F.getEmpNit())}`;
    const body = {
      CODPROD: codprod,
      CODMEDIDA: codmedida,
      CANTIDAD: cantidad,
      CAMPO_PRECIO: this._precioCampo,
    };
    if (precio !== undefined && precio !== null) {
      body.PRECIO = precio;
    }
    const obsTrim = String(obs ?? '').trim();
    if (obsTrim) body.OBS = obsTrim.slice(0, 255);
    const res = await F.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    this._pedido = res.pedido;
    this.renderCart();
    this.renderOrderSummary();
    F.toast('Producto agregado', 'success');
  },

  setCartBusy(busy) {
    this._cartBusy = busy;
    const tbody = this._container?.querySelector('#pos-cart-tbody');
    tbody?.classList.toggle('pos-cart-busy', busy);
    const fab = this._container?.querySelector('#btn-pos-finalizar');
    if (fab) fab.disabled = busy;
    const enviarFab = this._container?.querySelector('#btn-pos-enviar-cocina');
    if (enviarFab) enviarFab.disabled = busy;
    const barcodeFab = this._container?.querySelector('#pos-fab-barcode');
    if (barcodeFab) barcodeFab.disabled = busy;
  },

  async actualizarCantidad(lineId, cantidad) {
    const key = this.docKey();
    if (!key) return;
    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/lineas/${lineId}?empnit=${encodeURIComponent(F.getEmpNit())}`;
    const res = await F.fetchJson(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CANTIDAD: cantidad }),
    });
    this._pedido = res.pedido;
    this.renderCart();
    this.renderOrderSummary();
  },

  async eliminarLinea(lineId) {
    const key = this.docKey();
    if (!key) return;
    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}/lineas/${lineId}?empnit=${encodeURIComponent(F.getEmpNit())}`;
    const res = await F.fetchJson(url, { method: 'DELETE' });
    this._pedido = res.pedido;
    this.renderCart();
    this.renderOrderSummary();
  },

  async onProductClick(row) {
    if (!row?.CODPROD) {
      F.toast('Producto no disponible', 'warning');
      return;
    }
    const precios = this._productos.filter(
      (p) => String(p.CODPROD).trim() === String(row.CODPROD).trim()
    );
    if (!precios.length) {
      F.toast('Sin precios habilitados', 'warning');
      return;
    }
    const defaultMedida = row.CODMEDIDA || precios[0].CODMEDIDA;
    const priceByMedida = Object.fromEntries(
      precios.map((p) => [String(p.CODMEDIDA), Number(p.PRECIO) || 0])
    );
    const defaultPrecio = priceByMedida[String(defaultMedida)] ?? 0;
    const permiteCambiarPrecio = this.permiteCambiarPrecioPedido();
    const options = precios
      .map((p) => {
        const selected = String(p.CODMEDIDA) === String(defaultMedida) ? ' selected' : '';
        return `<option value="${this.escapeHtml(p.CODMEDIDA)}"${selected}>${this.escapeHtml(p.CODMEDIDA)} — ${this.escapeHtml(this.formatMoney(p.PRECIO))} (eq. ${this.escapeHtml(p.EQUIVALE)}, exist. ${this.escapeHtml(this.formatQty(p.EXISTENCIA))})</option>`;
      })
      .join('');
    const { value: picked } = await Swal.fire({
      ...CatalogosUI.modalBase(),
      title: row.DESPROD || row.CODPROD,
      html: `
        <label class="form-label small mb-0">Medida</label>
        <select id="pos-swal-medida" class="form-select form-select-sm">${options}</select>
        <div class="row g-2 mt-2 align-items-end">
          <div class="col-6">
            <label class="form-label small mb-0" for="pos-swal-cant">Cantidad</label>
            <input type="number" id="pos-swal-cant" class="form-control form-control-sm" value="1" min="0.01" step="any">
          </div>
          <div class="col-6">
            <label class="form-label small mb-0" for="pos-swal-precio">Precio</label>
            ${
              permiteCambiarPrecio
                ? `<input type="number" id="pos-swal-precio" class="form-control form-control-sm" value="${defaultPrecio}" min="0" step="any">`
                : `<input type="text" id="pos-swal-precio" class="form-control form-control-sm bg-light" value="${this.escapeHtml(this.formatMoney(defaultPrecio))}" readonly>`
            }
          </div>
        </div>
        <p class="small text-muted mb-0 mt-2 text-end" id="pos-swal-total">Total: ${this.escapeHtml(this.formatMoney(defaultPrecio))}</p>
        <label class="form-label small mb-0 mt-2" for="pos-swal-obs">Notas:</label>
        <textarea id="pos-swal-obs" class="form-control form-control-sm" rows="2" maxlength="255"></textarea>
      `,
      showCancelButton: true,
      confirmButtonText: CatalogosUI.guardarButtonHtml('Agregar'),
      cancelButtonText: CatalogosUI.cancelButtonHtml('Cancelar'),
      focusConfirm: false,
      didOpen: (popup) => {
        const medSel = document.getElementById('pos-swal-medida');
        const cantInp = document.getElementById('pos-swal-cant');
        const precioInp = document.getElementById('pos-swal-precio');
        const totalEl = document.getElementById('pos-swal-total');
        const readPrecio = () => {
          if (permiteCambiarPrecio) {
            return Number(precioInp?.value) || 0;
          }
          const med = medSel?.value;
          return priceByMedida[med] ?? 0;
        };
        const updateTotal = () => {
          const cant = Number(cantInp?.value) || 0;
          const precio = readPrecio();
          if (totalEl) totalEl.textContent = `Total: ${this.formatMoney(cant * precio)}`;
        };
        const syncPrecioFromMedida = () => {
          const med = medSel?.value;
          const precio = priceByMedida[med] ?? 0;
          if (precioInp) {
            precioInp.value = permiteCambiarPrecio ? String(precio) : this.formatMoney(precio);
          }
          updateTotal();
        };
        medSel?.addEventListener('change', syncPrecioFromMedida);
        cantInp?.addEventListener('input', updateTotal);
        if (permiteCambiarPrecio) {
          precioInp?.addEventListener('input', updateTotal);
        }
        PosProductKeyboardUI.focusInput(cantInp);
        PosProductKeyboardUI.wireModalQtyFlow({ cantInput: cantInp, priceInput: precioInp, popup });
      },
      preConfirm: () => {
        const cant = Number(document.getElementById('pos-swal-cant')?.value);
        if (!cant || cant <= 0) {
          Swal.showValidationMessage('Cantidad inválida');
          return false;
        }
        const medida = document.getElementById('pos-swal-medida')?.value;
        if (!medida) {
          Swal.showValidationMessage('Seleccione una medida');
          return false;
        }
        const obs = document.getElementById('pos-swal-obs')?.value?.trim() || '';
        if (permiteCambiarPrecio) {
          const precio = Number(document.getElementById('pos-swal-precio')?.value);
          if (!Number.isFinite(precio) || precio < 0) {
            Swal.showValidationMessage('Precio inválido');
            return false;
          }
          return { medida, cantidad: cant, precio, obs };
        }
        return { medida, cantidad: cant, obs };
      },
    });
    if (picked?.medida) {
      await this.agregarLinea(row.CODPROD, picked.medida, picked.cantidad, picked.precio, picked.obs);
    }
  },

  renderProductList() {
    const targets = PosDocSearchUI.listTargets(this._container, 'pos');
    if (!targets.length) return;
    if (!this._productos.length) {
      const empty =
        '<p class="text-muted small text-center py-3 mb-0">No hay productos para mostrar</p>';
      targets.forEach((el) => {
        el.innerHTML = empty;
      });
      return;
    }
    const fallbackSrc = '/icons/icon-72.png';
    const html = this._productos
      .map((p) => {
        const fotoUrl = `/api/productos/${encodeURIComponent(String(p.CODPROD).trim())}/foto?empnit=${encodeURIComponent(F.getEmpNit())}`;
        return `
          <div class="crs-product-card pos-product-item" tabindex="0" role="button"
            data-codprod="${this.escapeHtml(p.CODPROD)}"
            data-codmedida="${this.escapeHtml(p.CODMEDIDA)}"
            aria-label="Agregar ${this.escapeHtml(this.formatProdLabel(p.DESPROD, p.DESMARCA))} ${this.escapeHtml(p.CODMEDIDA)}">
            <div class="crs-product-thumb">
              <img src="${this.escapeHtml(fotoUrl)}" alt="" class="crs-product-thumb-img"
                data-fallback="${this.escapeHtml(fallbackSrc)}"
                onerror="if(!this.dataset.err){this.dataset.err='1';this.src=this.dataset.fallback;}">
            </div>
            <div class="crs-product-body">
              <div class="crs-product-name">${this.renderProdNameHtml(p.DESPROD, p.DESMARCA)}</div>
              ${this.renderDesprod2Html(p)}
              <div class="crs-product-meta">
                <span class="pos-prod-price">${this.escapeHtml(this.formatMoney(p.PRECIO))}</span>
                <span class="pos-prod-stock small text-muted">Exist. ${this.escapeHtml(this.formatQty(p.EXISTENCIA))}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
    targets.forEach((el) => {
      el.classList.add('crs-product-cards');
      el.innerHTML = html;
    });
  },

  renderCart() {
    const tbody = this._container?.querySelector('#pos-cart-tbody');
    if (!tbody) return;
    const lines = this._pedido?.lines || [];
    const h = this._pedido?.header;
    const editable = this.docEditable(h);
    if (!lines.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="text-center text-muted py-3">Sin productos en la comanda</td></tr>';
      return;
    }
    tbody.innerHTML = lines
      .map((ln) => {
        const lineId = this.lineId(ln);
        const qty = Number(ln.CANTIDAD) || 0;
        const unitPrice = this.formatMoney(ln.PRECIO);
        const lineObsRaw = String(ln.OBS || '').trim();
        const lineObs = lineObsRaw && lineObsRaw.toUpperCase() !== 'SN' ? lineObsRaw : '';
        const solicitado = Number(ln.SOLICITADO);
        const solBadge =
          solicitado === 2
            ? '<span class="badge text-bg-primary ms-1" title="Despachado">Despachado</span>'
            : solicitado === 1
              ? '<span class="badge text-bg-success ms-1" title="Enviado a cocina">Cocina</span>'
              : '<span class="badge text-bg-secondary ms-1" title="Pendiente de enviar">Pendiente</span>';
        const qtyControlsInner = editable
          ? `<button type="button" class="btn btn-outline-secondary btn-sm pos-qty-btn" data-action="qty-minus" data-id="${lineId}"${this._cartBusy ? ' disabled' : ''}>−</button>
              <span class="px-1">${qty}</span>
              <button type="button" class="btn btn-outline-secondary btn-sm pos-qty-btn" data-action="qty-plus" data-id="${lineId}"${this._cartBusy ? ' disabled' : ''}>+</button>`
          : `<span>${qty}</span>`;
        const qtyCell = `<div class="pos-cart-qty-price d-flex align-items-center justify-content-center gap-2 flex-wrap">
            <div class="d-flex align-items-center gap-1">${qtyControlsInner}</div>
            <span class="pos-cart-unit-price small text-nowrap">${this.escapeHtml(unitPrice)}</span>
          </div>`;
        const delBtn = editable
          ? `<button type="button" class="btn btn-sm btn-outline-danger" data-action="line-del" data-id="${lineId}" title="Quitar"${this._cartBusy ? ' disabled' : ''}><i class="fa-solid fa-trash"></i></button>`
          : '';
        return `<tr>
          <td class="small">${this.escapeHtml(ln.CODPROD)}</td>
          <td class="small">${this.escapeHtml(ln.DESPROD)}${solBadge}${lineObs ? `<br><span class="text-muted fst-italic">${this.escapeHtml(lineObs)}</span>` : ''}<br><span class="text-muted">${this.escapeHtml(ln.CODMEDIDA)}</span></td>
          <td class="text-end small pos-cart-exist">${this.escapeHtml(this.formatQty(ln.EXISTENCIA))}</td>
          <td class="text-center">${qtyCell}</td>
          <td class="text-end">${this.escapeHtml(this.formatMoney(ln.TOTALPRECIO))}</td>
          <td class="text-end">${delBtn}</td>
        </tr>`;
      })
      .join('');
  },

  renderOrderSummary() {
    const totalEl = this._container?.querySelector('#pos-header-total');
    const itemsEl = this._container?.querySelector('#pos-header-items');
    const docEl = this._container?.querySelector('#pos-header-doc');
    const h = this._pedido?.header;
    const lines = this._pedido?.lines || [];
    const total = h?.TOTALPRECIO ?? 0;
    const itemCount = lines.reduce((sum, ln) => sum + (Number(ln.CANTIDAD) || 0), 0);
    if (totalEl) totalEl.textContent = this.formatMoney(total);
    if (itemsEl) {
      itemsEl.textContent = itemCount === 1 ? '1 item' : `${itemCount} items`;
    }
    if (docEl && h) docEl.textContent = this.docLabel();
  },

  renderHeaderInfo() {
    const cliente = this._container?.querySelector('#pos-cliente-nombre');
    const h = this._pedido?.header;
    if (cliente && h) {
      cliente.textContent = h.DOC_NOMCLIE || '—';
      const inp = this._container.querySelector('#pos-cliente-search');
      if (inp && !inp.matches(':focus')) inp.value = h.DOC_NOMCLIE || '';
    }
    const fechaInp = this._container?.querySelector('#pos-doc-fecha');
    if (fechaInp && h && !fechaInp.matches(':focus')) {
      fechaInp.value = DocFecha.inputValueFromHeader(h);
    }
    const vendedorSel = this._container?.querySelector('#pos-doc-vendedor');
    if (vendedorSel && h && document.activeElement !== vendedorSel) {
      const codven = h.CODVEN != null && h.CODVEN !== '' ? String(h.CODVEN) : '';
      vendedorSel.value = codven;
    }
  },

  renderPrecioCampoSelector(editable) {
    const disabled = !editable ? ' disabled' : '';
    const opts = this.PRECIO_CAMPO_OPTIONS.map(
      (o) =>
        `<option value="${o.value}"${o.value === this._precioCampo ? ' selected' : ''}>${this.escapeHtml(o.label)}</option>`
    ).join('');
    return `
      <div class="pos-precio-campo-wrap ms-auto">
        <select class="form-select form-select-sm" id="pos-precio-campo" title="Columna de precio"${disabled}>
          ${opts}
        </select>
      </div>`;
  },

  renderVendedorField() {
    const h = this._pedido?.header;
    const codven = h?.CODVEN != null && h.CODVEN !== '' ? String(h.CODVEN) : '';
    const disabled = !this.docEditable(h) ? ' disabled' : '';
    const opts = (this._vendedores || [])
      .map(
        (v) =>
          `<option value="${v.CODEMPLEADO}"${String(v.CODEMPLEADO) === codven ? ' selected' : ''}>${this.escapeHtml(v.NOMEMPLEADO)}</option>`
      )
      .join('');
    return `
      <div class="pos-doc-vendedor-wrap">
        <label class="form-label small mb-0" for="pos-doc-vendedor">Vendedor <span class="text-danger">*</span></label>
        <div class="input-group input-group-sm">
          <select class="form-select form-select-sm" id="pos-doc-vendedor"${disabled}>
            <option value="">— Seleccione —</option>
            ${opts}
          </select>
          <button type="button" class="btn btn-outline-secondary btn-refresh-vendedores" title="Actualizar vendedores" aria-label="Actualizar vendedores"${disabled}>
            <i class="fa-solid fa-rotate" aria-hidden="true"></i>
          </button>
        </div>
      </div>`;
  },

  syncEditorControls() {
    const editable = this.docEditable(this._pedido?.header);
    PosDocSearchUI.syncControls(this._container, 'pos', editable);
    ['#pos-cliente-search', '#pos-doc-fecha', '#pos-doc-vendedor', '#pos-precio-campo', '#pos-cliente-nuevo', '.btn-refresh-vendedores'].forEach((sel) => {
      const el = this._container?.querySelector(sel);
      if (el) el.disabled = !editable;
    });
    const fab = this._container?.querySelector('#btn-pos-finalizar');
    if (fab) fab.style.display = editable ? '' : 'none';
    const enviarFab = this._container?.querySelector('#btn-pos-enviar-cocina');
    if (enviarFab) enviarFab.style.display = editable ? '' : 'none';
    this.syncClienteSearchEmphasis();
    this.syncVendedorEmphasis();
  },

  renderAll() {
    this.renderHeaderInfo();
    this.renderCart();
    this.renderOrderSummary();
    this.syncEditorControls();
  },

  async bloquearPedido(coddoc, correlativo) {
    const row = this._pedidosList.find(
      (r) => String(r.CODDOC) === String(coddoc) && Number(r.CORRELATIVO) === Number(correlativo)
    );
    const label = row ? `${coddoc} #${correlativo}` : `${coddoc} #${correlativo}`;
    const confirm = await CatalogosUI.fireConfirm({
      title: '¿Bloquear comanda?',
      html: `<p class="mb-0">La comanda <strong>${this.escapeHtml(label)}</strong> pasará a estado bloqueado (I). No se elimina; solo dejará de mostrarse como operada.</p>`,
      icon: 'warning',
      confirmText: 'BLOQUEAR',
      confirmClass: 'btn-catalogo-bloquear',
    });
    if (!confirm) return;
    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(coddoc)}/${correlativo}/bloquear?empnit=${encodeURIComponent(F.getEmpNit())}`;
    await F.fetchJson(url, { method: 'POST' });
    F.toast('Comanda bloqueada', 'success');
    await this.showMesas();
  },

  async eliminarPedido(coddoc, correlativo) {
    const label = `${coddoc} #${correlativo}`;
    const pass = await CatalogosUI.confirmEliminarDocumento({ label, tipo: 'comanda' });
    if (!pass) return;
    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(coddoc)}/${correlativo}?empnit=${encodeURIComponent(F.getEmpNit())}`;
    await F.fetchJson(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pass: String(pass),
        USUARIO: String(F.session('user')?.usuario || '').trim() || undefined,
      }),
    });
    F.toast('Comanda eliminada', 'success');
    await this.showMesas();
  },

  async imprimirPedido(coddoc, correlativo) {
    try {
      const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(coddoc)}/${correlativo}?empnit=${encodeURIComponent(F.getEmpNit())}&_=${Date.now()}`;
      const pedido = await F.fetchJson(url);
      const h = pedido.header;
      const lines = pedido.lines || [];
      const rows = lines
        .map(
          (ln) => `<tr>
            <td>${this.escapeHtml(ln.CODPROD)}</td>
            <td>${this.escapeHtml(ln.DESPROD)}${ln.OBS ? `<br><em>${this.escapeHtml(ln.OBS)}</em>` : ''}</td>
            <td>${this.escapeHtml(ln.CODMEDIDA)}</td>
            <td class="text-end">${Number(ln.CANTIDAD) || 0}</td>
            <td class="text-end">${this.escapeHtml(this.formatMoney(ln.TOTALPRECIO))}</td>
          </tr>`
        )
        .join('');
      await PrintReport.openAndPrint(
        () =>
          PrintReport.wrapDocument({
            title: 'Comanda restaurante',
            bodyHtml: `
          ${PrintReport.reportHeaderHtml({
            title: 'Comanda restaurante',
            subtitleHtml: `
              <p><strong>${this.escapeHtml(h.CODDOC)} #${h.CORRELATIVO}</strong> · ${this.formatFechaPedido(h)} · ${PrintReport.escapeHtml(h.USUARIO || '')}</p>
              <p><strong>Cliente:</strong> ${PrintReport.escapeHtml(h.DOC_NOMCLIE || '—')}</p>
              ${h.OBS ? `<p><em>${PrintReport.escapeHtml(h.OBS)}</em></p>` : ''}
            `,
          })}
          <table><thead><tr><th>Cód.</th><th>Producto</th><th>Medida</th><th class="text-end">Cant.</th><th class="text-end">Total</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5">Sin líneas</td></tr>'}</tbody></table>
          <p class="text-end"><strong>Total: ${PrintReport.escapeHtml(this.formatMoney(h.TOTALPRECIO))}</strong></p>
        `,
          }),
        'width=800,height=600'
      );
    } catch (err) {
      F.toast(err.message || 'Error al imprimir', 'error');
    }
  },

  refreshMesasDom() {
    const grid = this._container?.querySelector('#crs-mesas-grid');
    if (grid) grid.innerHTML = this.renderMesasCardsHtml();
    const sub = this._container?.querySelector('.crs-mesas-sub');
    if (sub) {
      const ocupadas = this._mesas.filter((m) => this.mesaOcupada(m)).length;
      sub.textContent = `${this._mesas.length} mesa(s) · ${ocupadas} ocupada(s)`;
    }
  },

  renderMesasCardsHtml() {
    const rows = this._mesas || [];
    if (!rows.length) {
      return '<div class="pos-list-empty text-muted text-center py-5">No hay mesas configuradas</div>';
    }
    return rows
      .map((m) => {
        const ocupada = this.mesaOcupada(m);
        const statusLabel = ocupada ? 'Ocupada' : 'Disponible';
        const statusClass = ocupada ? 'crs-mesa-ocupada' : 'crs-mesa-disponible';
        const des = m.DESMESA || m.CODMESA || `Mesa ${m.ID}`;
        const cod = m.CODMESA != null ? String(m.CODMESA) : '';
        const docLabel =
          ocupada && m.CODDOC
            ? `${m.CODDOC} #${m.CORRELATIVO ?? ''}`
            : '';
        const total =
          ocupada && m.TOTALPRECIO != null && m.TOTALPRECIO !== ''
            ? this.formatMoney(m.TOTALPRECIO)
            : '';
        return `
          <div class="crs-mesa-card inv-doc-card ${statusClass}" data-mesa-id="${this.escapeHtml(m.ID)}"
            data-ocupada="${ocupada ? 'SI' : 'NO'}"
            data-coddoc="${this.escapeHtml(m.CODDOC || '')}"
            data-correlativo="${this.escapeHtml(m.CORRELATIVO ?? '')}"
            role="button" tabindex="0">
            <div class="crs-mesa-card-top">
              <span class="crs-mesa-card-name">${this.escapeHtml(des)}</span>
              <span class="crs-mesa-badge badge ${ocupada ? 'bg-warning text-dark' : 'bg-success'}">${statusLabel}</span>
            </div>
            ${cod ? `<div class="crs-mesa-card-cod small text-muted">Código: ${this.escapeHtml(cod)}</div>` : ''}
            ${
              ocupada
                ? `<div class="crs-mesa-card-doc">${this.escapeHtml(docLabel)}</div>
                   ${total ? `<div class="crs-mesa-card-total">${this.escapeHtml(total)}</div>` : ''}
                   <div class="inv-card-actions">
                     <button type="button" class="btn btn-sm btn-outline-danger inv-card-btn" data-action="cerrar-cuenta">
                       <i class="fa-solid fa-circle-xmark me-1"></i>Cerrar Cuenta
                     </button>
                   </div>`
                : ''
            }
          </div>`;
      })
      .join('');
  },

  renderMesasScreen() {
    const ocupadas = (this._mesas || []).filter((m) => this.mesaOcupada(m)).length;
    const count = (this._mesas || []).length;
    return `
      <div class="pos-list-wrap crs-mesas-wrap">
        <div class="pos-list-header">
          <h2 class="pos-list-title">Seleccione una mesa</h2>
          <p class="pos-list-sub crs-mesas-sub text-muted mb-0">${count} mesa(s) · ${ocupadas} ocupada(s)</p>
        </div>
        <div class="pos-list-toolbar mb-3">
          ${DocTipoSelect.renderSelectHtml({
            selectId: 'pos-list-coddoc',
            tipos: this._config?.tiposDocumento,
            selected: this.activeCoddoc(),
            label: 'Serie',
          })}
        </div>
        <div class="crs-mesas-grid" id="crs-mesas-grid">${this.renderMesasCardsHtml()}</div>
      </div>`;
  },

  renderEditorShell() {
    const tipoLabel = this._config?.tiposDocumento?.[0]?.DESDOC || 'Comandas';
    const editable = this.docEditable(this._pedido?.header);
    return `
      <div class="pos-vista-wrap">
        <div class="pos-header card shadow-sm">
          <div class="card-body pos-header-body">
            <div class="pos-header-top d-flex flex-wrap align-items-center gap-2">
              <button type="button" class="btn btn-sm btn-outline-secondary pos-btn-atras" id="btn-pos-atras">
                <i class="fa-solid fa-arrow-left me-1"></i>Atrás
              </button>
              <div class="pos-header-brand">
                ${typeof EmpresaLogo !== 'undefined' ? EmpresaLogo.posHeaderLogoHtml() : '<img src="/icons/icon-72.png" width="40" height="40" alt="OnneB" class="pos-header-logo">'}
              </div>
              <div class="pos-header-doc-label small fw-semibold" id="pos-header-doc">${this.escapeHtml(this.docLabel())}</div>
              <div class="pos-doc-meta-fields d-flex flex-wrap align-items-end gap-2">
                ${DocFecha.renderField('pos-doc-fecha', this._pedido?.header)}
                ${this.renderVendedorField()}
              </div>
              <div class="pos-header-summary ms-auto text-end">
                <h3 class="pos-header-total mb-0" id="pos-header-total">Q 0.00</h3>
                <div class="pos-header-items" id="pos-header-items">0 items</div>
              </div>
            </div>
          </div>
        </div>
        <div class="pos-main">
          <div class="pos-panel pos-panel-search card shadow-sm">
            <div class="card-header py-2 d-flex align-items-center gap-2 flex-wrap w-100">
              <i class="fa-solid fa-box"></i>
              <span class="fw-semibold">Productos</span>
              <span class="small text-muted">(${this.escapeHtml(tipoLabel)})</span>
              ${this.renderPrecioCampoSelector(editable)}
            </div>
            <div class="card-body">
              <div class="input-group input-group-sm mb-2 pos-search-group">
                <span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
                <input type="search" class="form-control pos-search-glow" id="pos-product-search"
                  placeholder="Código o descripción… (Enter)" autocomplete="off">
              </div>
              <div class="pos-product-list crs-product-cards" id="pos-product-list"></div>
            </div>
          </div>
          <div class="pos-panel pos-panel-cart card shadow-sm">
            <div class="card-header py-2 d-flex align-items-center gap-2 flex-wrap">
              <div class="d-flex align-items-center gap-2">
                <i class="fa-solid fa-receipt"></i>
                <span class="fw-semibold">Comanda actual</span>
              </div>
            </div>
            <div class="card-body">
              <div class="pos-cliente-wrap mb-2 position-relative">
                <label class="form-label small mb-1">Cliente</label>
                <div class="input-group input-group-sm">
                  <input type="search" class="form-control pos-search-glow" id="pos-cliente-search"
                    placeholder="Buscar cliente… (requerido)" autocomplete="off"${editable ? '' : ' disabled'}>
                  <button type="button" class="btn btn-outline-primary text-nowrap" id="pos-cliente-nuevo"
                    title="Crear cliente nuevo"${editable ? '' : ' disabled'}>NUEVO (+)</button>
                </div>
                <div id="pos-cliente-nombre" class="small text-muted mt-1"></div>
                <div id="pos-cliente-results" class="list-group position-absolute w-100 shadow-sm d-none"
                  style="z-index: 20; max-height: 200px; overflow-y: auto;"></div>
              </div>
              <div class="pos-cart-table flex-grow-1 d-flex flex-column">
                <div class="table-responsive">
                  <table class="table table-sm table-hover mb-0">
                    <thead class="table-light">
                      <tr>
                        <th>Cód.</th>
                        <th>Producto</th>
                        <th class="text-end">Exist.</th>
                        <th class="text-center">Cant. / Precio</th>
                        <th class="text-end">Total</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody id="pos-cart-tbody"></tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
        ${editable ? `
        ${PosDocSearchUI.barcodeFabHtml('pos')}
        <button type="button" class="pos-fab-enviar-cocina" id="btn-pos-enviar-cocina"
          aria-label="Enviar a cocina" title="Enviar a cocina">
          <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
        </button>
        <div class="pos-fab-bar" id="pos-fab-bar">
          ${PosDocSearchUI.mobileFabHtml('pos')}
          <button type="button" class="pos-fab-finalizar" id="btn-pos-finalizar">
            <i class="fa-solid fa-check me-2"></i>Finalizar
          </button>
        </div>` : ''}
        ${PosDocSearchUI.productModalHtml('pos')}
      </div>`;
  },

  findMesaById(id) {
    const n = Number(id);
    return (this._mesas || []).find((m) => Number(m.ID) === n) || null;
  },

  async onMesaClick(mesa) {
    if (!mesa) return;
    if (this.mesaOcupada(mesa)) {
      if (!mesa.CODDOC || mesa.CORRELATIVO == null || mesa.CORRELATIVO === '') {
        F.toast('La mesa no tiene comanda asociada', 'warning');
        return;
      }
      await this.showEditor(mesa.CODDOC, mesa.CORRELATIVO, { focusProductSearch: true });
      return;
    }
    await this.abrirMesa(mesa.ID);
  },

  async abrirMesa(id) {
    const mesa = this.findMesaById(id) || { ID: id, DESMESA: `Mesa ${id}` };
    const confirm = await CatalogosUI.fireConfirm({
      title: '¿Iniciar cuenta en esta mesa?',
      html: `<p class="mb-0">Se abrirá una comanda en <strong>${this.escapeHtml(mesa.DESMESA || mesa.CODMESA || `Mesa ${id}`)}</strong>.</p>`,
      icon: 'question',
      confirmText: 'INICIAR',
    });
    if (!confirm) return;
    if (this._container?.querySelector('#pos-list-coddoc')) {
      DocTipoSelect.syncFromDom(this._container, 'pos-list-coddoc', this);
    }
    const coddoc = this.activeCoddoc();
    if (!coddoc) {
      F.toast('Seleccione una serie de documento', 'warning');
      return;
    }
    const url = `/api/comandas-restaurante/mesas/${encodeURIComponent(id)}/abrir?empnit=${encodeURIComponent(F.getEmpNit())}`;
    await this.fetchVendedores();
    const body = { CODDOC: coddoc, USUARIO: this.usuario() };
    const codven = F.defaultCodvenFromSession(this._vendedores);
    if (codven != null) body.CODVEN = codven;
    const res = await F.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    this._pedido = res.pedido || res;
    const key = this.docKey();
    if (!key) {
      F.toast('No se recibió la comanda de la mesa', 'error');
      return;
    }
    F.toast('Cuenta iniciada', 'success');
    await this.showEditor(key.coddoc, key.correlativo, { focusProductSearch: true });
  },

  async cerrarMesa(id) {
    const mesa = this.findMesaById(id);
    const label = mesa?.DESMESA || mesa?.CODMESA || `Mesa ${id}`;
    const confirm = await CatalogosUI.fireConfirm({
      title: '¿Cerrar cuenta?',
      html: `<p class="mb-0">Se cerrará la cuenta de <strong>${this.escapeHtml(label)}</strong> y la mesa quedará disponible.</p>`,
      icon: 'warning',
      confirmText: 'CERRAR',
      confirmClass: 'btn-catalogo-bloquear',
    });
    if (!confirm) return;
    const url = `/api/comandas-restaurante/mesas/${encodeURIComponent(id)}/cerrar?empnit=${encodeURIComponent(F.getEmpNit())}`;
    await F.fetchJson(url, { method: 'POST' });
    F.toast('Cuenta cerrada', 'success');
    await this.fetchMesas();
    this.refreshMesasDom();
  },

  bindMesasEvents() {
    DocTipoSelect.bind(this._container, 'pos-list-coddoc', this);

    this._container?.querySelector('#crs-mesas-grid')?.addEventListener('click', async (e) => {
      const cerrarBtn = e.target.closest('[data-action="cerrar-cuenta"]');
      if (cerrarBtn) {
        e.preventDefault();
        e.stopPropagation();
        const card = cerrarBtn.closest('[data-mesa-id]');
        if (!card) return;
        try {
          await this.cerrarMesa(card.getAttribute('data-mesa-id'));
        } catch (err) {
          F.toast(err.message || 'Error al cerrar cuenta', 'error');
        }
        return;
      }
      const card = e.target.closest('[data-mesa-id]');
      if (!card) return;
      e.preventDefault();
      const mesa = this.findMesaById(card.getAttribute('data-mesa-id'));
      if (!mesa) return;
      try {
        await this.onMesaClick(mesa);
      } catch (err) {
        F.toast(err.message || 'Error', 'error');
      }
    });

    this._container?.querySelector('#crs-mesas-grid')?.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('[data-mesa-id]');
      if (!card || e.target.closest('button')) return;
      e.preventDefault();
      const mesa = this.findMesaById(card.getAttribute('data-mesa-id'));
      if (!mesa) return;
      try {
        await this.onMesaClick(mesa);
      } catch (err) {
        F.toast(err.message || 'Error', 'error');
      }
    });

    PosDocSearchUI.bindDocKeyboard(this, {
      isDetail: () => false,
      onNuevo: () => this.onNuevoPedido(),
    });
  },

  bindEditorEvents() {
    PosDocSearchUI.bind(this, 'pos', {
      getEditable: () => true,
      allowEmptySearch: true,
      keepProductSearchAfterAdd: true,
      buscarProductos: this.buscarProductos,
      onProductPick: (row) => this.onProductClick(row),
    });

    PosDocSearchUI.bindDocKeyboard(this, {
      isDetail: () => true,
      getEditable: () => this.docEditable(this._pedido?.header),
      onNuevo: () => this.onNuevoPedido(),
      onFinalizar: () => this.finalizarPedido(),
    });

    const precioCampoSel = this._container?.querySelector('#pos-precio-campo');
    if (precioCampoSel) {
      precioCampoSel.addEventListener('change', () => {
        if (precioCampoSel.disabled) return;
        this._precioCampo = precioCampoSel.value || 'PRECIO';
        const q = this._container?.querySelector('#pos-product-search')?.value?.trim() || '';
        this.buscarProductos(q).catch((err) => F.toast(err.message, 'error'));
      });
    }

    this._container?.querySelector('#pos-cliente-nuevo')?.addEventListener('click', () => {
      this.onNuevoCliente().catch((err) => F.toast(err.message, 'error'));
    });

    this._container?.querySelector('#pos-cart-tbody')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled || this._cartBusy) return;
      e.preventDefault();
      const id = Number(btn.getAttribute('data-id'));
      const line = this.findLineById(id);
      if (!line) {
        F.toast('No se encontró la línea de la comanda', 'warning');
        return;
      }
      const action = btn.getAttribute('data-action');
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
        F.toast(err.message || 'Error al actualizar la comanda', 'error');
      } finally {
        this.setCartBusy(false);
        this.renderCart();
      }
    });

    this._container?.querySelector('#btn-pos-atras')?.addEventListener('click', () => this.showMesas());
    this._container?.querySelector('#btn-pos-finalizar')?.addEventListener('click', () => {
      this.finalizarPedido().catch((err) => F.toast(err.message, 'error'));
    });
    this._container?.querySelector('#btn-pos-enviar-cocina')?.addEventListener('click', () => {
      this.enviarACocina().catch((err) => F.toast(err.message, 'error'));
    });

    const fechaInp = this._container?.querySelector('#pos-doc-fecha');
    if (fechaInp) {
      fechaInp.addEventListener('change', () => {
        if (fechaInp.disabled) return;
        const val = fechaInp.value?.trim();
        if (!val) return;
        this.guardarFechaDocumento(val).catch((err) => F.toast(err.message, 'error'));
      });
    }

    const vendedorSel = this._container?.querySelector('#pos-doc-vendedor');
    if (vendedorSel) {
      vendedorSel.addEventListener('change', () => {
        if (vendedorSel.disabled) return;
        const val = vendedorSel.value?.trim();
        this.guardarVendedorDocumento(val).catch((err) => F.toast(err.message, 'error'));
      });
    }

    const refreshVenBtn = this._container?.querySelector('.btn-refresh-vendedores');
    if (refreshVenBtn) {
      refreshVenBtn.addEventListener('click', () => {
        this.reloadVendedoresOptions().catch((err) => F.toast(err.message || 'No se pudo actualizar', 'error'));
      });
    }

    const clienteSearch = this._container?.querySelector('#pos-cliente-search');
    const clienteList = this._container?.querySelector('#pos-cliente-results');
    if (clienteSearch && clienteList) {
      const runCli = F.debounce(async () => {
        const q = clienteSearch.value.trim();
        if (q.length < 2) {
          clienteList.classList.add('d-none');
          return;
        }
        try {
          const rows = await this.buscarClientes(q);
          if (!rows.length) {
            clienteList.innerHTML = '<div class="list-group-item small text-muted">Sin resultados</div>';
          } else {
            clienteList.innerHTML = rows
              .map(
                (c) =>
                  `<button type="button" class="list-group-item list-group-item-action small"
                    data-codcliente="${c.CODCLIENTE}">
                    <strong>${this.escapeHtml([c.TIPONEGOCIO, c.NEGOCIO, c.NOMBRECLIENTE].map((v) => String(v || '').trim()).filter(Boolean).join(' · ') || String(c.CODCLIENTE))}</strong>
                    <span class="text-muted d-block">${this.escapeHtml(c.NIT || '')}</span>
                  </button>`
              )
              .join('');
          }
          clienteList.classList.remove('d-none');
        } catch (err) {
          clienteList.innerHTML = `<div class="list-group-item text-danger small">${this.escapeHtml(err.message)}</div>`;
          clienteList.classList.remove('d-none');
        }
      }, 350);
      clienteSearch.addEventListener('input', runCli);
      clienteList.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-codcliente]');
        if (!btn) return;
        const cod = parseInt(btn.getAttribute('data-codcliente'), 10);
        clienteList.classList.add('d-none');
        await this.aplicarCliente(cod);
      });
      if (typeof PosProductKeyboardUI !== 'undefined') {
        PosProductKeyboardUI.bindPartyResultsKeyboard(clienteSearch, clienteList, {
          itemSelector: 'button[data-codcliente]',
        });
      }
      document.addEventListener('click', (e) => {
        if (!clienteSearch.contains(e.target) && !clienteList.contains(e.target)) {
          clienteList.classList.add('d-none');
        }
      });
    }
  },

  async buscarProductos(q) {
    const term = String(q ?? '').trim();
    if (this._loadingProducts) return;
    this._loadingProducts = true;
    const spinner = '<p class="text-muted small text-center py-3"><i class="fa-solid fa-spinner fa-spin"></i></p>';
    PosDocSearchUI.setListsHtml(this._container, 'pos', spinner);
    try {
      const data = await this.fetchProductos(term);
      this._productos = data.rows || [];
      if (!this._productos.length) {
        PosDocSearchUI.setListsHtml(
          this._container,
          'pos',
          term
            ? '<p class="text-muted small text-center py-3 mb-0">Sin resultados para la búsqueda</p>'
            : '<p class="text-muted small text-center py-3 mb-0">No hay productos habilitados</p>'
        );
        return;
      }
      this.renderProductList();
    } catch (err) {
      const errHtml = `<p class="text-danger small text-center py-3">${this.escapeHtml(err.message)}</p>`;
      PosDocSearchUI.setListsHtml(this._container, 'pos', errHtml);
    } finally {
      this._loadingProducts = false;
    }
  },

  async preloadProductos() {
    await this.buscarProductos('');
  },

  async buscarClientes(q) {
    const emp = F.getEmpNit();
    const params = new URLSearchParams({ empnit: emp, q, limit: '15', habilitado: 'SI', _: Date.now() });
    const data = await F.fetchJson(`/api/clientes?${params}`);
    return data.rows || [];
  },

  async guardarFechaDocumento(fecha) {
    const key = this.docKey();
    if (!key || !this.docEditable(this._pedido?.header)) return;
    const actual = DocFecha.inputValueFromHeader(this._pedido.header);
    if (fecha === actual) return;
    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}?empnit=${encodeURIComponent(F.getEmpNit())}`;
    this._pedido = await F.fetchJson(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ FECHA: fecha }),
    });
    this.renderHeaderInfo();
    F.toast('Fecha actualizada', 'success');
  },

  async fetchVendedores(force = false) {
    if (!force && this._vendedores.length) return this._vendedores;
    const data = await F.fetchJson(this.apiUrl('/vendedores', { _: Date.now() }));
    this._vendedores = data.rows || [];
    return this._vendedores;
  },

  async reloadVendedoresOptions() {
    const sel = this._container?.querySelector('#pos-doc-vendedor');
    const btn = this._container?.querySelector('.btn-refresh-vendedores');
    if (!sel || btn?.disabled) return;
    const current = String(sel.value || '').trim();
    const icon = btn?.querySelector('i');
    if (btn) btn.disabled = true;
    if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
    try {
      await this.fetchVendedores(true);
      const opts = (this._vendedores || [])
        .map((v) => `<option value="${v.CODEMPLEADO}">${this.escapeHtml(v.NOMEMPLEADO)}</option>`)
        .join('');
      sel.innerHTML = `<option value="">— Seleccione —</option>${opts}`;
      if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
      F.toast('Vendedores actualizados', 'success');
    } finally {
      const editable = this.docEditable(this._pedido?.header);
      if (btn) btn.disabled = !editable;
      if (icon) icon.className = 'fa-solid fa-rotate';
    }
  },

  async guardarVendedorDocumento(codven) {
    const key = this.docKey();
    if (!key || !this.docEditable(this._pedido?.header)) return;
    const h = this._pedido.header;
    const actual = h.CODVEN != null && h.CODVEN !== '' ? String(h.CODVEN) : '';
    const next = codven || '';
    if (next === actual) return;
    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}?empnit=${encodeURIComponent(F.getEmpNit())}`;
    this._pedido = await F.fetchJson(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CODVEN: next ? parseInt(next, 10) : null }),
    });
    this.renderHeaderInfo();
    this.syncVendedorEmphasis();
    F.toast('Vendedor actualizado', 'success');
  },

  async aplicarCliente(codcliente) {
    const key = this.docKey();
    if (!key || !this.docEditable(this._pedido?.header)) return;
    const url = `/api/comandas-restaurante/pedidos/${encodeURIComponent(key.coddoc)}/${key.correlativo}?empnit=${encodeURIComponent(F.getEmpNit())}`;
    this._pedido = await F.fetchJson(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CODCLIENTE: codcliente }),
    });
    this.renderHeaderInfo();
    this.syncClienteSearchEmphasis();
    F.toast('Cliente actualizado', 'success');
  },

  async onNuevoCliente() {
    if (!this.docEditable(this._pedido?.header)) {
      F.toast('La comanda no está en edición', 'warning');
      return;
    }
    const data = await ClientesView.showForm('Nuevo cliente', {}, false, { profile: 'facturacion' });
    if (!data) return;
    try {
      const res = await F.fetchJson(ClientesView.apiBase(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const cod = res.CODCLIENTE;
      if (!cod) throw new Error('No se recibió el código del cliente');
      await this.aplicarCliente(cod);
      const inp = this._container?.querySelector('#pos-cliente-search');
      if (inp) inp.value = data.NOMBRECLIENTE || data.NEGOCIO || String(cod);
    } catch (err) {
      F.alert('Error', err.message, 'error');
    }
  },

  async showMesas() {
    this._screen = 'mesas';
    this._pedido = null;
    PosDocSearchUI.unbindDocKeyboard(this);
    PosDocSearchUI.teardown('pos');
    try {
      await DocTipoSelect.reloadTiposDocumento(this);
    } catch (err) {
      console.warn('[Comandas] reload tipodocumentos:', err?.message || err);
      if (this._config) DocTipoSelect.initView(this);
    }
    this._container.innerHTML = this.renderMesasScreen();
    this.bindMesasEvents();
    await this.fetchMesas();
    this.refreshMesasDom();
  },

  async showEditor(coddoc, correlativo, opts = {}) {
    this._screen = 'editor';
    PosDocSearchUI.unbindDocKeyboard(this);
    PosDocSearchUI.teardown('pos');
    if (coddoc && correlativo) {
      await this.loadPedido(coddoc, correlativo, { skipRender: true });
    }
    await this.fetchVendedores();
    this._container.innerHTML = this.renderEditorShell();
    this.bindEditorEvents();
    await this.preloadProductos();
    this.renderAll();
    if (opts.focusProductSearch) {
      PosDocSearchUI.focusProductSearch(this._container, 'pos');
    }
  },

  async onNuevoPedido() {
    try {
      if (this._container?.querySelector('#pos-list-coddoc')) {
        DocTipoSelect.syncFromDom(this._container, 'pos-list-coddoc', this);
      }
      await this.crearPedido();
      const key = this.docKey();
      if (key) await this.showEditor(key.coddoc, key.correlativo, { focusProductSearch: true });
    } catch (err) {
      F.toast(err.message || 'Error al crear comanda', 'error');
    }
  },

  async load(container) {
    PosDocSearchUI.clearActiveDocKeyboard();
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

    container.innerHTML = `<div class="text-center text-muted py-4 w-100"><i class="fa-solid fa-spinner fa-spin me-2"></i>Cargando comandas…</div>`;

    try {
      this._config = await this.fetchConfig();
      DocTipoSelect.initView(this);
      await this.fetchVendedores();
      if (!this._config.coddocDefault) {
        container.innerHTML = `
          <div class="alert alert-warning m-3 w-100">
            Configure un tipo de documento <strong>CRS</strong> (comandas restaurante) activo para esta empresa.
          </div>`;
        return;
      }
      await this.showMesas();
    } catch (err) {
      container.innerHTML = `
        <div class="alert alert-danger m-3 w-100">
          <i class="fa-solid fa-circle-exclamation me-2"></i>${this.escapeHtml(err.message)}
        </div>`;
    }
  },
};
