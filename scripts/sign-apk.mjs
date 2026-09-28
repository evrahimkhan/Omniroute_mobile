#!/usr/bin/env node
/**
 * CI helper — sign the release APK with a release keystore (optional).
 *
 * Required environment variables:
 *   ANDROID_KEYSTORE_BASE64  base64-encoded .jks keystore
 *   ANDROID_KEYSTORE_PASSWORD
 *   ANDROID_KEY_ALIAS
 *   ANDROID_KEY_PASSWORD     (usually same as keystore password)
 *
 * Optional: ANDROID_SDK_HOME (defaults to /usr/lib/android-sdk on GitHub
 * runners). The signed APK replaces the unsigned one in place.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const apkPath = process.argv[2];
if (!apkPath) {
  console.error('usage: node scripts/sign-apk.mjs <path-to-release-apk>');
  process.exit(1);
}

const required = [
  'ANDROID_KEYSTORE_BASE64',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD',
];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
}

const sdk = process.env.ANDROID_SDK_HOME || '/usr/lib/android-sdk';
const dir = mkdtempSync(join(tmpdir(), 'omniroute-sign-'));
const keystore = join(dir, 'release.jks');
writeFileSync(keystore, Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, 'base64'));

// Find apksigner inside build-tools (newest version).
const buildTools = join(sdk, 'build-tools');
const versions = readdirSync(buildTools)
  .filter((v) => statSync(join(buildTools, v)).isDirectory())
  .sort()
  .reverse();
if (!versions.length) {
  console.error('No build-tools found under ' + buildTools);
  process.exit(1);
}
const apksigner = join(buildTools, versions[0], 'apksigner');

const tmpSigned = join(dir, 'signed.apk');
execFileSync(
  apksigner,
  [
    'sign',
    '--ks', keystore,
    '--ks-key-alias', process.env.ANDROID_KEY_ALIAS,
    '--ks-pass', `pass:${process.env.ANDROID_KEYSTORE_PASSWORD}`,
    '--ks-key-pass', `pass:${process.env.ANDROID_KEY_PASSWORD}`,
    '--out', tmpSigned,
    apkPath,
  ],
  { stdio: 'inherit' },
);

renameSync(tmpSigned, apkPath);
console.log(`Signed APK: ${apkPath}`);
