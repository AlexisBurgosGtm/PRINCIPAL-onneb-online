const express = require('express');
const sql = require('mssql');
const { isDbConfigured } = require('../config/database');
const { fechaIsoFromRow, normalizeDocumentoRows } = require('../lib/documento-fecha');
const {
  SQL_TIPODOC_FACTURA_IN,
  SQL_TIPODOC_DEVOLUCION_IN,
} = require('../lib/corte-caja-docs');

const router = express.Router();

const TIPODOC_RETIRO = 'RETIRO';
const TIPODOC_VALES_CAJA = 'VALES_CAJA';
const SELECTOR_PRODUCTOS = '__PRODUCTOS__';

function getEmpNitFromReq(req) {
  return String(req.query.empnit || req.body?.empnit || req.headers['x-emp-nit'] || '').trim();
}

function requireEmpNit(req, res) {
  const empnit = getEmpNitFromReq(req);
  if (!empnit) {
    res.status(400).json({ error: 'EMPNIT requerido (empresa de la sesión)' });
    return null;
  }
  return empnit;
}

function parseMesAnio(req) {
  const now = new Date();
  const mes = parseInt(req.query.mes ?? req.body?.mes, 10);
  const anio = parseInt(req.query.anio ?? req.body?.anio, 10);
  return {
    mes: Number.isFinite(mes) && mes >= 1 && mes <= 12 ? mes : now.getMonth() + 1,
    anio: Number.isFinite(anio) && anio >= 2000 && anio <= 2100 ? anio : now.getFullYear(),
  };
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

function mapCorteRow(r) {
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
    IDINICIAL: r.IDINICIAL,
    IDFINAL: r.IDFINAL,
  };
}

function mapDocRow(r) {
  const status = String(r.STATUS || '').trim().toUpperCase();
  const total = roundMoney(r.TOTALPRECIO);
  const anulado = status === 'A';
  const concreRaw = String(r.CONCRE || 'CON').trim().toUpperCase();
  const concre = concreRaw === 'CRE' ? 'CRE' : 'CON';
  const fpEfectivo = anulado ? 0 : roundMoney(r.FPAGO_EFECTIVO);
  const fpTarjeta = anulado ? 0 : roundMoney(r.FPAGO_TARJETA);
  const fpDeposito = anulado ? 0 : roundMoney(r.FPAGO_DEPOSITO);
  const fpCheque = anulado ? 0 : roundMoney(r.FPAGO_CHEQUE);
  return {
    ID: r.ID,
    FECHA: fechaIsoFromRow(r) || null,
    CODDOC: r.CODDOC,
    CORRELATIVO: r.CORRELATIVO,
    CLIENTE: r.DOC_NOMCLIE || '',
    TOTALPRECIO: total,
    IMPORTE: anulado ? 0 : total,
    STATUS: status || '—',
    CONCRE: concre,
    CONCRE_LABEL: concre === 'CRE' ? 'Crédito' : 'Contado',
    FPAGO_EFECTIVO: fpEfectivo,
    FPAGO_TARJETA: fpTarjeta,
    FPAGO_DEPOSITO: fpDeposito,
    FPAGO_CHEQUE: fpCheque,
    TIPODOC: String(r.TIPODOC || '').trim().toUpperCase(),
    DESDOC: r.DESDOC || '',
    ES_RETIRO: false,
    ES_VALE_CAJA: false,
  };
}

function mapRetiroRow(r) {
  const importe = roundMoney(Math.abs(Number(r.IMPORTE) || 0));
  const banco = String(r.DESBANCO || '').trim();
  const cuenta = String(r.NOCUENTA || '').trim();
  const desc = String(r.DESCRIPCION || '').trim();
  const cliente = [banco, cuenta].filter(Boolean).join(' · ') || desc || 'Retiro a banco';
  return {
    ID: r.ID,
    FECHA: fechaIsoFromRow({ FECHA: r.FECHA }) || null,
    CODDOC: r.CODDOC,
    CORRELATIVO: r.CORRELATIVO,
    CLIENTE: cliente,
    TOTALPRECIO: importe,
    IMPORTE: importe,
    STATUS: 'O',
    CONCRE: 'CON',
    CONCRE_LABEL: 'Contado',
    FPAGO_EFECTIVO: importe,
    FPAGO_TARJETA: 0,
    FPAGO_DEPOSITO: 0,
    FPAGO_CHEQUE: 0,
    TIPODOC: TIPODOC_RETIRO,
    DESDOC: 'Retiro de efectivo',
    ES_RETIRO: true,
    ES_VALE_CAJA: false,
    NODOCUMENTO: r.NODOCUMENTO || '',
    DESCRIPCION: desc,
  };
}

function mapValeCajaRow(r) {
  const importe = roundMoney(Math.abs(Number(r.IMPORTE) || 0));
  const recibe = String(r.RECIBE || '').trim();
  const tipo = String(r.TIPO || '').trim();
  const desc = String(r.DESCRIPCION || '').trim();
  const cliente = [recibe, tipo].filter(Boolean).join(' · ') || desc || 'Vale de caja';
  return {
    ID: r.NOVALE,
    FECHA: fechaIsoFromRow({ FECHA: r.FECHA }) || null,
    CODDOC: 'VC',
    CORRELATIVO: r.NOVALE,
    CLIENTE: cliente,
    TOTALPRECIO: importe,
    IMPORTE: importe,
    STATUS: 'O',
    CONCRE: 'CON',
    CONCRE_LABEL: 'Contado',
    FPAGO_EFECTIVO: importe,
    FPAGO_TARJETA: 0,
    FPAGO_DEPOSITO: 0,
    FPAGO_CHEQUE: 0,
    TIPODOC: TIPODOC_VALES_CAJA,
    DESDOC: 'Vales de caja',
    ES_RETIRO: false,
    ES_VALE_CAJA: true,
    TIPO: tipo,
    RECIBE: recibe,
    DESCRIPCION: desc,
  };
}

function mapProductoRow(r) {
  return {
    CODPROD: String(r.CODPROD || '').trim(),
    DESPROD: String(r.DESPROD || '').trim(),
    UNIDADES: roundMoney(r.UNIDADES),
    PRECIO: roundMoney(r.PRECIO),
    UNIDADES_CON: roundMoney(r.UNIDADES_CON),
    PRECIO_CON: roundMoney(r.PRECIO_CON),
    UNIDADES_CRE: roundMoney(r.UNIDADES_CRE),
    PRECIO_CRE: roundMoney(r.PRECIO_CRE),
  };
}

/** Payload para reimpresión del cuadre (misma forma que corte-caja). */
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

/** Lista cortes del mes/año (tabla CORTES). */
router.get('/cortes', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isDbConfigured()) return res.status(503).json({ error: 'Base de datos no configurada' });
  const empnit = requireEmpNit(req, res);
  if (!empnit) return;
  const { mes, anio } = parseMesAnio(req);

  try {
    const pool = await req.app.locals.getDbPool();
    const result = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('MES', sql.Int, mes)
      .input('ANIO', sql.Int, anio)
      .query(`
        SELECT
          c.ID, c.CORRELATIVO, c.FECHA, c.ANIO, c.MES, c.DIA, c.HORA, c.MINUTO,
          c.CODCAJA, c.TOTALMOVIMIENTOS, c.TOTALVENTA, c.TOTALREPORTADO,
          c.FALTANTE, c.SOBRANTE, c.USUARIO, c.OBS, c.IDINICIAL, c.IDFINAL,
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
        ORDER BY c.FECHA DESC, c.HORA DESC, c.MINUTO DESC, c.ID DESC
      `);

    res.json({
      mes,
      anio,
      rows: (result.recordset || []).map(mapCorteRow),
    });
  } catch (err) {
    console.warn('[API GET /auditoria-cajas/cortes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** Detalle: documentos del corte agrupados por TIPODOC + payload de cuadre/reimpresión. */
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
          c.FALTANTE, c.SOBRANTE, c.USUARIO, c.OBS, c.IDINICIAL, c.IDFINAL,
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

    const corte = mapCorteRow(corteRow);
    const print = mapCortePrintPayload(corteRow);
    const nocorte = Number(corte.CORRELATIVO);

    const docsRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('NOCORTE', sql.Int, nocorte)
      .query(`
        SELECT
          d.ID, d.FECHA, d.ANIO, d.MES, d.DIA, d.CODDOC, d.CORRELATIVO,
          ISNULL(d.DOC_NOMCLIE, '') AS DOC_NOMCLIE,
          ISNULL(d.TOTALPRECIO, 0) AS TOTALPRECIO,
          ISNULL(d.STATUS, '') AS STATUS,
          ISNULL(d.CONCRE, 'CON') AS CONCRE,
          ISNULL(d.FPAGO_EFECTIVO, 0) AS FPAGO_EFECTIVO,
          ISNULL(d.FPAGO_TARJETA, 0) AS FPAGO_TARJETA,
          ISNULL(d.FPAGO_DEPOSITO, 0) AS FPAGO_DEPOSITO,
          ISNULL(d.FPAGO_CHEQUE, 0) AS FPAGO_CHEQUE,
          UPPER(LTRIM(RTRIM(ISNULL(t.TIPODOC, '')))) AS TIPODOC,
          ISNULL(t.DESDOC, '') AS DESDOC
        FROM dbo.DOCUMENTOS d
        LEFT JOIN dbo.TIPODOCUMENTOS t ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        WHERE d.EMPNIT = @EMPNIT
          AND d.NOCORTE = @NOCORTE
        ORDER BY t.TIPODOC, d.FECHA, d.CODDOC, d.CORRELATIVO
      `);

    const rawDocs = normalizeDocumentoRows(docsRes.recordset || []);
    const byTipo = new Map();

    for (const raw of rawDocs) {
      const row = mapDocRow(raw);
      const key = row.TIPODOC || 'SN';
      if (!byTipo.has(key)) {
        byTipo.set(key, {
          TIPODOC: key,
          DESDOC: row.DESDOC || key,
          rows: [],
          total: 0,
          totalEfectivo: 0,
          totalTarjeta: 0,
          totalDeposito: 0,
          totalCheque: 0,
          count: 0,
          anulados: 0,
        });
      }
      const g = byTipo.get(key);
      if (!g.DESDOC && row.DESDOC) g.DESDOC = row.DESDOC;
      g.rows.push(row);
      g.total = roundMoney(g.total + row.IMPORTE);
      g.totalEfectivo = roundMoney(g.totalEfectivo + row.FPAGO_EFECTIVO);
      g.totalTarjeta = roundMoney(g.totalTarjeta + row.FPAGO_TARJETA);
      g.totalDeposito = roundMoney(g.totalDeposito + row.FPAGO_DEPOSITO);
      g.totalCheque = roundMoney(g.totalCheque + row.FPAGO_CHEQUE);
      g.count += 1;
      if (row.STATUS === 'A') g.anulados += 1;
    }

    const retirosRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('NOCORTE', sql.Int, nocorte)
      .query(`
        SELECT
          b.ID, b.FECHA, b.CODDOC, b.CORRELATIVO, b.IMPORTE, b.DESCRIPCION,
          ISNULL(b.NODOCUMENTO, '') AS NODOCUMENTO,
          ISNULL(c.NOCUENTA, '') AS NOCUENTA,
          ISNULL(bn.DESBANCO, '') AS DESBANCO
        FROM dbo.DOCUMENTOS_BANCO b
        LEFT JOIN dbo.CUENTAS c ON c.EMPNIT = b.EMPNIT AND c.CODCUENTA = b.CODCUENTA
        LEFT JOIN dbo.BANCOS bn ON bn.CODBANCO = c.CODBANCO
        WHERE b.EMPNIT = @EMPNIT
          AND b.NOCORTE = @NOCORTE
          AND b.TIPO = 'E'
          AND UPPER(LTRIM(RTRIM(ISNULL(b.CATEGORIA, '')))) = 'DEPOSITO'
        ORDER BY b.FECHA, b.CODDOC, b.CORRELATIVO, b.ID
      `);

    const retirosRows = (retirosRes.recordset || []).map(mapRetiroRow);
    if (retirosRows.length) {
      const g = {
        TIPODOC: TIPODOC_RETIRO,
        DESDOC: 'Retiro de efectivo',
        rows: retirosRows,
        total: roundMoney(retirosRows.reduce((s, r) => s + r.IMPORTE, 0)),
        totalEfectivo: roundMoney(retirosRows.reduce((s, r) => s + r.FPAGO_EFECTIVO, 0)),
        totalTarjeta: 0,
        totalDeposito: 0,
        totalCheque: 0,
        count: retirosRows.length,
        anulados: 0,
      };
      byTipo.set(TIPODOC_RETIRO, g);
    }

    const valesCajaRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('NOCORTE', sql.Float, nocorte)
      .query(`
        SELECT
          v.NOVALE, v.FECHA, v.CODCAJA, v.TIPO, v.DESCRIPCION, v.RECIBE,
          ISNULL(v.IMPORTE, 0) AS IMPORTE
        FROM dbo.DOCUMENTOS_VALES_CAJA v
        WHERE v.EMPNIT = @EMPNIT
          AND ISNULL(v.NOCORTE, 0) = @NOCORTE
        ORDER BY v.FECHA, v.NOVALE
      `);

    const valesCajaRows = (valesCajaRes.recordset || []).map(mapValeCajaRow);
    const totalValesCaja = roundMoney(valesCajaRows.reduce((s, r) => s + r.IMPORTE, 0));
    if (valesCajaRows.length) {
      byTipo.set(TIPODOC_VALES_CAJA, {
        TIPODOC: TIPODOC_VALES_CAJA,
        DESDOC: 'Vales de caja',
        rows: valesCajaRows,
        total: totalValesCaja,
        totalEfectivo: totalValesCaja,
        totalTarjeta: 0,
        totalDeposito: 0,
        totalCheque: 0,
        count: valesCajaRows.length,
        anulados: 0,
      });
    }

    if (print?.resumen) {
      const totalRetirosGrupo = roundMoney(retirosRows.reduce((s, r) => s + r.IMPORTE, 0));
      print.resumen.totalValesCaja = totalValesCaja;
      print.resumen.totalRetiros = totalRetirosGrupo;
      // CORTES no guarda EFECTIVOINICIAL; se reconstruye del arqueo del corte.
      print.resumen.efectivoInicial = roundMoney(
        Number(print.resumen.efectivoEsperado || 0) -
          Number(print.resumen.fpEfectivo || 0) +
          totalRetirosGrupo +
          totalValesCaja
      );
    }

    const productosRes = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('NOCORTE', sql.Int, nocorte)
      .query(`
        SELECT
          LTRIM(RTRIM(ISNULL(l.CODPROD, ''))) AS CODPROD,
          MAX(LTRIM(RTRIM(ISNULL(l.DESPROD, '')))) AS DESPROD,
          SUM(
            CASE
              WHEN t.TIPODOC IN (${SQL_TIPODOC_FACTURA_IN}) THEN ISNULL(l.TOTALUNIDADES, 0)
              WHEN t.TIPODOC IN (${SQL_TIPODOC_DEVOLUCION_IN}) THEN -ISNULL(l.TOTALUNIDADES, 0)
              ELSE 0
            END
          ) AS UNIDADES,
          SUM(
            CASE
              WHEN t.TIPODOC IN (${SQL_TIPODOC_FACTURA_IN}) THEN ISNULL(l.TOTALPRECIO, 0)
              WHEN t.TIPODOC IN (${SQL_TIPODOC_DEVOLUCION_IN}) THEN -ISNULL(l.TOTALPRECIO, 0)
              ELSE 0
            END
          ) AS PRECIO,
          SUM(
            CASE
              WHEN ISNULL(d.CONCRE, 'CON') <> 'CRE' AND t.TIPODOC IN (${SQL_TIPODOC_FACTURA_IN})
                THEN ISNULL(l.TOTALUNIDADES, 0)
              WHEN ISNULL(d.CONCRE, 'CON') <> 'CRE' AND t.TIPODOC IN (${SQL_TIPODOC_DEVOLUCION_IN})
                THEN -ISNULL(l.TOTALUNIDADES, 0)
              ELSE 0
            END
          ) AS UNIDADES_CON,
          SUM(
            CASE
              WHEN ISNULL(d.CONCRE, 'CON') <> 'CRE' AND t.TIPODOC IN (${SQL_TIPODOC_FACTURA_IN})
                THEN ISNULL(l.TOTALPRECIO, 0)
              WHEN ISNULL(d.CONCRE, 'CON') <> 'CRE' AND t.TIPODOC IN (${SQL_TIPODOC_DEVOLUCION_IN})
                THEN -ISNULL(l.TOTALPRECIO, 0)
              ELSE 0
            END
          ) AS PRECIO_CON,
          SUM(
            CASE
              WHEN ISNULL(d.CONCRE, 'CON') = 'CRE' AND t.TIPODOC IN (${SQL_TIPODOC_FACTURA_IN})
                THEN ISNULL(l.TOTALUNIDADES, 0)
              WHEN ISNULL(d.CONCRE, 'CON') = 'CRE' AND t.TIPODOC IN (${SQL_TIPODOC_DEVOLUCION_IN})
                THEN -ISNULL(l.TOTALUNIDADES, 0)
              ELSE 0
            END
          ) AS UNIDADES_CRE,
          SUM(
            CASE
              WHEN ISNULL(d.CONCRE, 'CON') = 'CRE' AND t.TIPODOC IN (${SQL_TIPODOC_FACTURA_IN})
                THEN ISNULL(l.TOTALPRECIO, 0)
              WHEN ISNULL(d.CONCRE, 'CON') = 'CRE' AND t.TIPODOC IN (${SQL_TIPODOC_DEVOLUCION_IN})
                THEN -ISNULL(l.TOTALPRECIO, 0)
              ELSE 0
            END
          ) AS PRECIO_CRE
        FROM dbo.DOCPRODUCTOS l
        INNER JOIN dbo.DOCUMENTOS d
          ON d.EMPNIT = l.EMPNIT AND d.CODDOC = l.CODDOC AND d.CORRELATIVO = l.CORRELATIVO
        INNER JOIN dbo.TIPODOCUMENTOS t
          ON t.EMPNIT = d.EMPNIT AND t.CODDOC = d.CODDOC
        WHERE d.EMPNIT = @EMPNIT
          AND d.NOCORTE = @NOCORTE
          AND ISNULL(d.STATUS, '') <> 'A'
          AND t.TIPODOC IN (${SQL_TIPODOC_FACTURA_IN}, ${SQL_TIPODOC_DEVOLUCION_IN})
        GROUP BY LTRIM(RTRIM(ISNULL(l.CODPROD, '')))
        HAVING
          SUM(
            CASE
              WHEN t.TIPODOC IN (${SQL_TIPODOC_FACTURA_IN}) THEN ISNULL(l.TOTALUNIDADES, 0)
              WHEN t.TIPODOC IN (${SQL_TIPODOC_DEVOLUCION_IN}) THEN -ISNULL(l.TOTALUNIDADES, 0)
              ELSE 0
            END
          ) <> 0
          OR SUM(
            CASE
              WHEN t.TIPODOC IN (${SQL_TIPODOC_FACTURA_IN}) THEN ISNULL(l.TOTALPRECIO, 0)
              WHEN t.TIPODOC IN (${SQL_TIPODOC_DEVOLUCION_IN}) THEN -ISNULL(l.TOTALPRECIO, 0)
              ELSE 0
            END
          ) <> 0
        ORDER BY MAX(LTRIM(RTRIM(ISNULL(l.DESPROD, '')))), LTRIM(RTRIM(ISNULL(l.CODPROD, '')))
      `);

    const productos = (productosRes.recordset || []).map(mapProductoRow);

    const grupos = [...byTipo.values()].sort((a, b) => {
      const orderTail = (t) => {
        if (t === TIPODOC_VALES_CAJA) return 2;
        if (t === TIPODOC_RETIRO) return 3;
        return 0;
      };
      const oa = orderTail(a.TIPODOC);
      const ob = orderTail(b.TIPODOC);
      if (oa !== ob) return oa - ob;
      return String(a.TIPODOC).localeCompare(String(b.TIPODOC), 'es');
    });

    res.json({
      corte,
      print,
      grupos,
      productos,
      selectorProductos: SELECTOR_PRODUCTOS,
      totalGeneral: roundMoney(grupos.reduce((s, g) => s + g.total, 0)),
      totalDocs: grupos.reduce((s, g) => s + g.count, 0),
    });
  } catch (err) {
    console.warn('[API GET /auditoria-cajas/cortes/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
