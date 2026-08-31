const sql = require('mssql');

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/**
 * Costo promedio ponderado: (costo compra + costo existente) / (unidades compra + saldo).
 * @param {{ costoCompraTotal: number, unidadesCompra: number, costoUnitarioActual: number, saldoExistencia: number }} params
 */
function calcularCostoPromedioUnitario(params) {
  const unidadesCompra = Number(params.unidadesCompra) || 0;
  const costoCompraTotal = Number(params.costoCompraTotal) || 0;
  const saldo = Number(params.saldoExistencia) || 0;
  const costoUnitarioActual = Number(params.costoUnitarioActual) || 0;
  const costoExistencia = costoUnitarioActual * saldo;
  const unidadesTotal = unidadesCompra + saldo;
  const costoTotal = costoCompraTotal + costoExistencia;
  if (unidadesTotal <= 0) {
    if (unidadesCompra > 0) return roundMoney(costoCompraTotal / unidadesCompra);
    return roundMoney(costoUnitarioActual);
  }
  return roundMoney(costoTotal / unidadesTotal);
}

/**
 * Actualiza PRODUCTOS.COSTO_PROMEDIO, PRECIOS.COSTO_PROMEDIO y INVSALDO.COSTO_PROMEDIO.
 */
async function actualizarCostoPromedio(transaction, empnit, codprod, costoPromedioUnitario) {
  const costoPromedio = roundMoney(costoPromedioUnitario);
  await new sql.Request(transaction)
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROD', sql.VarChar, codprod)
    .input('COSTO_PROMEDIO', sql.Decimal(18, 3), costoPromedio)
    .query(`
      UPDATE dbo.PRODUCTOS
      SET COSTO_PROMEDIO = @COSTO_PROMEDIO
      WHERE EMPNIT = @EMPNIT AND LTRIM(RTRIM(CODPROD)) = LTRIM(RTRIM(@CODPROD))
    `);

  const precios = await new sql.Request(transaction)
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROD', sql.VarChar, codprod)
    .input('COSTO_PROMEDIO_UNIT', sql.Decimal(18, 3), costoPromedio)
    .query(`
      UPDATE dbo.PRECIOS
      SET COSTO_PROMEDIO = ROUND(@COSTO_PROMEDIO_UNIT * CAST(ISNULL(NULLIF(EQUIVALE, 0), 1) AS decimal(18, 3)), 3)
      WHERE EMPNIT = @EMPNIT AND LTRIM(RTRIM(CODPROD)) = LTRIM(RTRIM(@CODPROD))
    `);

  const inv = await new sql.Request(transaction)
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROD', sql.VarChar, codprod)
    .input('COSTO_PROMEDIO', sql.Decimal(18, 3), costoPromedio)
    .query(`
      UPDATE dbo.INVSALDO
      SET COSTO_PROMEDIO = @COSTO_PROMEDIO
      WHERE EMPNIT = @EMPNIT AND LTRIM(RTRIM(CODPROD)) = LTRIM(RTRIM(@CODPROD))
    `);

  return {
    costoPromedio,
    preciosActualizados: precios.rowsAffected?.[0] || 0,
    invsaldoActualizados: inv.rowsAffected?.[0] || 0,
  };
}

/**
 * Lee saldo total y costo unitario actual del producto (antes de actualizar).
 */
async function leerExistenciaCostoProducto(requestable, empnit, codprod) {
  const prod = await requestable
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROD', sql.VarChar, codprod)
    .query(`
      SELECT ISNULL(COSTO, 0) AS COSTO
      FROM dbo.PRODUCTOS
      WHERE EMPNIT = @EMPNIT AND LTRIM(RTRIM(CODPROD)) = LTRIM(RTRIM(@CODPROD))
    `);
  if (!prod.recordset.length) return null;

  const saldoRow = await requestable
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODPROD', sql.VarChar, codprod)
    .query(`
      SELECT ISNULL(SUM(ISNULL(SALDO, 0)), 0) AS SALDO
      FROM dbo.INVSALDO
      WHERE EMPNIT = @EMPNIT AND LTRIM(RTRIM(CODPROD)) = LTRIM(RTRIM(@CODPROD))
    `);

  return {
    costoUnitario: Number(prod.recordset[0].COSTO) || 0,
    saldo: Number(saldoRow.recordset[0]?.SALDO) || 0,
  };
}

/**
 * Totales de compra (TOTALCOSTO, TOTALUNIDADES) para un producto en un documento.
 */
async function totalesCompraProducto(requestable, empnit, coddoc, correlativo, codprod) {
  const res = await requestable
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .input('CODPROD', sql.VarChar, codprod)
    .query(`
      SELECT
        ISNULL(SUM(ISNULL(TOTALCOSTO, 0)), 0) AS TOTALCOSTO,
        ISNULL(SUM(ISNULL(TOTALUNIDADES, 0)), 0) AS TOTALUNIDADES
      FROM dbo.DOCPRODUCTOS
      WHERE EMPNIT = @EMPNIT AND CODDOC = @CODDOC AND CORRELATIVO = @CORRELATIVO
        AND LTRIM(RTRIM(CODPROD)) = LTRIM(RTRIM(@CODPROD))
        AND ISNULL(TIPOPROD, '') <> 'S'
        AND LEFT(UPPER(LTRIM(RTRIM(ISNULL(CODPROD, '')))), 3) <> 'PSE'
    `);
  const row = res.recordset[0] || {};
  return {
    totalCosto: Number(row.TOTALCOSTO) || 0,
    totalUnidades: Number(row.TOTALUNIDADES) || 0,
  };
}

module.exports = {
  roundMoney,
  calcularCostoPromedioUnitario,
  actualizarCostoPromedio,
  leerExistenciaCostoProducto,
  totalesCompraProducto,
};
