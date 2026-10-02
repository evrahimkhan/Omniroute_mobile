#!/usr/bin/env node
/**
 * Writes lib/screens/catalog.ts from scripts/data/dashboard-surfaces.json.
 *
 * Why a generator: the catalog is the app's answer to "every function of the web
 * UI". OmniRoute's dashboard has 94 sidebar surfaces and 723 API routes; a list
 * that size, maintained by hand, is wrong within a week of the pinned ref moving.
 * The snapshot records what the dashboard's own source says (see
 * docs/NATIVE_UI.md for how it is produced); this script turns it into typed
 * TypeScript the app imports, and `--check` fails if the committed file has
 * drifted from the snapshot — so the table can be trusted.
 *
 *   node scripts/gen-surface-catalog.mjs           # write
 *   node scripts/gen-surface-catalog.mjs --check   # verify (CI)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = join(root, 'scripts/data/dashboard-surfaces.json');
const outPath = join(root, 'lib/screens/catalog.ts');

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));

/**
 * Material Symbols (the dashboard's icon set) → MaterialCommunityIcons, which is
 * what the app already ships. Only names used by the snapshot are listed; an
 * unmapped name falls back to the section icon rather than rendering nothing.
 */
const ICONS = {
  account: 'account-outline',
  'account-cog': 'account-cog-outline',
  'account-voice': 'account-voice',
  block: 'block-helper',
  bolt: 'lightning-bolt',
  book: 'book-open-page-variant-outline',
  brain: 'brain',
  bug: 'bug-outline',
  'calendar-clock': 'calendar-clock-outline',
  'chart-bar': 'chart-bar',
  'chart-box-outline': 'chart-box-outline',
  'chart-donut': 'chart-donut',
  'chart-line': 'chart-line',
  cloud: 'cloud-outline',
  'code-braces': 'code-braces',
  cog: 'cog-outline',
  'cog-extended': 'cog-outline',
  compass: 'compass-outline',
  console: 'console-line',
  database: 'database-outline',
  dns: 'dns-outline',
  export: 'export-variant',
  feather: 'feather',
  'file-document': 'file-document-outline',
  filter: 'filter-variant',
  flag: 'flag-variant-outline',
  flame: 'fire',
  flask: 'flask-outline',
  folder: 'folder-outline',
  'format-list-bulleted': 'format-list-bulleted',
  'format-list-checks': 'format-list-checks',
  'format-list-numbered': 'format-list-numbered',
  forum: 'forum-outline',
  gauge: 'gauge',
  hand: 'hand-back-right-outline',
  heart: 'heart-outline',
  'heart-pulse': 'heart-pulse',
  image: 'image-outline',
  'image-multiple': 'image-multiple-outline',
  'image-search': 'image-search-outline',
  key: 'key-outline',
  'key-variant': 'key-variant',
  'layers-triple': 'layers-triple-outline',
  link: 'link-variant',
  lock: 'lock-outline',
  magnify: 'magnify',
  'magnify-plus': 'magnify-plus-outline',
  menu: 'menu',
  merge: 'merge',
  music: 'music',
  network: 'network-outline',
  palette: 'palette-outline',
  'pie-chart': 'chart-pie',
  'piggy-bank': 'piggy-bank-outline',
  plug: 'power-plug-outline',
  radar: 'radar',
  robot: 'robot',
  'robot-outline': 'robot-outline',
  route: 'routes',
  scissors: 'scissors-cutting',
  server: 'server',
  'server-network': 'server-network',
  shield: 'shield-outline',
  'shield-account': 'shield-account-outline',
  'shield-check': 'shield-check-outline',
  'shield-link': 'shield-link-variant-outline',
  sitemap: 'sitemap-outline',
  swap: 'swap-horizontal',
  'swap-horizontal': 'swap-horizontal-bold',
  'swap-horizontal-variant': 'swap-horizontal-variant',
  table: 'table-large',
  tag: 'tag-outline',
  terminal: 'console',
  ticket: 'ticket-outline',
  'ticket-confirmation': 'ticket-confirmation-outline',
  'timeline-clock': 'timeline-clock-outline',
  translate: 'translate',
  trophy: 'trophy-outline',
  tune: 'tune-variant',
  wallet: 'wallet-outline',
  wand: 'magic-staff',
  web: 'web',
  'web-refresh': 'web-refresh',
};

/**
 * How each dashboard section reads on a phone.
 *
 * The sidebar's own names are the product's internal taxonomy — "OmniProxy",
 * "Other Features" — and a menu that repeats them verbatim is the web sidebar
 * with a different scroll bar. A phone menu needs a short label, a line saying
 * what is inside, and no more than a screenful of entries.
 */
const SECTION_PRESENTATION = {
  OmniProxy: {
    label: 'Gateway',
    subtitle: 'Endpoints, API keys, providers and combos',
    icon: 'swap-horizontal-bold',
  },
  Analytics: {
    label: 'Analytics',
    subtitle: 'Usage, health, evaluations and search',
    icon: 'chart-box-outline',
  },
  Costs: {
    label: 'Costs',
    subtitle: 'Spend, pricing, budgets and free tiers',
    icon: 'cash-multiple',
  },
  Monitoring: {
    label: 'Monitoring',
    subtitle: 'Logs, activity and runtime health',
    icon: 'monitor-dashboard',
  },
  'Dev Tools': {
    label: 'Developer tools',
    subtitle: 'CLI tools, agent bridge and traffic inspection',
    icon: 'toolbox-outline',
  },
  'Agentic Features': {
    label: 'Agents',
    subtitle: 'Cloud agents, skills and memory',
    icon: 'robot-outline',
  },
  'Other Features': {
    label: 'More features',
    subtitle: 'Everything else the gateway offers',
    icon: 'shape-outline',
  },
  Configuration: {
    label: 'Settings',
    subtitle: 'Compression, routing, cache and security',
    icon: 'tune-variant',
  },
  Help: {
    label: 'Help & about',
    subtitle: 'Docs, changelog and this build',
    icon: 'help-circle-outline',
  },
};

/** Icons for sections the presentation map does not name. */
const SECTION_ICONS = Object.fromEntries(
  Object.entries(SECTION_PRESENTATION).map(([title, presentation]) => [title, presentation.icon])
);

const quote = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const lines = [];
lines.push(`/**`);
lines.push(` * Every gateway surface the app can show, from the dashboard's own definition.`);
lines.push(` *`);
lines.push(` * GENERATED by scripts/gen-surface-catalog.mjs from`);
lines.push(` * scripts/data/dashboard-surfaces.json — do not edit by hand. The snapshot is`);
lines.push(` * derived from ${snapshot.source}, and \`npm run surfaces:test\` fails if this`);
lines.push(` * file and the snapshot disagree.`);
lines.push(` *`);
lines.push(` * \`kind\` is which native renderer draws the surface:`);
lines.push(` *   custom     — a purpose-built screen, listed in APP_ROUTES below`);
lines.push(` *   config     — a settings object: native toggles, fields and pickers`);
lines.push(` *   collection — a list of records with search and a detail view`);
lines.push(` *   stats      — numbers and breakdowns for a window of traffic`);
lines.push(` *   local      — not gateway data; the screen explains why`);
lines.push(` *   external   — a link out of the app, opened deliberately by the user`);
lines.push(` */`);
lines.push('');
lines.push(`import type { MaterialCommunityIcons } from '@expo/vector-icons';`);
lines.push('');
lines.push(`export type SurfaceKind = 'custom' | 'config' | 'collection' | 'stats' | 'local' | 'external';`);
lines.push('');
lines.push(`export interface Surface {`);
lines.push(`  /** Stable id, used in the route and as a list key. */`);
lines.push(`  id: string;`);
lines.push(`  title: string;`);
lines.push(`  subtitle: string;`);
lines.push(`  /** MaterialCommunityIcons name. */`);
lines.push(`  icon: keyof typeof MaterialCommunityIcons.glyphMap;`);
lines.push(`  /** Section title, as the dashboard groups them. */`);
lines.push(`  section: string;`);
lines.push(`  kind: SurfaceKind;`);
lines.push(`  /** API route the surface reads (and usually writes). */`);
lines.push(`  path?: string;`);
lines.push(`  /** How a config surface writes back, when the route takes one. */`);
lines.push(`  method?: 'patch' | 'post' | 'put';`);
lines.push(`  /** For custom surfaces: the expo-router route to open. */`);
lines.push(`  route?: string;`);
lines.push(`  /** For local surfaces: why there is nothing to fetch. */`);
lines.push(`  note?: string;`);
lines.push(`  /** The dashboard page this replaces, kept for traceability. */`);
lines.push(`  page?: string;`);
lines.push(`}`);
lines.push('');
lines.push(`export interface SurfaceSection {`);
lines.push(`  id: string;`);
lines.push(`  /** The dashboard's own section name, kept for traceability. */`);
lines.push(`  title: string;`);
lines.push(`  /** What the phone menu shows — short, and not the internal taxonomy. */`);
lines.push(`  label: string;`);
lines.push(`  subtitle: string;`);
lines.push(`  icon: Surface['icon'];`);
lines.push(`  surfaces: Surface[];`);
lines.push(`}`);
lines.push('');

// The bespoke screens, from the snapshot's custom entries.
const custom = snapshot.surfaces.filter((s) => s.kind === 'custom');
lines.push(`/** Surfaces that get their own screen rather than a renderer. */`);
lines.push(`export const APP_ROUTES: Record<string, string> = {`);
for (const surface of custom) lines.push(`  ${quote(surface.id)}: ${quote(surface.route)},`);
lines.push(`};`);
lines.push('');

lines.push(`export const SURFACES: Surface[] = [`);
let currentSection = null;
for (const surface of snapshot.surfaces) {
  if (surface.section !== currentSection) {
    currentSection = surface.section;
    lines.push(`  // ── ${currentSection ?? 'Ungrouped'} ──`);
  }
  const icon = ICONS[surface.icon] ?? SECTION_ICONS[surface.section] ?? 'application-outline';
  const fields = [
    `id: ${quote(surface.id)}`,
    `title: ${quote(surface.title)}`,
    `subtitle: ${quote(surface.subtitle ?? '')}`,
    `icon: ${quote(icon)}`,
    `section: ${quote(surface.section ?? 'Other')}`,
    `kind: ${quote(surface.kind)}`,
  ];
  if (surface.route) fields.push(`route: ${quote(surface.route)}`);
  if (surface.path && surface.kind !== 'custom') fields.push(`path: ${quote(surface.path)}`);
  if (surface.method && surface.kind === 'config') fields.push(`method: ${quote(surface.method)}`);
  if (surface.note) fields.push(`note: ${quote(surface.note)}`);
  if (surface.page) fields.push(`page: ${quote(surface.page)}`);
  lines.push(`  { ${fields.join(', ')} },`);
}
lines.push(`];`);
lines.push('');

// Order matters: these are module-level consts read by SECTIONS below, and a
// const used before its initializer runs is a TDZ crash, not a lint warning.
lines.push(`/** Dashboard section order, so the app's catalog reads like the web sidebar. */`);
lines.push(`const SECTION_ORDER = ${JSON.stringify([...new Set(snapshot.surfaces.map((s) => s.section))].filter(Boolean))};`);
lines.push('');
lines.push(`const SECTION_ICONS: Record<string, Surface['icon']> = {`);
for (const [title, icon] of Object.entries(SECTION_ICONS)) lines.push(`  ${quote(title)}: ${quote(icon)},`);
lines.push(`};`);
lines.push('');
lines.push(`const SECTION_PRESENTATION: Record<string, { label: string; subtitle: string }> = {`);
for (const [title, presentation] of Object.entries(SECTION_PRESENTATION)) {
  lines.push(`  ${quote(title)}: { label: ${quote(presentation.label)}, subtitle: ${quote(presentation.subtitle)} },`);
}
lines.push(`};`);
lines.push('');
lines.push(`export const SECTIONS: SurfaceSection[] = SECTION_ORDER.map((title) => ({`);
lines.push(`  id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),`);
lines.push(`  title,`);
lines.push(`  label: SECTION_PRESENTATION[title]?.label ?? title,`);
lines.push(`  subtitle: SECTION_PRESENTATION[title]?.subtitle ?? '',`);
lines.push(`  icon: SECTION_ICONS[title] ?? 'folder-outline',`);
lines.push(`  surfaces: SURFACES.filter((surface) => surface.section === title),`);
lines.push(`})).filter((section) => section.surfaces.length > 0);`);
lines.push('');
lines.push(`export function findSurface(id: string): Surface | undefined {`);
lines.push(`  return SURFACES.find((surface) => surface.id === id);`);
lines.push(`}`);
lines.push('');
lines.push(`/** Search across title, subtitle, section and the API path it uses. */`);
lines.push(`export function searchSurfaces(query: string): Surface[] {`);
lines.push(`  const needle = query.trim().toLowerCase();`);
lines.push(`  if (!needle) return SURFACES;`);
lines.push(`  return SURFACES.filter((surface) =>`);
lines.push(`    [surface.title, surface.subtitle, surface.section, surface.id, surface.path ?? '']`);
lines.push(`      .join(' ')`);
lines.push(`      .toLowerCase()`);
lines.push(`      .includes(needle)`);
lines.push(`  );`);
lines.push(`}`);
lines.push('');

const output = lines.join('\n');

if (process.argv.includes('--check')) {
  const current = readFileSync(outPath, 'utf8');
  if (current !== output) {
    console.error('surface-catalog: lib/screens/catalog.ts is out of date with scripts/data/dashboard-surfaces.json');
    console.error('  run: node scripts/gen-surface-catalog.mjs');
    process.exit(1);
  }
  const surfaces = snapshot.surfaces.length;
  console.log(`surface-catalog: OK — ${surfaces} surfaces match the committed catalog`);
  process.exit(0);
}

writeFileSync(outPath, output);
const kinds = snapshot.surfaces.reduce((acc, s) => ({ ...acc, [s.kind]: (acc[s.kind] ?? 0) + 1 }), {});
console.log(`surface-catalog: wrote lib/screens/catalog.ts — ${snapshot.surfaces.length} surfaces ${JSON.stringify(kinds)}`);
