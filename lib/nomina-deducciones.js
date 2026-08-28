const sql = require('mssql');
const { roundMoney } = require('./nomina-utils');
const { calcularLineaNomina, totalesPlanilla } = require('./nomina-calculo');
const { listValesPendientesEmpleado, crearPagoVale, eliminarPagoVale } = require('./nomina-vales');

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function ensureDeduccionesTable(pool) {
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'NOMINA_DETALLE_DEDUCCIONES' AND schema_id = SCHEMA_ID('dbo'))
    BEGIN
      CREATE TABLE dbo.NOMINA_DETALLE_DEDUCCIONES (
        ID INT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
        DETALLE_ID INT NOT NULL,
        EMPNIT VARCHAR(20) NOT NULL,
        TIPO VARCHAR(20) NOT NULL,
        REF_ID INT NULL,
        PAGO_VALE_ID INT NULL,
        DESCRIPCION VARCHAR(250) NULL,
        MONTO DECIMAL(18, 3) NOT NULL CONSTRAINT DF_NOMINA_DET_DED_MONTO_RT DEFAULT (0),
        FECHA_CREACION DATETIME NOT NULL CONSTRAINT DF_NOMINA_DET_DED_FC_RT DEFAULT (GETDATE()),
        CONSTRAINT CK_NOMINA_DET_DED_TIPO_RT CHECK (TIPO IN ('VALE', 'MANUAL'))
      );
      CREATE INDEX IX_NOMINA_DET_DED_DET ON dbo.NOMINA_DETALLE_DEDUCCIONES (DETALLE_ID);
    END
  `);
}

async function assertDetalleEditable(pool, empnit, planillaId, detalleId) {
  const res = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('PLANILLA_ID', sql.Int, planillaId)
    .input('DETALLE_ID', sql.Int, detalleId)
    .query(`
      SELECT d.*, p.STATUS AS PLANILLA_STATUS
      FROM dbo.NOMINA_DETALLE d
      INNER JOIN dbo.NOMINA_PLANILLAS p ON p.ID = d.PLANILLA_ID AND p.EMPNIT = d.EMPNIT
      WHERE d.EMPNIT = @EMPNIT AND d.PLANILLA_ID = @PLANILLA_ID AND d.ID = @DETALLE_ID
    `);
  const row = res.recordset[0];
  if (!row) throw httpError('Línea de planilla no encontrada', 404);
  if (String(row.PLANILLA_STATUS || '').toUpperCase() === 'F') {
    throw httpError('La planilla está cerrada', 400);
  }
  return row;
}

async function listDeduccionesLinea(pool, empnit, detalleId) {
  await ensureDeduccionesTable(pool);
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('DETALLE_ID', sql.Int, detalleId)
    .query(`
      SELECT d.ID, d.DETALLE_ID, d.EMPNIT, d.TIPO, d.REF_ID, d.PAGO_VALE_ID,
             d.DESCRIPCION, d.MONTO, d.FECHA_CREACION,
             CASE WHEN d.PAGO_VALE_ID IS NOT NULL THEN 'SI' ELSE 'NO' END AS ABONO_APLICADO
      FROM dbo.NOMINA_DETALLE_DEDUCCIONES d
      WHERE d.EMPNIT = @EMPNIT AND d.DETALLE_ID = @DETALLE_ID
      ORDER BY d.ID ASC
    `);
  return result.recordset || [];
}

async function sumDeduccionesLinea(pool, empnit, detalleId) {
  await ensureDeduccionesTable(pool);
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('DETALLE_ID', sql.Int, detalleId)
    .query(`
      SELECT ISNULL(SUM(MONTO), 0) AS TOTAL
      FROM dbo.NOMINA_DETALLE_DEDUCCIONES
      WHERE EMPNIT = @EMPNIT AND DETALLE_ID = @DETALLE_ID
    `);
  return roundMoney(result.recordset[0]?.TOTAL ?? 0);
}

async function recalcLineaFromDeducciones(pool, empnit, planillaId, detalleId) {
  const { getNominaConfig } = require('./nomina-planillas');
  const detalle = await assertDetalleEditable(pool, empnit, planillaId, detalleId);
  const config = await getNominaConfig(pool, empnit);
  const totalDed = await sumDeduccionesLinea(pool, empnit, detalleId);
  const merged = { ...detalle, OTRAS_DEDUCCIONES: totalDed };
  const calc = calcularLineaNomina(merged, config);

  await pool
    .request()
    .input('ID', sql.Int, detalleId)
    .input('OTRAS_DEDUCCIONES', sql.Decimal(18, 3), calc.OTRAS_DEDUCCIONES)
    .input('IGSS_LABORAL', sql.Decimal(18, 3), calc.IGSS_LABORAL)
    .input('IGSS_PATRONAL', sql.Decimal(18, 3), calc.IGSS_PATRONAL)
    .input('ISR', sql.Decimal(18, 3), calc.ISR)
    .input('TOTAL_INGRESOS', sql.Decimal(18, 3), calc.TOTAL_INGRESOS)
    .input('TOTAL_DEDUCCIONES', sql.Decimal(18, 3), calc.TOTAL_DEDUCCIONES)
    .input('NETO_PAGAR', sql.Decimal(18, 3), calc.NETO_PAGAR)
    .query(`
      UPDATE dbo.NOMINA_DETALLE SET
        OTRAS_DEDUCCIONES=@OTRAS_DEDUCCIONES, IGSS_LABORAL=@IGSS_LABORAL, IGSS_PATRONAL=@IGSS_PATRONAL,
        ISR=@ISR, TOTAL_INGRESOS=@TOTAL_INGRESOS, TOTAL_DEDUCCIONES=@TOTAL_DEDUCCIONES, NETO_PAGAR=@NETO_PAGAR
      WHERE ID=@ID
    `);

  const linesRes = await pool
    .request()
    .input('PLANILLA_ID', sql.Int, planillaId)
    .query(`SELECT * FROM dbo.NOMINA_DETALLE WHERE PLANILLA_ID=@PLANILLA_ID`);
  const tot = totalesPlanilla(linesRes.recordset || []);
  await pool
    .request()
    .input('ID', sql.Int, planillaId)
    .input('TOTAL_INGRESOS', sql.Decimal(18, 3), tot.TOTAL_INGRESOS)
    .input('TOTAL_DEDUCCIONES', sql.Decimal(18, 3), tot.TOTAL_DEDUCCIONES)
    .input('TOTAL_NETO', sql.Decimal(18, 3), tot.TOTAL_NETO)
    .input('TOTAL_IGSS_LAB', sql.Decimal(18, 3), tot.TOTAL_IGSS_LAB)
    .input('TOTAL_IGSS_PAT', sql.Decimal(18, 3), tot.TOTAL_IGSS_PAT)
    .query(`
      UPDATE dbo.NOMINA_PLANILLAS SET
        TOTAL_INGRESOS=@TOTAL_INGRESOS, TOTAL_DEDUCCIONES=@TOTAL_DEDUCCIONES, TOTAL_NETO=@TOTAL_NETO,
        TOTAL_IGSS_LAB=@TOTAL_IGSS_LAB, TOTAL_IGSS_PAT=@TOTAL_IGSS_PAT, STATUS='C'
      WHERE ID=@ID
    `);

  return calc;
}

async function insertDeduccionesValesSugeridas(pool, empnit, detalleId, vales) {
  if (!vales?.length) return;
  await ensureDeduccionesTable(pool);
  for (const vale of vales) {
    const monto = roundMoney(vale.CUOTA_SUGERIDA ?? 0);
    if (monto <= 0) continue;
    const desc = `Vale #${vale.ID}${vale.DESCRIPCION ? ` — ${String(vale.DESCRIPCION).slice(0, 200)}` : ''}`;
    await pool
      .request()
      .input('DETALLE_ID', sql.Int, detalleId)
      .input('EMPNIT', sql.VarChar, empnit)
      .input('TIPO', sql.VarChar, 'VALE')
      .input('REF_ID', sql.Int, Number(vale.ID))
      .input('DESCRIPCION', sql.VarChar, desc.slice(0, 250))
      .input('MONTO', sql.Decimal(18, 3), monto)
      .query(`
        IF NOT EXISTS (
          SELECT 1 FROM dbo.NOMINA_DETALLE_DEDUCCIONES
          WHERE EMPNIT = @EMPNIT AND DETALLE_ID = @DETALLE_ID AND TIPO = 'VALE' AND REF_ID = @REF_ID
        )
        INSERT INTO dbo.NOMINA_DETALLE_DEDUCCIONES (DETALLE_ID, EMPNIT, TIPO, REF_ID, DESCRIPCION, MONTO)
        VALUES (@DETALLE_ID, @EMPNIT, @TIPO, @REF_ID, @DESCRIPCION, @MONTO)
      `);
  }
}

async function getDeduccionesModalData(pool, empnit, planillaId, detalleId, codemp) {
  const detalle = await assertDetalleEditable(pool, empnit, planillaId, detalleId);
  const vales = await listValesPendientesEmpleado(pool, empnit, codemp);
  const deducciones = await listDeduccionesLinea(pool, empnit, detalleId);
  const totalCuota = vales.reduce((s, r) => s + (Number(r.CUOTA_SUGERIDA) || 0), 0);
  const totalSaldo = vales.reduce((s, r) => s + (Number(r.SALDO) || 0), 0);
  const totalCargos = deducciones.reduce((s, r) => s + (Number(r.MONTO) || 0), 0);
  return {
    detalle: {
      ID: detalle.ID,
      CODEMPLEADO: detalle.CODEMPLEADO,
      NOMEMPLEADO: detalle.NOMEMPLEADO,
      OTRAS_DEDUCCIONES: detalle.OTRAS_DEDUCCIONES,
    },
    vales,
    deducciones,
    totalCuota: roundMoney(totalCuota),
    totalSaldo: roundMoney(totalSaldo),
    totalCargos: roundMoney(totalCargos),
  };
}

async function confirmarAbonoValeNomina(pool, empnit, planillaId, detalleId, body) {
  const detalle = await assertDetalleEditable(pool, empnit, planillaId, detalleId);
  const idVale = parseInt(body.IDVALE ?? body.idVale, 10);
  const monto = roundMoney(body.MONTO ?? body.monto);
  const fechaStr = String(body.FECHA ?? body.fecha ?? new Date().toISOString()).slice(0, 10);

  if (!Number.isFinite(idVale) || idVale <= 0) throw httpError('Vale inválido');
  if (!(monto > 0)) throw httpError('El importe debe ser mayor a cero');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) throw httpError('Fecha inválida');

  const pago = await crearPagoVale(pool, empnit, idVale, {
    MONTO: monto,
    FECHA: fechaStr,
    FECHA_PAGO: fechaStr,
    desdeNomina: true,
    ORIGEN: 'NOMINA',
  });

  await ensureDeduccionesTable(pool);
  const desc = `Abono vale #${idVale} (nómina)`;
  const existing = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('DETALLE_ID', sql.Int, detalleId)
    .input('REF_ID', sql.Int, idVale)
    .query(`
      SELECT TOP 1 ID FROM dbo.NOMINA_DETALLE_DEDUCCIONES
      WHERE EMPNIT = @EMPNIT AND DETALLE_ID = @DETALLE_ID AND TIPO = 'VALE' AND REF_ID = @REF_ID
      ORDER BY ID DESC
    `);

  if (existing.recordset[0]?.ID) {
    await pool
      .request()
      .input('ID', sql.Int, existing.recordset[0].ID)
      .input('PAGO_VALE_ID', sql.Int, pago.pagoId)
      .input('MONTO', sql.Decimal(18, 3), monto)
      .input('DESCRIPCION', sql.VarChar, desc)
      .query(`
        UPDATE dbo.NOMINA_DETALLE_DEDUCCIONES
        SET PAGO_VALE_ID = @PAGO_VALE_ID, MONTO = @MONTO, DESCRIPCION = @DESCRIPCION
        WHERE ID = @ID
      `);
  } else {
    await pool
      .request()
      .input('DETALLE_ID', sql.Int, detalleId)
      .input('EMPNIT', sql.VarChar, empnit)
      .input('REF_ID', sql.Int, idVale)
      .input('PAGO_VALE_ID', sql.Int, pago.pagoId)
      .input('DESCRIPCION', sql.VarChar, desc)
      .input('MONTO', sql.Decimal(18, 3), monto)
      .query(`
        INSERT INTO dbo.NOMINA_DETALLE_DEDUCCIONES
          (DETALLE_ID, EMPNIT, TIPO, REF_ID, PAGO_VALE_ID, DESCRIPCION, MONTO)
        VALUES (@DETALLE_ID, @EMPNIT, 'VALE', @REF_ID, @PAGO_VALE_ID, @DESCRIPCION, @MONTO)
      `);
  }

  await recalcLineaFromDeducciones(pool, empnit, planillaId, detalleId);
  return getDeduccionesModalData(pool, empnit, planillaId, detalleId, detalle.CODEMPLEADO);
}

async function deleteDeduccionLinea(pool, empnit, planillaId, detalleId, deduccionId) {
  const detalle = await assertDetalleEditable(pool, empnit, planillaId, detalleId);
  await ensureDeduccionesTable(pool);
  const rowRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('DETALLE_ID', sql.Int, detalleId)
    .input('ID', sql.Int, deduccionId)
    .query(`
      SELECT ID, TIPO, REF_ID, PAGO_VALE_ID, MONTO
      FROM dbo.NOMINA_DETALLE_DEDUCCIONES
      WHERE EMPNIT = @EMPNIT AND DETALLE_ID = @DETALLE_ID AND ID = @ID
    `);
  const row = rowRes.recordset[0];
  if (!row) throw httpError('Deducción no encontrada', 404);

  if (row.TIPO === 'VALE' && row.PAGO_VALE_ID && row.REF_ID) {
    await eliminarPagoVale(pool, empnit, row.REF_ID, row.PAGO_VALE_ID, {});
  }

  await pool
    .request()
    .input('ID', sql.Int, deduccionId)
    .query(`DELETE FROM dbo.NOMINA_DETALLE_DEDUCCIONES WHERE ID = @ID`);

  await recalcLineaFromDeducciones(pool, empnit, planillaId, detalleId);
  return getDeduccionesModalData(pool, empnit, planillaId, detalleId, detalle.CODEMPLEADO);
}

module.exports = {
  ensureDeduccionesTable,
  listDeduccionesLinea,
  insertDeduccionesValesSugeridas,
  getDeduccionesModalData,
  confirmarAbonoValeNomina,
  deleteDeduccionLinea,
  recalcLineaFromDeducciones,
};
