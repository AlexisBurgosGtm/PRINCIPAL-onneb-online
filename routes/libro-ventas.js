const express = require('express');
const multer = require('multer');
const { isDbConfigured } = require('../config/database');
const { listLibroVentas, TIPODOC_LIBRO_VENTAS } = require('../lib/libro-ventas');
const { compararSatConSistema } = require('../lib/sat-ventas-compare');
const {
  requireEmpNit,
  parsePeriod,
  buildLibroWorkbook,
  sendLibroXlsx,
  safeFilenamePart,
  mesLabel,
  formatLibroFechaExport,
} = require('../lib/libro-contable-utils');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const name = String(file.originalname || '').toLowerCase();
    if (name.endsWith('.xls') || name.endsWith('.xlsx')) {
      cb(null, true);
      return;
    }
    cb(new Error('Solo se permiten archivos .xls o .xlsx'));
  },
});

const EXPORT_COLUMNS = [
  { header: 'No.', key: 'LINEA', width: 6 },
  { header: 'Fecha', key: 'FEL_FECHA', width: 12, type: 'string' },
  { header: 'Serie', key: 'FEL_SERIE', width: 10 },
  { header: 'Número', key: 'FEL_NUMERO', width: 12 },
  { header: 'Tipo', key: 'TIPODOC', width: 8 },
  { header: 'NIT', key: 'DOC_NIT', width: 14 },
  { header: 'Nombre proveedor', key: 'DOC_NOMCLIE', width: 28 },
  { header: 'Total', key: 'TOTAL', width: 12, type: 'money' },
  { header: 'Total servicios', key: 'TOTAL_SERVICIOS', width: 14, type: 'money' },
  { header: 'Exentas', key: 'TOTALEXENTO', width: 12, type: 'money' },
  { header: 'Base del total', key: 'TOTALSINIVA', width: 14, type: 'money' },
  { header: 'Base servicios', key: 'BASE_SERVICIOS', width: 14, type: 'money' },
  { header: 'IVA', key: 'TOTALIVA', width: 12, type: 'money' },
  { header: 'Anulado', key: 'ANULADO', width: 10 },
];

router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const period = parsePeriod(req, res);
  if (!period) return;

  try {
    const pool = await req.app.locals.getDbPool();
    const data = await listLibroVentas(pool, require('mssql'), empnit, period.mes, period.anio);
    res.json({
      rows: data.rows,
      totals: data.totals,
      mes: data.mes,
      anio: data.anio,
      tipodocs: TIPODOC_LIBRO_VENTAS,
    });
  } catch (err) {
    console.warn('[API GET /libro-ventas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/export', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const period = parsePeriod(req, res);
  if (!period) return;

  try {
    const pool = await req.app.locals.getDbPool();
    const data = await listLibroVentas(pool, require('mssql'), empnit, period.mes, period.anio);
    const exportRows = (data.rows || []).map((r) => ({
      ...r,
      FEL_FECHA: formatLibroFechaExport(r.FEL_FECHA, r.FECHA),
      ANULADO: r.ANULADO ? 'Sí' : 'No',
    }));
    const t = data.totals || {};
    const buffer = await buildLibroWorkbook({
      sheetName: 'Libro Ventas',
      title: 'Libro de Ventas y Servicios Prestados',
      periodLabel: `Período: ${mesLabel(period.mes)} ${period.anio}`,
      columns: EXPORT_COLUMNS,
      rows: exportRows,
      totalsRow: {
        LINEA: '',
        FEL_FECHA: '',
        FEL_SERIE: '',
        FEL_NUMERO: '',
        TIPODOC: '',
        DOC_NIT: '',
        DOC_NOMCLIE: 'Totales (sin anulados)',
        TOTAL: t.total ?? 0,
        TOTAL_SERVICIOS: t.totalServicios ?? 0,
        TOTALEXENTO: t.exento ?? 0,
        TOTALSINIVA: t.gravado ?? 0,
        BASE_SERVICIOS: t.baseServicios ?? 0,
        TOTALIVA: t.iva ?? 0,
        ANULADO: '',
      },
    });
    const filename = `libro_ventas_${safeFilenamePart(empnit)}_${period.mes}_${period.anio}_${Date.now()}.xlsx`;
    sendLibroXlsx(res, buffer, filename);
  } catch (err) {
    console.warn('[API GET /libro-ventas/export]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/comparar-sat', (req, res) => {
  upload.single('archivo')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || 'Error al subir el archivo' });
    }
    res.setHeader('Cache-Control', 'no-store');
    if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
    const empnit = requireEmpNit(req, res);
    if (!empnit) return;
    const period = parsePeriod(req, res);
    if (!period) return;
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'Debe seleccionar un archivo Excel (.xls o .xlsx)' });
    }
    try {
      const pool = await req.app.locals.getDbPool();
      const result = await compararSatConSistema(
        pool,
        require('mssql'),
        empnit,
        period.mes,
        period.anio,
        req.file.buffer
      );
      res.json({
        ...result,
        archivo: req.file.originalname,
      });
    } catch (err) {
      const code = err.statusCode || 500;
      if (code >= 500) console.warn('[API POST /libro-ventas/comparar-sat]', err.message);
      res.status(code).json({ error: err.message });
    }
  });
});

module.exports = router;
