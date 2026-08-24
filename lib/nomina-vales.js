const sql = require('mssql');
const { createValeCaja, deleteValeCaja } = require('./vales-caja');
const { crearMovimientoBanco } = require('./movimientos-banco');

function roundMoney(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function parseMesAnio(mesRaw, anioRaw) {
  const now = new Date();
  const mes = parseInt(mesRaw, 10);
  const anio = parseInt(anioRaw, 10);
  return {
    mes: Number.isFinite(mes) && mes >= 1 && mes <= 12 ? mes : now.getMonth() + 1,
    anio: Number.isFinite(anio) && anio >= 2000 && anio <= 2100 ? anio : now.getFullYear(),
  };
}

function parseCuotas(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(48, n);
}

async function listVales(pool, empnit, mes, anio) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('MES', sql.Int, mes)
    .input('ANIO', sql.Int, anio)
    .query(`
      SELECT v.ID, v.EMPNIT, v.CODEMP, v.CODCAJA, v.FECHA, v.MES, v.ANIO, v.MONTO,
             ISNULL(v.ABONOS, 0) AS ABONOS,
             ISNULL(v.SALDO, v.MONTO - ISNULL(v.ABONOS, 0)) AS SALDO,
             ISNULL(v.CUOTAS, 1) AS CUOTAS,
             v.DESCRIPCION, v.USUARIO, v.FECHA_CREACION, v.CORTE, v.NOCORTE,
             v.GENERADO_TIPO, v.GENERADO_CODIGO, v.GENERADO_CODDOC, v.GENERADO_CORRELATIVO,
             ISNULL(e.NOMEMPLEADO, '') AS NOMEMPLEADO,
             ISNULL(c.DESCAJA, '') AS DESCAJA,
             CASE
               WHEN UPPER(ISNULL(v.GENERADO_TIPO, '')) = 'CAJA' THEN ISNULL(cg.DESCAJA, '')
               WHEN UPPER(ISNULL(v.GENERADO_TIPO, '')) = 'BANCO' THEN
                 LTRIM(RTRIM(ISNULL(b.DESBANCO, '') + ' ' + ISNULL(cu.NOCUENTA, '')))
               ELSE ISNULL(c.DESCAJA, '')
             END AS ACREDITACION_DESC
      FROM dbo.NOMINA_VALES_EMPLEADOS v
      LEFT JOIN dbo.Empleados e ON e.EMPNIT = v.EMPNIT AND e.CODEMPLEADO = v.CODEMP
      LEFT JOIN dbo.Cajas c ON c.EMPNIT = v.EMPNIT AND c.CODCAJA = v.CODCAJA
      LEFT JOIN dbo.Cajas cg ON cg.EMPNIT = v.EMPNIT AND cg.CODCAJA = v.GENERADO_CODIGO
        AND UPPER(ISNULL(v.GENERADO_TIPO, '')) = 'CAJA'
      LEFT JOIN dbo.CUENTAS cu ON cu.EMPNIT = v.EMPNIT AND cu.CODCUENTA = v.GENERADO_CODIGO
        AND UPPER(ISNULL(v.GENERADO_TIPO, '')) = 'BANCO'
      LEFT JOIN dbo.BANCOS b ON b.CODBANCO = cu.CODBANCO
      WHERE v.EMPNIT = @EMPNIT AND v.MES = @MES AND v.ANIO = @ANIO
      ORDER BY v.FECHA DESC, v.ID DESC
    `);
  return result.recordset || [];
}

async function listEmpleadosActivosCombo(pool, empnit) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT CODEMPLEADO, NOMEMPLEADO
      FROM dbo.Empleados
      WHERE EMPNIT = @EMPNIT AND ACTIVO = 'SI'
      ORDER BY NOMEMPLEADO ASC
    `);
  return result.recordset || [];
}

async function listCajasAbiertas(pool, empnit) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT CODCAJA, DESCAJA
      FROM dbo.Cajas
      WHERE EMPNIT = @EMPNIT AND ISNULL(STATUS, 0) = 1
      ORDER BY DESCAJA ASC
    `);
  return result.recordset || [];
}

async function listCuentasBancariasCombo(pool, empnit) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT c.CODCUENTA, c.NOCUENTA, ISNULL(b.DESBANCO, '') AS DESBANCO
      FROM dbo.CUENTAS c
      LEFT JOIN dbo.BANCOS b ON b.CODBANCO = c.CODBANCO
      WHERE c.EMPNIT = @EMPNIT
      ORDER BY b.DESBANCO ASC, c.NOCUENTA ASC, c.CODCUENTA ASC
    `);
  return result.recordset || [];
}

async function assertCuentaBancaria(pool, empnit, codcuenta) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCUENTA', sql.Int, codcuenta)
    .query(`
      SELECT CODCUENTA FROM dbo.CUENTAS
      WHERE EMPNIT = @EMPNIT AND CODCUENTA = @CODCUENTA
    `);
  if (!result.recordset[0]) {
    throw httpError('Cuenta bancaria no encontrada', 404);
  }
  return result.recordset[0];
}

async function assertCajaAbierta(pool, empnit, codcaja) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODCAJA', sql.Int, codcaja)
    .query(`
      SELECT CODCAJA, DESCAJA, ISNULL(STATUS, 0) AS STATUS
      FROM dbo.Cajas
      WHERE EMPNIT = @EMPNIT AND CODCAJA = @CODCAJA
    `);
  const row = result.recordset[0];
  if (!row) {
    const err = new Error('Caja no encontrada');
    err.statusCode = 404;
    throw err;
  }
  if (Number(row.STATUS) !== 1) {
    const err = new Error('La caja seleccionada no está abierta');
    err.statusCode = 400;
    throw err;
  }
  return row;
}

async function assertEmpleadoActivo(pool, empnit, codemp) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODEMP', sql.Int, codemp)
    .query(`
      SELECT CODEMPLEADO, NOMEMPLEADO
      FROM dbo.Empleados
      WHERE EMPNIT = @EMPNIT AND CODEMPLEADO = @CODEMP AND ACTIVO = 'SI'
    `);
  const row = result.recordset[0];
  if (!row) {
    const err = new Error('Empleado no encontrado o inactivo');
    err.statusCode = 404;
    throw err;
  }
  return row;
}

async function createVale(pool, empnit, data) {
  const codemp = parseInt(data.CODEMP, 10);
  const monto = roundMoney(data.MONTO);
  const fechaStr = String(data.FECHA || '').trim().slice(0, 10);
  const descripcion = String(data.DESCRIPCION || '').trim() || null;
  const usuario = String(data.USUARIO || '').trim() || null;
  const generadoTipo = String(data.GENERADO_TIPO || '').trim().toUpperCase();
  const generadoCodigo = parseInt(data.GENERADO_CODIGO, 10);

  if (!Number.isFinite(codemp) || codemp <= 0) {
    throw httpError('Seleccione un empleado');
  }
  if (generadoTipo !== 'CAJA' && generadoTipo !== 'BANCO') {
    throw httpError('Seleccione la forma de cobrarlo (CAJA o BANCO)');
  }
  if (!Number.isFinite(generadoCodigo) || generadoCodigo <= 0) {
    throw httpError(
      generadoTipo === 'CAJA'
        ? 'Seleccione una caja abierta'
        : 'Seleccione una cuenta bancaria'
    );
  }
  if (!(monto > 0)) {
    throw httpError('El monto debe ser mayor a cero');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) {
    throw httpError('Fecha inválida');
  }

  const cuotas = parseCuotas(data.CUOTAS);
  const empleado = await assertEmpleadoActivo(pool, empnit, codemp);
  const [anio, mes] = fechaStr.split('-').map((n) => parseInt(n, 10));
  const nombreEmp = String(empleado.NOMEMPLEADO || '').trim() || `Empleado ${codemp}`;
  const descDoc = (descripcion || `Vale a empleado ${nombreEmp}`).slice(0, 250);

  let generadoCoddoc = null;
  let generadoCorrelativo = null;
  let cleanup = null;

  try {
    if (generadoTipo === 'CAJA') {
      await assertCajaAbierta(pool, empnit, generadoCodigo);
      const vc = await createValeCaja(pool, empnit, {
        CODCAJA: generadoCodigo,
        IMPORTE: monto,
        FECHA: fechaStr,
        TIPO: 'VALE EMPLEADO',
        DESCRIPCION: descDoc,
        RECIBE: nombreEmp.slice(0, 150),
      });
      generadoCoddoc = 'VC';
      generadoCorrelativo = Number(vc.novale);
      if (!Number.isFinite(generadoCorrelativo) || generadoCorrelativo <= 0) {
        throw httpError('No se pudo obtener el correlativo del vale de caja', 500);
      }
      cleanup = async () => {
        await deleteValeCaja(pool, empnit, generadoCorrelativo);
      };
    } else {
      await assertCuentaBancaria(pool, empnit, generadoCodigo);
      const mov = await crearMovimientoBanco(pool, sql, empnit, {
        TIPO: 'S',
        CODCUENTA: generadoCodigo,
        autoCoddoc: true,
        IMPORTE: monto,
        FECHA: fechaStr,
        DESCRIPCION: descDoc,
        ENCARGADO: nombreEmp.slice(0, 150),
        CATEGORIA: 'TRANSFERENCIA',
        USUARIO: usuario || 'NOMINA',
        OBS: `Vale empleado #${codemp}`,
      });
      generadoCoddoc = String(mov.movimiento?.CODDOC || '').trim() || null;
      generadoCorrelativo = Number(mov.movimiento?.CORRELATIVO);
      const bancoId = Number(mov.movimiento?.ID);
      if (!generadoCoddoc || !Number.isFinite(generadoCorrelativo)) {
        throw httpError('No se pudo obtener el documento bancario generado', 500);
      }
      cleanup = async () => {
        if (!Number.isFinite(bancoId) || bancoId <= 0) return;
        await pool
          .request()
          .input('EMPNIT', sql.VarChar, empnit)
          .input('ID', sql.Int, bancoId)
          .query(`DELETE FROM dbo.DOCUMENTOS_BANCO WHERE EMPNIT = @EMPNIT AND ID = @ID`);
      };
    }

    const insert = await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODEMP', sql.Int, codemp)
      .input('CODCAJA', sql.Int, null)
      .input('FECHA', sql.Date, fechaStr)
      .input('MES', sql.Int, mes)
      .input('ANIO', sql.Int, anio)
      .input('MONTO', sql.Decimal(18, 3), monto)
      .input('CUOTAS', sql.Int, cuotas)
      .input('DESCRIPCION', sql.VarChar, descripcion)
      .input('USUARIO', sql.VarChar, usuario)
      .input('GENERADO_TIPO', sql.VarChar, generadoTipo)
      .input('GENERADO_CODIGO', sql.Int, generadoCodigo)
      .input('GENERADO_CODDOC', sql.VarChar, generadoCoddoc)
      .input('GENERADO_CORRELATIVO', sql.Decimal(18, 0), generadoCorrelativo)
      .query(`
        INSERT INTO dbo.NOMINA_VALES_EMPLEADOS (
          EMPNIT, CODEMP, CODCAJA, FECHA, MES, ANIO, MONTO, ABONOS, SALDO, CUOTAS, DESCRIPCION, USUARIO, CORTE,
          GENERADO_TIPO, GENERADO_CODIGO, GENERADO_CODDOC, GENERADO_CORRELATIVO
        )
        OUTPUT INSERTED.ID
        VALUES (
          @EMPNIT, @CODEMP, @CODCAJA, @FECHA, @MES, @ANIO, @MONTO, 0, @MONTO, @CUOTAS, @DESCRIPCION, @USUARIO, 'NO',
          @GENERADO_TIPO, @GENERADO_CODIGO, @GENERADO_CODDOC, @GENERADO_CORRELATIVO
        )
      `);

    const id = insert.recordset[0]?.ID;
    const rows = await listVales(pool, empnit, mes, anio);
    return {
      id,
      rows,
      mes,
      anio,
      generado: {
        TIPO: generadoTipo,
        CODIGO: generadoCodigo,
        CODDOC: generadoCoddoc,
        CORRELATIVO: generadoCorrelativo,
      },
    };
  } catch (err) {
    if (cleanup) {
      try {
        await cleanup();
      } catch (cleanupErr) {
        console.warn('[nomina-vales createVale cleanup]', cleanupErr.message);
      }
    }
    const msg = String(err?.message || '');
    if (/CODCAJA/i.test(msg) && /NULL/i.test(msg)) {
      throw httpError(
        'La columna CODCAJA de NOMINA_VALES_EMPLEADOS no admite NULL. Ejecute el actualizador de BD (query CUOTAS / CODCAJA nullable).',
        500
      );
    }
    if (/CUOTAS/i.test(msg) && /column/i.test(msg)) {
      throw httpError(
        'Falta la columna CUOTAS en NOMINA_VALES_EMPLEADOS. Ejecute el actualizador de BD.',
        500
      );
    }
    throw err;
  }
}

async function getValeById(pool, empnit, id) {
  const existing = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ID', sql.Int, id)
    .query(`
      SELECT ID, EMPNIT, CODEMP, CODCAJA, FECHA, MES, ANIO, MONTO,
             ISNULL(ABONOS, 0) AS ABONOS,
             ISNULL(SALDO, MONTO - ISNULL(ABONOS, 0)) AS SALDO,
             ISNULL(CUOTAS, 1) AS CUOTAS,
             DESCRIPCION, CORTE, NOCORTE,
             GENERADO_TIPO, GENERADO_CODIGO, GENERADO_CODDOC, GENERADO_CORRELATIVO
      FROM dbo.NOMINA_VALES_EMPLEADOS
      WHERE EMPNIT = @EMPNIT AND ID = @ID
    `);
  return existing.recordset[0] || null;
}

async function updateVale(pool, empnit, id, data) {
  const row = await getValeById(pool, empnit, id);
  if (!row) {
    throw httpError('Vale no encontrado', 404);
  }

  const codemp = parseInt(data.CODEMP, 10);
  const monto = roundMoney(data.MONTO);
  const fechaStr = String(data.FECHA || '').trim().slice(0, 10);
  const descripcion = String(data.DESCRIPCION || '').trim() || null;
  const usuario = String(data.USUARIO || '').trim() || null;
  const cuotas = parseCuotas(data.CUOTAS ?? row.CUOTAS);

  if (!Number.isFinite(codemp) || codemp <= 0) {
    throw httpError('Seleccione un empleado');
  }
  if (!(monto > 0)) {
    throw httpError('El monto debe ser mayor a cero');
  }
  const abonosActual = roundMoney(row.ABONOS);
  if (monto + 0.0005 < abonosActual) {
    throw httpError(`El monto no puede ser menor a los abonos (${abonosActual})`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) {
    throw httpError('Fecha inválida');
  }

  if (Number(row.CODEMP) !== codemp) {
    await assertEmpleadoActivo(pool, empnit, codemp);
  }

  const [anio, mes] = fechaStr.split('-').map((n) => parseInt(n, 10));
  const saldo = roundMoney(monto - abonosActual);

  await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ID', sql.Int, id)
    .input('CODEMP', sql.Int, codemp)
    .input('FECHA', sql.Date, fechaStr)
    .input('MES', sql.Int, mes)
    .input('ANIO', sql.Int, anio)
    .input('MONTO', sql.Decimal(18, 3), monto)
    .input('SALDO', sql.Decimal(18, 3), saldo)
    .input('CUOTAS', sql.Int, cuotas)
    .input('DESCRIPCION', sql.VarChar, descripcion)
    .input('USUARIO', sql.VarChar, usuario)
    .query(`
      UPDATE dbo.NOMINA_VALES_EMPLEADOS
      SET CODEMP = @CODEMP,
          FECHA = @FECHA,
          MES = @MES,
          ANIO = @ANIO,
          MONTO = @MONTO,
          SALDO = @SALDO,
          CUOTAS = @CUOTAS,
          DESCRIPCION = @DESCRIPCION,
          USUARIO = ISNULL(@USUARIO, USUARIO)
      WHERE EMPNIT = @EMPNIT AND ID = @ID
    `);

  const listMes = Number(data.listMes) || mes;
  const listAnio = Number(data.listAnio) || anio;
  const rows = await listVales(pool, empnit, listMes, listAnio);
  return { id, rows, mes: listMes, anio: listAnio, valeMes: mes, valeAnio: anio };
}

async function deleteVale(pool, empnit, id) {
  const row = await getValeById(pool, empnit, id);
  if (!row) {
    const err = new Error('Vale no encontrado');
    err.statusCode = 404;
    throw err;
  }
  if (roundMoney(row.ABONOS) > 0) {
    const err = new Error('No se puede eliminar un vale con abonos. Elimine los pagos del historial primero.');
    err.statusCode = 400;
    throw err;
  }
  await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ID', sql.Int, id)
    .query(`DELETE FROM dbo.NOMINA_VALES_EMPLEADOS WHERE EMPNIT = @EMPNIT AND ID = @ID`);
  return { mes: row.MES, anio: row.ANIO };
}

async function listPagosVale(pool, empnit, idVale) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('IDVALE', sql.Int, idVale)
    .query(`
      SELECT p.ID, p.IDVALE, p.EMPNIT, p.CODCAJA,
             p.FECHA_PAGO AS FECHA,
             p.ABONO AS MONTO,
             ISNULL(p.CORTE, 'NO') AS CORTE,
             p.NOCORTE,
             ISNULL(c.DESCAJA, '') AS DESCAJA
      FROM dbo.NOMINA_VALES_EMPLEADOS_PAGOS p
      INNER JOIN dbo.NOMINA_VALES_EMPLEADOS v ON v.ID = p.IDVALE AND v.EMPNIT = p.EMPNIT
      LEFT JOIN dbo.Cajas c ON c.EMPNIT = p.EMPNIT AND c.CODCAJA = p.CODCAJA
      WHERE p.EMPNIT = @EMPNIT AND p.IDVALE = @IDVALE
      ORDER BY p.FECHA_PAGO DESC, p.ID DESC
    `);
  return result.recordset || [];
}

async function crearPagoVale(pool, empnit, idVale, data) {
  const row = await getValeById(pool, empnit, idVale);
  if (!row) {
    const err = new Error('Vale no encontrado');
    err.statusCode = 404;
    throw err;
  }
  const saldo = roundMoney(row.SALDO);
  if (!(saldo > 0)) {
    const err = new Error('El vale no tiene saldo pendiente');
    err.statusCode = 400;
    throw err;
  }
  const monto = roundMoney(data.MONTO ?? data.IMPORTE ?? data.ABONO);
  const fechaStr = String(data.FECHA || data.FECHA_PAGO || '').trim().slice(0, 10);
  const codcaja = parseInt(data.CODCAJA ?? row.CODCAJA, 10);

  if (!(monto > 0)) {
    const err = new Error('El importe abonado debe ser mayor a cero');
    err.statusCode = 400;
    throw err;
  }
  if (monto > saldo + 0.0005) {
    const err = new Error(`El pago no puede superar el saldo pendiente (${saldo})`);
    err.statusCode = 400;
    throw err;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) {
    const err = new Error('Fecha inválida');
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isFinite(codcaja) || codcaja <= 0) {
    const err = new Error('Seleccione una caja abierta');
    err.statusCode = 400;
    throw err;
  }
  await assertCajaAbierta(pool, empnit, codcaja);

  const nuevoAbonos = roundMoney(Number(row.ABONOS) + monto);
  const nuevoSaldo = roundMoney(Number(row.MONTO) - nuevoAbonos);

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const ins = await transaction
      .request()
      .input('IDVALE', sql.Int, idVale)
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODCAJA', sql.Int, codcaja)
      .input('FECHA_PAGO', sql.Date, fechaStr)
      .input('ABONO', sql.Decimal(18, 3), monto)
      .query(`
        INSERT INTO dbo.NOMINA_VALES_EMPLEADOS_PAGOS (IDVALE, EMPNIT, CODCAJA, FECHA_PAGO, ABONO, CORTE)
        OUTPUT INSERTED.ID
        VALUES (@IDVALE, @EMPNIT, @CODCAJA, @FECHA_PAGO, @ABONO, 'NO')
      `);
    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ID', sql.Int, idVale)
      .input('ABONOS', sql.Decimal(18, 3), nuevoAbonos)
      .input('SALDO', sql.Decimal(18, 3), Math.max(0, nuevoSaldo))
      .query(`
        UPDATE dbo.NOMINA_VALES_EMPLEADOS
        SET ABONOS = @ABONOS, SALDO = @SALDO
        WHERE EMPNIT = @EMPNIT AND ID = @ID
      `);
    await transaction.commit();
    const pagoId = ins.recordset[0]?.ID;
    const listMes = Number(data.listMes) || row.MES;
    const listAnio = Number(data.listAnio) || row.ANIO;
    const rows = await listVales(pool, empnit, listMes, listAnio);
    return { pagoId, rows, mes: listMes, anio: listAnio, abonos: nuevoAbonos, saldo: Math.max(0, nuevoSaldo) };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function eliminarPagoVale(pool, empnit, idVale, pagoId, listOpts = {}) {
  const row = await getValeById(pool, empnit, idVale);
  if (!row) {
    const err = new Error('Vale no encontrado');
    err.statusCode = 404;
    throw err;
  }

  const pagoRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('IDVALE', sql.Int, idVale)
    .input('ID', sql.Int, pagoId)
    .query(`
      SELECT ID, ABONO AS MONTO, ISNULL(CORTE, 'NO') AS CORTE
      FROM dbo.NOMINA_VALES_EMPLEADOS_PAGOS
      WHERE EMPNIT = @EMPNIT AND IDVALE = @IDVALE AND ID = @ID
    `);
  const pago = pagoRes.recordset[0];
  if (!pago) {
    const err = new Error('Pago no encontrado');
    err.statusCode = 404;
    throw err;
  }

  const montoPago = roundMoney(pago.MONTO);
  const nuevoAbonos = roundMoney(Math.max(0, Number(row.ABONOS) - montoPago));
  const nuevoSaldo = roundMoney(Number(row.MONTO) - nuevoAbonos);

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('IDVALE', sql.Int, idVale)
      .input('ID', sql.Int, pagoId)
      .query(`
        DELETE FROM dbo.NOMINA_VALES_EMPLEADOS_PAGOS
        WHERE EMPNIT = @EMPNIT AND IDVALE = @IDVALE AND ID = @ID
      `);
    await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('ID', sql.Int, idVale)
      .input('ABONOS', sql.Decimal(18, 3), nuevoAbonos)
      .input('SALDO', sql.Decimal(18, 3), Math.max(0, nuevoSaldo))
      .query(`
        UPDATE dbo.NOMINA_VALES_EMPLEADOS
        SET ABONOS = @ABONOS, SALDO = @SALDO
        WHERE EMPNIT = @EMPNIT AND ID = @ID
      `);
    await transaction.commit();
    const listMes = Number(listOpts.listMes) || row.MES;
    const listAnio = Number(listOpts.listAnio) || row.ANIO;
    const [rows, pagos] = await Promise.all([
      listVales(pool, empnit, listMes, listAnio),
      listPagosVale(pool, empnit, idVale),
    ]);
    return { rows, pagos, mes: listMes, anio: listAnio, abonos: nuevoAbonos, saldo: Math.max(0, nuevoSaldo) };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/**
 * Vales de empleado ya no se cargan al corte: la salida de caja vive en Vales de caja (VC).
 */
async function sumValesSesionCaja() {
  return { totalVales: 0, cantidadVales: 0 };
}

async function sumPagosValesSesionCaja() {
  return { totalPagos: 0, cantidadPagos: 0 };
}

async function listValesSesionCaja() {
  return [];
}

async function listPagosValesSesionCaja() {
  return [];
}

async function marcarValesCorte() {
  return 0;
}

async function marcarPagosValesCorte() {
  return 0;
}

module.exports = {
  parseMesAnio,
  listVales,
  listEmpleadosActivosCombo,
  listCajasAbiertas,
  listCuentasBancariasCombo,
  createVale,
  updateVale,
  deleteVale,
  getValeById,
  listPagosVale,
  crearPagoVale,
  eliminarPagoVale,
  sumValesSesionCaja,
  sumPagosValesSesionCaja,
  listValesSesionCaja,
  listPagosValesSesionCaja,
  marcarValesCorte,
  marcarPagosValesCorte,
  roundMoney,
};
