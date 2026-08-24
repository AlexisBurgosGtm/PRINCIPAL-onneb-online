const sql = require('mssql');

/** Nombres en dbo.SETTINGS.OPCION (coinciden con la base de datos). */
const SETTING_OPCION = {
  CLAVE_ADMIN: 'CLAVE ADMIN',
  CLAVE_OPERADOR: 'CLAVE OPERADOR',
  INVENTARIO_NEGATIVO: 'INVENTARIO NEGATIVO',
  SOLICITA_CLAVE_VENDEDOR: 'SOLICITA CLAVE VENDEDOR',
  IMPRIME_TICKET: 'IMPRIME TICKET AL GUARDAR VENTA',
  COBRO_PREDETERMINADO: 'COBRO PREDETERMINADO',
  URL_FEL: 'URL FEL',
  MUESTRA_DATOS_CORTE: 'MUESTRA DATOS EN CORTE DE CAJA',
  CONFIGURACION_IVA: 'CONFIGURACION IVA',
  PORCENTAJE_RETENCION_IVA: 'PORCENTAJE RETENCION IVA',
  PORCENTAJE_RETENCION_ISR: 'PORCENTAJE RETENCION ISR',
  PERMITE_CAMBIAR_PRECIO_PEDIDOS: 'PERMITE CAMBIAR PRECIO EN PEDIDOS',
  SOLICITA_AUTORIZACIONES: 'SOLICITA AUTORIZACIONES',
  FORMATO_IMPRESION: 'FORMATO IMPRESION C O T',
  GUARDADO_FOTOS: 'GUARDADO DE FOTOS',
  CERTIFICA_AL_FINALIZAR: 'CERTIFICA AL FINALIZAR',
  MUESTRA_FORMATO_FEL_ONLINE: 'MUESTRA FORMATO FEL ONLINE',
  MAXIMO_FRACCIONAMIENTO_FACTURAS: 'MAXIMO FRACCIONAMIENTO FACTURAS',
  MUESTRA_DESPROD2_EN_DOCS_Y_PRODS: 'MUESTRA DESPROD2 EN DOCS Y PRODS',
  PERMITE_BIOMETRICO_EN_LOGIN: 'PERMITE BIOMETRICO EN LOGIN',
  PERMITE_FRACCIONAMIENTO_FACTURAS: 'PERMITE FRACCIONAMIENTO FACTURAS',
  FACTURA_SE_PASA_A_FRACCIONAMIENTO_AUTOM: 'FACTURA SE PASA A FRACCIONAMIENTO AUTOM',
  DEFAULT_TIPO_DOCUMENTO_FINALIZADO: 'DEFAULT TIPO DOCUMENTO FINALIZADO',
  LIMITA_EFECTIVO_DISPONIBLE_EN_VALES_CAJA: 'LIMITA EFECTIVO DISPONIBLE EN VALES CAJA',
};

const SETTING_DEFAULTS = {
  [SETTING_OPCION.CONFIGURACION_IVA]: '1.12',
  [SETTING_OPCION.PORCENTAJE_RETENCION_IVA]: '15',
  [SETTING_OPCION.PORCENTAJE_RETENCION_ISR]: '5',
  [SETTING_OPCION.FORMATO_IMPRESION]: 'CARTA',
  [SETTING_OPCION.GUARDADO_FOTOS]: 'LOCAL',
  [SETTING_OPCION.CERTIFICA_AL_FINALIZAR]: 'NO',
  [SETTING_OPCION.MUESTRA_FORMATO_FEL_ONLINE]: 'NO',
  [SETTING_OPCION.MAXIMO_FRACCIONAMIENTO_FACTURAS]: '2500',
  [SETTING_OPCION.SOLICITA_AUTORIZACIONES]: 'NO',
  [SETTING_OPCION.MUESTRA_DESPROD2_EN_DOCS_Y_PRODS]: 'NO',
  [SETTING_OPCION.PERMITE_BIOMETRICO_EN_LOGIN]: 'NO',
  [SETTING_OPCION.PERMITE_FRACCIONAMIENTO_FACTURAS]: 'SI',
  [SETTING_OPCION.FACTURA_SE_PASA_A_FRACCIONAMIENTO_AUTOM]: 'NO',
  [SETTING_OPCION.DEFAULT_TIPO_DOCUMENTO_FINALIZADO]: 'FEF',
  [SETTING_OPCION.LIMITA_EFECTIVO_DISPONIBLE_EN_VALES_CAJA]: 'NO',
};

/** Respaldo temporal: Config.ID → PASS o SINO si SETTINGS.VALOR aún está vacío. */
const LEGACY_CONFIG_PASS = {
  [SETTING_OPCION.CLAVE_ADMIN]: 2,
  [SETTING_OPCION.CLAVE_OPERADOR]: 21,
};

const LEGACY_CONFIG_SINO = {
  [SETTING_OPCION.INVENTARIO_NEGATIVO]: 3,
  [SETTING_OPCION.SOLICITA_CLAVE_VENDEDOR]: 17,
  [SETTING_OPCION.IMPRIME_TICKET]: 11,
  [SETTING_OPCION.COBRO_PREDETERMINADO]: 15,
};

function normalizeOpcion(raw) {
  return String(raw ?? '').trim();
}

function isEmptyValor(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function normalizeSino(value) {
  const sino = String(value ?? '')
    .trim()
    .toUpperCase();
  return sino === 'SI' ? 'SI' : 'NO';
}

/** CON = contado, CRE = crédito (acepta legado SI/NO). */
function normalizeConcre(value) {
  const s = String(value ?? 'CON')
    .trim()
    .toUpperCase();
  if (s === 'CRE' || s === 'SI') return 'CRE';
  return 'CON';
}

/** CARTA = impresora normal, TICKET = impresora térmica. */
function normalizeFormatoImpresion(value) {
  const s = String(value ?? 'CARTA')
    .trim()
    .toUpperCase();
  return s === 'TICKET' ? 'TICKET' : 'CARTA';
}

/** LOCAL = carpeta Fotos_productos del servidor, HOST = almacenamiento remoto. */
function normalizeGuardadoFotos(value) {
  const s = String(value ?? 'LOCAL')
    .trim()
    .toUpperCase();
  return s === 'HOST' ? 'HOST' : 'LOCAL';
}

/** NO = solo formato sistema, SI = solo FEL online, AMBOS = ambos. */
function normalizeMuestraFormatoFelOnline(value) {
  const s = String(value ?? 'NO')
    .trim()
    .toUpperCase();
  if (s === 'SI') return 'SI';
  if (s === 'AMBOS') return 'AMBOS';
  return 'NO';
}

/** TIPOFAC por defecto al finalizar (mismo catálogo del modal pedidos/cotizaciones). */
function normalizeTipofacFinalizado(value) {
  const s = String(value ?? 'FEF')
    .trim()
    .toUpperCase();
  if (s === 'FAC' || s === 'FEC' || s === 'FEF') return s;
  return 'FEF';
}

async function readLegacyConfigValue(pool, opcion) {
  const passId = LEGACY_CONFIG_PASS[opcion];
  if (passId) {
    const result = await pool
      .request()
      .input('ID', sql.Int, passId)
      .query('SELECT PASS FROM Config WHERE ID = @ID');
    if (result.recordset.length) {
      return String(result.recordset[0].PASS ?? '');
    }
  }
  const sinoId = LEGACY_CONFIG_SINO[opcion];
  if (sinoId) {
    const result = await pool
      .request()
      .input('ID', sql.Int, sinoId)
      .query('SELECT SINO FROM Config WHERE ID = @ID');
    if (result.recordset.length) {
      return normalizeSino(result.recordset[0].SINO);
    }
  }
  return null;
}

async function getSettingRow(pool, opcion) {
  const key = normalizeOpcion(opcion);
  if (!key) return null;
  const result = await pool
    .request()
    .input('OPCION', sql.VarChar, key)
    .query('SELECT OPCION, VALOR FROM dbo.SETTINGS WHERE OPCION = @OPCION');
  return result.recordset[0] || null;
}

async function getSettingValue(pool, opcion, { migrateLegacy = true } = {}) {
  const key = normalizeOpcion(opcion);
  if (!key) return null;

  const row = await getSettingRow(pool, key);
  if (!row) return null;

  let valor = row.VALOR;
  if (isEmptyValor(valor) && migrateLegacy) {
    const legacy = await readLegacyConfigValue(pool, key);
    if (!isEmptyValor(legacy)) {
      valor = legacy;
      if (key === SETTING_OPCION.COBRO_PREDETERMINADO) {
        valor = normalizeConcre(legacy);
      }
      await setSettingValue(pool, key, valor, { skipExistsCheck: true });
    }
  }

  if (isEmptyValor(valor)) return null;
  if (key === SETTING_OPCION.COBRO_PREDETERMINADO) {
    return normalizeConcre(valor);
  }
  if (key === SETTING_OPCION.FORMATO_IMPRESION) {
    return normalizeFormatoImpresion(valor);
  }
  if (key === SETTING_OPCION.GUARDADO_FOTOS) {
    return normalizeGuardadoFotos(valor);
  }
  if (key === SETTING_OPCION.MUESTRA_FORMATO_FEL_ONLINE) {
    return normalizeMuestraFormatoFelOnline(valor);
  }
  if (key === SETTING_OPCION.DEFAULT_TIPO_DOCUMENTO_FINALIZADO) {
    return normalizeTipofacFinalizado(valor);
  }
  if (key === SETTING_OPCION.CERTIFICA_AL_FINALIZAR) {
    return normalizeSino(valor);
  }
  if (key === SETTING_OPCION.PERMITE_FRACCIONAMIENTO_FACTURAS) {
    return normalizeSino(valor);
  }
  if (key === SETTING_OPCION.FACTURA_SE_PASA_A_FRACCIONAMIENTO_AUTOM) {
    return normalizeSino(valor);
  }
  return String(valor);
}

async function ensureSettingDefault(pool, opcion) {
  const key = normalizeOpcion(opcion);
  const defaultValue = SETTING_DEFAULTS[key];
  if (!defaultValue) return defaultValue ?? null;

  const row = await getSettingRow(pool, key);
  if (!row) {
    await pool
      .request()
      .input('OPCION', sql.VarChar, key)
      .input('VALOR', sql.NVarChar(sql.MAX), defaultValue)
      .query('INSERT INTO dbo.SETTINGS (OPCION, VALOR) VALUES (@OPCION, @VALOR)');
    return defaultValue;
  }
  if (isEmptyValor(row.VALOR)) {
    await setSettingValue(pool, key, defaultValue, { skipExistsCheck: true });
    return defaultValue;
  }
  return String(row.VALOR);
}

async function setSettingValue(pool, opcion, valor, { skipExistsCheck = false } = {}) {
  const key = normalizeOpcion(opcion);
  if (!key) {
    const err = new Error('OPCION requerida');
    err.statusCode = 400;
    throw err;
  }

  const existing = await getSettingRow(pool, key);
  const valueToStore = valor === null || valor === undefined ? null : String(valor);

  if (existing) {
    const result = await pool
      .request()
      .input('OPCION', sql.VarChar, key)
      .input('VALOR', sql.NVarChar(sql.MAX), valueToStore)
      .query('UPDATE dbo.SETTINGS SET VALOR = @VALOR WHERE OPCION = @OPCION');
    if (result.rowsAffected[0] > 0) return valueToStore;
  }

  if (!existing && !skipExistsCheck) {
    await pool
      .request()
      .input('OPCION', sql.VarChar, key)
      .input('VALOR', sql.NVarChar(sql.MAX), valueToStore)
      .query('INSERT INTO dbo.SETTINGS (OPCION, VALOR) VALUES (@OPCION, @VALOR)');
    return valueToStore;
  }

  if (skipExistsCheck) {
    const result = await pool
      .request()
      .input('OPCION', sql.VarChar, key)
      .input('VALOR', sql.NVarChar(sql.MAX), valueToStore)
      .query('UPDATE dbo.SETTINGS SET VALOR = @VALOR WHERE OPCION = @OPCION');
    if (result.rowsAffected[0] === 0) {
      const err = new Error(`Configuración no encontrada: ${key}`);
      err.statusCode = 404;
      throw err;
    }
    return valueToStore;
  }

  const err = new Error(`Configuración no encontrada: ${key}`);
  err.statusCode = 404;
  throw err;
}

async function getSettingSino(pool, opcion, options) {
  const raw = await getSettingValue(pool, opcion, options);
  return normalizeSino(raw ?? 'NO');
}

async function getSettingConcre(pool, opcion, options) {
  const raw = await getSettingValue(pool, opcion, options);
  return normalizeConcre(raw ?? 'CON');
}

async function getSettingFormatoImpresion(pool, opcion, options) {
  await ensureSettingDefault(pool, opcion || SETTING_OPCION.FORMATO_IMPRESION);
  const raw = await getSettingValue(pool, opcion || SETTING_OPCION.FORMATO_IMPRESION, options);
  return normalizeFormatoImpresion(raw ?? 'CARTA');
}

async function getSettingGuardadoFotos(pool, opcion, options) {
  await ensureSettingDefault(pool, opcion || SETTING_OPCION.GUARDADO_FOTOS);
  const raw = await getSettingValue(pool, opcion || SETTING_OPCION.GUARDADO_FOTOS, options);
  return normalizeGuardadoFotos(raw ?? 'LOCAL');
}

async function getSettingMuestraFormatoFelOnline(pool, opcion, options) {
  await ensureSettingDefault(pool, opcion || SETTING_OPCION.MUESTRA_FORMATO_FEL_ONLINE);
  const raw = await getSettingValue(pool, opcion || SETTING_OPCION.MUESTRA_FORMATO_FEL_ONLINE, options);
  return normalizeMuestraFormatoFelOnline(raw ?? 'NO');
}

async function getSettingCertificaAlFinalizar(pool, opcion, options) {
  await ensureSettingDefault(pool, opcion || SETTING_OPCION.CERTIFICA_AL_FINALIZAR);
  const raw = await getSettingValue(pool, opcion || SETTING_OPCION.CERTIFICA_AL_FINALIZAR, options);
  return normalizeSino(raw ?? 'NO');
}

async function getSettingPermiteFraccionamientoFacturas(pool, opcion, options) {
  await ensureSettingDefault(pool, opcion || SETTING_OPCION.PERMITE_FRACCIONAMIENTO_FACTURAS);
  const raw = await getSettingValue(
    pool,
    opcion || SETTING_OPCION.PERMITE_FRACCIONAMIENTO_FACTURAS,
    options
  );
  return normalizeSino(raw ?? 'SI');
}

async function getSettingFacturaSePasaAFraccionamientoAutom(pool, opcion, options) {
  await ensureSettingDefault(pool, opcion || SETTING_OPCION.FACTURA_SE_PASA_A_FRACCIONAMIENTO_AUTOM);
  const raw = await getSettingValue(
    pool,
    opcion || SETTING_OPCION.FACTURA_SE_PASA_A_FRACCIONAMIENTO_AUTOM,
    options
  );
  return normalizeSino(raw ?? 'NO');
}

async function getSettingTipofacFinalizado(pool, opcion, options) {
  await ensureSettingDefault(pool, opcion || SETTING_OPCION.DEFAULT_TIPO_DOCUMENTO_FINALIZADO);
  const raw = await getSettingValue(
    pool,
    opcion || SETTING_OPCION.DEFAULT_TIPO_DOCUMENTO_FINALIZADO,
    options
  );
  return normalizeTipofacFinalizado(raw ?? 'FEF');
}

async function verifySettingPass(pool, pass, opcion = SETTING_OPCION.CLAVE_ADMIN) {
  const stored = await getSettingValue(pool, opcion);
  if (stored === null) return false;
  return String(pass ?? '') === stored;
}

module.exports = {
  SETTING_OPCION,
  SETTING_DEFAULTS,
  normalizeOpcion,
  normalizeSino,
  normalizeConcre,
  normalizeFormatoImpresion,
  normalizeGuardadoFotos,
  normalizeMuestraFormatoFelOnline,
  normalizeTipofacFinalizado,
  getSettingValue,
  getSettingSino,
  getSettingConcre,
  getSettingFormatoImpresion,
  getSettingGuardadoFotos,
  getSettingMuestraFormatoFelOnline,
  getSettingCertificaAlFinalizar,
  getSettingPermiteFraccionamientoFacturas,
  getSettingFacturaSePasaAFraccionamientoAutom,
  getSettingTipofacFinalizado,
  setSettingValue,
  verifySettingPass,
  ensureSettingDefault,
};
