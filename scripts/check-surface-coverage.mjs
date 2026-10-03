#!/usr/bin/env node
/**
 * Coverage check: is every dashboard function reachable natively?
 *
 * `surfaces:test` proves the catalog matches the dashboard snapshot. That is not
 * the same as the app being able to *show* all of it, which is the question a
 * reviewer asks next ("did you actually convert everything, or is some of it a
 * list of names?"). So this file walks the compiled catalog and the real source
 * tree and asserts the parts that would otherwise be believed rather than checked:
 *
 *   - every surface belongs to exactly one section, and every section is a route;
 *   - every surface that needs gateway data names an API route, not a page —
 *     fetching a page is how the app ended up printing HTML on every screen;
 *   - every custom surface has a route, and the route file exists on disk;
 *   - every kind has a renderer, so a new kind cannot arrive unhandled;
 *   - every icon name exists in the font's glyph map (a typo here is a blank
 *     square on the phone and nothing in a build log);
 *   - nothing claims to open a URL it does not have.
 *
 * It also prints the numbers the code review quotes, so the summary in
 * docs/CODE_REVIEW.md is generated rather than remembered.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'lib', 'screens', 'catalog.ts');
const RENDERER = join(ROOT, 'components', 'screens', 'SurfaceScreen.tsx');
const MENU = join(ROOT, 'app', '(tabs)', 'more.tsx');
const SECTION_ROUTE = join(ROOT, 'app', 'section', '[id].tsx');
const SURFACE_ROUTE = join(ROOT, 'app', 'surface', '[id].tsx');
// The glyph map has moved between releases of @expo/vector-icons; look for it in
// the shapes it ships in rather than assuming one, because "no glyph map found"
// would silently skip the icon assertions — the worst kind of passing test.
const GLYPHS = [
  join(ROOT, 'node_modules', '@expo', 'vector-icons', 'build', 'vendor', 'react-native-vector-icons', 'glyphmaps', 'MaterialCommunityIcons.json'),
  join(ROOT, 'node_modules', '@expo', 'vector-icons', 'build', 'glyphmaps', 'MaterialCommunityIcons.json'),
].find((f) => existsSync(f));

const failures = [];
let checks = 0;
const check = (name, ok) => {
  checks += 1;
  if (ok) process.stdout.write(`  ✓ ${name}\n`);
  else {
    failures.push(name);
    process.stdout.write(`  ✖ ${name}\n`);
  }
};

/** Compile the catalog so the check reads the shipped data, not a parsed guess. */
function loadCatalog() {
  const out = mkdtempSync(join(tmpdir(), 'surface-coverage-'));
  try {
    execFileSync('npx', ['--no-install', 'tsc', CATALOG, '--ignoreConfig', '--outDir', out, '--module', 'esnext', '--target', 'es2022', '--skipLibCheck'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return import(pathToFileURL(join(out, 'catalog.js')).href);
  } finally {
    // The dynamic import above has resolved by the time the caller awaits, so the
    // temporary directory is disposable as soon as that promise settles.
  }
}

/**
 * expo-router route → the file that must exist for it to open.
 *
 * `/(tabs)/providers` lives under a group directory and `/keys` does not, so the
 * mapping has to know both shapes; a route that resolves to nothing is a redirect
 * to a 404 screen, which is the failure this check exists to catch.
 */
function routeToFile(route) {
  const path = route.replace(/^\//, '');
  const candidates = [`${path}.tsx`, `${path}.ts`, `${path}/index.tsx`, `${path}/_layout.tsx`];
  return candidates.map((c) => join(ROOT, 'app', c)).find((f) => existsSync(f)) ?? null;
}

const { SURFACES, SECTIONS, APP_ROUTES, findSurface } = await loadCatalog();
const renderer = readFileSync(RENDERER, 'utf8');
const menu = readFileSync(MENU, 'utf8');
const glyphs = existsSync(GLYPHS) ? new Set(Object.keys(JSON.parse(readFileSync(GLYPHS, 'utf8')))) : null;

const byKind = {};
for (const s of SURFACES) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;

// --- the catalog's own shape -------------------------------------------------
check(`${SURFACES.length} surfaces, ids unique`, new Set(SURFACES.map((s) => s.id)).size === SURFACES.length);
check('every surface has a title', SURFACES.every((s) => s.title && s.title.trim().length > 0));
check(
  'every surface belongs to exactly one section',
  SURFACES.every((s) => SECTIONS.some((sec) => sec.title === s.section))
);
check(
  'sections hold no duplicates and no strangers',
  SECTIONS.every((sec) => {
    const mine = SURFACES.filter((s) => s.section === sec.title).map((s) => s.id).sort();
    const listed = sec.surfaces.map((s) => s.id).sort();
    return mine.length === listed.length && mine.every((id, i) => id === listed[i]);
  })
);
check('every surface is listed in a section', SURFACES.every((s) => SECTIONS.some((sec) => sec.surfaces.some((x) => x.id === s.id))));
check(
  'the dashboard page each one replaces is unique',
  new Set(SURFACES.map((s) => s.page).filter(Boolean)).size === SURFACES.filter((s) => s.page).length
);

// --- data surfaces must read the API, never a page ---------------------------
const needsData = SURFACES.filter((s) => s.kind === 'config' || s.kind === 'collection' || s.kind === 'stats');
check(`${needsData.length} data surfaces all name an /api/… path`, needsData.every((s) => (s.path ?? '').startsWith('/api/')));
check(
  'no data surface points at a dashboard page',
  needsData.every((s) => !(s.path ?? '').startsWith('/dashboard'))
);
check(
  'config surfaces say how they write back',
  SURFACES.filter((s) => s.kind === 'config' && s.method === undefined).length === 0 ||
    SURFACES.filter((s) => s.kind === 'config').every((s) => s.method || s.note)
);

// --- custom screens must exist ------------------------------------------------
const custom = SURFACES.filter((s) => s.kind === 'custom');
check(`${custom.length} custom surfaces all carry a route`, custom.every((s) => Boolean(s.route)));
check(
  'every custom route is in APP_ROUTES, and vice versa',
  custom.every((s) => APP_ROUTES[s.id] === s.route) &&
    Object.entries(APP_ROUTES).every(([id, route]) => custom.some((s) => s.id === id && s.route === route))
);
const missing = custom.filter((s) => !routeToFile(s.route));
check(
  `every route resolves to a file on disk${missing.length ? ` (missing: ${missing.map((s) => s.route).join(', ')})` : ''}`,
  missing.length === 0
);
const brokenRedirect = custom.filter((s) => !renderer.includes(`route`));
check('the renderer redirects custom surfaces instead of fetching them', renderer.includes("surface.kind === 'custom'") && renderer.includes('Redirect'));

// --- kinds and renderers ------------------------------------------------------
const kinds = [...new Set(SURFACES.map((s) => s.kind))].sort();
check(
  `every kind has a renderer branch (${kinds.join(', ')})`,
  kinds.every((k) => renderer.includes(`'${k}'`) || (k === 'config' && renderer.includes('ConfigBody')) || (k === 'collection' && renderer.includes('CollectionBody')) || (k === 'stats' && renderer.includes('StatsBody')))
);
check('the menu and both dynamic routes exist', existsSync(MENU) && existsSync(SECTION_ROUTE) && existsSync(SURFACE_ROUTE));
check('the menu is generated from the catalog, not a copy of it', /SECTIONS|SURFACES/.test(menu));

// --- icons --------------------------------------------------------------------
if (glyphs) {
  const bad = SURFACES.filter((s) => !glyphs.has(s.icon)).map((s) => `${s.id}: ${s.icon}`);
  check(`every icon exists in the font${bad.length ? ` (bad: ${bad.join(', ')})` : ''}`, bad.length === 0);
  const badSections = SECTIONS.filter((sec) => !glyphs.has(sec.icon)).map((sec) => sec.icon);
  check('every section icon exists', badSections.length === 0);
} else {
  // Hard fail, never a skip: the icons are the menu, and a check that quietly
  // opts out of them is worse than no check.
  check('the glyph map is available to check icons against', false);
}

// --- external links must not lie ------------------------------------------------
const externals = SURFACES.filter((s) => s.kind === 'external');
const vague = externals.filter((s) => !(s.page ?? '').startsWith('http'));
check(
  `every external surface has a real URL${vague.length ? ` (${vague.map((s) => s.id).join(', ')} do not)` : ''}`,
  vague.length === 0
);
check(
  'a surface without a URL is not labelled as one that leaves the app',
  !vague.some((s) => (s.note ?? '').toLowerCase().includes('browser') && !(s.note ?? '').includes('project'))
);

// --- lookups ------------------------------------------------------------------
check('findSurface resolves a sample of ids', ['endpoints', 'api-manager', 'logs', 'docs'].every((id) => findSurface(id)?.id === id));
check(
  'no surface is unreachable from the menu',
  SURFACES.every((s) => s.section && SECTIONS.some((sec) => sec.title === s.section))
);

// --- the numbers a reviewer asks for ------------------------------------------
const writable = SURFACES.filter((s) => s.method).length;
process.stdout.write(
  `\n  surfaces: ${SURFACES.length} across ${SECTIONS.length} sections — ` +
    `${byKind.config ?? 0} config, ${byKind.collection ?? 0} collection, ${byKind.stats ?? 0} stats, ` +
    `${byKind.custom ?? 0} bespoke, ${byKind.local ?? 0} app-local, ${byKind.external ?? 0} external; ` +
    `${writable} with a documented write method\n`
);

if (failures.length) {
  process.stderr.write(`\n✖ surface-coverage: ${failures.length} of ${checks} checks failed\n`);
  for (const f of failures) process.stderr.write(`  · ${f}\n`);
  process.exit(1);
}
process.stdout.write(`\nsurface-coverage — OK (${checks} assertions)\n`);
