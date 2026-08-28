const ExcelJS = require('exceljs');
const { normalizeExportCellValue, applyExcelDateFormats, toExcelDate } = require('./excel-export');

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/**
 * Fecha de libro para Excel: FEL_FECHA si existe; si no, FECHA del documento.
 * Formato dd/mm/yyyy (igual que la vista).
 */
function formatLibroFechaExport(felFecha, fechaFallback) {
  const fel = String(felFecha ?? '').trim();
  const dt = toExcelDate(fel || fechaFallback);
  if (!dt) return '';
  const day = String(dt.getDate()).padStart(2, '0');
  const month = String(dt.getMonth() + 1).padStart(2, '0');
  const year = dt.getFullYear();
  return `${day}/${month}/${year}`;
}

function parseMes(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || n > 12) return null;
  return n;
}

function parseAnio(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 2020 || n > 2035) return null;
  return n;
}

function getEmpNitFromReq(req) {
  return String(req.query.empnit || req.headers['x-emp-nit'] || '').trim();
}

function requireEmpNit(req, res) {
  const empnit = getEmpNitFromReq(req);
  if (!empnit) {
    res.status(400).json({ error: 'EMPNIT requerido (empresa de la sesión)' });
    return null;
  }
  return empnit;
}

function parsePeriod(req, res) {
  const mes = parseMes(req.query.mes);
  const anio = parseAnio(req.query.anio);
  if (mes === null) {
    res.status(400).json({ error: 'MES inválido (1-12)' });
    return null;
  }
  if (anio === null) {
    res.status(400).json({ error: 'ANIO inválido (2020-2035)' });
    return null;
  }
  return { mes, anio };
}

function safeFilenamePart(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 40);
}

async function buildLibroWorkbook({ sheetName = 'Reporte', title, periodLabel, columns, rows, totalsRow }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  let rowIdx = 1;

  if (title) {
    sheet.mergeCells(rowIdx, 1, rowIdx, Math.max(columns.length, 1));
    sheet.getCell(rowIdx, 1).value = title;
    sheet.getCell(rowIdx, 1).font = { bold: true, size: 14 };
    rowIdx += 1;
  }
  if (periodLabel) {
    sheet.mergeCells(rowIdx, 1, rowIdx, Math.max(columns.length, 1));
    sheet.getCell(rowIdx, 1).value = periodLabel;
    rowIdx += 1;
  }
  if (title || periodLabel) rowIdx += 1;

  sheet.columns = columns.map((c) => ({
    key: c.key,
    width: c.width || 14,
  }));
  const headerRow = sheet.getRow(rowIdx);
  columns.forEach((c, i) => {
    headerRow.getCell(i + 1).value = c.header;
    headerRow.getCell(i + 1).font = { bold: true };
  });
  rowIdx += 1;

  const dataHeaderRow = rowIdx - 1;

  rows.forEach((row) => {
    const excelRow = {};
    columns.forEach((c) => {
      excelRow[c.key] = normalizeExportCellValue(c, row[c.key]);
    });
    sheet.addRow(excelRow);
  });

  if (totalsRow) {
    const total = {};
    columns.forEach((c) => {
      total[c.key] = normalizeExportCellValue(c, totalsRow[c.key]);
    });
    const tr = sheet.addRow(total);
    tr.font = { bold: true };
  }

  columns.forEach((c, i) => {
    if (c.type === 'money') {
      const col = sheet.getColumn(i + 1);
      col.numFmt = '#,##0.00';
    }
  });
  applyExcelDateFormats(sheet, columns, { headerRow: dataHeaderRow });

  return workbook.xlsx.writeBuffer();
}

function sendLibroXlsx(res, buffer, filename) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buffer));
}

function mesLabel(mes) {
  const labels = [
    'ENERO',
    'FEBRERO',
    'MARZO',
    'ABRIL',
    'MAYO',
    'JUNIO',
    'JULIO',
    'AGOSTO',
    'SEPTIEMBRE',
    'OCTUBRE',
    'NOVIEMBRE',
    'DICIEMBRE',
  ];
  const n = Number(mes);
  return labels[n - 1] || String(mes);
}

module.exports = {
  toNumber,
  roundMoney,
  parseMes,
  parseAnio,
  getEmpNitFromReq,
  requireEmpNit,
  parsePeriod,
  safeFilenamePart,
  formatLibroFechaExport,
  buildLibroWorkbook,
  sendLibroXlsx,
  mesLabel,
};
