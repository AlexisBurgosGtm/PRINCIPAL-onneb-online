const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { fechaIsoFromValue } = require('../documento-fecha');
const { escapeXml } = require('./utils');

const ADENDAS_PATH = require('../app-paths').felAdendasPath();
const SLOT_COUNT = 20;

const ADENDA_OPTIONS = [
  { value: '', label: '(Sin asignar)' },
  { value: 'DOCUMENTO_INTERNO', label: 'DOCUMENTO INTERNO' },
  { value: 'EMPLEADO', label: 'EMPLEADO' },
  { value: 'TELEFONO_EMPLEADO', label: 'TELEFONO EMPLEADO' },
  { value: 'FORMA_DE_PAGO', label: 'FORMA DE PAGO' },
  { value: 'EMBARQUE', label: 'EMBARQUE' },
  { value: 'VENCIMIENTO', label: 'VENCIMIENTO' },
  { value: 'TELEFONO_EMPRESA', label: 'TELEFONO EMPRESA' },
  { value: 'OBSERVACIONES', label: 'OBSERVACIONES' },
  { value: 'DIRECCION_ENTREGA', label: 'DIRECCION ENTREGA' },
];

const OPTION_VALUES = new Set(ADENDA_OPTIONS.map((o) => o.value).filter(Boolean));

let cache = null;

function defaultSlots() {
  const slots = {};
  for (let i = 1; i <= SLOT_COUNT; i++) slots[String(i)] = '';
  return slots;
}

function normalizeSlots(raw) {
  const slots = defaultSlots();
  const src = raw && typeof raw === 'object' ? raw : {};
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const key = String(i);
    const v = String(src[key] ?? src[i] ?? '')
      .trim()
      .toUpperCase();
    slots[key] = OPTION_VALUES.has(v) ? v : '';
  }
  return slots;
}

function loadAdendasConfig() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(ADENDAS_PATH, 'utf8'));
    cache = {
      version: Number(raw.version) || 1,
      slots: normalizeSlots(raw.slots),
    };
  } catch (_) {
    cache = { version: 1, slots: defaultSlots() };
  }
  return cache;
}

function saveAdendasConfig(slotsInput) {
  const slots = normalizeSlots(slotsInput);
  const payload = {
    version: 1,
    description: 'Mapeo global de adendas FEL Perso1–Perso20. Valores vacíos = sin asignar.',
    slots,
  };
  fs.mkdirSync(path.dirname(ADENDAS_PATH), { recursive: true });
  fs.writeFileSync(ADENDAS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  cache = { version: 1, slots };
  return cache;
}

function formatDdMmYyyy(value) {
  const iso = fechaIsoFromValue(value);
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return '';
  return `${d}/${m}/${y}`;
}

function formaPagoFromConcre(concre) {
  const c = String(concre || '')
    .trim()
    .toUpperCase();
  if (c === 'CRE' || c === 'CREDITO' || c === 'CRÉDITO') return 'CREDITO';
  if (c === 'CON' || c === 'CONTADO') return 'CONTADO';
  return c || '';
}

async function loadAdendaContext(pool, empnit, header) {
  const ctx = {
    telefonoEmpresa: '',
    nombreEmpleado: '',
    telefonoEmpleado: '',
  };

  try {
    const emp = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .query(`
        SELECT TOP 1 EMPTELEFONO
        FROM dbo.Empresas
        WHERE EMPNIT = @EMPNIT
      `);
    ctx.telefonoEmpresa = String(emp.recordset[0]?.EMPTELEFONO || '').trim();
  } catch (_) {
    /* ignore */
  }

  const codven = Number(header?.CODVEN);
  if (Number.isFinite(codven) && codven > 0) {
    try {
      const e = await pool
        .request()
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODEMPLEADO', sql.Int, codven)
        .query(`
          SELECT TOP 1 NOMEMPLEADO, TELEFONOS
          FROM dbo.Empleados
          WHERE EMPNIT = @EMPNIT AND CODEMPLEADO = @CODEMPLEADO
        `);
      const row = e.recordset[0];
      ctx.nombreEmpleado = String(row?.NOMEMPLEADO || '').trim();
      ctx.telefonoEmpleado = String(row?.TELEFONOS || '').trim();
    } catch (_) {
      /* ignore */
    }
  }

  return ctx;
}

function resolveAdendaValue(option, header, ctx = {}) {
  switch (option) {
    case 'DOCUMENTO_INTERNO': {
      const cod = String(header.CODDOC || '').trim();
      const corr = header.CORRELATIVO != null ? String(header.CORRELATIVO).trim() : '';
      return [cod, corr].filter(Boolean).join(' ');
    }
    case 'EMPLEADO':
      return String(ctx.nombreEmpleado || '').trim();
    case 'TELEFONO_EMPLEADO':
      return String(ctx.telefonoEmpleado || '').trim();
    case 'FORMA_DE_PAGO':
      return formaPagoFromConcre(header.CONCRE);
    case 'EMBARQUE':
      return String(header.CODEMBARQUE || '').trim();
    case 'VENCIMIENTO':
      return formatDdMmYyyy(header.VENCIMIENTO);
    case 'TELEFONO_EMPRESA':
      return String(ctx.telefonoEmpresa || '').trim();
    case 'OBSERVACIONES':
      return String(header.OBS || '').trim();
    case 'DIRECCION_ENTREGA': {
      const dir = String(header.DIRENTREGA || '').trim();
      if (!dir || dir.toUpperCase() === 'SN') return '';
      return dir;
    }
    default:
      return '';
  }
}

/**
 * Resuelve Perso1–Perso20 según el JSON de configuración y el documento.
 * Solo incluye slots con opción asignada y valor no vacío.
 */
function resolvePersoAdendas(header, ctx = {}) {
  const { slots } = loadAdendasConfig();
  const perso = {};
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const opt = slots[String(i)];
    if (!opt) continue;
    const value = resolveAdendaValue(opt, header, ctx);
    if (!value) continue;
    perso[`Perso${i}`] = value;
  }
  return perso;
}

function buildAdendaXml(header, ctx = {}) {
  const perso = resolvePersoAdendas(header, ctx);
  const keys = Object.keys(perso);
  if (!keys.length) return '';
  const inner = keys
    .map((k) => `<${k}>${escapeXml(perso[k])}</${k}>`)
    .join('');
  return `<dte:Adenda>${inner}</dte:Adenda>`;
}

module.exports = {
  SLOT_COUNT,
  ADENDA_OPTIONS,
  loadAdendasConfig,
  saveAdendasConfig,
  loadAdendaContext,
  resolvePersoAdendas,
  buildAdendaXml,
};
