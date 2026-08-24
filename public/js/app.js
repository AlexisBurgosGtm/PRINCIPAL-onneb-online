/**
 * OnneB POS — SPA vanilla JS
 */
(function () {
  const views = {
    login: document.getElementById('view-login'),
    main: document.getElementById('view-main'),
  };

  const loginForm = document.getElementById('login-form');
  const btnLogout = document.getElementById('btn-logout');
  const buildCounterEl = document.getElementById('build-counter');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const btnMenuToggle = document.getElementById('btn-menu-toggle');
  const btnMenuFab = document.getElementById('btn-menu-fab');
  const mainContent = document.getElementById('main-content');
  const mainTitle = document.getElementById('main-title');

  let socket = null;
  let currentView = 'login';
  let permiteBiometricoLogin = false;

  const VIEW_CLASSES = [
    'view-active',
    'view-next',
    'view-exit-left',
    'view-exit-right',
    'view-enter-from-right',
    'view-enter-from-left',
    'view-start-left',
  ];

  /** Cambio de vista sin animación (evita pantalla congelada al salir). */
  function setViewImmediate(showLogin) {
    if (!views.login || !views.main) return;

    [views.login, views.main].forEach((el) => {
      VIEW_CLASSES.forEach((c) => el.classList.remove(c));
      el.classList.remove('view-hidden');
      el.style.transition = 'none';
    });

    if (showLogin) {
      views.main.classList.add('view-hidden');
      views.login.classList.add('view-active');
      views.login.classList.remove('view-hidden', 'view-next');
      views.main.classList.remove('view-active');
      currentView = 'login';
    } else {
      views.login.classList.add('view-hidden');
      views.main.classList.add('view-active');
      views.main.classList.remove('view-hidden', 'view-next');
      views.login.classList.remove('view-active');
      currentView = 'main';
    }

    void views.main.offsetHeight;
    [views.login, views.main].forEach((el) => {
      el.style.transition = '';
    });
    updateFabVisibility();
  }

  function stopLoadingOverlays() {
    if (window.OnnebPace) OnnebPace.stop();
    if (typeof Pace !== 'undefined' && Pace.running) Pace.stop();
    const paceOverlay = document.getElementById('onneb-pace-overlay');
    if (paceOverlay) {
      paceOverlay.classList.remove('is-active');
      paceOverlay.setAttribute('aria-busy', 'false');
    }
  }

  function dismissBlockingLayers() {
    stopLoadingOverlays();
    if (typeof Swal !== 'undefined' && Swal.isVisible()) Swal.close();
    closeSidebar();
  }

  /** Muestra la pantalla de login y oculta la vista principal. */
  function ensureLoginView(clearSession = true) {
    if (clearSession) {
      F.clearSession('user');
      window.OnnebContext = {};
      if (typeof EmpresaLogo !== 'undefined') EmpresaLogo.clearSession();
    }
    setViewImmediate(true);
  }

  /** Cerrar sesión y volver al login (botón Salir). Expuesto para flujos críticos (ej. eliminar empresa). */
  function goToLogin() {
    dismissBlockingLayers();

    F.clearSession('user');
    window.OnnebContext = {};
    if (typeof EmpresaLogo !== 'undefined') EmpresaLogo.clearSession();

    resetLoginCredentials();

    if (mainTitle) mainTitle.textContent = 'OnneB POS';
    clearHeaderSessionInfo();
    if (mainContent) {
      mainContent.className = 'main-content flex-grow-1 d-flex align-items-center justify-content-center';
      mainContent.innerHTML = '<p class="text-muted mb-0">Seleccione una opción del menú</p>';
    }
    document.querySelectorAll('.sidebar-link').forEach((l) => l.classList.remove('is-active'));

    if (typeof TipoEmpleadoAccess !== 'undefined') {
      TipoEmpleadoAccess.resetSidebarVisibility();
    }

    setViewImmediate(true);
    loadLoginEmpresas();
  }

  /** Evita que el navegador muestre/sugiera la última contraseña (campo type=text enmascarado). */
  function resetLoginCredentials() {
    const userInput = document.getElementById('username');
    const passInput = document.getElementById('password');
    if (userInput) {
      userInput.value = '';
      userInput.setAttribute('autocomplete', 'off');
    }
    if (passInput) {
      passInput.value = '';
      passInput.setAttribute('readonly', 'readonly');
      // Nombre y autocomplete únicos para que no reaparezca historial del navegador
      const token = `x${Date.now().toString(36)}`;
      passInput.setAttribute('name', `onneb-pass-${token}`);
      passInput.setAttribute('autocomplete', `off-${token}`);
      passInput.setAttribute('aria-autocomplete', 'none');
    }
  }

  function updateFabVisibility() {
    const showMain = currentView === 'main';
    if (btnMenuFab) btnMenuFab.classList.toggle('is-visible', showMain);
    if (typeof FavoritosFab !== 'undefined') {
      FavoritosFab.setVisible(showMain);
    } else {
      document.getElementById('btn-favoritos-fab')?.classList.toggle('is-visible', showMain);
    }
  }

  function updateHeaderEmpresaLogo() {
    const logoWrap = document.getElementById('header-empresa-logo');
    const iconEl = document.getElementById('header-empresa-icon-fallback');
    if (!logoWrap) return;
    const dataUrl = typeof EmpresaLogo !== 'undefined' ? EmpresaLogo.getDataUrl() : null;
    if (dataUrl) {
      logoWrap.innerHTML = `<img src="${dataUrl}" alt="" class="header-empresa-logo-img">`;
      logoWrap.hidden = false;
      if (iconEl) iconEl.hidden = true;
    } else {
      logoWrap.innerHTML = '';
      logoWrap.hidden = true;
      if (iconEl) iconEl.hidden = false;
    }
  }

  function updateHeaderSessionInfo() {
    const empNameEl = document.getElementById('header-empresa-name');
    const userNameEl = document.getElementById('header-user-name');
    const empBadge = document.getElementById('header-empresa');
    const userBadge = document.getElementById('header-user');
    const user = F.session('user');
    const empNombre = user?.empNombre || F.getEmpNitNombre() || '—';
    const username = user?.username || '—';

    if (empNameEl) empNameEl.textContent = empNombre;
    if (userNameEl) userNameEl.textContent = username;
    if (empBadge) empBadge.title = empNombre !== '—' ? `Empresa: ${empNombre}` : 'Empresa activa';
    if (userBadge) userBadge.title = username !== '—' ? `Usuario: ${username}` : 'Usuario activo';
    updateHeaderEmpresaLogo();
  }

  function clearHeaderSessionInfo() {
    const empNameEl = document.getElementById('header-empresa-name');
    const userNameEl = document.getElementById('header-user-name');
    if (empNameEl) empNameEl.textContent = '—';
    if (userNameEl) userNameEl.textContent = '—';
    if (typeof LicenseAccess !== 'undefined' && LicenseAccess.clearExpiryBadge) {
      LicenseAccess.clearExpiryBadge();
    }
    updateHeaderEmpresaLogo();
  }

  window.updateHeaderEmpresaLogo = updateHeaderEmpresaLogo;
  window.goToLogin = goToLogin;

  function navigateTo(target) {
    if (target === currentView) return;

    const from = views[currentView];
    const to = views[target];
    if (!from || !to) return;

    const goingForward = target === 'main';

    if (target === 'main') {
      updateFabVisibility();
    } else if (target === 'login') {
      updateFabVisibility();
    }

    if (goingForward) {
      from.classList.remove('view-active');
      from.classList.add('view-exit-left');
      to.classList.remove('view-next');
      to.classList.add('view-enter-from-right');
    } else {
      from.classList.remove('view-active');
      from.classList.add('view-exit-right');
      to.classList.remove('view-next');
      to.classList.add('view-start-left');
      requestAnimationFrame(() => {
        to.classList.remove('view-start-left');
        to.classList.add('view-enter-from-left');
      });
    }

    const onEnd = (e) => {
      if (e.propertyName !== 'transform') return;
      to.removeEventListener('transitionend', onEnd);

      if (goingForward) {
        from.classList.remove('view-active', 'view-exit-left');
        from.classList.add('view-next');
        to.classList.remove('view-enter-from-right');
        to.classList.add('view-active');
      } else {
        from.classList.remove('view-active', 'view-exit-right');
        from.classList.add('view-next');
        to.classList.remove('view-enter-from-left', 'view-start-left');
        to.classList.add('view-active');
      }
      currentView = target;
      updateFabVisibility();
    };

    to.addEventListener('transitionend', onEnd);
  }

  async function loadBuildCounter() {
    if (!buildCounterEl) return;
    try {
      const meta = await F.fetchJson(`/api/build-meta?_=${Date.now()}`, { cache: 'no-store' });
      const n = meta.buildCount ?? 0;
      const date = meta.buildDate || F.formatDateDD(meta.lastBuild);
      buildCounterEl.innerHTML = [
        `<span class="build-count">Compilación #${n}</span>`,
        `<span class="build-date">${date}</span>`,
      ].join('');
      buildCounterEl.title = meta.lastBuild ? `Última actualización: ${meta.lastBuild}` : '';
    } catch {
      buildCounterEl.innerHTML = [
        '<span class="build-count">Compilación #—</span>',
        `<span class="build-date">${F.formatDateDD()}</span>`,
      ].join('');
    }
  }

  function startBuildCounterPoll() {
    if (window._buildPollId) return;
    window._buildPollId = setInterval(loadBuildCounter, 1500);
  }

  function registerSocketSession() {
    if (!socket?.connected) return;
    const user = F.session('user');
    if (!user?.empNit) return;
    const codtipo =
      typeof TipoEmpleadoAccess !== 'undefined'
        ? TipoEmpleadoAccess.getCodTipo(user)
        : Number(user.codtipoempleado);
    if (!codtipo) return;
    socket.emit('session:register', {
      empnit: user.empNit,
      codtipoempleado: codtipo,
      codempleado: user.codempleado ?? null,
    });
  }

  function initSocket() {
    if (typeof io === 'undefined') return;
    socket = io();
    if (typeof F !== 'undefined' && typeof F.setSocket === 'function') {
      F.setSocket(socket);
    } else {
      window.OnnebSocket = socket;
    }
    socket.on('connect', () => {
      console.log('[Socket.IO] Conectado');
      registerSocketSession();
      if (typeof AutorizacionesUI !== 'undefined') {
        AutorizacionesUI.bindSocket();
      }
    });
    socket.on('welcome', (data) => {
      console.log('[Socket.IO]', data?.message || 'Conectado');
    });
    socket.on('disconnect', () => {
      console.log('[Socket.IO] Desconectado');
      // Evita overlay de Pace atrapado por reconexión / polling de socket.io
      stopLoadingOverlays();
    });
    socket.on('connect_error', () => {
      stopLoadingOverlays();
    });
    if (socket.io) {
      socket.io.on('reconnect_attempt', () => {
        stopLoadingOverlays();
      });
      socket.io.on('reconnect', () => {
        stopLoadingOverlays();
        registerSocketSession();
      });
    }
    socket.on('build:updated', () => {
      loadBuildCounter();
    });
    socket.on('pedido:nuevo', (data) => {
      const user = F.session('user');
      const codtipo =
        typeof TipoEmpleadoAccess !== 'undefined'
          ? TipoEmpleadoAccess.getCodTipo(user)
          : Number(user?.codtipoempleado);
      // Solo bodega: en caja el toast de Swal puede interferir con el documento abierto.
      const tipoBodega = TipoEmpleadoAccess?.TIPO_BODEGA ?? 5;
      if (Number(codtipo) !== Number(tipoBodega)) return;
      if (data?.empnit && user?.empNit && String(data.empnit) !== String(user.empNit)) return;
      const msg = String(data?.mensaje || '').trim() || 'Nuevo pedido de mostrador';
      F.toast(msg, 'info');
    });
    if (typeof DespachosEnCocinaView !== 'undefined' && typeof DespachosEnCocinaView.bindSocket === 'function') {
      DespachosEnCocinaView.bindSocket();
    }
    if (typeof AutorizacionesUI !== 'undefined') {
      AutorizacionesUI.bindSocket();
    }
  }

  function escapeOptionText(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normEmpNit(value) {
    return String(value ?? '').trim();
  }

  async function fetchEmpresasForLogin() {
    return F.fetchJson(`/api/empresas/combo?_=${Date.now()}`, { cache: 'no-store' });
  }

  async function fetchBiometricConfig() {
    try {
      const data = await F.fetchJson(`/api/auth/biometric-config?_=${Date.now()}`, { cache: 'no-store' });
      return String(data?.permiteBiometrico || 'NO').trim().toUpperCase() === 'SI';
    } catch {
      return false;
    }
  }

  function updateLoginPasskeyButton() {
    const passkeyBtn = document.getElementById('login-passkey-btn');
    if (!passkeyBtn) return;
    const show =
      permiteBiometricoLogin &&
      typeof WebAuthnClient !== 'undefined' &&
      WebAuthnClient.isSupported();
    passkeyBtn.style.display = show ? '' : 'none';
  }

  async function loadLoginEmpresas(selectedNit = '') {
    const select = document.getElementById('login-empresa');
    if (!select) return;
    const nitGuardado = normEmpNit(selectedNit);
    try {
      const [data, biometricOk] = await Promise.all([
        fetchEmpresasForLogin(),
        fetchBiometricConfig(),
      ]);
      permiteBiometricoLogin = biometricOk;
      updateLoginPasskeyButton();
      const rows = (data.rows || [])
        .map((e) => ({
          EMPNIT: normEmpNit(e.EMPNIT),
          EMPNOMBRE: String(e.EMPNOMBRE ?? '').trim() || normEmpNit(e.EMPNIT),
          CODTIPOEMPRESA:
            e.CODTIPOEMPRESA == null || e.CODTIPOEMPRESA === ''
              ? ''
              : String(parseInt(e.CODTIPOEMPRESA, 10) || ''),
        }))
        .filter((e) => e.EMPNIT);
      if (!rows.length) {
        select.innerHTML = '<option value="">Sin empresas disponibles</option>';
        select.disabled = true;
        return;
      }
      select.disabled = false;
      select.innerHTML = rows
        .map((e) => {
          const nit = escapeOptionText(e.EMPNIT);
          const nombre = escapeOptionText(e.EMPNOMBRE);
          const tip = escapeOptionText(e.CODTIPOEMPRESA);
          return `<option value="${nit}" data-codtipoempresa="${tip}">${nombre}</option>`;
        })
        .join('');
      const existe = nitGuardado && rows.some((r) => r.EMPNIT === nitGuardado);
      select.value = existe ? nitGuardado : rows[0].EMPNIT;
    } catch (err) {
      console.warn('[Login] Empresas:', err);
      select.innerHTML = '<option value="">Error al cargar empresas</option>';
      select.disabled = true;
      permiteBiometricoLogin = false;
      updateLoginPasskeyButton();
    }
  }

  if (loginForm) {
    const passInput = document.getElementById('password');
    resetLoginCredentials();

    const unlockPass = () => {
      if (!passInput) return;
      passInput.removeAttribute('readonly');
    };
    passInput?.addEventListener('focus', unlockPass);
    passInput?.addEventListener('mousedown', unlockPass);
    passInput?.addEventListener('touchstart', unlockPass, { passive: true });

    /** Limpia autofill del navegador mientras el campo sigue readonly. */
    const scrubAutofill = () => {
      if (currentView !== 'login' || !passInput) return;
      if (passInput.hasAttribute('readonly') && passInput.value) {
        passInput.value = '';
      }
    };
    [50, 200, 500, 1000].forEach((ms) => window.setTimeout(scrubAutofill, ms));
    window.addEventListener(
      'pageshow',
      () => {
        if (currentView === 'login') {
          resetLoginCredentials();
          [50, 200, 500].forEach((ms) => window.setTimeout(scrubAutofill, ms));
        }
      },
      { passive: true }
    );

    async function completeLoginSession(auth, empNit, empNombre, fallbackUsername, codTipoEmpresa) {
      const authUser = auth.user;
      const displayName = authUser?.nomempleado || authUser?.usuario || fallbackUsername;
      let tip =
        codTipoEmpresa == null || codTipoEmpresa === ''
          ? null
          : parseInt(codTipoEmpresa, 10);
      if (!Number.isFinite(tip) || tip <= 0) tip = null;
      const sessionData = {
        username: displayName,
        usuario: authUser?.usuario || fallbackUsername,
        codempleado: authUser?.codempleado ?? null,
        codtipoempleado: authUser?.codtipoempleado ?? (authUser?.superUser ? 1 : null),
        superUser: Boolean(authUser?.superUser),
        email: authUser?.email ?? '',
        hasPasskey: Boolean(auth.hasPasskey || authUser?.hasPasskey),
        empNit,
        empNombre,
        codTipoEmpresa: tip,
        at: new Date().toISOString(),
      };
      F.session('user', sessionData);
      F.setEmpresaGlobal(empNit, empNombre, tip);
      registerSocketSession();
      if (typeof AutorizacionesUI !== 'undefined') {
        AutorizacionesUI.bindSocket();
      }
      document.getElementById('password').value = '';
      stopLoadingOverlays();
      setViewImmediate(false);
      updateHeaderSessionInfo();
      if (typeof TipoEmpleadoAccess !== 'undefined') {
        await TipoEmpleadoAccess.refreshMenuAccess();
        if (typeof LicenseAccess !== 'undefined') {
          await LicenseAccess.refresh();
        }
        await F.ensureCodTipoEmpresa();
        TipoEmpleadoAccess.applySidebarVisibility();
      }
      if (typeof MenuFavoritos !== 'undefined') {
        MenuFavoritos.bind();
        MenuFavoritos.render();
      }
      if (typeof FavoritosFab !== 'undefined') {
        FavoritosFab.init();
        FavoritosFab.setVisible(true);
      }
      loadInicioDefault();
      F.toast(`Bienvenido — ${empNombre}`, 'success');
      if (typeof EmpresaLogo !== 'undefined') {
        EmpresaLogo.loadForSession(empNit)
          .then(() => updateHeaderEmpresaLogo())
          .catch(() => updateHeaderEmpresaLogo());
      }
      if (typeof WebAuthnClient !== 'undefined') {
        WebAuthnClient.offerRegisterAfterLogin({
          ...auth,
          empnit: empNit,
          permiteBiometrico: auth.permiteBiometrico || (permiteBiometricoLogin ? 'SI' : 'NO'),
        }).catch(() => {});
      }
      resetLoginCredentials();
    }

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const empresaSelect = document.getElementById('login-empresa');
      const empNit = empresaSelect?.value?.trim();
      if (!empNit || empresaSelect?.disabled) {
        F.toast('No hay empresa disponible', 'warning');
        return;
      }
      const empNombre = empresaSelect.selectedOptions[0]?.textContent?.trim() || empNit;
      const codTipoEmpresa = empresaSelect.selectedOptions[0]?.dataset?.codtipoempresa || '';
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      if (!username || !password) {
        F.toast('Usuario y contraseña son obligatorios', 'warning');
        return;
      }
      if (window.OnnebPace) OnnebPace.start();
      try {
        const auth = await F.fetchJson('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usuario: username, password, empnit: empNit }),
        });
        await completeLoginSession(auth, empNit, empNombre, username, codTipoEmpresa);
      } catch (err) {
        stopLoadingOverlays();
        F.toast(err.message || 'Error al iniciar sesión', 'error');
      }
    });

    const passkeyBtn = document.getElementById('login-passkey-btn');
    if (passkeyBtn && typeof WebAuthnClient !== 'undefined') {
      updateLoginPasskeyButton();
      passkeyBtn.addEventListener('click', async () => {
        if (!permiteBiometricoLogin) {
          F.toast('El acceso biométrico está deshabilitado', 'warning');
          return;
        }
        const empresaSelect = document.getElementById('login-empresa');
        const empNit = empresaSelect?.value?.trim();
        if (!empNit || empresaSelect?.disabled) {
          F.toast('Seleccione la empresa', 'warning');
          return;
        }
        const empNombre = empresaSelect.selectedOptions[0]?.textContent?.trim() || empNit;
        const codTipoEmpresa = empresaSelect.selectedOptions[0]?.dataset?.codtipoempresa || '';
        const username = document.getElementById('username').value.trim();
        if (window.OnnebPace) OnnebPace.start();
        try {
          const auth = await WebAuthnClient.login({
            empnit: empNit,
            ...(username ? { usuario: username } : {}),
          });
          const loginUser = auth.user?.usuario || username || 'passkey';
          await completeLoginSession(auth, empNit, empNombre, loginUser, codTipoEmpresa);
        } catch (err) {
          stopLoadingOverlays();
          if (err?.name === 'NotAllowedError') {
            F.toast('Autenticación cancelada', 'warning');
            return;
          }
          F.toast(err.message || 'No se pudo iniciar con passkey', 'error');
        }
      });
    }
  }

  function setMenuExpanded(expanded) {
    const value = expanded ? 'true' : 'false';
    if (btnMenuToggle) btnMenuToggle.setAttribute('aria-expanded', value);
    if (btnMenuFab) btnMenuFab.setAttribute('aria-expanded', value);
  }

  function openSidebar() {
    if (!sidebar || !sidebarOverlay) return;
    sidebar.classList.add('is-open');
    sidebarOverlay.classList.add('is-visible');
    setMenuExpanded(true);
  }

  function closeSidebar() {
    if (!sidebar || !sidebarOverlay) return;
    sidebar.classList.remove('is-open');
    sidebarOverlay.classList.remove('is-visible');
    setMenuExpanded(false);
  }

  function toggleSidebar() {
    if (sidebar.classList.contains('is-open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  }

  function loadInicioDefault() {
    if (!mainContent) return;
    // Sin licencia activa: solo la vista Licencia.
    if (
      typeof LicenseAccess !== 'undefined' &&
      !LicenseAccess.canAccessMenu('inicio') &&
      typeof LicenciaView !== 'undefined'
    ) {
      if (typeof F !== 'undefined' && typeof F.beginMenuNavigation === 'function') {
        F.beginMenuNavigation('licencia');
      }
      if (mainTitle) mainTitle.textContent = menuLabels.licencia || 'Licencia';
      document.querySelectorAll('.sidebar-link').forEach((l) => l.classList.remove('is-active'));
      document.querySelector('.sidebar-link[data-menu="licencia"]')?.classList.add('is-active');
      mainContent.className = 'main-content flex-grow-1 d-flex p-3';
      LicenciaView.load(mainContent);
      return;
    }
    if (typeof F !== 'undefined' && typeof F.beginMenuNavigation === 'function') {
      F.beginMenuNavigation('inicio');
    }
    if (mainTitle) mainTitle.textContent = menuLabels.inicio || 'Inicio';
    document.querySelectorAll('.sidebar-link').forEach((l) => l.classList.remove('is-active'));
    document.querySelector('.sidebar-link[data-menu="inicio"]')?.classList.add('is-active');
    mainContent.className = 'main-content flex-grow-1 d-flex p-3';
    if (typeof InicioEmpleadoView !== 'undefined') {
      InicioEmpleadoView.load(mainContent);
    } else {
      mainContent.classList.add('align-items-center', 'justify-content-center');
      mainContent.innerHTML = '<p class="text-muted mb-0">Inicio</p>';
    }
  }

  function loadInicio() {
    loadInicioDefault();
  }

  /** @deprecated Usar loadInicioDefault según tipo de empleado. */
  function loadFacturacionDefault() {
    loadInicioDefault();
  }

  const menuLabels = {
    inicio: 'Inicio',
    'pedidos-mostrador': 'Pedidos de Mostrador',
    'comandas-restaurante': 'Comandas Restaurante',
    facturacion: 'Facturas normales',
    'facturas-electronicas': 'Facturas Electrónicas',
    'facturacion-completa': 'Facturación',
    'notas-credito': 'Notas de Credito (clientes)',
    'notas-abono': 'Notas de Abono',
    compras: 'Compras',
    'notas-debito': 'Notas de credito (Proveedores)',
    gastos: 'Gastos',
    'vales-caja': 'Vales de Caja',
    'corte-caja': 'Corte de Caja',
    cotizaciones: 'Cotizaciones',
    'fraccionamiento-fac': 'Fraccionamiento Facturas',
    tareas: 'Tareas',
    embarques: 'Embarques (picking)',
    'asignacion-pedidos': 'Asignación de Facturas',
    'pendientes-entrega': 'Pendientes Entrega',
    'despachos-en-cocina': 'Despachos en Cocina',
    'cuentas-cobrar': 'Cuentas por Cobrar',
    'recibos-caja-cxc': 'Recibos de Caja CXC',
    'cuentas-pagar': 'Cuentas por Pagar',
    'retenciones-isr': 'Retenciones Emitidas ISR',
    'retenciones-iva': 'Retenciones Emitidas IVA',
    'retenciones-isr-recibidas': 'Retenciones ISR Recibidas',
    'retenciones-iva-recibidas': 'Retenciones IVA Recibidas',
    'libro-compras': 'Libro Compras',
    'libro-ventas': 'Libro Ventas',
    'libro-diario': 'Libro Diario',
    'libro-mayor': 'Libro Mayor',
    'libro-balance': 'Libro Balance',
    'inventario-fiscal': 'Inventario Fiscal',
    'nomenclatura-contable': 'Nomenclatura Contable',
    'formatos-contables': 'Formatos Contables',
    'configuraciones-contabilidad': 'Configuraciones Contabilidad',
    'movimientos-banco': 'Movimientos',
    bancos: 'Bancos',
    'cuentas-bancarias': 'Cuentas Bancarias',
    updater: 'Actualizador BD',
    'productos-precios': 'Productos y precios',
    'lista-precios': 'Lista Precios',
    inventario: 'Inventario',
    'relleno-inventario': 'Relleno de inventario',
    'entradas-inventario': 'Entradas de inventario',
    'salidas-inventario': 'Salidas de inventario',
    'inventario-retroactivo': 'Inventario Retroactivo',
    'actualizacion-inventario': 'Actualización de inventario',
    'actualizacion-costos': 'Actualización de costos',
    'crear-traslado': 'Crear Traslado',
    'recibir-traslado': 'Recibir Traslado',
    documentos: 'Documentos',
    'lista-facturas': 'Lista Facturas',
    'cuadre-caja': 'Cuadre de Caja',
    'resumen-del-dia': 'Resumen del día',
    autorizaciones: 'Autorizaciones',
    'documentos-eliminados': 'Documentos eliminados',
    promociones: 'Promociones',
    'auditoria-cajas': 'Auditoría Cajas',
    'reportes-ventas': 'Reportes de Ventas',
    'subir-catalogo': 'Subir catálogo',
    'descargar-catalogo': 'Descargar Catálogo',
    'traslados-en-transito': 'Traslados en tránsito',
    empleados: 'Empleados',
    'control-asistencia': 'Control de Asistencia',
    'nomina-config': 'Configuración nómina',
    'nomina-conceptos': 'Conceptos nómina',
    'nomina-empleados': 'Datos nómina empleados',
    'nomina-vales': 'Vales a Empleados',
    'nomina-interna': 'Nómina interna',
    'nomina-igss': 'Planilla IGSS',
    municipios: 'Municipios',
    departamentos: 'Departamentos',
    marcas: 'Marcas',
    medidas: 'Medidas',
    clientes: 'Clientes',
    'tipo-negocios': 'Tipo de Negocios',
    rutas: 'Rutas',
    proveedores: 'Proveedores',
    fabricantes: 'Fabricantes',
    ubicaciones: 'Ubicaciones',
    'mesas-restaurante': 'Mesas Restaurante',
    empresas: 'Empresas',
    'config-general': 'Config general',
    'roles-usuarios': 'Roles de usuarios',
    'tipo-documentos': 'Tipo documentos',
    'formatos-impresion': 'Formatos de impresión',
    'credenciales-fel': 'Credenciales FEL',
    cajas: 'Cajas',
    'servicio-mecanica': 'Servicio Mecánica',
    'mantenimiento-llantas': 'Mantenimiento de llantas',
    'registro-kilometrajes': 'Registro de Kilometrajes',
    vehiculos: 'VEHICULOS',
    plataformas: 'Plataformas',
    licencia: 'Licencia',
  };

  if (btnMenuToggle) btnMenuToggle.addEventListener('click', toggleSidebar);
  if (btnMenuFab) btnMenuFab.addEventListener('click', toggleSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);

  if (typeof MenuFavoritos !== 'undefined') {
    MenuFavoritos.bind();
  }

  /** Delegación: soporta clones dinámicos de Favoritos. */
  sidebar?.addEventListener('click', (e) => {
    if (e.target.closest('[data-favoritos-config], #btn-favoritos-config')) return;
    const link = e.target.closest('.sidebar-link[data-menu]');
    if (!link || !sidebar.contains(link)) return;
    e.preventDefault();
    if (window.OnnebPace) OnnebPace.start();
    const key = link.dataset.menu;
    if (
      typeof TipoEmpleadoAccess !== 'undefined' &&
      !TipoEmpleadoAccess.canAccessMenu(key)
    ) {
      F.toast('No tiene permiso para acceder a esta opción', 'warning');
      closeSidebar();
      return;
    }
    if (typeof LicenseAccess !== 'undefined' && !LicenseAccess.canAccessMenu(key)) {
      F.toast('Este módulo no está incluido en la licencia', 'warning');
      closeSidebar();
      return;
    }
    const label = menuLabels[key] || key;
    if (typeof F !== 'undefined' && typeof F.beginMenuNavigation === 'function') {
      F.beginMenuNavigation(key);
    }
    document.querySelectorAll('.sidebar-link').forEach((l) => l.classList.remove('is-active'));
    document.querySelectorAll('.sidebar-link[data-menu]').forEach((l) => {
      if (l.dataset.menu === key) l.classList.add('is-active');
    });
    mainTitle.textContent = label;
    mainContent.className = 'main-content flex-grow-1 d-flex p-3';
    if (typeof PosDocSearchUI !== 'undefined') PosDocSearchUI.clearActiveDocKeyboard();

    if (key === 'inicio') {
      loadInicio();
    } else if (key === 'compras' && typeof ComprasView !== 'undefined') {
      ComprasView.load(mainContent);
    } else if (key === 'pedidos-mostrador' && typeof PosView !== 'undefined') {
      PosView.load(mainContent);
    } else if (key === 'comandas-restaurante' && typeof ComandasRestauranteView !== 'undefined') {
      ComandasRestauranteView.load(mainContent);
    } else if (key === 'facturacion' && typeof FacturacionView !== 'undefined') {
      FacturacionView.load(mainContent);
    } else if (key === 'facturas-electronicas' && typeof FacturasElectronicasView !== 'undefined') {
      FacturasElectronicasView.load(mainContent);
    } else if (key === 'facturacion-completa' && typeof FacturacionCompletaView !== 'undefined') {
      FacturacionCompletaView.load(mainContent);
    } else if (key === 'notas-credito' && typeof NotasCreditoView !== 'undefined') {
      NotasCreditoView.load(mainContent);
    } else if (key === 'notas-abono' && typeof NotasAbonoView !== 'undefined') {
      NotasAbonoView.load(mainContent);
    } else if (key === 'notas-debito' && typeof NotasDebitoView !== 'undefined') {
      NotasDebitoView.load(mainContent);
    } else if (key === 'vales-caja' && typeof ValesCajaView !== 'undefined') {
      ValesCajaView.load(mainContent);
    } else if (key === 'corte-caja' && typeof CorteCajaView !== 'undefined') {
      CorteCajaView.load(mainContent);
    } else if (key === 'cotizaciones' && typeof CotizacionesView !== 'undefined') {
      CotizacionesView.load(mainContent);
    } else if (key === 'fraccionamiento-fac' && typeof FraccionamientoFacView !== 'undefined') {
      FraccionamientoFacView.load(mainContent);
    } else if (key === 'tareas' && typeof TareasView !== 'undefined') {
      TareasView.load(mainContent);
    } else if (key === 'embarques' && typeof EmbarquesView !== 'undefined') {
      EmbarquesView.load(mainContent);
    } else if (key === 'asignacion-pedidos' && typeof AsignacionPedidosView !== 'undefined') {
      AsignacionPedidosView.load(mainContent);
    } else if (key === 'despachos-en-cocina' && typeof DespachosEnCocinaView !== 'undefined') {
      DespachosEnCocinaView.load(mainContent);
    } else if (key === 'cuentas-cobrar' && typeof CuentasPorCobrarView !== 'undefined') {
      CuentasPorCobrarView.load(mainContent);
    } else if (key === 'recibos-caja-cxc' && typeof RecibosCajaCxcView !== 'undefined') {
      RecibosCajaCxcView.load(mainContent);
    } else if (key === 'cuentas-pagar' && typeof CuentasPorPagarView !== 'undefined') {
      CuentasPorPagarView.load(mainContent);
    } else if (key === 'entradas-inventario' && typeof EntradasInventarioView !== 'undefined') {
      EntradasInventarioView.load(mainContent);
    } else if (key === 'salidas-inventario' && typeof SalidasInventarioView !== 'undefined') {
      SalidasInventarioView.load(mainContent);
    } else if (key === 'crear-traslado' && typeof CrearTrasladoView !== 'undefined') {
      CrearTrasladoView.load(mainContent);
    } else if (key === 'recibir-traslado' && typeof RecibirTrasladoView !== 'undefined') {
      RecibirTrasladoView.load(mainContent);
    } else if (key === 'inventario' && typeof InventarioView !== 'undefined') {
      InventarioView.load(mainContent);
    } else if (key === 'relleno-inventario' && typeof InventarioRellenoView !== 'undefined') {
      InventarioRellenoView.load(mainContent);
    } else if (key === 'inventario-retroactivo' && typeof InventarioRetroactivoView !== 'undefined') {
      InventarioRetroactivoView.load(mainContent);
    } else if (
      key === 'actualizacion-inventario' &&
      typeof InventarioActualizacionView !== 'undefined'
    ) {
      InventarioActualizacionView.load(mainContent);
    } else if (key === 'actualizacion-costos' && typeof ActualizacionCostosView !== 'undefined') {
      ActualizacionCostosView.load(mainContent);
    } else if (key === 'lista-precios' && typeof ListaPreciosView !== 'undefined') {
      ListaPreciosView.load(mainContent);
    } else if (key === 'documentos' && typeof DocumentosView !== 'undefined') {
      DocumentosView.load(mainContent);
    } else if (key === 'lista-facturas' && typeof ListaFacturasView !== 'undefined') {
      ListaFacturasView.load(mainContent);
    } else if (key === 'cuadre-caja' && typeof CuadreCajaView !== 'undefined') {
      CuadreCajaView.load(mainContent);
    } else if (key === 'resumen-del-dia' && typeof ResumenDelDiaView !== 'undefined') {
      ResumenDelDiaView.load(mainContent);
    } else if (key === 'autorizaciones' && typeof AutorizacionesView !== 'undefined') {
      AutorizacionesView.load(mainContent);
    } else if (key === 'documentos-eliminados' && typeof DocumentosEliminadosView !== 'undefined') {
      DocumentosEliminadosView.load(mainContent);
    } else if (key === 'promociones' && typeof PromocionesView !== 'undefined') {
      PromocionesView.load(mainContent);
    } else if (key === 'auditoria-cajas' && typeof AuditoriaCajasView !== 'undefined') {
      AuditoriaCajasView.load(mainContent);
    } else if (key === 'reportes-ventas' && typeof ReportesVentasView !== 'undefined') {
      ReportesVentasView.load(mainContent);
    } else if (key === 'subir-catalogo' && typeof SubirCatalogoView !== 'undefined') {
      SubirCatalogoView.load(mainContent);
    } else if (key === 'descargar-catalogo' && typeof DescargarCatalogoView !== 'undefined') {
      DescargarCatalogoView.load(mainContent);
    } else if (key === 'traslados-en-transito' && typeof TrasladosEnTransitoView !== 'undefined') {
      TrasladosEnTransitoView.load(mainContent);
    } else if (key === 'libro-ventas' && typeof LibroVentasView !== 'undefined') {
      LibroVentasView.load(mainContent);
    } else if (key === 'libro-compras' && typeof LibroComprasView !== 'undefined') {
      LibroComprasView.load(mainContent);
    } else if (key === 'libro-diario' && typeof LibroDiarioView !== 'undefined') {
      LibroDiarioView.load(mainContent);
    } else if (key === 'libro-mayor' && typeof LibroMayorView !== 'undefined') {
      LibroMayorView.load(mainContent);
    } else if (key === 'libro-balance' && typeof LibroBalanceView !== 'undefined') {
      LibroBalanceView.load(mainContent);
    } else if (key === 'inventario-fiscal' && typeof InventarioFiscalView !== 'undefined') {
      InventarioFiscalView.load(mainContent);
    } else if (key === 'retenciones-iva' && typeof RetencionesIvaView !== 'undefined') {
      RetencionesIvaView.load(mainContent);
    } else if (key === 'retenciones-isr' && typeof RetencionesIsrView !== 'undefined') {
      RetencionesIsrView.load(mainContent);
    } else if (
      key === 'retenciones-iva-recibidas' &&
      typeof RetencionesIvaRecibidasView !== 'undefined'
    ) {
      RetencionesIvaRecibidasView.load(mainContent);
    } else if (
      key === 'retenciones-isr-recibidas' &&
      typeof RetencionesIsrRecibidasView !== 'undefined'
    ) {
      RetencionesIsrRecibidasView.load(mainContent);
    } else if (key === 'nomenclatura-contable' && typeof NomenclaturaContableView !== 'undefined') {
      NomenclaturaContableView.load(mainContent);
    } else if (key === 'formatos-contables' && typeof FormatosContablesView !== 'undefined') {
      FormatosContablesView.load(mainContent);
    } else if (
      key === 'configuraciones-contabilidad' &&
      typeof ConfiguracionesContabilidadView !== 'undefined'
    ) {
      ConfiguracionesContabilidadView.load(mainContent);
    } else if (key === 'movimientos-banco' && typeof MovimientosBancoView !== 'undefined') {
      MovimientosBancoView.load(mainContent);
    } else if (key === 'bancos' && typeof BancosView !== 'undefined') {
      BancosView.load(mainContent);
    } else if (key === 'cuentas-bancarias' && typeof CuentasBancariasView !== 'undefined') {
      CuentasBancariasView.load(mainContent);
    } else if (
      (key === 'productos-precios' || key === 'productos') &&
      typeof ProductosView !== 'undefined'
    ) {
      ProductosView.load(mainContent);
    } else if (key === 'updater' && typeof UpdaterView !== 'undefined') {
      UpdaterView.load(mainContent);
    } else if (key === 'empresas' && typeof EmpresasView !== 'undefined') {
      EmpresasView.load(mainContent);
    } else if (key === 'marcas' && typeof MarcasView !== 'undefined') {
      MarcasView.load(mainContent);
    } else if (key === 'medidas' && typeof MedidasView !== 'undefined') {
      MedidasView.load(mainContent);
    } else if (key === 'rutas' && typeof RutasView !== 'undefined') {
      RutasView.load(mainContent);
    } else if (key === 'fabricantes' && typeof FabricantesView !== 'undefined') {
      FabricantesView.load(mainContent);
    } else if (key === 'ubicaciones' && typeof UbicacionesView !== 'undefined') {
      UbicacionesView.load(mainContent);
    } else if (key === 'mesas-restaurante' && typeof MesasRestauranteView !== 'undefined') {
      MesasRestauranteView.load(mainContent);
    } else if (key === 'clientes' && typeof ClientesView !== 'undefined') {
      ClientesView.load(mainContent);
    } else if (key === 'tipo-negocios' && typeof TipoNegociosView !== 'undefined') {
      TipoNegociosView.load(mainContent);
    } else if (key === 'proveedores' && typeof ProveedoresView !== 'undefined') {
      ProveedoresView.load(mainContent);
    } else if (key === 'municipios' && typeof MunicipiosView !== 'undefined') {
      MunicipiosView.load(mainContent);
    } else if (key === 'departamentos' && typeof DepartamentosView !== 'undefined') {
      DepartamentosView.load(mainContent);
    } else if (key === 'empleados' && typeof EmpleadosView !== 'undefined') {
      EmpleadosView.load(mainContent);
    } else if (key === 'control-asistencia' && typeof ControlAsistenciaView !== 'undefined') {
      ControlAsistenciaView.load(mainContent);
    } else if (key === 'nomina-config' && typeof NominaConfigView !== 'undefined') {
      NominaConfigView.load(mainContent);
    } else if (key === 'nomina-conceptos' && typeof NominaConceptosView !== 'undefined') {
      NominaConceptosView.load(mainContent);
    } else if (key === 'nomina-empleados' && typeof NominaEmpleadosView !== 'undefined') {
      NominaEmpleadosView.load(mainContent);
    } else if (key === 'nomina-vales' && typeof NominaValesView !== 'undefined') {
      NominaValesView.load(mainContent);
    } else if (key === 'nomina-interna' && typeof NominaInternaView !== 'undefined') {
      NominaInternaView.load(mainContent);
    } else if (key === 'nomina-igss' && typeof NominaIgssView !== 'undefined') {
      NominaIgssView.load(mainContent);
    } else if (key === 'tipo-documentos' && typeof TipoDocumentosView !== 'undefined') {
      TipoDocumentosView.load(mainContent);
    } else if (key === 'formatos-impresion' && typeof FormatosImpresionView !== 'undefined') {
      FormatosImpresionView.load(mainContent);
    } else if (key === 'cajas' && typeof CajasView !== 'undefined') {
      CajasView.load(mainContent);
    } else if (key === 'vehiculos' && typeof VehiculosView !== 'undefined') {
      VehiculosView.load(mainContent);
    } else if (key === 'plataformas' && typeof PlataformasView !== 'undefined') {
      PlataformasView.load(mainContent);
    } else if (key === 'mantenimiento-llantas' && typeof MantenimientoLlantasView !== 'undefined') {
      MantenimientoLlantasView.load(mainContent);
    } else if (key === 'registro-kilometrajes' && typeof KilometrajesView !== 'undefined') {
      KilometrajesView.load(mainContent);
    } else if (key === 'servicio-mecanica' && typeof ServicioMecanicaView !== 'undefined') {
      ServicioMecanicaView.load(mainContent);
    } else if (key === 'config-general' && typeof ConfigGeneralView !== 'undefined') {
      ConfigGeneralView.load(mainContent);
    } else if (key === 'roles-usuarios' && typeof RolesUsuariosView !== 'undefined') {
      RolesUsuariosView.load(mainContent);
    } else if (key === 'licencia' && typeof LicenciaView !== 'undefined') {
      LicenciaView.load(mainContent);
    } else if (key === 'credenciales-fel' && typeof CredencialesFelView !== 'undefined') {
      CredencialesFelView.load(mainContent);
    } else {
      mainContent.classList.add('align-items-center', 'justify-content-center');
      mainContent.classList.remove('align-items-stretch', 'justify-content-start');
      mainContent.innerHTML = `<p class="text-muted mb-0">${label} — contenido pendiente</p>`;
    }

    closeSidebar();
    setTimeout(() => {
      if (typeof Pace !== 'undefined' && Pace.running) Pace.stop();
    }, 600);
  });

  /* legacy per-link binding removed — uses sidebar delegation above */
  async function handleLogoutClick() {
    if (currentView !== 'main') return;

    dismissBlockingLayers();

    let salir = true;
    if (typeof CatalogosUI !== 'undefined' && CatalogosUI.confirmSalir) {
      salir = await CatalogosUI.confirmSalir({
        title: '¿Cerrar sesión?',
        text: 'Se cerrará la sesión y volverá al inicio de sesión.',
      });
    }
    if (!salir) return;

    dismissBlockingLayers();
    goToLogin();
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('#btn-logout')) {
      e.preventDefault();
      e.stopPropagation();
      handleLogoutClick();
    }
  });

  async function bootApp() {
    if (typeof OnnebThemes !== 'undefined') OnnebThemes.init();

    try {
      await F.loadRuntime();
    } catch (err) {
      console.warn('[App] runtime/TOKEN:', err?.message || err);
    }

    ensureLoginView();
    await loadLoginEmpresas();

    if (F.isLoggedIn()) {
      updateHeaderSessionInfo();
      const empNit = F.getEmpNit();
      if (empNit && typeof EmpresaLogo !== 'undefined') {
        EmpresaLogo.loadForSession(empNit)
          .then(() => updateHeaderEmpresaLogo())
          .catch(() => updateHeaderEmpresaLogo());
      }
    }

    if (buildCounterEl) {
      await loadBuildCounter();
      startBuildCounterPoll();
    }

    try {
      await OnnebDb.init();
    } catch (err) {
      console.warn('[DB] init:', err);
    }

    initSocket();
    if (F.isLoggedIn()) {
      registerSocketSession();
      if (typeof TipoEmpleadoAccess !== 'undefined') {
        try {
          await TipoEmpleadoAccess.refreshMenuAccess();
          if (typeof LicenseAccess !== 'undefined') {
            await LicenseAccess.refresh();
          }
          await F.ensureCodTipoEmpresa();
          TipoEmpleadoAccess.applySidebarVisibility();
        } catch (err) {
          console.warn('[App] acceso menú/licencia:', err?.message || err);
        }
      }
    }
  }

  ensureLoginView();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      bootApp().catch((err) => console.error('[App] boot:', err));
    });
  } else {
    bootApp().catch((err) => console.error('[App] boot:', err));
  }
})();
