const { getTipomDocumento } = require('./inventario');

const CODPROD_DESCUENTO = 'DESCUENTO';
const CODMEDIDA_DESCUENTO = 'UN';
const DEFAULT_BODEGA = 0;

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function isLineaDescuentoCodprod(codprod) {
  return String(codprod || '').trim().toUpperCase() === CODPROD_DESCUENTO;
}

/**
 * @returns {{ desprod: string, monto: number }|null}
 */
function parseDescuentoLineaBody(body) {
  const tipo = String(body?.tipo || '').trim().toLowerCase();
  const codprod = String(body?.CODPROD || '').trim().toUpperCase();
  if (tipo !== 'descuento' && codprod !== CODPROD_DESCUENTO) return null;

  const desprod = String(body?.DESPROD || '').trim();
  const rawMonto = body?.MONTO ?? body?.PRECIO ?? body?.TOTALPRECIO ?? body?.COSTO;
  const monto = roundMoney(rawMonto);

  if (!desprod) {
    const err = new Error('La descripción del descuento es obligatoria');
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(monto) || monto <= 0) {
    const err = new Error('El monto del descuento debe ser mayor a cero');
    err.statusCode = 400;
    throw err;
  }

  return { desprod, monto };
}

async function insertDescuentoLinea(transaction, sql, opts) {
  const { empnit, coddoc, correlativo, desprod, monto, parts } = opts;
  const m = roundMoney(monto);
  const tipom = await getTipomDocumento(transaction, empnit, coddoc);

  const result = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ANIO', sql.Int, parts.anio)
    .input('MES', sql.Int, parts.mes)
    .input('DIA', sql.Int, parts.dia)
    .input('CODDOC', sql.VarChar, coddoc)
    .input('CORRELATIVO', sql.Decimal(18, 0), correlativo)
    .input('CODPROD', sql.VarChar, CODPROD_DESCUENTO)
    .input('DESPROD', sql.VarChar, desprod)
    .input('CODMEDIDA', sql.VarChar, CODMEDIDA_DESCUENTO)
    .input('CANTIDAD', sql.Float, 1)
    .input('EQUIVALE', sql.Int, 1)
    .input('TOTALUNIDADES', sql.Float, 0)
    .input('COSTO', sql.Decimal(18, 3), m)
    .input('PRECIO', sql.Decimal(18, 3), m)
    .input('TOTALCOSTO', sql.Decimal(18, 3), m)
    .input('TOTALPRECIO', sql.Decimal(18, 3), m)
    .input('TIPOM', sql.Int, tipom)
    .query(`
      INSERT INTO dbo.DOCPRODUCTOS (
        EMPNIT, ANIO, MES, DIA, CODDOC, CORRELATIVO, CODPROD, DESPROD, CODMEDIDA,
        CANTIDAD, CANTIDADBONIF, EQUIVALE, TOTALUNIDADES, TOTALBONIF,
        COSTO, PRECIO, TOTALCOSTO, TOTALPRECIO,
        ENTREGADOS_TOTALUNIDADES, ENTREGADOS_TOTALCOSTO, ENTREGADOS_TOTALPRECIO,
        COSTOANTERIOR, COSTOPROMEDIO, CODBODEGAENTRADA, CODBODEGASALIDA,
        DESCUENTO, PORCDESCUENTO, NOSERIE, EXENTO, OBS,
        TIPOPROD, TIPOPRECIO, PESO, TOTALPESO, TIPOM, LASTUPDATE
      ) VALUES (
        @EMPNIT, @ANIO, @MES, @DIA, @CODDOC, @CORRELATIVO, @CODPROD, @DESPROD, @CODMEDIDA,
        @CANTIDAD, 0, @EQUIVALE, @TOTALUNIDADES, 0,
        @COSTO, @PRECIO, @TOTALCOSTO, @TOTALPRECIO,
        0, @TOTALCOSTO, @TOTALPRECIO,
        0, 0, ${DEFAULT_BODEGA}, ${DEFAULT_BODEGA},
        0, 0, 'SN', 0, 'SN',
        'P', 'P', 0, 0, @TIPOM, CAST(GETDATE() AS DATE)
      );
      SELECT SCOPE_IDENTITY() AS ID;
    `);

  return result.recordset[0]?.ID ?? null;
}

module.exports = {
  CODPROD_DESCUENTO,
  CODMEDIDA_DESCUENTO,
  isLineaDescuentoCodprod,
  parseDescuentoLineaBody,
  insertDescuentoLinea,
};
