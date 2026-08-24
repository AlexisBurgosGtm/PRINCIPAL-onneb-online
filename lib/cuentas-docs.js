const { TIPODOC_FACTURA, TIPODOC_DEVOLUCION } = require('./corte-caja-docs');
const { SQL_TIPODOC_REPORTES_SI, sqlTipodocReportesSi } = require('./documento-status');

const TIPODOC_CUENTAS_COBRAR = [...TIPODOC_FACTURA];
const SQL_TIPODOC_CUENTAS_COBRAR_IN = TIPODOC_CUENTAS_COBRAR.map((t) => `'${t}'`).join(', ');

/** Abonos / créditos aplicados a cuentas por cobrar. */
const TIPODOC_ABONO_CXC = ['RCC', 'PRC', 'RAR', ...TIPODOC_DEVOLUCION];
const SQL_TIPODOC_ABONO_CXC_IN = TIPODOC_ABONO_CXC.map((t) => `'${t}'`).join(', ');

/** FEL de venta (retenciones recibidas se aplican a estos, no a FAC). */
const TIPODOC_FEL_CXC = ['FEF', 'FEC', 'FES'];
const SQL_TIPODOC_FEL_CXC_IN = TIPODOC_FEL_CXC.map((t) => `'${t}'`).join(', ');

/** Retenciones recibidas que abonan CXC vía DOCUMENTOS_FACTURAS_ABONADAS. */
const TIPODOC_RETENCION_CXC = ['RVR', 'RIR'];
const SQL_TIPODOC_RETENCION_CXC_IN = TIPODOC_RETENCION_CXC.map((t) => `'${t}'`).join(', ');

/** Notas FEL usadas como referencia de abono CXC (vía RAR, ligadas a la FEL de la FAC). */
const TIPODOC_NOTA_FEL_CXC = ['FNC', 'FNA'];
const SQL_TIPODOC_NOTA_FEL_CXC_IN = TIPODOC_NOTA_FEL_CXC.map((t) => `'${t}'`).join(', ');

/** Notas de crédito (DEV, FNC). */
const SQL_TIPODOC_DEVOLUCION_IN = TIPODOC_DEVOLUCION.map((t) => `'${t}'`).join(', ');

/**
 * EXISTS: la nota (alias `d`) referencia (SERIEFAC/NOFAC) una factura
 * al crédito (CONCRE = CRE) operada y con REPORTES distinto de 'NO'.
 */
const SQL_EXISTS_FACTURA_CRE_REF = `
  EXISTS (
    SELECT 1
    FROM dbo.DOCUMENTOS f
    INNER JOIN dbo.TIPODOCUMENTOS tf ON tf.EMPNIT = f.EMPNIT AND tf.CODDOC = f.CODDOC
    WHERE f.EMPNIT = d.EMPNIT
      AND LTRIM(RTRIM(f.CODDOC)) = LTRIM(RTRIM(d.SERIEFAC))
      AND TRY_CAST(LTRIM(RTRIM(d.NOFAC)) AS DECIMAL(18, 0)) = f.CORRELATIVO
      AND tf.TIPODOC IN (${SQL_TIPODOC_CUENTAS_COBRAR_IN})
      AND ISNULL(f.CONCRE, 'CON') = 'CRE'
      AND f.STATUS = 'O'
      AND ${sqlTipodocReportesSi('tf')}
  )
`;

/**
 * Saldo pendiente por cobrar/pagar.
 * Convención del sistema: DOC_SALDO = restante por cobrar; DOC_ABONO = suma de abonos.
 * No restar DOC_ABONO otra vez (provoca T−2A y oculta facturas con A ≥ T/2).
 */
const SQL_DOC_SALDO_PENDIENTE = 'ISNULL(d.DOC_SALDO, 0)';

/** Solo documentos con saldo pendiente a 2 decimales (milésimas se ignoran). */
const SQL_DOC_SALDO_PENDIENTE_POSITIVO = `ROUND(${SQL_DOC_SALDO_PENDIENTE}, 2) > 0`;

/** Documento referencia factura por SERIEFAC (CODDOC) y NOFAC (correlativo). */
const SQL_MATCH_FACTURA_REF = `
  LTRIM(RTRIM(d.SERIEFAC)) = LTRIM(RTRIM(@SERIEFAC))
  AND (
    LTRIM(RTRIM(d.NOFAC)) = LTRIM(RTRIM(@NOFAC))
    OR TRY_CAST(LTRIM(RTRIM(d.NOFAC)) AS DECIMAL(18, 0)) = @FAC_CORRELATIVO
  )
`;

module.exports = {
  TIPODOC_CUENTAS_COBRAR,
  SQL_TIPODOC_CUENTAS_COBRAR_IN,
  TIPODOC_ABONO_CXC,
  SQL_TIPODOC_ABONO_CXC_IN,
  TIPODOC_FEL_CXC,
  SQL_TIPODOC_FEL_CXC_IN,
  TIPODOC_RETENCION_CXC,
  SQL_TIPODOC_RETENCION_CXC_IN,
  TIPODOC_NOTA_FEL_CXC,
  SQL_TIPODOC_NOTA_FEL_CXC_IN,
  SQL_TIPODOC_DEVOLUCION_IN,
  SQL_EXISTS_FACTURA_CRE_REF,
  SQL_DOC_SALDO_PENDIENTE,
  SQL_DOC_SALDO_PENDIENTE_POSITIVO,
  SQL_MATCH_FACTURA_REF,
  SQL_TIPODOC_REPORTES_SI,
};