#!/usr/bin/env node
/**
 * CI helper — stamp app version + build numbers into app.json.
 *
 * Usage: node scripts/stamp-version.mjs <version> <buildNumber>
 * (version empty → keep the existing app.json version)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'app.json');

const version = process.argv[2] || '';
const buildNumber = parseInt(process.argv[3] || '1', 10) || 1;

const config = JSON.parse(readFileSync(file, 'utf8'));
const expo = (config.expo ??= {});

if (version) expo.version = version;
expo.android = expo.android ?? {};
expo.android.versionCode = buildNumber;
expo.ios = expo.ios ?? {};
expo.ios.buildNumber = String(buildNumber);

writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Stamped version=${expo.version} buildNumber=${buildNumber}`);
