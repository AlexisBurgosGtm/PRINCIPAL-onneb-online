/**
 * Saldos CxC/CxP se operan a 2 decimales (centavos).
 * La 3ª decimal y siguientes se ignoran al validar abonos y al cerrar documentos.
 * Abonos por retención pueden exceder el saldo hasta 2 centavos para cerrar el documento.
 */

const TOLERANCIA_ABONO_RETENCION = 0.02;

function roundCentavos(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function abonoSuperaSaldo(abono, saldo, extraPermitido = 0) {
  return roundCentavos(abono) > roundCentavos(Number(saldo) + Number(extraPermitido || 0));
}

function saldoEfectivo(docSaldo, totalPrecio, docAbono) {
  const col = roundCentavos(docSaldo);
  const porAbonos = Math.max(0, roundCentavos(totalPrecio) - roundCentavos(docAbono));
  return Math.min(col, porAbonos);
}

/** Recalcula DOC_ABONO / DOC_SALDO a 2 decimales; milésimas (o tolerancia) cierran el documento. */
function aplicarSaldoCentavos(totalPrecio, nuevoAbono, extraCierre = 0) {
  const total = Number(totalPrecio) || 0;
  const abono = Number(nuevoAbono) || 0;
  const restante = roundCentavos(total - abono);
  if (restante <= roundCentavos(extraCierre)) {
    return { DOC_ABONO: total, DOC_SALDO: 0 };
  }
  return { DOC_ABONO: roundCentavos(abono), DOC_SALDO: restante };
}

/** Aplica un abono sobre columnas actuales; si el resto es milésimas o ≤ extra, cancela. */
function aplicarAbonoSobreSaldo(docAbono, docSaldo, abono, extraCierre = 0) {
  const saldo = Number(docSaldo) || 0;
  const pago = Number(abono) || 0;
  const restante = roundCentavos(saldo - pago);
  if (restante <= roundCentavos(extraCierre)) {
    return {
      DOC_ABONO: roundCentavos((Number(docAbono) || 0) + saldo),
      DOC_SALDO: 0,
    };
  }
  return {
    DOC_ABONO: roundCentavos((Number(docAbono) || 0) + pago),
    DOC_SALDO: restante,
  };
}

/**
 * SET de UPDATE: cuadra a 2 decimales y pone saldo 0 si el resto redondeado es ≤ tolerancia.
 * @param {string} totalExpr p.ej. 'TOTALPRECIO' o 'd.TOTALPRECIO'
 * @param {string} abonoExpr p.ej. '@DOC_ABONO' o 'ab.TOTAL_ABONOS'
 * @param {string} [colPrefix] p.ej. 'd.'
 * @param {number} [toleranciaCierre] centavos para cancelar (0.02 en corrección / retenciones)
 */
function sqlSetDocSaldoFromAbonos(totalExpr, abonoExpr, colPrefix = '', toleranciaCierre = 0) {
  const p = colPrefix;
  const rest = `ROUND(ISNULL(${totalExpr}, 0) - ISNULL(${abonoExpr}, 0), 2)`;
  const limite = roundCentavos(toleranciaCierre);
  return `${p}DOC_ABONO = CASE
        WHEN ${rest} <= ${limite} THEN ISNULL(${totalExpr}, 0)
        ELSE ROUND(ISNULL(${abonoExpr}, 0), 2)
      END,
      ${p}DOC_SALDO = CASE
        WHEN ${rest} <= ${limite} THEN 0
        ELSE ${rest}
      END`;
}

module.exports = {
  TOLERANCIA_ABONO_RETENCION,
  roundCentavos,
  abonoSuperaSaldo,
  saldoEfectivo,
  aplicarSaldoCentavos,
  aplicarAbonoSobreSaldo,
  sqlSetDocSaldoFromAbonos,
};
