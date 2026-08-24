const TIPODOC_CUENTAS_PAGAR = ['COM', 'COP'];
const SQL_TIPODOC_CUENTAS_PAGAR_IN = TIPODOC_CUENTAS_PAGAR.map((t) => `'${t}'`).join(', ');

const TIPODOC_NOTA_PAGO = ['DVP'];
const SQL_TIPODOC_NOTA_PAGO_IN = TIPODOC_NOTA_PAGO.map((t) => `'${t}'`).join(', ');

/** Pagos / notas aplicados a cuentas por pagar (vínculo SERIEFAC/NOFAC). */
const TIPODOC_ABONO_CXP = ['RCP', ...TIPODOC_NOTA_PAGO];
const SQL_TIPODOC_ABONO_CXP_IN = TIPODOC_ABONO_CXP.map((t) => `'${t}'`).join(', ');

/** Retenciones emitidas que abonan compras vía DOCUMENTOS_FACTURAS_ABONADAS. */
const TIPODOC_RETENCION_CXP = ['RTV', 'RTI'];
const SQL_TIPODOC_RETENCION_CXP_IN = TIPODOC_RETENCION_CXP.map((t) => `'${t}'`).join(', ');

/**
 * EXISTS: la nota (alias `d`) referencia (SERIEFAC/NOFAC) una compra
 * al crédito (CONCRE = CRE) operada.
 */
const SQL_EXISTS_COMPRA_CRE_REF = `
  EXISTS (
    SELECT 1
    FROM dbo.DOCUMENTOS f
    INNER JOIN dbo.TIPODOCUMENTOS tf ON tf.EMPNIT = f.EMPNIT AND tf.CODDOC = f.CODDOC
    WHERE f.EMPNIT = d.EMPNIT
      AND LTRIM(RTRIM(f.CODDOC)) = LTRIM(RTRIM(d.SERIEFAC))
      AND TRY_CAST(LTRIM(RTRIM(d.NOFAC)) AS DECIMAL(18, 0)) = f.CORRELATIVO
      AND tf.TIPODOC IN (${SQL_TIPODOC_CUENTAS_PAGAR_IN})
      AND ISNULL(f.CONCRE, 'CON') = 'CRE'
      AND f.STATUS = 'O'
  )
`;

/**
 * Saldo pendiente por pagar.
 * Convención: DOC_SALDO = restante por pagar; DOC_ABONO = suma de pagos.
 */
const SQL_DOC_SALDO_PENDIENTE = 'ISNULL(d.DOC_SALDO, 0)';

/** Solo documentos con saldo pendiente a 2 decimales (milésimas se ignoran). */
const SQL_DOC_SALDO_PENDIENTE_POSITIVO = `ROUND(${SQL_DOC_SALDO_PENDIENTE}, 2) > 0`;

/** Documento referencia compra por SERIEFAC (CODDOC) y NOFAC (correlativo). */
const SQL_MATCH_COMPRA_REF = `
  LTRIM(RTRIM(d.SERIEFAC)) = LTRIM(RTRIM(@SERIEFAC))
  AND (
    LTRIM(RTRIM(d.NOFAC)) = LTRIM(RTRIM(@NOFAC))
    OR TRY_CAST(LTRIM(RTRIM(d.NOFAC)) AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
  )
`;

/**
 * Pago válido para CXP: recibos RCP, o notas DVP que referencien
 * una compra al crédito (CONCRE = CRE) operada.
 */
const SQL_ABONO_CXP_FILTER = `(
  t.TIPODOC = 'RCP'
  OR (t.TIPODOC IN (${SQL_TIPODOC_NOTA_PAGO_IN}) AND ${SQL_EXISTS_COMPRA_CRE_REF})
)`;

module.exports = {
  TIPODOC_CUENTAS_PAGAR,
  SQL_TIPODOC_CUENTAS_PAGAR_IN,
  TIPODOC_NOTA_PAGO,
  SQL_TIPODOC_NOTA_PAGO_IN,
  TIPODOC_ABONO_CXP,
  SQL_TIPODOC_ABONO_CXP_IN,
  TIPODOC_RETENCION_CXP,
  SQL_TIPODOC_RETENCION_CXP_IN,
  SQL_EXISTS_COMPRA_CRE_REF,
  SQL_DOC_SALDO_PENDIENTE,
  SQL_DOC_SALDO_PENDIENTE_POSITIVO,
  SQL_MATCH_COMPRA_REF,
  SQL_ABONO_CXP_FILTER,
};
