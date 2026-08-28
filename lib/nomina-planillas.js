const sql = require('mssql');
const { calcularLineaNomina, totalesPlanilla } = require('./nomina-calculo');
const { roundMoney, toNumber, diasLaboradosPorPeriodo } = require('./nomina-utils');
const { mapValesPendientesPorEmpleado } = require('./nomina-vales');

const DEFAULT_CONFIG = {
  PORC_IGSS_LABORAL: 4.83,
  PORC_IGSS_PATRONAL: 10.67,
  PORC_ISR: 0,
  DIAS_MES: 30,
  IGSS_CENTRO_TRABAJO: '1',
};

async function ensureNominaConfig(pool, empnit) {
  const existing = await pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
    SELECT TOP 1 * FROM dbo.NOMINA_CONFIG WHERE EMPNIT = @EMPNIT
  `);
  if (existing.recordset[0]) return existing.recordset[0];
  await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      INSERT INTO dbo.NOMINA_CONFIG (EMPNIT) VALUES (@EMPNIT)
    `);
  const created = await pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
    SELECT TOP 1 * FROM dbo.NOMINA_CONFIG WHERE EMPNIT = @EMPNIT
  `);
  return created.recordset[0];
}

async function getNominaConfig(pool, empnit) {
  return ensureNominaConfig(pool, empnit);
}

async function saveNominaConfig(pool, empnit, body) {
  await ensureNominaConfig(pool, empnit);
  const fields = [
    'NIT_PATRONO',
    'RAZON_SOCIAL',
    'IGSS_NUMERO_PATRONO',
    'IGSS_CENTRO_TRABAJO',
    'IGSS_EMAIL',
    'PORC_IGSS_LABORAL',
    'PORC_IGSS_PATRONAL',
    'PORC_ISR',
    'DIAS_MES',
    'SALARIO_MINIMO',
    'OBS',
  ];
  const request = pool.request().input('EMPNIT', sql.VarChar, empnit);
  const sets = fields
    .filter((f) => body[f] !== undefined)
    .map((f) => {
      const key = `P_${f}`;
      if (['PORC_IGSS_LABORAL', 'PORC_IGSS_PATRONAL', 'PORC_ISR', 'DIAS_MES', 'SALARIO_MINIMO'].includes(f)) {
        request.input(key, sql.Decimal(18, 4), toNumber(body[f]));
      } else {
        request.input(key, sql.VarChar, String(body[f] ?? '').trim());
      }
      return `${f} = @${key}`;
    });
  if (!sets.length) return getNominaConfig(pool, empnit);
  await request.query(`UPDATE dbo.NOMINA_CONFIG SET ${sets.join(', ')} WHERE EMPNIT = @EMPNIT`);
  return getNominaConfig(pool, empnit);
}

async function listConceptos(pool, empnit) {
  const result = await pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
    SELECT * FROM dbo.NOMINA_CONCEPTOS WHERE EMPNIT = @EMPNIT ORDER BY CODIGO
  `);
  return result.recordset;
}

async function upsertConcepto(pool, empnit, body, id = null) {
  const codigo = String(body.CODIGO || '').trim();
  const descripcion = String(body.DESCRIPCION || '').trim();
  if (!codigo || !descripcion) {
    const err = new Error('CODIGO y DESCRIPCION son obligatorios');
    err.statusCode = 400;
    throw err;
  }
  const tipo = String(body.TIPO || 'ING').trim().toUpperCase();
  if (!['ING', 'DED'].includes(tipo)) {
    const err = new Error('TIPO debe ser ING o DED');
    err.statusCode = 400;
    throw err;
  }
  if (id) {
    await pool
      .request()
      .input('ID', sql.Int, id)
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODIGO', sql.VarChar, codigo)
      .input('DESCRIPCION', sql.VarChar, descripcion)
      .input('TIPO', sql.VarChar, tipo)
      .input('AFECTA_IGSS', sql.VarChar, String(body.AFECTA_IGSS || 'SI').toUpperCase())
      .input('AFECTA_ISR', sql.VarChar, String(body.AFECTA_ISR || 'SI').toUpperCase())
      .input('ACTIVO', sql.VarChar, String(body.ACTIVO || 'SI').toUpperCase())
      .query(`
        UPDATE dbo.NOMINA_CONCEPTOS
        SET CODIGO=@CODIGO, DESCRIPCION=@DESCRIPCION, TIPO=@TIPO,
            AFECTA_IGSS=@AFECTA_IGSS, AFECTA_ISR=@AFECTA_ISR, ACTIVO=@ACTIVO
        WHERE ID=@ID AND EMPNIT=@EMPNIT
      `);
    return { ID: id };
  }
  const ins = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODIGO', sql.VarChar, codigo)
    .input('DESCRIPCION', sql.VarChar, descripcion)
    .input('TIPO', sql.VarChar, tipo)
    .input('AFECTA_IGSS', sql.VarChar, String(body.AFECTA_IGSS || 'SI').toUpperCase())
    .input('AFECTA_ISR', sql.VarChar, String(body.AFECTA_ISR || 'SI').toUpperCase())
    .input('ACTIVO', sql.VarChar, String(body.ACTIVO || 'SI').toUpperCase())
    .query(`
      INSERT INTO dbo.NOMINA_CONCEPTOS (EMPNIT, CODIGO, DESCRIPCION, TIPO, AFECTA_IGSS, AFECTA_ISR, ACTIVO)
      OUTPUT INSERTED.ID
      VALUES (@EMPNIT, @CODIGO, @DESCRIPCION, @TIPO, @AFECTA_IGSS, @AFECTA_ISR, @ACTIVO)
    `);
  return { ID: ins.recordset[0]?.ID };
}

async function deleteConcepto(pool, empnit, id) {
  await pool
    .request()
    .input('ID', sql.Int, id)
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`DELETE FROM dbo.NOMINA_CONCEPTOS WHERE ID=@ID AND EMPNIT=@EMPNIT`);
}

async function listDepartamentos(pool, empnit, { soloActivos = false } = {}) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`
      SELECT ID, EMPNIT, CODIGO, NOMBRE, ACTIVO
      FROM dbo.NOMINA_DEPARTAMENTOS
      WHERE EMPNIT = @EMPNIT
        ${soloActivos ? `AND UPPER(LTRIM(RTRIM(ISNULL(ACTIVO, 'SI')))) = 'SI'` : ''}
      ORDER BY NOMBRE, CODIGO
    `);
  return result.recordset;
}

async function upsertDepartamento(pool, empnit, body, id = null) {
  const codigo = String(body.CODIGO || '').trim().toUpperCase();
  const nombre = String(body.NOMBRE || '').trim();
  if (!codigo || !nombre) {
    const err = new Error('CODIGO y NOMBRE son obligatorios');
    err.statusCode = 400;
    throw err;
  }
  const activo = String(body.ACTIVO || 'SI').trim().toUpperCase() === 'NO' ? 'NO' : 'SI';
  if (id) {
    await pool
      .request()
      .input('ID', sql.Int, id)
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODIGO', sql.VarChar, codigo)
      .input('NOMBRE', sql.VarChar, nombre)
      .input('ACTIVO', sql.VarChar, activo)
      .query(`
        UPDATE dbo.NOMINA_DEPARTAMENTOS
        SET CODIGO=@CODIGO, NOMBRE=@NOMBRE, ACTIVO=@ACTIVO
        WHERE ID=@ID AND EMPNIT=@EMPNIT
      `);
    return { ID: id };
  }
  const ins = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODIGO', sql.VarChar, codigo)
    .input('NOMBRE', sql.VarChar, nombre)
    .input('ACTIVO', sql.VarChar, activo)
    .query(`
      INSERT INTO dbo.NOMINA_DEPARTAMENTOS (EMPNIT, CODIGO, NOMBRE, ACTIVO)
      OUTPUT INSERTED.ID
      VALUES (@EMPNIT, @CODIGO, @NOMBRE, @ACTIVO)
    `);
  return { ID: ins.recordset[0]?.ID };
}

async function deleteDepartamento(pool, empnit, id) {
  await pool
    .request()
    .input('ID', sql.Int, id)
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`DELETE FROM dbo.NOMINA_DEPARTAMENTOS WHERE ID=@ID AND EMPNIT=@EMPNIT`);
}

async function listEmpleadosActivos(pool, empnit) {
  const result = await pool.request().input('EMPNIT', sql.VarChar, empnit).query(`
    SELECT
      e.CODEMPLEADO, e.NOMEMPLEADO, e.DPI, e.IGSS, e.ACTIVO, e.FECHA_NACIMIENTO,
      ne.ID AS NOMINA_EMP_ID, ne.SALARIO_BASE, ne.FECHA_INGRESO, ne.FECHA_BAJA,
      ne.COD_CENTRO_TRABAJO, ne.CONDICION_LABORAL, ne.TIPO_SALARIO_IGSS,
      ne.TIEMPO_COMPLETO, ne.HORAS_MES, ne.COD_OCUPACION_IGSS, ne.CUENTA_BANCO,
      ne.DEPARTAMENTO, ne.BONO_LEY, ne.BONO_ADICIONAL, ne.OBS
    FROM dbo.Empleados e
    LEFT JOIN dbo.NOMINA_EMPLEADO ne ON ne.EMPNIT = e.EMPNIT AND ne.CODEMPLEADO = e.CODEMPLEADO
    WHERE e.EMPNIT = @EMPNIT AND UPPER(LTRIM(RTRIM(ISNULL(e.ACTIVO, 'NO')))) = 'SI'
    ORDER BY e.NOMEMPLEADO
  `);
  return result.recordset;
}

async function saveNominaEmpleado(pool, empnit, codempleado, body) {
  const cod = parseInt(codempleado, 10);
  if (!Number.isFinite(cod)) {
    const err = new Error('CODEMPLEADO inválido');
    err.statusCode = 400;
    throw err;
  }
  const emp = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODEMPLEADO', sql.Int, cod)
    .query(`
      SELECT CODEMPLEADO FROM dbo.Empleados
      WHERE EMPNIT=@EMPNIT AND CODEMPLEADO=@CODEMPLEADO AND UPPER(LTRIM(RTRIM(ISNULL(ACTIVO,'NO'))))='SI'
    `);
  if (!emp.recordset.length) {
    const err = new Error('Empleado no encontrado o inactivo');
    err.statusCode = 404;
    throw err;
  }
  const existing = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('CODEMPLEADO', sql.Int, cod)
    .query(`SELECT ID FROM dbo.NOMINA_EMPLEADO WHERE EMPNIT=@EMPNIT AND CODEMPLEADO=@CODEMPLEADO`);
  const payload = {
    SALARIO_BASE: roundMoney(body.SALARIO_BASE),
    FECHA_INGRESO: body.FECHA_INGRESO || null,
    FECHA_BAJA: body.FECHA_BAJA || null,
    COD_CENTRO_TRABAJO: String(body.COD_CENTRO_TRABAJO || '').trim() || null,
    CONDICION_LABORAL: String(body.CONDICION_LABORAL || 'P').trim().toUpperCase(),
    TIPO_SALARIO_IGSS: String(body.TIPO_SALARIO_IGSS || '').trim() || null,
    TIEMPO_COMPLETO: String(body.TIEMPO_COMPLETO || 'SI').trim().toUpperCase(),
    HORAS_MES: body.HORAS_MES != null ? toNumber(body.HORAS_MES) : null,
    COD_OCUPACION_IGSS: String(body.COD_OCUPACION_IGSS || '').trim() || null,
    CUENTA_BANCO: String(body.CUENTA_BANCO || '').trim() || null,
    DEPARTAMENTO: String(body.DEPARTAMENTO || '').trim() || null,
    BONO_LEY: roundMoney(body.BONO_LEY),
    BONO_ADICIONAL: roundMoney(body.BONO_ADICIONAL),
    OBS: String(body.OBS || '').trim() || null,
  };
  if (existing.recordset[0]) {
    await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODEMPLEADO', sql.Int, cod)
      .input('SALARIO_BASE', sql.Decimal(18, 3), payload.SALARIO_BASE)
      .input('FECHA_INGRESO', sql.Date, payload.FECHA_INGRESO)
      .input('FECHA_BAJA', sql.Date, payload.FECHA_BAJA)
      .input('COD_CENTRO_TRABAJO', sql.VarChar, payload.COD_CENTRO_TRABAJO)
      .input('CONDICION_LABORAL', sql.VarChar, payload.CONDICION_LABORAL)
      .input('TIPO_SALARIO_IGSS', sql.VarChar, payload.TIPO_SALARIO_IGSS)
      .input('TIEMPO_COMPLETO', sql.VarChar, payload.TIEMPO_COMPLETO)
      .input('HORAS_MES', sql.Decimal(8, 2), payload.HORAS_MES)
      .input('COD_OCUPACION_IGSS', sql.VarChar, payload.COD_OCUPACION_IGSS)
      .input('CUENTA_BANCO', sql.VarChar, payload.CUENTA_BANCO)
      .input('DEPARTAMENTO', sql.VarChar, payload.DEPARTAMENTO)
      .input('BONO_LEY', sql.Decimal(18, 3), payload.BONO_LEY)
      .input('BONO_ADICIONAL', sql.Decimal(18, 3), payload.BONO_ADICIONAL)
      .input('OBS', sql.VarChar, payload.OBS)
      .query(`
        UPDATE dbo.NOMINA_EMPLEADO SET
          SALARIO_BASE=@SALARIO_BASE, FECHA_INGRESO=@FECHA_INGRESO, FECHA_BAJA=@FECHA_BAJA,
          COD_CENTRO_TRABAJO=@COD_CENTRO_TRABAJO, CONDICION_LABORAL=@CONDICION_LABORAL,
          TIPO_SALARIO_IGSS=@TIPO_SALARIO_IGSS, TIEMPO_COMPLETO=@TIEMPO_COMPLETO,
          HORAS_MES=@HORAS_MES, COD_OCUPACION_IGSS=@COD_OCUPACION_IGSS,
          CUENTA_BANCO=@CUENTA_BANCO, DEPARTAMENTO=@DEPARTAMENTO,
          BONO_LEY=@BONO_LEY, BONO_ADICIONAL=@BONO_ADICIONAL, OBS=@OBS
        WHERE EMPNIT=@EMPNIT AND CODEMPLEADO=@CODEMPLEADO
      `);
  } else {
    await pool
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('CODEMPLEADO', sql.Int, cod)
      .input('SALARIO_BASE', sql.Decimal(18, 3), payload.SALARIO_BASE)
      .input('FECHA_INGRESO', sql.Date, payload.FECHA_INGRESO)
      .input('FECHA_BAJA', sql.Date, payload.FECHA_BAJA)
      .input('COD_CENTRO_TRABAJO', sql.VarChar, payload.COD_CENTRO_TRABAJO)
      .input('CONDICION_LABORAL', sql.VarChar, payload.CONDICION_LABORAL)
      .input('TIPO_SALARIO_IGSS', sql.VarChar, payload.TIPO_SALARIO_IGSS)
      .input('TIEMPO_COMPLETO', sql.VarChar, payload.TIEMPO_COMPLETO)
      .input('HORAS_MES', sql.Decimal(8, 2), payload.HORAS_MES)
      .input('COD_OCUPACION_IGSS', sql.VarChar, payload.COD_OCUPACION_IGSS)
      .input('CUENTA_BANCO', sql.VarChar, payload.CUENTA_BANCO)
      .input('DEPARTAMENTO', sql.VarChar, payload.DEPARTAMENTO)
      .input('BONO_LEY', sql.Decimal(18, 3), payload.BONO_LEY)
      .input('BONO_ADICIONAL', sql.Decimal(18, 3), payload.BONO_ADICIONAL)
      .input('OBS', sql.VarChar, payload.OBS)
      .query(`
        INSERT INTO dbo.NOMINA_EMPLEADO (
          EMPNIT, CODEMPLEADO, SALARIO_BASE, FECHA_INGRESO, FECHA_BAJA, COD_CENTRO_TRABAJO,
          CONDICION_LABORAL, TIPO_SALARIO_IGSS, TIEMPO_COMPLETO, HORAS_MES, COD_OCUPACION_IGSS,
          CUENTA_BANCO, DEPARTAMENTO, BONO_LEY, BONO_ADICIONAL, OBS
        ) VALUES (
          @EMPNIT, @CODEMPLEADO, @SALARIO_BASE, @FECHA_INGRESO, @FECHA_BAJA, @COD_CENTRO_TRABAJO,
          @CONDICION_LABORAL, @TIPO_SALARIO_IGSS, @TIEMPO_COMPLETO, @HORAS_MES, @COD_OCUPACION_IGSS,
          @CUENTA_BANCO, @DEPARTAMENTO, @BONO_LEY, @BONO_ADICIONAL, @OBS
        )
      `);
  }
  return payload;
}

async function listPlanillas(pool, empnit, tipo, mes, anio) {
  const result = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('TIPO', sql.VarChar, tipo)
    .input('MES', sql.Int, mes)
    .input('ANIO', sql.Int, anio)
    .query(`
      SELECT * FROM dbo.NOMINA_PLANILLAS
      WHERE EMPNIT=@EMPNIT AND TIPO=@TIPO AND MES=@MES AND ANIO=@ANIO
      ORDER BY ID DESC
    `);
  return result.recordset;
}

async function loadPlanilla(pool, empnit, id) {
  const headerRes = await pool
    .request()
    .input('EMPNIT', sql.VarChar, empnit)
    .input('ID', sql.Int, id)
    .query(`SELECT * FROM dbo.NOMINA_PLANILLAS WHERE EMPNIT=@EMPNIT AND ID=@ID`);
  const header = headerRes.recordset[0];
  if (!header) return null;
  const config = await getNominaConfig(pool, empnit);
  const linesRes = await pool
    .request()
    .input('PLANILLA_ID', sql.Int, id)
    .query(`SELECT * FROM dbo.NOMINA_DETALLE WHERE PLANILLA_ID=@PLANILLA_ID ORDER BY NOMEMPLEADO, CODEMPLEADO`);
  const lines = (linesRes.recordset || []).map((row) => {
    const calc = calcularLineaNomina(row, config);
    return { ...row, SALARIOQ: calc.SALARIOQ, SALARIO_PERIODO: calc.SALARIO_PERIODO };
  });
  return { header, lines };
}

function buildLineFromEmpleado(emp, config, diasMes) {
  const bonoLey = roundMoney(emp.BONO_LEY ?? 0);
  const bonoAdicional = roundMoney(emp.BONO_ADICIONAL ?? 0);
  return {
    CODEMPLEADO: emp.CODEMPLEADO,
    NOMEMPLEADO: emp.NOMEMPLEADO,
    DPI: emp.DPI,
    IGSS: emp.IGSS,
    SALARIO_BASE: roundMoney(emp.SALARIO_BASE ?? 0),
    DIAS_LABORADOS: diasMes,
    HORAS_LABORADAS: emp.HORAS_MES ?? null,
    OTROS_INGRESOS: 0,
    BONO_LEY: bonoLey,
    BONO_ADICIONAL: bonoAdicional,
    BONIFICACION: bonoLey,
    COMISION: 0,
    OTRAS_DEDUCCIONES: 0,
    FECHA_ALTA: emp.FECHA_INGRESO || null,
    FECHA_BAJA: emp.FECHA_BAJA || null,
    COD_CENTRO_TRABAJO: emp.COD_CENTRO_TRABAJO || config.IGSS_CENTRO_TRABAJO || DEFAULT_CONFIG.IGSS_CENTRO_TRABAJO,
    DEPARTAMENTO: String(emp.DEPARTAMENTO || '').trim() || null,
    CONDICION_LABORAL: emp.CONDICION_LABORAL || 'P',
    TIPO_SALARIO_IGSS: emp.TIPO_SALARIO_IGSS || '01',
    TIEMPO_COMPLETO: emp.TIEMPO_COMPLETO || 'SI',
    COD_OCUPACION_IGSS: emp.COD_OCUPACION_IGSS || null,
    INCLUIDO: roundMoney(emp.SALARIO_BASE) > 0 ? 'SI' : 'NO',
    OBS: emp.OBS || null,
  };
}

async function createPlanilla(pool, empnit, tipo, body) {
  const config = await getNominaConfig(pool, empnit);
  const mes = parseInt(body.MES, 10);
  const anio = parseInt(body.ANIO, 10);
  if (!Number.isFinite(mes) || !Number.isFinite(anio)) {
    const err = new Error('MES y ANIO son obligatorios');
    err.statusCode = 400;
    throw err;
  }
  const empleados = await listEmpleadosActivos(pool, empnit);
  const periodoTipo = String(body.PERIODO_TIPO || 'MENSUAL').trim().toUpperCase() || 'MENSUAL';
  const diasPeriodo = diasLaboradosPorPeriodo(periodoTipo, config.DIAS_MES);
  const empleadosPlanilla =
    String(tipo || '').toUpperCase() === 'INTERNA'
      ? empleados.filter((emp) => roundMoney(emp.SALARIO_BASE ?? 0) > 0)
      : empleados;
  const valesPendientesMap =
    String(tipo || '').toUpperCase() === 'INTERNA'
      ? await mapValesPendientesPorEmpleado(pool, empnit).catch(() => new Map())
      : new Map();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const ins = await transaction
      .request()
      .input('EMPNIT', sql.VarChar, empnit)
      .input('TIPO', sql.VarChar, tipo)
      .input('PERIODO_TIPO', sql.VarChar, periodoTipo)
      .input('MES', sql.Int, mes)
      .input('ANIO', sql.Int, anio)
      .input('FECHA_INICIO', sql.Date, body.FECHA_INICIO || null)
      .input('FECHA_FIN', sql.Date, body.FECHA_FIN || null)
      .input('FECHA_PAGO', sql.Date, body.FECHA_PAGO || null)
      .input('DESCRIPCION', sql.VarChar, String(body.DESCRIPCION || '').trim())
      .input('USUARIO', sql.VarChar, String(body.USUARIO || 'SISTEMA').trim())
      .input('OBS', sql.VarChar, String(body.OBS || '').trim())
      .query(`
        INSERT INTO dbo.NOMINA_PLANILLAS (
          EMPNIT, TIPO, PERIODO_TIPO, MES, ANIO, FECHA_INICIO, FECHA_FIN, FECHA_PAGO,
          DESCRIPCION, STATUS, USUARIO, OBS
        )
        OUTPUT INSERTED.ID
        VALUES (
          @EMPNIT, @TIPO, @PERIODO_TIPO, @MES, @ANIO, @FECHA_INICIO, @FECHA_FIN, @FECHA_PAGO,
          @DESCRIPCION, 'B', @USUARIO, @OBS
        )
      `);
    const planillaId = ins.recordset[0].ID;
    const lines = [];
    const deduccionesPendientes = [];
    for (const emp of empleadosPlanilla) {
      const raw = buildLineFromEmpleado(emp, config, diasPeriodo);
      const valesInfo = valesPendientesMap.get(Number(emp.CODEMPLEADO));
      const calc = calcularLineaNomina(raw, config);
      const insLine = await transaction
        .request()
        .input('PLANILLA_ID', sql.Int, planillaId)
        .input('EMPNIT', sql.VarChar, empnit)
        .input('CODEMPLEADO', sql.Int, calc.CODEMPLEADO)
        .input('NOMEMPLEADO', sql.VarChar, calc.NOMEMPLEADO)
        .input('DPI', sql.VarChar, calc.DPI)
        .input('IGSS', sql.VarChar, calc.IGSS)
        .input('SALARIO_BASE', sql.Decimal(18, 3), calc.SALARIO_BASE)
        .input('DIAS_LABORADOS', sql.Decimal(8, 2), calc.DIAS_LABORADOS)
        .input('HORAS_LABORADAS', sql.Decimal(8, 2), calc.HORAS_LABORADAS)
        .input('OTROS_INGRESOS', sql.Decimal(18, 3), calc.OTROS_INGRESOS)
        .input('BONIFICACION', sql.Decimal(18, 3), calc.BONIFICACION)
        .input('BONO_LEY', sql.Decimal(18, 3), calc.BONO_LEY)
        .input('BONO_ADICIONAL', sql.Decimal(18, 3), calc.BONO_ADICIONAL)
        .input('COMISION', sql.Decimal(18, 3), calc.COMISION)
        .input('IGSS_LABORAL', sql.Decimal(18, 3), calc.IGSS_LABORAL)
        .input('IGSS_PATRONAL', sql.Decimal(18, 3), calc.IGSS_PATRONAL)
        .input('ISR', sql.Decimal(18, 3), calc.ISR)
        .input('OTRAS_DEDUCCIONES', sql.Decimal(18, 3), calc.OTRAS_DEDUCCIONES)
        .input('TOTAL_INGRESOS', sql.Decimal(18, 3), calc.TOTAL_INGRESOS)
        .input('TOTAL_DEDUCCIONES', sql.Decimal(18, 3), calc.TOTAL_DEDUCCIONES)
        .input('NETO_PAGAR', sql.Decimal(18, 3), calc.NETO_PAGAR)
        .input('FECHA_ALTA', sql.Date, calc.FECHA_ALTA)
        .input('FECHA_BAJA', sql.Date, calc.FECHA_BAJA)
        .input('COD_CENTRO_TRABAJO', sql.VarChar, calc.COD_CENTRO_TRABAJO)
        .input('DEPARTAMENTO', sql.VarChar, calc.DEPARTAMENTO)
        .input('CONDICION_LABORAL', sql.VarChar, calc.CONDICION_LABORAL)
        .input('TIPO_SALARIO_IGSS', sql.VarChar, calc.TIPO_SALARIO_IGSS)
        .input('TIEMPO_COMPLETO', sql.VarChar, calc.TIEMPO_COMPLETO)
        .input('COD_OCUPACION_IGSS', sql.VarChar, calc.COD_OCUPACION_IGSS)
        .input('INCLUIDO', sql.VarChar, calc.INCLUIDO)
        .input('OBS', sql.VarChar, calc.OBS)
        .query(`
          INSERT INTO dbo.NOMINA_DETALLE (
            PLANILLA_ID, EMPNIT, CODEMPLEADO, NOMEMPLEADO, DPI, IGSS, SALARIO_BASE, DIAS_LABORADOS,
            HORAS_LABORADAS, OTROS_INGRESOS, BONIFICACION, BONO_LEY, BONO_ADICIONAL, COMISION,
            IGSS_LABORAL, IGSS_PATRONAL, ISR, OTRAS_DEDUCCIONES, TOTAL_INGRESOS, TOTAL_DEDUCCIONES,
            NETO_PAGAR, FECHA_ALTA, FECHA_BAJA, COD_CENTRO_TRABAJO, DEPARTAMENTO, CONDICION_LABORAL,
            TIPO_SALARIO_IGSS, TIEMPO_COMPLETO, COD_OCUPACION_IGSS, INCLUIDO, OBS
          )
          OUTPUT INSERTED.ID
          VALUES (
            @PLANILLA_ID, @EMPNIT, @CODEMPLEADO, @NOMEMPLEADO, @DPI, @IGSS, @SALARIO_BASE, @DIAS_LABORADOS,
            @HORAS_LABORADAS, @OTROS_INGRESOS, @BONIFICACION, @BONO_LEY, @BONO_ADICIONAL, @COMISION,
            @IGSS_LABORAL, @IGSS_PATRONAL, @ISR, @OTRAS_DEDUCCIONES, @TOTAL_INGRESOS, @TOTAL_DEDUCCIONES,
            @NETO_PAGAR, @FECHA_ALTA, @FECHA_BAJA, @COD_CENTRO_TRABAJO, @DEPARTAMENTO, @CONDICION_LABORAL,
            @TIPO_SALARIO_IGSS, @TIEMPO_COMPLETO, @COD_OCUPACION_IGSS, @INCLUIDO, @OBS
          )
        `);
      const detalleId = insLine.recordset[0]?.ID;
      if (
        detalleId &&
        String(tipo || '').toUpperCase() === 'INTERNA' &&
        valesInfo?.vales?.length
      ) {
        deduccionesPendientes.push({ detalleId, vales: valesInfo.vales });
      }
      lines.push(calc);
    }
    const tot = totalesPlanilla(lines);
    await transaction
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
    await transaction.commit();
    if (deduccionesPendientes.length) {
      const { insertDeduccionesValesSugeridas, recalcLineaFromDeducciones } = require('./nomina-deducciones');
      for (const item of deduccionesPendientes) {
        await insertDeduccionesValesSugeridas(pool, empnit, item.detalleId, item.vales);
        await recalcLineaFromDeducciones(pool, empnit, planillaId, item.detalleId);
      }
    }
    return loadPlanilla(pool, empnit, planillaId);
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function updateDetalleLine(pool, empnit, planillaId, detalleId, body) {
  const plan = await loadPlanilla(pool, empnit, planillaId);
  if (!plan) {
    const err = new Error('Planilla no encontrada');
    err.statusCode = 404;
    throw err;
  }
  if (String(plan.header.STATUS) === 'F') {
    const err = new Error('La planilla está cerrada');
    err.statusCode = 400;
    throw err;
  }
  const config = await getNominaConfig(pool, empnit);
  const line = plan.lines.find((l) => Number(l.ID) === Number(detalleId));
  if (!line) {
    const err = new Error('Línea no encontrada');
    err.statusCode = 404;
    throw err;
  }
  const merged = { ...line, ...body };
  const calc = calcularLineaNomina(merged, config);
  await pool
    .request()
    .input('ID', sql.Int, detalleId)
    .input('SALARIO_BASE', sql.Decimal(18, 3), calc.SALARIO_BASE)
    .input('DIAS_LABORADOS', sql.Decimal(8, 2), calc.DIAS_LABORADOS)
    .input('HORAS_LABORADAS', sql.Decimal(8, 2), calc.HORAS_LABORADAS)
    .input('OTROS_INGRESOS', sql.Decimal(18, 3), calc.OTROS_INGRESOS)
    .input('BONIFICACION', sql.Decimal(18, 3), calc.BONIFICACION)
    .input('BONO_LEY', sql.Decimal(18, 3), calc.BONO_LEY)
    .input('BONO_ADICIONAL', sql.Decimal(18, 3), calc.BONO_ADICIONAL)
    .input('COMISION', sql.Decimal(18, 3), calc.COMISION)
    .input('IGSS_LABORAL', sql.Decimal(18, 3), calc.IGSS_LABORAL)
    .input('IGSS_PATRONAL', sql.Decimal(18, 3), calc.IGSS_PATRONAL)
    .input('ISR', sql.Decimal(18, 3), calc.ISR)
    .input('OTRAS_DEDUCCIONES', sql.Decimal(18, 3), calc.OTRAS_DEDUCCIONES)
    .input('TOTAL_INGRESOS', sql.Decimal(18, 3), calc.TOTAL_INGRESOS)
    .input('TOTAL_DEDUCCIONES', sql.Decimal(18, 3), calc.TOTAL_DEDUCCIONES)
    .input('NETO_PAGAR', sql.Decimal(18, 3), calc.NETO_PAGAR)
    .input('DEPARTAMENTO', sql.VarChar, calc.DEPARTAMENTO)
    .input('INCLUIDO', sql.VarChar, String(calc.INCLUIDO || 'SI').toUpperCase())
    .input('OBS', sql.VarChar, calc.OBS || null)
    .query(`
      UPDATE dbo.NOMINA_DETALLE SET
        SALARIO_BASE=@SALARIO_BASE, DIAS_LABORADOS=@DIAS_LABORADOS, HORAS_LABORADAS=@HORAS_LABORADAS,
        OTROS_INGRESOS=@OTROS_INGRESOS, BONIFICACION=@BONIFICACION, BONO_LEY=@BONO_LEY,
        BONO_ADICIONAL=@BONO_ADICIONAL, COMISION=@COMISION, IGSS_LABORAL=@IGSS_LABORAL,
        IGSS_PATRONAL=@IGSS_PATRONAL, ISR=@ISR, OTRAS_DEDUCCIONES=@OTRAS_DEDUCCIONES,
        TOTAL_INGRESOS=@TOTAL_INGRESOS, TOTAL_DEDUCCIONES=@TOTAL_DEDUCCIONES, NETO_PAGAR=@NETO_PAGAR,
        DEPARTAMENTO=@DEPARTAMENTO, INCLUIDO=@INCLUIDO, OBS=@OBS
      WHERE ID=@ID
    `);
  const refreshed = await loadPlanilla(pool, empnit, planillaId);
  const tot = totalesPlanilla(refreshed.lines);
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
  return loadPlanilla(pool, empnit, planillaId);
}

async function recalcularPlanilla(pool, empnit, planillaId) {
  const plan = await loadPlanilla(pool, empnit, planillaId);
  if (!plan) {
    const err = new Error('Planilla no encontrada');
    err.statusCode = 404;
    throw err;
  }
  if (String(plan.header.STATUS) === 'F') {
    const err = new Error('La planilla está cerrada');
    err.statusCode = 400;
    throw err;
  }
  const config = await getNominaConfig(pool, empnit);
  for (const line of plan.lines) {
    const calc = calcularLineaNomina(line, config);
    await pool
      .request()
      .input('ID', sql.Int, line.ID)
      .input('IGSS_LABORAL', sql.Decimal(18, 3), calc.IGSS_LABORAL)
      .input('IGSS_PATRONAL', sql.Decimal(18, 3), calc.IGSS_PATRONAL)
      .input('ISR', sql.Decimal(18, 3), calc.ISR)
      .input('BONIFICACION', sql.Decimal(18, 3), calc.BONIFICACION)
      .input('BONO_LEY', sql.Decimal(18, 3), calc.BONO_LEY)
      .input('BONO_ADICIONAL', sql.Decimal(18, 3), calc.BONO_ADICIONAL)
      .input('TOTAL_INGRESOS', sql.Decimal(18, 3), calc.TOTAL_INGRESOS)
      .input('TOTAL_DEDUCCIONES', sql.Decimal(18, 3), calc.TOTAL_DEDUCCIONES)
      .input('NETO_PAGAR', sql.Decimal(18, 3), calc.NETO_PAGAR)
      .query(`
        UPDATE dbo.NOMINA_DETALLE SET
          IGSS_LABORAL=@IGSS_LABORAL, IGSS_PATRONAL=@IGSS_PATRONAL, ISR=@ISR,
          BONIFICACION=@BONIFICACION, BONO_LEY=@BONO_LEY, BONO_ADICIONAL=@BONO_ADICIONAL,
          TOTAL_INGRESOS=@TOTAL_INGRESOS, TOTAL_DEDUCCIONES=@TOTAL_DEDUCCIONES, NETO_PAGAR=@NETO_PAGAR
        WHERE ID=@ID
      `);
  }
  const refreshed = await loadPlanilla(pool, empnit, planillaId);
  const tot = totalesPlanilla(refreshed.lines);
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
  return loadPlanilla(pool, empnit, planillaId);
}

async function cerrarPlanilla(pool, empnit, planillaId) {
  const plan = await loadPlanilla(pool, empnit, planillaId);
  if (!plan) {
    const err = new Error('Planilla no encontrada');
    err.statusCode = 404;
    throw err;
  }
  await pool
    .request()
    .input('ID', sql.Int, planillaId)
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`UPDATE dbo.NOMINA_PLANILLAS SET STATUS='F' WHERE ID=@ID AND EMPNIT=@EMPNIT`);
  return loadPlanilla(pool, empnit, planillaId);
}

async function deletePlanilla(pool, empnit, planillaId) {
  const plan = await loadPlanilla(pool, empnit, planillaId);
  if (!plan) {
    const err = new Error('Planilla no encontrada');
    err.statusCode = 404;
    throw err;
  }
  if (String(plan.header.STATUS) === 'F') {
    const err = new Error('No se puede eliminar una planilla cerrada');
    err.statusCode = 400;
    throw err;
  }
  await pool
    .request()
    .input('ID', sql.Int, planillaId)
    .input('EMPNIT', sql.VarChar, empnit)
    .query(`DELETE FROM dbo.NOMINA_PLANILLAS WHERE ID=@ID AND EMPNIT=@EMPNIT`);
}

module.exports = {
  DEFAULT_CONFIG,
  ensureNominaConfig,
  getNominaConfig,
  saveNominaConfig,
  listConceptos,
  upsertConcepto,
  deleteConcepto,
  listDepartamentos,
  upsertDepartamento,
  deleteDepartamento,
  listEmpleadosActivos,
  saveNominaEmpleado,
  listPlanillas,
  loadPlanilla,
  createPlanilla,
  updateDetalleLine,
  recalcularPlanilla,
  cerrarPlanilla,
  deletePlanilla,
};
