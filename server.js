const path = require('path');
const fs = require('fs');
const { envFilePath } = require('./lib/app-paths');

require('dotenv').config({ path: envFilePath() });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sql = require('mssql');
const { getDbConfig, isDbConfigured } = require('./config/database');
const { registerSocketHandlers } = require('./lib/socket-hub');

const PORT = process.env.PORT || 6500;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

let dbPool = null;
let dbConnecting = null;

function isPoolAlive(pool) {
  return Boolean(pool && pool.connected && !pool.connecting);
}

async function closeDbPoolQuietly(pool) {
  if (!pool) return;
  try {
    await pool.close();
  } catch {
    /* ignore */
  }
}

async function createDbPool(dbConfig) {
  const pool = new sql.ConnectionPool(dbConfig);
  pool.on('error', (err) => {
    console.warn('[DB] pool error:', err?.message || err);
    if (dbPool === pool) dbPool = null;
  });
  await pool.connect();
  return pool;
}

/**
 * Pool SQL con reconexión automática si la conexión local se cae.
 */
async function getDbPool() {
  const dbConfig = getDbConfig();
  if (!dbConfig) return null;

  if (isPoolAlive(dbPool)) return dbPool;
  if (dbConnecting) return dbConnecting;

  dbConnecting = (async () => {
    const previous = dbPool;
    dbPool = null;
    await closeDbPoolQuietly(previous);

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const pool = await createDbPool(dbConfig);
        dbPool = pool;
        if (attempt > 1) {
          console.warn(`[DB] reconectado en intento ${attempt}`);
        }
        return pool;
      } catch (err) {
        lastErr = err;
        console.warn(`[DB] conexión fallida (intento ${attempt}/3):`, err?.message || err);
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    throw lastErr || new Error('No se pudo conectar a SQL Server');
  })();

  try {
    return await dbConnecting;
  } finally {
    dbConnecting = null;
  }
}

const empresasRouter = require('./routes/empresas');
const marcasRouter = require('./routes/marcas');
const medidasRouter = require('./routes/medidas');
const rutasRouter = require('./routes/rutas');
const fabricantesRouter = require('./routes/fabricantes');
const ubicacionesRouter = require('./routes/ubicaciones');
const mesasRestauranteRouter = require('./routes/mesas-restaurante');
const clientesRouter = require('./routes/clientes');
const tipoNegociosRouter = require('./routes/tipo-negocios');
const proveedoresRouter = require('./routes/proveedores');
const municipiosRouter = require('./routes/municipios');
const departamentosRouter = require('./routes/departamentos');
const empleadosRouter = require('./routes/empleados');
const asistenciaRouter = require('./routes/asistencia');
const tipoDocumentosRouter = require('./routes/tipo-documentos');
const cajasRouter = require('./routes/cajas');
const vehiculosRouter = require('./routes/vehiculos');
const mantenimientoLlantasRouter = require('./routes/mantenimiento-llantas');
const kilometrajesRouter = require('./routes/kilometrajes');
const servicioMecanicaRouter = require('./routes/servicio-mecanica');
const plataformasRouter = require('./routes/plataformas');
const authRouter = require('./routes/auth');
const { router: configRouter } = require('./routes/config');
const rolesUsuariosRouter = require('./routes/roles-usuarios');
const posRouter = require('./routes/pos');
const comandasRestauranteRouter = require('./routes/comandas-restaurante');
const cotizacionesRouter = require('./routes/cotizaciones');
const fraccionamientoFacRouter = require('./routes/fraccionamiento-fac');
const formatosImpresionRouter = require('./routes/formatos-impresion');
const facturacionRouter = require('./routes/facturacion');
const notasCreditoRouter = require('./routes/notas-credito');
const notasAbonoRouter = require('./routes/notas-abono');
const notasDebitoRouter = require('./routes/notas-debito');
const corteCajaRouter = require('./routes/corte-caja');
const comprasRouter = require('./routes/compras');
const { entradasRouter, salidasRouter, trasladosCrearRouter, trasladosRecibirRouter } = require('./routes/inventario-docs');
const inventarioSaldoRouter = require('./routes/inventario-saldo');
const documentosRouter = require('./routes/documentos');
const asistenteRouter = require('./routes/asistente');
const documentosEliminadosRouter = require('./routes/documentos-eliminados');
const promocionesRouter = require('./routes/promociones');
const auditoriaCajasRouter = require('./routes/auditoria-cajas');
const reportesVentasRouter = require('./routes/reportes-ventas');
const autorizacionesRouter = require('./routes/autorizaciones');
const resumenDelDiaRouter = require('./routes/resumen-del-dia');
const productosRouter = require('./routes/productos');
const actualizacionCostosRouter = require('./routes/actualizacion-costos');
const listaPreciosRouter = require('./routes/lista-precios');
const listaFacturasRouter = require('./routes/lista-facturas');
const cuadreCajaRouter = require('./routes/cuadre-caja');
const suscripcionesRouter = require('./routes/suscripciones');
const credencialesFelRouter = require('./routes/credenciales-fel');
const felRouter = require('./routes/fel');
const updaterRouter = require('./routes/updater');
const dashboardRouter = require('./routes/dashboard');
const tareasRouter = require('./routes/tareas');
const embarquesRouter = require('./routes/embarques');
const asignacionPedidosRouter = require('./routes/asignacion-pedidos');
const cuentasCobrarRouter = require('./routes/cuentas-cobrar');
const cuentasPagarRouter = require('./routes/cuentas-pagar');
const libroVentasRouter = require('./routes/libro-ventas');
const libroComprasRouter = require('./routes/libro-compras');
const libroDiarioRouter = require('./routes/libro-diario');
const libroMayorRouter = require('./routes/libro-mayor');
const libroBalanceRouter = require('./routes/libro-balance');
const inventarioFiscalRouter = require('./routes/inventario-fiscal');
const nomenclaturaContableRouter = require('./routes/nomenclatura-contable');
const formatosContablesRouter = require('./routes/formatos-contables');
const retencionesIvaRouter = require('./routes/retenciones-iva');
const retencionesIsrRouter = require('./routes/retenciones-isr');
const retencionesIvaRecibidasRouter = require('./routes/retenciones-iva-recibidas');
const retencionesIsrRecibidasRouter = require('./routes/retenciones-isr-recibidas');
const configContabilidadRouter = require('./routes/config-contabilidad');
const nominaRouter = require('./routes/nomina');
const nominaValesRouter = require('./routes/nomina-vales');
const valesCajaRouter = require('./routes/vales-caja');
const bancosRouter = require('./routes/bancos');
const cuentasBancariasRouter = require('./routes/cuentas-bancarias');
const movimientosBancoRouter = require('./routes/movimientos-banco');
const recibosCajaCxcRouter = require('./routes/recibos-caja-cxc');
const licenseRouter = require('./routes/license');
const communityRouter = require('./routes/community');
const { licenseMiddleware, getLicenseStatus } = require('./lib/license');
const { getAppToken } = require('./lib/app-token');

/** Logo empresa: hasta ~512 KB binario → ~1 MB hex en JSON + demás campos del formulario. */
app.use(express.json({ limit: '3mb' }));
app.locals.getDbPool = getDbPool;
app.locals.io = io;

/** Licencia de instalación: limita APIs por módulo comprado. */
app.use(licenseMiddleware);

const publicDir = require('./lib/app-paths').publicDir();
const dataDir = require('./lib/app-paths').writableDataDir();
const fotosProductosDir = require('./lib/app-paths').fotosProductosDir();
const buildMetaPath = path.join(publicDir, 'build-meta.json');

if (!fs.existsSync(fotosProductosDir)) {
  try {
    fs.mkdirSync(fotosProductosDir, { recursive: true });
  } catch (err) {
    console.warn('[Fotos_productos] no se pudo crear carpeta:', err.message);
  }
}

app.use(
  '/data',
  express.static(dataDir, {
    etag: false,
    lastModified: true,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  })
);

app.use(
  '/fotos_productos',
  express.static(fotosProductosDir, {
    etag: false,
    lastModified: true,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  })
);

app.use(
  express.static(publicDir, {
    etag: false,
    lastModified: true,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  })
);

app.get('/api/build-meta', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  if (fs.existsSync(buildMetaPath)) {
    res.sendFile(buildMetaPath);
  } else {
    res.json({ buildCount: 0, buildDate: null });
  }
});

function watchBuildMetaBroadcast() {
  if (!fs.existsSync(publicDir)) return;

  let notifyTimer = null;
  const notify = () => {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      io.emit('build:updated');
    }, 80);
  };

  try {
    fs.watch(publicDir, { recursive: true }, (_event, filename) => {
      if (filename && String(filename).replace(/\\/g, '/').includes('build-meta.json')) {
        notify();
      }
    });
  } catch (err) {
    console.warn('[Watch] build-meta broadcast:', err.message);
  }
}

app.use('/api/empresas', empresasRouter);
app.use('/api/marcas', marcasRouter);
app.use('/api/medidas', medidasRouter);
app.use('/api/rutas', rutasRouter);
app.use('/api/fabricantes', fabricantesRouter);
app.use('/api/ubicaciones', ubicacionesRouter);
app.use('/api/mesas-restaurante', mesasRestauranteRouter);
app.use('/api/clientes', clientesRouter);
app.use('/api/tipo-negocios', tipoNegociosRouter);
app.use('/api/proveedores', proveedoresRouter);
app.use('/api/municipios', municipiosRouter);
app.use('/api/departamentos', departamentosRouter);
app.use('/api/empleados', empleadosRouter);
app.use('/api/asistencia', asistenciaRouter);
app.use('/api/qr', require('./routes/qr'));
app.use('/api/tipo-documentos', tipoDocumentosRouter);
app.use('/api/cajas', cajasRouter);
app.use('/api/vehiculos', vehiculosRouter);
app.use('/api/mantenimiento-llantas', mantenimientoLlantasRouter);
app.use('/api/kilometrajes', kilometrajesRouter);
app.use('/api/servicio-mecanica', servicioMecanicaRouter);
app.use('/api/plataformas', plataformasRouter);
app.use('/api/auth', authRouter);
app.use('/api/license', licenseRouter);
app.use('/api/community', communityRouter);
app.use('/api/config', configRouter);
app.use('/api/roles-usuarios', rolesUsuariosRouter);
app.use('/api/pos', posRouter);
app.use('/api/comandas-restaurante', comandasRestauranteRouter);
app.use('/api/despachos-en-cocina', require('./routes/despachos-en-cocina'));
app.use('/api/cotizaciones', cotizacionesRouter);
app.use('/api/fraccionamiento-fac', fraccionamientoFacRouter);
app.use('/api/formatos-impresion', formatosImpresionRouter);
app.use('/api/facturacion', facturacionRouter);
app.use('/api/notas-credito', notasCreditoRouter);
app.use('/api/notas-abono', notasAbonoRouter);
app.use('/api/notas-debito', notasDebitoRouter);
app.use('/api/corte-caja', corteCajaRouter);
app.use('/api/vales-caja', valesCajaRouter);
app.use('/api/compras', comprasRouter);
app.use('/api/inventario/ent', entradasRouter);
app.use('/api/inventario/sal', salidasRouter);
app.use('/api/traslados/crear', trasladosCrearRouter);
app.use('/api/traslados/recibir', trasladosRecibirRouter);
app.use('/api/inventario', inventarioSaldoRouter);
app.use('/api/documentos', documentosRouter);
app.use('/api/asistente', asistenteRouter);
app.use('/api/documentos-eliminados', documentosEliminadosRouter);
app.use('/api/promociones', promocionesRouter);
app.use('/api/auditoria-cajas', auditoriaCajasRouter);
app.use('/api/reportes-ventas', reportesVentasRouter);
app.use('/api/autorizaciones', autorizacionesRouter);
app.use('/api/resumen-del-dia', resumenDelDiaRouter);
app.use('/api/productos', productosRouter);
app.use('/api/actualizacion-costos', actualizacionCostosRouter);
app.use('/api/lista-precios', listaPreciosRouter);
app.use('/api/lista-facturas', listaFacturasRouter);
app.use('/api/cuadre-caja', cuadreCajaRouter);
app.use('/api/suscripciones', suscripcionesRouter);
app.use('/api/credenciales-fel', credencialesFelRouter);
app.use('/api/fel', felRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/tareas', tareasRouter);
app.use('/api/embarques', embarquesRouter);
app.use('/api/asignacion-pedidos', asignacionPedidosRouter);
app.use('/api/cuentas-cobrar', cuentasCobrarRouter);
app.use('/api/cuentas-pagar', cuentasPagarRouter);
app.use('/api/libro-ventas', libroVentasRouter);
app.use('/api/libro-compras', libroComprasRouter);
app.use('/api/libro-diario', libroDiarioRouter);
app.use('/api/libro-mayor', libroMayorRouter);
app.use('/api/libro-balance', libroBalanceRouter);
app.use('/api/inventario-fiscal', inventarioFiscalRouter);
app.use('/api/nomenclatura-contable', nomenclaturaContableRouter);
app.use('/api/formatos-contables', formatosContablesRouter);
app.use('/api/retenciones-iva', retencionesIvaRouter);
app.use('/api/retenciones-isr', retencionesIsrRouter);
app.use('/api/retenciones-iva-recibidas', retencionesIvaRecibidasRouter);
app.use('/api/retenciones-isr-recibidas', retencionesIsrRecibidasRouter);
app.use('/api/config-contabilidad', configContabilidadRouter);
app.use('/api/nomina/vales', nominaValesRouter);
app.use('/api/nomina', nominaRouter);
app.use('/api/bancos', bancosRouter);
app.use('/api/cuentas-bancarias', cuentasBancariasRouter);
app.use('/api/movimientos-banco', movimientosBancoRouter);
app.use('/api/recibos-caja-cxc', recibosCajaCxcRouter);
app.use('/api/updater', updaterRouter);

app.get('/api/health', async (_req, res) => {
  let dbStatus = 'not_configured';
  if (isDbConfigured()) {
    try {
      const pool = await getDbPool();
      await pool.request().query('SELECT 1 AS ok');
      dbStatus = 'connected';
    } catch (err) {
      dbStatus = 'error';
      console.warn('[MSSQL]', err.message);
      // Forzar reconexión en el siguiente request
      await closeDbPoolQuietly(dbPool);
      dbPool = null;
    }
  }
  res.json({ ok: true, db: dbStatus });
});

registerSocketHandlers(io);

server.listen(PORT, () => {
  const { pidFilePath, getDataRoot: dataRootFn, isPackaged: packagedFn } = require('./lib/app-paths');
  const pidPath = pidFilePath();
  try {
    fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  } catch (err) {
    console.warn('[OnneB] no se pudo escribir PID:', err.message);
  }
  const clearPid = () => {
    try {
      if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
  };
  process.once('exit', clearPid);

  console.log(`OnneB_pos en http://localhost:${PORT}`);
  console.log(`Datos locales: ${dataRootFn()}`);
  if (packagedFn()) {
    console.log('Modo: ejecutable empaquetado (.env y Fotos_productos junto al .exe)');
  } else {
    console.log('Detener: npm stop');
  }
  const appToken = getAppToken();
  if (appToken) {
    console.log(`[TOKEN] instalación: ${appToken}`);
  } else {
    console.warn('[TOKEN] no configurado en .env');
  }
  try {
    const lic = getLicenseStatus({ refresh: true });
    console.log(`[Licencia] ${lic.status} · modo ${lic.mode}${lic.customer ? ` · ${lic.customer}` : ''}`);
    const { assertLicenseCatalogIntegrity } = require('./lib/license-modules');
    assertLicenseCatalogIntegrity({ log: console.warn });
  } catch (err) {
    console.warn('[Licencia]', err.message);
  }
  if (!require('./lib/app-paths').isPackaged() && process.env.BUMP_WATCH !== 'false') {
    require('./scripts/watch-build').start();
    watchBuildMetaBroadcast();
  }
});

process.on('SIGINT', async () => {
  try {
    const pidPath = require('./lib/app-paths').pidFilePath();
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
  if (dbPool) {
    await dbPool.close();
  }
  process.exit(0);
});
