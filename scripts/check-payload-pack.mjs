#!/usr/bin/env node
/**
 * Round-trips a fixture tree through the packer and the installer's extractor.
 *
 * Why this exists: `scripts/pack-payload.mjs` (CI, writes the archive) and
 * `gateway/bootstrap.mjs` (on-device, reads it) are two independent tar
 * implementations, and nothing else forces them to agree. They already did not
 * once: the extractor `continue`d past pax metadata entries without skipping
 * their 512-byte padding, so every entry after the first long path was read from
 * mid-record. Against npm's tarball — which happens not to use pax records —
 * that bug was invisible; against an archive this repo packs itself, it failed
 * with `EISDIR ... open <extract-dir>`.
 *
 * So the fixture deliberately contains everything that makes the two disagree:
 * a path well past ustar's 100-byte name field, nested and empty directories, an
 * executable, a symlink, and a zero-byte file.
 *
 *   node scripts/check-payload-pack.mjs
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKER = join(ROOT, 'scripts', 'pack-payload.mjs');

/** A path comfortably past ustar's 100-byte name field. */
function deepPath(root) {
  const segments = [];
  for (let i = 0; i < 8; i++) segments.push(`level-${i}-${'x'.repeat(12)}`);
  return join(root, ...segments, `deep-${'y'.repeat(40)}.txt`);
}

function buildFixture(dir) {
  writeFileSync(join(dir, 'server.js'), 'console.log("entry");\n');
  writeFileSync(join(dir, 'empty.txt'), '');
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');
  chmodSync(join(dir, 'run.sh'), 0o755);
  mkdirSync(join(dir, 'nested', 'a'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'a', 'b.txt'), 'nested file\n');
  mkdirSync(join(dir, 'empty-dir'), { recursive: true });

  const deep = deepPath(dir);
  mkdirSync(dirname(deep), { recursive: true });
  writeFileSync(deep, 'long path payload\n');

  try {
    symlinkSync('server.js', join(dir, 'link-to-entry.js'));
  } catch {
    // Filesystems without symlink support: the symlink assertion adapts.
  }
}

/** path → { kind, size?, mode?, sha? | target? }, sorted by path. */
function manifest(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = relative(dir, full).split(sep).join('/');
      const info = lstatSync(full);
      if (info.isSymbolicLink()) {
        out.set(rel, { kind: 'link', target: readlinkSync(full) });
      } else if (info.isDirectory()) {
        out.set(`${rel}/`, { kind: 'dir' });
        walk(full);
      } else if (info.isFile()) {
        const sha = createHash('sha256').update(readFileSync(full)).digest('hex');
        out.set(rel, { kind: 'file', size: info.size, mode: info.mode & 0o777, sha });
      }
    }
  };
  walk(dir);
  return out;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Compare a source manifest against an extracted one. Returns problems[]. */
function diff(source, got, { label }) {
  const problems = [];
  for (const [key, expected] of source) {
    const actual = got.get(key);
    if (!actual) {
      problems.push(`${label}: missing ${key}`);
      continue;
    }
    if (expected.kind !== actual.kind) {
      problems.push(`${label}: ${key} is ${actual.kind}, expected ${expected.kind}`);
      continue;
    }
    if (expected.kind === 'file') {
      if (expected.size !== actual.size) {
        problems.push(`${label}: ${key} size ${actual.size} != ${expected.size}`);
      }
      if (expected.sha !== actual.sha) problems.push(`${label}: ${key} content differs`);
      const wanted = expected.mode & 0o111 ? 0o755 : 0o644;
      if (actual.mode !== wanted) {
        problems.push(
          `${label}: ${key} mode ${actual.mode.toString(8)}, expected ${wanted.toString(8)}`
        );
      }
    }
    if (expected.kind === 'link' && expected.target !== actual.target) {
      problems.push(`${label}: ${key} link target differs`);
    }
  }
  for (const key of got.keys()) {
    if (!source.has(key)) problems.push(`${label}: unexpected ${key}`);
  }
  return problems;
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'payload-pack-'));
  const failures = [];
  let assertions = 0;
  const check = (label, ok, detail) => {
    assertions++;
    if (ok) {
      process.stdout.write(`  ✓ ${label}\n`);
    } else {
      failures.push(detail ? `${label} — ${detail}` : label);
      process.stdout.write(`  ✗ ${label}${detail ? ` — ${detail}` : ''}\n`);
    }
  };

  try {
    const source = join(work, 'source');
    mkdirSync(source, { recursive: true });
    buildFixture(source);
    const sourceManifest = manifest(source);

    // 1. No entry script: refuse, and say why, instead of packing something the
    //    device could never start.
    let refusal = '';
    try {
      execFileSync('node', [PACKER, source, '-o', join(work, 'bad.tar.gz'), '--entry', 'nope.js'], {
        stdio: 'pipe',
      });
    } catch (err) {
      refusal = String(err.stderr ?? '');
    }
    check('refuses an archive without the entry script', refusal.includes('is not at the root'));

    // 2. Deterministic bytes, so the app can pin a checksum.
    const first = join(work, 'a.tar.gz');
    const second = join(work, 'b.tar.gz');
    execFileSync('node', [PACKER, source, '-o', first, '--entry', 'server.js'], { stdio: 'pipe' });
    execFileSync('node', [PACKER, source, '-o', second, '--entry', 'server.js'], { stdio: 'pipe' });
    const shaFirst = sha256File(first);
    const shaSecond = sha256File(second);
    check('packing twice gives identical bytes', shaFirst === shaSecond, `${shaFirst} vs ${shaSecond}`);

    const meta = JSON.parse(readFileSync(`${first}.json`, 'utf8'));
    check('the manifest agrees with the archive', meta.sha256 === shaFirst && meta.bytes > 0);

    // 3. The installer's own extractor reads what the packer wrote — the check
    //    that would have caught the pax-padding bug.
    const { extractTarGz } = await import(pathToFileURL(join(ROOT, 'gateway', 'bootstrap.mjs')).href);
    const mine = join(work, 'extracted-mine');
    let extracted = null;
    let extractError = '';
    try {
      extracted = await extractTarGz(first, mine);
    } catch (err) {
      // A tar the packer wrote but the extractor cannot read is the exact
      // failure this script exists to catch, so report it as one.
      extractError = err?.message ?? String(err);
    }
    check('the installer can extract what the packer wrote', Boolean(extracted), extractError);
    if (extracted) {
      check('extractor reports no skipped entries', extracted.skipped === 0, JSON.stringify(extracted));
      const mineProblems = diff(sourceManifest, manifest(mine), { label: 'extractor' });
      check(
        'extractor reproduces every path, byte and mode',
        mineProblems.length === 0,
        mineProblems.slice(0, 4).join('; ')
      );
    }

    // 4. And system tar agrees, so the archive is a real tar.gz rather than
    //    something only our own code can read.
    const system = join(work, 'extracted-tar');
    mkdirSync(system, { recursive: true });
    let tarProblems = null;
    try {
      execFileSync('tar', ['-xzf', first, '-C', system], { stdio: 'pipe' });
      tarProblems = diff(sourceManifest, manifest(system), { label: 'tar' });
    } catch (err) {
      // A missing symlink is the one difference a filesystem may legitimately
      // impose; anything else is a failure.
      tarProblems = [`tar failed: ${err?.message ?? err}`];
    }
    if (tarProblems && /link-to-entry/.test(tarProblems.join(' ')) && tarProblems.length === 1) {
      check('system tar reads the archive (symlink unsupported here)', true);
    } else {
      check(
        'system tar reads the archive identically',
        tarProblems.length === 0,
        (tarProblems ?? []).slice(0, 4).join('; ')
      );
    }

    // 5. The long path really did need pax: prove the fixture exercised it.
    const longest = [...sourceManifest.keys()].reduce((a, b) => (b.length > a.length ? b : a), '');
    check('fixture includes a >100-byte path', longest.length > 100, `${longest.length} bytes`);

    // 6. A corrupt archive must not be mistaken for a good one.
    const corrupt = join(work, 'corrupt.tar.gz');
    const good = readFileSync(first);
    const truncated = Buffer.concat([good.subarray(0, Math.floor(good.length / 3))]);
    writeFileSync(corrupt, truncated);
    let corruptFailed = false;
    try {
      await extractTarGz(corrupt, join(work, 'extracted-corrupt'));
    } catch {
      corruptFailed = true;
    }
    check('a truncated archive fails loudly', corruptFailed);

    // 7. Path traversal is refused.
    const evil = join(work, 'evil.tar.gz');
    writeFileSync(evil, buildTraversalArchive());
    let traversalRefused = false;
    try {
      await extractTarGz(evil, join(work, 'extracted-evil'));
    } catch (err) {
      traversalRefused = String(err?.message ?? '').includes('outside the install dir');
    }
    check('refuses an entry that escapes the install dir', traversalRefused);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  if (failures.length) {
    process.stderr.write(`\n✖ payload round-trip failed (${failures.length}):\n`);
    for (const failure of failures) process.stderr.write(`  · ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write(`\npayload:test — OK (${assertions} assertions)\n`);
}

/** A minimal tar.gz containing one entry that points outside its destination. */
function buildTraversalArchive() {
  const block = Buffer.alloc(512, 0);
  const name = '../escaped.txt';
  block.write(name, 0, 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write('00000000003\0', 124); // 3 bytes
  block.write('00000000000\0', 136);
  block.fill(0x20, 148, 156);
  block.write('0', 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0'), 148);
  block[154] = 0;
  block[155] = 0x20;
  const body = Buffer.from('abc');
  const pad = Buffer.alloc(512 - 3);
  return gzipSync(Buffer.concat([block, body, pad, Buffer.alloc(1024)]));
}

main().catch((err) => {
  process.stderr.write(`✖ check-payload-pack: ${err?.stack ?? err}\n`);
  process.exit(1);
});
