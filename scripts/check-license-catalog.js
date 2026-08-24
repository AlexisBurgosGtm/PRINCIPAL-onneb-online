/**
 * Verifica que el catálogo de licencias esté alineado con:
 * - ALL_MENUS / MENU_GROUPS
 * - data-menu del sidebar (public/index.html)
 * - API_PREFIX_RULES
 *
 * Uso: npm run license:check
 */
const fs = require('fs');
const path = require('path');
const {
  assertLicenseCatalogIntegrity,
  licenseModulesCatalog,
  ALL_MENUS,
  MENU_LABELS,
} = require('../lib/license-modules');

function readSidebarMenus() {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const menus = new Set();
  const re = /data-menu=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    menus.add(String(m[1]).trim());
  }
  return [...menus].sort();
}

const result = assertLicenseCatalogIntegrity({
  log: (msg) => console.error(msg),
  throwOnError: false,
});

const catalog = licenseModulesCatalog();
const sidebarMenus = readSidebarMenus();
const allSet = new Set(ALL_MENUS);
const catalogMenus = new Set(catalog.flatMap((m) => m.menus || []));
catalogMenus.add('inicio');
catalogMenus.add('licencia');

const inSidebarNotInAll = sidebarMenus.filter((m) => !allSet.has(m));
const inAllNotInSidebar = ALL_MENUS.filter((m) => !sidebarMenus.includes(m) && m !== 'inicio');
const inSidebarNotInCatalog = sidebarMenus.filter((m) => !catalogMenus.has(m));

console.log(`[Licencia] ${catalog.length} módulo(s) en generador:`);
for (const m of catalog) {
  console.log(`  - ${m.id} (${m.title}): ${m.menus.length} vista(s)`);
  for (const key of m.menus) {
    console.log(`      · ${key} — ${MENU_LABELS[key] || key}`);
  }
}

const problems = [...(result.problems || [])];
if (inSidebarNotInAll.length) {
  problems.push(`data-menu en sidebar sin ALL_MENUS: ${inSidebarNotInAll.join(', ')}`);
}
if (inSidebarNotInCatalog.length) {
  problems.push(`data-menu en sidebar fuera de MENU_GROUPS (generador): ${inSidebarNotInCatalog.join(', ')}`);
}
if (inAllNotInSidebar.length) {
  console.warn(
    `[Licencia] Aviso: ALL_MENUS sin ítem en sidebar (puede ser intencional): ${inAllNotInSidebar.join(', ')}`
  );
}

if (problems.length) {
  console.error('\nProblemas:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nCorrige MENU_GROUPS / ALL_MENUS / sidebar antes de emitir licencias.');
  process.exit(1);
}

console.log(`\n[Licencia] Sidebar: ${sidebarMenus.length} data-menu(s) · Catálogo: ${catalogMenus.size} vista(s)`);
console.log('[Licencia] Catálogo OK — Mariandre lee este mismo MENU_GROUPS.');
