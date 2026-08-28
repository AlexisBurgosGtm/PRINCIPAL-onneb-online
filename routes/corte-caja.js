const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const { nowParts, fechaIsoFromRow, normalizeDocumentoRows } = require('../lib/documento-fecha');
const {
  sessionCorteDocsSql,
  sessionCorteDocsListSql,
  sessionCorteAnuladasSumSql,
  SQL_TIPODOC_CORTE_IN,
  SQL_EXCLUIR_FACTURAS_TIPOM_NEUTRO,
  SQL_EXCLUIR_COMPRAS_Y_DVP_CORTE,
  SQL_TIPODOC_FACTURA_IN,
  SQL_TIPODOC_PRC_IN,
  TIPODOC_FACTURA,
  TIPODOC_DEVOLUCION,
  TIPODOC_EXCLUIDOS_CORTE_CAJA,
} = require('../lib/corte-caja-docs');
const {
  sumValesCajaSesion,
  marcarValesCajaCorte,
  listValesCajaSesion,
} = require('../lib/vales-caja');
const {
  crearMovimientoBanco,
  sumRetirosEfectivoSesionCaja,
  listRetirosEfectivoSesionCaja,
  marcarRetirosEfectivoCorte,
} = require('../lib/movimientos-banco');
const {
  resolveEmpleadoCoddocPreferido,
  pickCajaDefault,
  OPCION_SERIES,
} = require('../lib/empleado-coddoc-preferido');

const router = express.Router();

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

function parseCodcaja(raw) {
  const n = parseInt(raw, 10);
  return Number.isNaN(n) || n < 1 ? null : n;
}

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

async function loadAnuladasSesion(pool, empnit, codcaja, apertura) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCAJA', sql.Int, codcaja)
    .input('APERTURA', sql.DateTime, apertura)
    .query(sessionCorteAnuladasSumSql());
  const row = result.recordset?.[0] || {};
  return {
    cantidadAnuladas: Number(row.cantidadAnuladas) || 0,
    totalAnuladas: roundMoney(row.totalAnuladas),
  };
}

function parseAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return roundMoney(n);
}

async function loadCaja(pool, empnit, codcaja) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCAJA', sql.Int, codcaja)
    .query(`
      SELECT CODCAJA, DESCAJA, ISNULL(STATUS, 0) AS STATUS,
             ISNULL(EFECTIVOINICIAL, 0) AS EFECTIVOINICIAL,
             ISNULL(EFECTIVOLIMITE, 0) AS EFECTIVOLIMITE,
             ISNULL(EFECTIVO_PROXIMA_CAJA, 0) AS EFECTIVO_PROXIMA_CAJA,
             LASTUPDATE
      FROM dbo.Cajas
      WHERE EMPNIT = @EMPNIT AND CODCAJA = @CODCAJA
    `);
  return result.recordset[0] || null;
}

/** Documentos pendientes de corte en la sesión actual. */
function sessionDocsSql() {
  return sessionCorteDocsSql();
}

/**
 * Marca documentos de la sesión con CORTE='SI' y NOCORTE=correlativo del corte.
 * Debe ejecutarse ANTES de insertar el registro en CORTES: el filtro por IDFINAL
 * usa el último corte de la caja; si ya existiera el nuevo, IDFINAL excluiría
 * justo los documentos de esta sesión.
 * Incluye operados (STATUS='O') y facturas anuladas de la sesión (STATUS='A').
 */
async function marcarDocumentosCorte(transaction, empnit, codcaja, nocorte, apertura) {
  const sessionIdFilter = `
        AND d.ID > ISNULL((
          SELECT TOP 1 CASE WHEN c.IDFINAL > 0 THEN c.IDFINAL ELSE 0 END
          FROM dbo.CORTES c
          WHERE c.EMPNIT = @EMPNIT AND c.CODCAJA = @CODCAJA
          ORDER BY c.ID DESC
        ), 0)
        AND d.FECHA >= CAST(@APERTURA AS DATE)`;

  const resultOperados = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCAJA', sql.Int, codcaja)
    .input('NOCORTE', sql.Int, nocorte)
    .input('APERTURA', sql.DateTime, apertura)
    .query(`
      UPDATE d
      SET d.CORTE = 'SI', d.NOCORTE = @NOCORTE, d.CODCAJA = @CODCAJA
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      WHERE d.EMPNIT = @EMPNIT
        AND (
          d.CODCAJA = @CODCAJA
          OR (
            t.TIPODOC IN (${SQL_TIPODOC_PRC_IN})
            AND ISNULL(TRY_CONVERT(INT, d.CODCAJA), 0) = 0
            AND UPPER(LTRIM(RTRIM(ISNULL(d.CODEMBARQUE, '')))) = 'CXC'
          )
        )
        AND d.STATUS = 'O'
        AND ISNULL(d.CORTE, 'NO') = 'NO'
        AND t.TIPODOC IN (${SQL_TIPODOC_CORTE_IN})
        ${SQL_EXCLUIR_COMPRAS_Y_DVP_CORTE}
        ${SQL_EXCLUIR_FACTURAS_TIPOM_NEUTRO}
        ${sessionIdFilter}
    `);

  const resultAnuladas = await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCAJA', sql.Int, codcaja)
    .input('NOCORTE', sql.Int, nocorte)
    .input('APERTURA', sql.DateTime, apertura)
    .query(`
      UPDATE d
      SET d.CORTE = 'SI', d.NOCORTE = @NOCORTE
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      WHERE d.EMPNIT = @EMPNIT
        AND d.CODCAJA = @CODCAJA
        AND d.STATUS = 'A'
        AND ISNULL(d.CORTE, 'NO') = 'NO'
        AND t.TIPODOC IN (${SQL_TIPODOC_FACTURA_IN})
        AND ISNULL(t.TIPOM, 0) <> 0
        ${SQL_EXCLUIR_COMPRAS_Y_DVP_CORTE}
        ${sessionIdFilter}
    `);

  /* Libera COM/COP/DVP marcados por error en cortes previos (no cuentan en efectivo).
   * Compras finalizadas conservan CORTE='SI' cuando NOCORTE está vacío. */
  await transaction
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      UPDATE d
      SET
        d.NOCORTE = NULL,
        d.CORTE = CASE
          WHEN t.TIPODOC = 'DVP' THEN 'NO'
          ELSE d.CORTE
        END
      FROM dbo.DOCUMENTOS d
      INNER JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
      WHERE d.EMPNIT = @EMPNIT
        AND t.TIPODOC IN (${TIPODOC_EXCLUIDOS_CORTE_CAJA.map((t) => `'${t}'`).join(', ')})
        AND ISNULL(d.NOCORTE, 0) > 0
    `);

  return (resultOperados.rowsAffected[0] || 0) + (resultAnuladas.rowsAffected[0] || 0);
}

function docTipodoc(row) {
  return String(row?.TIPODOC || '').trim().toUpperCase();
}

function isDevolucionDoc(row) {
  return TIPODOC_DEVOLUCION.includes(docTipodoc(row));
}

function isFacturaDoc(row) {
  return TIPODOC_FACTURA.includes(docTipodoc(row));
}

function isReciboDoc(row) {
  return ['RCC', 'PRC'].includes(docTipodoc(row));
}

function buildResumenFromRows(
  rows,
  efectivoInicial,
  totalRetiros = 0,
  totalValesCaja = 0
) {
  const excluidos = new Set(TIPODOC_EXCLUIDOS_CORTE_CAJA);
  const docs = (rows || []).filter((d) => !excluidos.has(docTipodoc(d)));
  const first = docs[0] || null;
  const last = docs[docs.length - 1] || null;
  let totalCosto = 0;
  let totalVenta = 0;
  let totalVentasBrutas = 0;
  let totalDevoluciones = 0;
  let movDevoluciones = 0;
  let totalCredito = 0;
  let totalRecibos = 0;
  let fpEfectivo = 0;
  let fpTarjeta = 0;
  let fpDeposito = 0;
  let fpCheque = 0;

  for (const d of docs) {
    const costo = Number(d.TOTALCOSTO) || 0;
    const precio = Number(d.TOTALPRECIO) || 0;
    const efectivo = Number(d.FPAGO_EFECTIVO) || 0;
    const tarjeta = Number(d.FPAGO_TARJETA) || 0;
    const deposito = Number(d.FPAGO_DEPOSITO) || 0;
    const cheque = Number(d.FPAGO_CHEQUE) || 0;

    // Recibos RCC/PRC: suman a caja por forma de pago; no inflan ventas/costos/crédito.
    if (isReciboDoc(d)) {
      totalRecibos += precio;
      let efe = efectivo;
      let tar = tarjeta;
      let dep = deposito;
      let che = cheque;
      const sumaFp = roundMoney(efe + tar + dep + che);
      // Si no cargaron formas de pago, el monto del recibo entra a efectivo.
      if (sumaFp === 0 && precio !== 0) {
        efe = precio;
      }
      fpEfectivo += efe;
      fpTarjeta += tar;
      fpDeposito += dep;
      fpCheque += che;
      continue;
    }

    const dev = isDevolucionDoc(d);
    const sign = dev ? -1 : 1;

    if (dev) {
      totalDevoluciones += precio;
      movDevoluciones += 1;
    } else if (isFacturaDoc(d)) {
      totalVentasBrutas += precio;
    }

    totalCosto += sign * costo;
    totalVenta += sign * precio;

    if (!dev && String(d.CONCRE || '').trim().toUpperCase() === 'CRE') {
      totalCredito += precio;
    }

    fpEfectivo += sign * efectivo;
    fpTarjeta += sign * tarjeta;
    fpDeposito += sign * deposito;
    fpCheque += sign * cheque;
  }

  totalCosto = roundMoney(totalCosto);
  totalVenta = roundMoney(totalVenta);
  totalVentasBrutas = roundMoney(totalVentasBrutas);
  totalDevoluciones = roundMoney(totalDevoluciones);
  totalCredito = roundMoney(totalCredito);
  totalRecibos = roundMoney(totalRecibos);
  fpEfectivo = roundMoney(fpEfectivo);
  fpTarjeta = roundMoney(fpTarjeta);
  fpDeposito = roundMoney(fpDeposito);
  fpCheque = roundMoney(fpCheque);
  const totalUtilidad = roundMoney(totalVenta - totalCosto);
  const margen = totalVenta > 0 ? roundMoney((totalUtilidad / totalVenta) * 100) : 0;
  const retiros = roundMoney(totalRetiros);
  const valesCaja = roundMoney(totalValesCaja);
  // Gastos: retiros a banco y vales de caja (salidas de efectivo).
  const totalGastos = roundMoney(retiros + valesCaja);
  const efectivoEsperado = roundMoney(
    (Number(efectivoInicial) || 0) + fpEfectivo - retiros - valesCaja
  );

  return {
    totalMovimientos: docs.length,
    totalCosto,
    totalVenta,
    totalVentasBrutas,
    totalDevoluciones,
    movDevoluciones,
    totalUtilidad,
    margen,
    totalCredito,
    totalRecibos,
    fpEfectivo,
    fpTarjeta,
    fpDeposito,
    fpCheque,
    totalGastos,
    totalRetiros: retiros,
    totalValesCaja: valesCaja,
    efectivoInicial: roundMoney(efectivoInicial),
    efectivoEsperado,
    docInicial: first
      ? {
          ID: first.ID,
          CODDOC: first.CODDOC,
          CORRELATIVO: first.CORRELATIVO,
          HORA: first.HORA,
          MINUTO: first.MINUTO,
        }
      : null,
    docFinal: last
      ? {
          ID: last.ID,
          CODDOC: last.CODDOC,
          CORRELATIVO: last.CORRELATIVO,
          HORA: last.HORA,
          MINUTO: last.MINUTO,
        }
      : null,
  };
}

function parseMesAnio(req) {
  const now = new Date();
  const mes = parseInt(req.query.mes, 10);
  const anio = parseInt(req.query.anio, 10);
  return {
    mes: Number.isFinite(mes) && mes >= 1 && mes <= 12 ? mes : now.getMonth() + 1,
    anio: Number.isFinite(anio) && anio >= 2000 && anio <= 2100 ? anio : now.getFullYear(),
  };
}

function mapCorteListRow(r) {
  if (!r) return null;
  return {
    ID: r.ID,
    CORRELATIVO: r.CORRELATIVO,
    FECHA: fechaIsoFromRow({ FECHA: r.FECHA }) || null,
    ANIO: r.ANIO,
    MES: r.MES,
    DIA: r.DIA,
    HORA: r.HORA,
    MINUTO: r.MINUTO,
    CODCAJA: r.CODCAJA,
    DESCAJA: r.DESCAJA || '',
    TOTALMOVIMIENTOS: Number(r.TOTALMOVIMIENTOS) || 0,
    TOTALVENTA: roundMoney(r.TOTALVENTA),
    TOTALREPORTADO: roundMoney(r.TOTALREPORTADO),
    FALTANTE: roundMoney(r.FALTANTE),
    SOBRANTE: roundMoney(r.SOBRANTE),
    USUARIO: r.USUARIO || '',
    OBS: r.OBS || '',
  };
}

function mapCortePrintPayload(r) {
  if (!r) return null;
  const faltante = roundMoney(r.FALTANTE);
  const sobrante = roundMoney(r.SOBRANTE);
  const totalReportado = roundMoney(r.TOTALREPORTADO);
  const totalDevoluciones = roundMoney(r.TOTALDEVOLUCIONES);
  const totalVenta = roundMoney(r.TOTALVENTA);
  const fpEfectivo = roundMoney(r.FPAGO_EFECTIVO);
  const fpTarjeta = roundMoney(r.FPAGO_TARJETA ?? r.TOTALTARJETA);
  const fpDeposito = roundMoney(r.FPAGO_DEPOSITO);
  const fpCheque = roundMoney(r.FPAGO_CHEQUE ?? r.TOTALCHEQUES);
  const totalGastos = roundMoney(r.TOTALGASTOS);
  // CORTES no guarda retiros/vales-caja por separado; TOTALGASTOS = retiros + vales de caja.
  const efectivoEsperado = roundMoney(totalReportado - sobrante + faltante);
  return {
    corte: {
      ID: r.ID,
      CORRELATIVO: r.CORRELATIVO,
      FECHA: fechaIsoFromRow({ FECHA: r.FECHA }) || null,
      HORA: r.HORA,
      MINUTO: r.MINUTO,
    },
    caja: {
      CODCAJA: r.CODCAJA,
      DESCAJA: r.DESCAJA || `Caja ${r.CODCAJA}`,
    },
    resumen: {
      totalMovimientos: Number(r.TOTALMOVIMIENTOS) || 0,
      totalVentasBrutas: roundMoney(totalVenta + totalDevoluciones),
      totalDevoluciones,
      totalVenta,
      totalCredito: roundMoney(r.TOTALVENTASCREDITO),
      totalRecibos: roundMoney(r.TOTALRECIBOS),
      efectivoInicial: 0,
      fpEfectivo,
      fpTarjeta,
      fpDeposito,
      fpCheque,
      totalValesCaja: 0,
      totalRetiros: totalGastos > 0 ? totalGastos : 0,
      efectivoEsperado,
    },
    reportado: {
      efectivo: totalReportado,
      tarjeta: roundMoney(r.REPORTADOTARJETA),
      cheques: roundMoney(r.REPORTADOCHEQUES),
      deposito: roundMoney(r.REPORTADO_DEPOSITO),
    },
    faltante,
    sobrante,
    obs: r.OBS || '',
    usuarioNombre: r.USUARIO || 'SN',
  };
}

function mapCorteDocRow(r) {
  const status = String(r.STATUS || '').trim().toUpperCase();
  const total = roundMoney(r.TOTALPRECIO);
  const anulado = status === 'A';
  return {
    ID: r.ID,
    FECHA: fechaIsoFromRow(r) || null,
    CODDOC: r.CODDOC,
    CORRELATIVO: r.CORRELATIVO,
    CLIENTE: r.DOC_NOMCLIE || '',
    TOTALPRECIO: total,
    IMPORTE: anulado ? 0 : total,
    STATUS: status || '—',
    TIPODOC: String(r.TIPODOC || '').trim().toUpperCase(),
    DESDOC: r.DESDOC || '',
  };
}

router.get('/cajas', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
      SELECT CODCAJA, DESCAJA, ISNULL(STATUS, 0) AS STATUS,
             ISNULL(EFECTIVOINICIAL, 0) AS EFECTIVOINICIAL,
             ISNULL(EFECTIVO_PROXIMA_CAJA, 0) AS EFECTIVO_PROXIMA_CAJA,
             LASTUPDATE
      FROM dbo.Cajas
      WHERE EMPNIT = @EMPNIT
      ORDER BY DESCAJA ASC
    `);
    const preferred = await resolveEmpleadoCoddocPreferido(
      pool,
      sql,
      empnit,
      req.query.codempleado,
      OPCION_SERIES.CAJAS
    );
    res.json({
      rows: result.recordset,
      cajaDefault: pickCajaDefault(result.recordset, preferred),
      preferredCaja: preferred,
    });
  } catch (err) {
    console.warn('[API GET /corte-caja/cajas]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/cortes', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const { mes, anio } = parseMesAnio(req);
  const codcaja = req.query.codcaja != null && String(req.query.codcaja).trim() !== ''
    ? parseCodcaja(req.query.codcaja)
    : null;
  try {
    const pool = await req.app.locals.getDbPool();
    const request = pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('MES', sql.Int, mes)
      .input('ANIO', sql.Int, anio);
    let cajaFilter = '';
    if (codcaja) {
      request.input('CODCAJA', sql.Int, codcaja);
      cajaFilter = ' AND c.CODCAJA = @CODCAJA';
    }
    const result = await request.query(`
      SELECT
        c.ID, c.CORRELATIVO, c.FECHA, c.ANIO, c.MES, c.DIA, c.HORA, c.MINUTO,
        c.CODCAJA, c.TOTALMOVIMIENTOS, c.TOTALVENTA, c.TOTALREPORTADO,
        c.FALTANTE, c.SOBRANTE, c.USUARIO, c.OBS,
        ISNULL(cj.DESCAJA, '') AS DESCAJA
      FROM dbo.CORTES c
      LEFT JOIN dbo.Cajas cj ON cj.EMPNIT = c.EMPNIT AND cj.CODCAJA = c.CODCAJA
      WHERE c.EMPNIT = @EMPNIT
        AND (
          (ISNULL(c.MES, 0) = @MES AND ISNULL(c.ANIO, 0) = @ANIO)
          OR (
            ISNULL(c.MES, 0) = 0
            AND MONTH(c.FECHA) = @MES
            AND YEAR(c.FECHA) = @ANIO
          )
        )
        ${cajaFilter}
      ORDER BY c.FECHA DESC, c.HORA DESC, c.MINUTO DESC, c.ID DESC
    `);
    res.json({
      mes,
      anio,
      rows: (result.recordset || []).map(mapCorteListRow),
    });
  } catch (err) {
    console.warn('[API GET /corte-caja/cortes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Detalle para historial: documentos por NOCORTE agrupados + payload de reimpresión. */
router.get('/cortes/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de corte inválido' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const corteRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ID', sql.Int, id)
      .query(`
        SELECT
          c.ID, c.CORRELATIVO, c.FECHA, c.ANIO, c.MES, c.DIA, c.HORA, c.MINUTO,
          c.CODCAJA, c.TOTALMOVIMIENTOS, c.TOTALVENTA, c.TOTALREPORTADO,
          c.FALTANTE, c.SOBRANTE, c.USUARIO, c.OBS,
          c.TOTALGASTOS, c.TOTALRECIBOS, c.TOTALDEVOLUCIONES, c.TOTALVENTASCREDITO,
          c.FPAGO_EFECTIVO, c.FPAGO_TARJETA, c.FPAGO_DEPOSITO, c.FPAGO_CHEQUE,
          c.REPORTADOTARJETA, c.REPORTADOCHEQUES, c.REPORTADO_DEPOSITO,
          c.TOTALTARJETA, c.TOTALCHEQUES,
          ISNULL(cj.DESCAJA, '') AS DESCAJA
        FROM dbo.CORTES c
        LEFT JOIN dbo.Cajas cj ON cj.EMPNIT = c.EMPNIT AND cj.CODCAJA = c.CODCAJA
        WHERE c.EMPNIT = @EMPNIT AND c.ID = @ID
      `);

    const corteRow = corteRes.recordset[0];
    if (!corteRow) return res.status(404).json({ error: 'Corte no encontrado' });

    const print = mapCortePrintPayload(corteRow);
    const nocorte = Number(corteRow.CORRELATIVO);
    const codcaja = Number(corteRow.CODCAJA);

    const docsRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('NOCORTE', sql.Int, nocorte)
      .input('CODCAJA', sql.Int, Number.isFinite(codcaja) ? codcaja : null)
      .query(`
        SELECT
          d.ID, d.FECHA, d.ANIO, d.MES, d.DIA, d.CODDOC, d.CORRELATIVO,
          ISNULL(d.DOC_NOMCLIE, '') AS DOC_NOMCLIE,
          ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
          ISNULL(d.STATUS, '') AS STATUS,
          UPPER(LTRIM(RTRIM(ISNULL(t.TIPODOC, '')))) AS TIPODOC,
          ISNULL(t.DESDOC, '') AS DESDOC
        FROM dbo.DOCUMENTOS d
        LEFT JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        WHERE d.EMPNIT = @EMPNIT
          AND d.NOCORTE = @NOCORTE
          AND (@CODCAJA IS NULL OR d.CODCAJA = @CODCAJA)
          AND (
            t.TIPODOC IS NULL
            OR t.TIPODOC NOT IN (${TIPODOC_EXCLUIDOS_CORTE_CAJA.map((t) => `'${t}'`).join(', ')})
          )
        ORDER BY t.TIPODOC, d.FECHA, d.CODDOC, d.CORRELATIVO
      `);

    const rawDocs = normalizeDocumentoRows(docsRes.recordset || []);
    const byTipo = new Map();
    for (const raw of rawDocs) {
      const row = mapCorteDocRow(raw);
      const key = row.TIPODOC || 'SN';
      if (!byTipo.has(key)) {
        byTipo.set(key, {
          TIPODOC: key,
          DESDOC: row.DESDOC || key,
          rows: [],
          total: 0,
          count: 0,
          anulados: 0,
        });
      }
      const g = byTipo.get(key);
      if (!g.DESDOC && row.DESDOC) g.DESDOC = row.DESDOC;
      g.rows.push(row);
      g.total = roundMoney(g.total + row.IMPORTE);
      g.count += 1;
      if (row.STATUS === 'A') g.anulados += 1;
    }

    const grupos = [...byTipo.values()].sort((a, b) =>
      String(a.TIPODOC).localeCompare(String(b.TIPODOC), 'es')
    );

    res.json({
      corte: mapCorteListRow(corteRow),
      print,
      grupos,
      totalGeneral: roundMoney(grupos.reduce((s, g) => s + g.total, 0)),
      totalDocs: grupos.reduce((s, g) => s + g.count, 0),
    });
  } catch (err) {
    console.warn('[API GET /corte-caja/cortes/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Retiros a banco (DOCUMENTOS_BANCO) marcados en el corte. */
router.get('/cortes/:id/retiros', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de corte inválido' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const corteRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ID', sql.Int, id)
      .query(`
        SELECT c.ID, c.CORRELATIVO, c.CODCAJA, c.FECHA, c.HORA, c.MINUTO,
               ISNULL(cj.DESCAJA, '') AS DESCAJA
        FROM dbo.CORTES c
        LEFT JOIN dbo.Cajas cj ON cj.EMPNIT = c.EMPNIT AND cj.CODCAJA = c.CODCAJA
        WHERE c.EMPNIT = @EMPNIT AND c.ID = @ID
      `);
    const corte = corteRes.recordset[0];
    if (!corte) return res.status(404).json({ error: 'Corte no encontrado' });

    const nocorte = Number(corte.CORRELATIVO);
    const retirosRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('NOCORTE', sql.Int, nocorte)
      .query(`
        SELECT
          b.ID, b.FECHA, b.CODDOC, b.CORRELATIVO, b.CODCUENTA,
          ISNULL(b.NODOCUMENTO, '') AS NODOCUMENTO,
          ISNULL(b.DESCRIPCION, '') AS DESCRIPCION,
          ISNULL(b.IMPORTE, 0) AS IMPORTE,
          ISNULL(c.NOCUENTA, '') AS NOCUENTA,
          ISNULL(bn.DESBANCO, '') AS DESBANCO
        FROM dbo.DOCUMENTOS_BANCO b
        LEFT JOIN dbo.CUENTAS c ON c.EMPNIT = b.EMPNIT AND c.CODCUENTA = b.CODCUENTA
        LEFT JOIN dbo.BANCOS bn ON bn.CODBANCO = c.CODBANCO
        WHERE b.EMPNIT = @EMPNIT
          AND ISNULL(b.NOCORTE, 0) = @NOCORTE
          AND b.TIPO = 'E'
          AND UPPER(LTRIM(RTRIM(ISNULL(b.CATEGORIA, '')))) = 'DEPOSITO'
        ORDER BY b.FECHA, b.ID
      `);

    const rows = (retirosRes.recordset || []).map((r) => ({
      ID: r.ID,
      FECHA: fechaIsoFromRow({ FECHA: r.FECHA }) || null,
      CODDOC: r.CODDOC,
      CORRELATIVO: r.CORRELATIVO,
      CODCUENTA: r.CODCUENTA,
      NODOCUMENTO: String(r.NODOCUMENTO || '').trim(),
      DESCRIPCION: String(r.DESCRIPCION || '').trim(),
      IMPORTE: roundMoney(Math.abs(Number(r.IMPORTE) || 0)),
      NOCUENTA: String(r.NOCUENTA || '').trim(),
      DESBANCO: String(r.DESBANCO || '').trim(),
    }));

    res.json({
      corte: {
        ID: corte.ID,
        CORRELATIVO: corte.CORRELATIVO,
        CODCAJA: corte.CODCAJA,
        DESCAJA: corte.DESCAJA || '',
        FECHA: fechaIsoFromRow({ FECHA: corte.FECHA }) || null,
        HORA: corte.HORA,
        MINUTO: corte.MINUTO,
      },
      rows,
    });
  } catch (err) {
    console.warn('[API GET /corte-caja/cortes/:id/retiros]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Actualiza solo el número de boleta (NODOCUMENTO) de un retiro a banco. */
router.patch('/documentos-banco/:id/boleta', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de movimiento inválido' });
  }
  const nodocumento = String(req.body?.NODOCUMENTO ?? req.body?.nodocumento ?? '').trim();
  if (nodocumento.length > 50) {
    return res.status(400).json({ error: 'Número de boleta demasiado largo (máx. 50)' });
  }

  try {
    const pool = await req.app.locals.getDbPool();
    const check = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ID', sql.Int, id)
      .query(`
        SELECT ID, TIPO, CATEGORIA, NODOCUMENTO
        FROM dbo.DOCUMENTOS_BANCO
        WHERE EMPNIT = @EMPNIT AND ID = @ID
      `);
    const row = check.recordset[0];
    if (!row) return res.status(404).json({ error: 'Movimiento de banco no encontrado' });
    if (String(row.TIPO || '').trim().toUpperCase() !== 'E') {
      return res.status(400).json({ error: 'Solo se puede actualizar boleta en retiros de efectivo' });
    }
    if (String(row.CATEGORIA || '').trim().toUpperCase() !== 'DEPOSITO') {
      return res.status(400).json({ error: 'El movimiento no es un retiro a banco (depósito)' });
    }

    await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ID', sql.Int, id)
      .input('NODOCUMENTO', sql.VarChar, nodocumento || null)
      .query(`
        UPDATE dbo.DOCUMENTOS_BANCO
        SET NODOCUMENTO = @NODOCUMENTO
        WHERE EMPNIT = @EMPNIT AND ID = @ID
      `);

    res.json({ ok: true, ID: id, NODOCUMENTO: nodocumento });
  } catch (err) {
    console.warn('[API PATCH /corte-caja/documentos-banco/:id/boleta]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codcaja/resumen', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codcaja = parseCodcaja(req.params.codcaja);
  if (!codcaja) return res.status(400).json({ error: 'CODCAJA inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const caja = await loadCaja(pool, empnit, codcaja);
    if (!caja) return res.status(404).json({ error: 'Caja no encontrada' });
    if (Number(caja.STATUS) !== 1) {
      return res.status(400).json({ error: 'La caja no está abierta' });
    }
    const apertura = caja.LASTUPDATE || new Date();
    const docs = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODCAJA', sql.Int, codcaja)
      .input('APERTURA', sql.DateTime, apertura)
      .query(sessionDocsSql());
    const retirosInfo = await sumRetirosEfectivoSesionCaja(pool, empnit, codcaja, apertura);
    const valesCajaInfo = await sumValesCajaSesion(pool, empnit, codcaja, apertura);
    const anuladasInfo = await loadAnuladasSesion(pool, empnit, codcaja, apertura);
    const resumen = buildResumenFromRows(
      docs.recordset,
      caja.EFECTIVOINICIAL,
      retirosInfo.totalRetiros,
      valesCajaInfo.totalValesCaja
    );
    resumen.cantidadRetiros = retirosInfo.cantidadRetiros;
    resumen.cantidadValesCaja = valesCajaInfo.cantidadValesCaja;
    resumen.cantidadAnuladas = anuladasInfo.cantidadAnuladas;
    resumen.totalAnuladas = anuladasInfo.totalAnuladas;
    res.json({ caja, resumen });
  } catch (err) {
    console.warn('[API GET /corte-caja/:codcaja/resumen]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codcaja/documentos', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codcaja = parseCodcaja(req.params.codcaja);
  if (!codcaja) return res.status(400).json({ error: 'CODCAJA inválido' });
  const filtro = String(req.query.filtro || '').trim().toLowerCase();
  const listSql = sessionCorteDocsListSql(filtro);
  if (!listSql) return res.status(400).json({ error: 'Filtro inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const caja = await loadCaja(pool, empnit, codcaja);
    if (!caja) return res.status(404).json({ error: 'Caja no encontrada' });
    if (Number(caja.STATUS) !== 1) {
      return res.status(400).json({ error: 'La caja no está abierta' });
    }
    const apertura = caja.LASTUPDATE || new Date();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODCAJA', sql.Int, codcaja)
      .input('APERTURA', sql.DateTime, apertura)
      .query(listSql);
    res.json({ filtro, rows: result.recordset });
  } catch (err) {
    console.warn('[API GET /corte-caja/:codcaja/documentos]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codcaja/vales-caja-detalle', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codcaja = parseCodcaja(req.params.codcaja);
  if (!codcaja) return res.status(400).json({ error: 'CODCAJA inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const caja = await loadCaja(pool, empnit, codcaja);
    if (!caja) return res.status(404).json({ error: 'Caja no encontrada' });
    if (Number(caja.STATUS) !== 1) {
      return res.status(400).json({ error: 'La caja no está abierta' });
    }
    const apertura = caja.LASTUPDATE || new Date();
    const rows = await listValesCajaSesion(pool, empnit, codcaja, apertura);
    res.json({ rows });
  } catch (err) {
    console.warn('[API GET /corte-caja/:codcaja/vales-caja-detalle]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:codcaja/retiros-detalle', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codcaja = parseCodcaja(req.params.codcaja);
  if (!codcaja) return res.status(400).json({ error: 'CODCAJA inválido' });
  try {
    const pool = await req.app.locals.getDbPool();
    const caja = await loadCaja(pool, empnit, codcaja);
    if (!caja) return res.status(404).json({ error: 'Caja no encontrada' });
    if (Number(caja.STATUS) !== 1) {
      return res.status(400).json({ error: 'La caja no está abierta' });
    }
    const apertura = caja.LASTUPDATE || new Date();
    const rows = await listRetirosEfectivoSesionCaja(pool, empnit, codcaja, apertura);
    res.json({ rows });
  } catch (err) {
    console.warn('[API GET /corte-caja/:codcaja/retiros-detalle]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Retiro de efectivo de caja → depósito (entrada) en DOCUMENTOS_BANCO.
 * CATEGORIA=DEPOSITO, DESCRIPCION=RETIRO DE EFECTIVO DE CAJA # {CODCAJA}
 */
router.post('/:codcaja/retiro-efectivo', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codcaja = parseCodcaja(req.params.codcaja);
  if (!codcaja) return res.status(400).json({ error: 'CODCAJA inválido' });

  const importe = parseAmount(req.body?.IMPORTE ?? req.body?.importe);
  if (importe <= 0) return res.status(400).json({ error: 'Ingrese un importe mayor a cero' });
  const codcuenta = parseInt(req.body?.CODCUENTA ?? req.body?.codcuenta, 10);
  if (Number.isNaN(codcuenta) || codcuenta <= 0) {
    return res.status(400).json({ error: 'Seleccione la cuenta bancaria' });
  }
  const nodocumento = String(req.body?.NODOCUMENTO || req.body?.nodocumento || '').trim();
  const usuario = String(req.body?.USUARIO || req.body?.usuario || '').trim() || 'CAJA';

  try {
    const pool = await req.app.locals.getDbPool();
    const caja = await loadCaja(pool, empnit, codcaja);
    if (!caja) return res.status(404).json({ error: 'Caja no encontrada' });
    if (Number(caja.STATUS) !== 1) {
      return res.status(400).json({ error: 'La caja no está abierta' });
    }

    const movimiento = await crearMovimientoBanco(pool, sql, empnit, {
      TIPO: 'E',
      CODCUENTA: codcuenta,
      IMPORTE: importe,
      CATEGORIA: 'DEPOSITO',
      DESCRIPCION: `RETIRO DE EFECTIVO DE CAJA # ${codcaja}`,
      NODOCUMENTO: nodocumento,
      USUARIO: usuario,
      CODCAJA: codcaja,
      CORTE: 'NO',
      autoCoddoc: true,
    });

    const apertura = caja.LASTUPDATE || new Date();
    const docs = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODCAJA', sql.Int, codcaja)
      .input('APERTURA', sql.DateTime, apertura)
      .query(sessionDocsSql());
    const retirosInfo = await sumRetirosEfectivoSesionCaja(pool, empnit, codcaja, apertura);
    const valesCajaInfo = await sumValesCajaSesion(pool, empnit, codcaja, apertura);
    const anuladasInfo = await loadAnuladasSesion(pool, empnit, codcaja, apertura);
    const resumen = buildResumenFromRows(
      docs.recordset,
      caja.EFECTIVOINICIAL,
      retirosInfo.totalRetiros,
      valesCajaInfo.totalValesCaja
    );
    resumen.cantidadRetiros = retirosInfo.cantidadRetiros;
    resumen.cantidadValesCaja = valesCajaInfo.cantidadValesCaja;
    resumen.cantidadAnuladas = anuladasInfo.cantidadAnuladas;
    resumen.totalAnuladas = anuladasInfo.totalAnuladas;

    res.status(201).json({ ok: true, movimiento, caja, resumen });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.warn('[API POST /corte-caja/:codcaja/retiro-efectivo]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:codcaja/abrir', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codcaja = parseCodcaja(req.params.codcaja);
  if (!codcaja) return res.status(400).json({ error: 'CODCAJA inválido' });

  const efectivoInicial = parseAmount(req.body?.EFECTIVOINICIAL ?? req.body?.efectivoinicial);

  try {
    const pool = await req.app.locals.getDbPool();
    const caja = await loadCaja(pool, empnit, codcaja);
    if (!caja) return res.status(404).json({ error: 'Caja no encontrada' });
    if (Number(caja.STATUS) === 1) {
      return res.status(400).json({ error: 'La caja ya está abierta' });
    }

    await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODCAJA', sql.Int, codcaja)
      .input('EFECTIVOINICIAL', sql.Decimal(18, 3), efectivoInicial)
      .query(`
        UPDATE dbo.Cajas
        SET STATUS = 1,
            EFECTIVOINICIAL = @EFECTIVOINICIAL,
            LASTUPDATE = GETDATE()
        WHERE EMPNIT = @EMPNIT AND CODCAJA = @CODCAJA
      `);

    const updated = await loadCaja(pool, empnit, codcaja);
    res.json({ ok: true, caja: updated });
  } catch (err) {
    console.warn('[API POST /corte-caja/:codcaja/abrir]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:codcaja/cerrar', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const codcaja = parseCodcaja(req.params.codcaja);
  if (!codcaja) return res.status(400).json({ error: 'CODCAJA inválido' });

  const totalReportado = parseAmount(req.body?.TOTALREPORTADO);
  const reportadoTarjeta = parseAmount(req.body?.REPORTADOTARJETA);
  const reportadoCheques = parseAmount(req.body?.REPORTADOCHEQUES);
  const reportadoDeposito = parseAmount(req.body?.REPORTADO_DEPOSITO);
  const obs = String(req.body?.OBS || '').trim() || 'S/N';
  const usuario = String(req.body?.USUARIO || '').trim() || 'SN';

  const transaction = new sql.Transaction(await req.app.locals.getDbPool());
  try {
    await transaction.begin();
    const cajaReq = transaction.request();
    const cajaResult = await cajaReq
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODCAJA', sql.Int, codcaja)
      .query(`
        SELECT CODCAJA, DESCAJA, ISNULL(STATUS, 0) AS STATUS,
               ISNULL(EFECTIVOINICIAL, 0) AS EFECTIVOINICIAL, LASTUPDATE
        FROM dbo.Cajas WITH (UPDLOCK, ROWLOCK)
        WHERE EMPNIT = @EMPNIT AND CODCAJA = @CODCAJA
      `);
    const caja = cajaResult.recordset[0];
    if (!caja) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Caja no encontrada' });
    }
    if (Number(caja.STATUS) !== 1) {
      await transaction.rollback();
      return res.status(400).json({ error: 'La caja no está abierta' });
    }

    const apertura = caja.LASTUPDATE || new Date();
    const docsResult = await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODCAJA', sql.Int, codcaja)
      .input('APERTURA', sql.DateTime, apertura)
      .query(sessionDocsSql());
    const retirosInfo = await sumRetirosEfectivoSesionCaja(transaction, empnit, codcaja, apertura);
    const valesCajaInfo = await sumValesCajaSesion(transaction, empnit, codcaja, apertura);
    const anuladasInfo = await loadAnuladasSesion(transaction, empnit, codcaja, apertura);
    const resumen = buildResumenFromRows(
      docsResult.recordset,
      caja.EFECTIVOINICIAL,
      retirosInfo.totalRetiros,
      valesCajaInfo.totalValesCaja
    );
    resumen.cantidadRetiros = retirosInfo.cantidadRetiros;
    resumen.cantidadValesCaja = valesCajaInfo.cantidadValesCaja;
    resumen.cantidadAnuladas = anuladasInfo.cantidadAnuladas;
    resumen.totalAnuladas = anuladasInfo.totalAnuladas;

    const diff = roundMoney(totalReportado - resumen.efectivoEsperado);
    const faltante = diff < 0 ? roundMoney(Math.abs(diff)) : 0;
    const sobrante = diff > 0 ? diff : 0;

    const parts = nowParts();
    const corrResult = await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .query('SELECT ISNULL(MAX(CORRELATIVO), 0) + 1 AS nextCorr FROM dbo.CORTES WHERE EMPNIT = @EMPNIT');
    const correlativo = corrResult.recordset[0].nextCorr;

    const ini = resumen.docInicial;
    const fin = resumen.docFinal;

    // Marcar antes del INSERT en CORTES (ver marcarDocumentosCorte).
    const docsMarcados = await marcarDocumentosCorte(transaction, empnit, codcaja, correlativo, apertura);
    const valesCajaMarcados = await marcarValesCajaCorte(
      transaction,
      empnit,
      codcaja,
      correlativo,
      apertura
    );
    const retirosMarcados = await marcarRetirosEfectivoCorte(
      transaction,
      empnit,
      codcaja,
      correlativo,
      apertura
    );

    const insertResult = await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ANIO', sql.Int, parts.anio)
      .input('MES', sql.Int, parts.mes)
      .input('DIA', sql.Int, parts.dia)
      .input('FECHA', sql.Date, parts.fecha)
      .input('HORA', sql.Int, parts.hora)
      .input('MINUTO', sql.Int, parts.minuto)
      .input('CORRELATIVO', sql.Int, correlativo)
      .input('IDINICIAL', sql.Int, ini?.ID ?? 0)
      .input('CODDOCINICIAL', sql.VarChar, ini?.CODDOC ?? 'SN')
      .input('CORRELATIVOINICIAL', sql.Decimal(18, 0), ini?.CORRELATIVO ?? 0)
      .input('HORAINICIAL', sql.Int, ini?.HORA ?? 0)
      .input('MINUTOINICIAL', sql.Int, ini?.MINUTO ?? 0)
      .input('IDFINAL', sql.Int, fin?.ID ?? 0)
      .input('CODDOCFINAL', sql.VarChar, fin?.CODDOC ?? 'SN')
      .input('CORRELATIVOFINAL', sql.Decimal(18, 0), fin?.CORRELATIVO ?? 0)
      .input('HORAFINAL', sql.Int, fin?.HORA ?? 0)
      .input('MINUTOFINAL', sql.Int, fin?.MINUTO ?? 0)
      .input('TOTALMOVIMIENTOS', sql.Int, resumen.totalMovimientos)
      .input('TOTALCOSTO', sql.Decimal(18, 3), resumen.totalCosto)
      .input('TOTALVENTA', sql.Decimal(18, 3), resumen.totalVenta)
      .input('TOTALUTILIDAD', sql.Decimal(18, 3), resumen.totalUtilidad)
      .input('MARGEN', sql.Decimal(18, 3), resumen.margen)
      .input('USUARIO', sql.VarChar, usuario)
      .input('TOTALREPORTADO', sql.Decimal(18, 3), totalReportado)
      .input('FALTANTE', sql.Decimal(18, 3), faltante)
      .input('SOBRANTE', sql.Decimal(18, 3), sobrante)
      .input('OBS', sql.VarChar, obs)
      .input('TOTALGASTOS', sql.Decimal(18, 3), resumen.totalGastos)
      .input('TOTALRECIBOS', sql.Decimal(18, 3), resumen.totalRecibos || 0)
      .input('CODCAJA', sql.Int, codcaja)
      .input('TOTALTARJETA', sql.Decimal(18, 3), resumen.fpTarjeta)
      .input('REPORTADOTARJETA', sql.Decimal(18, 3), reportadoTarjeta)
      .input('TOTALCHEQUES', sql.Decimal(18, 3), resumen.fpCheque)
      .input('REPORTADOCHEQUES', sql.Decimal(18, 3), reportadoCheques)
      .input('ENVIADO', sql.Int, 1)
      .input('TOTALDEVOLUCIONES', sql.Decimal(18, 3), resumen.totalDevoluciones)
      .input('TOTALVENTASCREDITO', sql.Decimal(18, 3), resumen.totalCredito)
      .input('FPAGO_EFECTIVO', sql.Decimal(18, 3), resumen.fpEfectivo)
      .input('FPAGO_TARJETA', sql.Decimal(18, 3), resumen.fpTarjeta)
      .input('FPAGO_DEPOSITO', sql.Decimal(18, 3), resumen.fpDeposito)
      .input('FPAGO_CHEQUE', sql.Decimal(18, 3), resumen.fpCheque)
      .input('REPORTADO_DEPOSITO', sql.Decimal(18, 3), reportadoDeposito)
      .query(`
        INSERT INTO dbo.CORTES (
          EMPNIT, ANIO, MES, DIA, FECHA, HORA, MINUTO, CORRELATIVO,
          IDINICIAL, CODDOCINICIAL, CORRELATIVOINICIAL, HORAINICIAL, MINUTOINICIAL,
          IDFINAL, CODDOCFINAL, CORRELATIVOFINAL, HORAFINAL, MINUTOFINAL,
          TOTALMOVIMIENTOS, TOTALCOSTO, TOTALVENTA, TOTALUTILIDAD, MARGEN,
          USUARIO, TOTALREPORTADO, FALTANTE, SOBRANTE, OBS,
          TOTALGASTOS, TOTALRECIBOS, CODCAJA,
          TOTALTARJETA, REPORTADOTARJETA, TOTALCHEQUES, REPORTADOCHEQUES,
          ENVIADO, TOTALDEVOLUCIONES, TOTALVENTASCREDITO,
          FPAGO_EFECTIVO, FPAGO_TARJETA, FPAGO_DEPOSITO, FPAGO_CHEQUE, REPORTADO_DEPOSITO
        )
        OUTPUT INSERTED.ID
        VALUES (
          @EMPNIT, @ANIO, @MES, @DIA, @FECHA, @HORA, @MINUTO, @CORRELATIVO,
          @IDINICIAL, @CODDOCINICIAL, @CORRELATIVOINICIAL, @HORAINICIAL, @MINUTOINICIAL,
          @IDFINAL, @CODDOCFINAL, @CORRELATIVOFINAL, @HORAFINAL, @MINUTOFINAL,
          @TOTALMOVIMIENTOS, @TOTALCOSTO, @TOTALVENTA, @TOTALUTILIDAD, @MARGEN,
          @USUARIO, @TOTALREPORTADO, @FALTANTE, @SOBRANTE, @OBS,
          @TOTALGASTOS, @TOTALRECIBOS, @CODCAJA,
          @TOTALTARJETA, @REPORTADOTARJETA, @TOTALCHEQUES, @REPORTADOCHEQUES,
          @ENVIADO, @TOTALDEVOLUCIONES, @TOTALVENTASCREDITO,
          @FPAGO_EFECTIVO, @FPAGO_TARJETA, @FPAGO_DEPOSITO, @FPAGO_CHEQUE, @REPORTADO_DEPOSITO
        )
      `);

    const newId = insertResult.recordset[0]?.ID;

    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODCAJA', sql.Int, codcaja)
      .input('EFECTIVO_PROXIMA_CAJA', sql.Decimal(18, 3), totalReportado)
      .query(`
        UPDATE dbo.Cajas
        SET STATUS = 0,
            LASTUPDATE = GETDATE(),
            EFECTIVO_PROXIMA_CAJA = @EFECTIVO_PROXIMA_CAJA
        WHERE EMPNIT = @EMPNIT AND CODCAJA = @CODCAJA
      `);

    await transaction.commit();
    res.json({
      ok: true,
      corte: { ID: newId, CORRELATIVO: correlativo },
      documentosMarcados: docsMarcados,
      valesCajaMarcados,
      retirosMarcados,
      resumen,
      faltante,
      sobrante,
    });
  } catch (err) {
    try {
      await transaction.rollback();
    } catch (_) {
      /* ya revertido */
    }
    console.warn('[API POST /corte-caja/:codcaja/cerrar]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
