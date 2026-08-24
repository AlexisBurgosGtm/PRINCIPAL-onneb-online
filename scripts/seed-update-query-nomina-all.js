/**
 * Registra en UPDATE_QUERIES todo el módulo Nóminas (orden de ejecución del actualizador).
 * Uso: node scripts/seed-update-query-nomina-all.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPTS = [
  'seed-update-query-nomina-modulo.js',
  'seed-update-query-control-asistencia.js',
  'seed-update-query-nomina-vales-empleados.js',
  'seed-update-query-nomina-vales-cuotas.js',
];

for (const name of SCRIPTS) {
  console.log(`\n--- ${name} ---`);
  const scriptPath = path.join(__dirname, name);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('\nListo: queries de Nóminas registradas en UPDATE_QUERIES.');
