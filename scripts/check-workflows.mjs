#!/usr/bin/env node
/**
 * CI helper — static audit of `.github/workflows/*.yml`.
 *
 * Why this exists
 * ---------------
 * GitHub validates a workflow file as a whole *before* scheduling any job.
 * If an expression references a context that isn't available at that key,
 * the entire file is rejected with e.g.
 *
 *     Invalid workflow file: .github/workflows/x.yml#L1
 *     (Line: 47, Col: 9): Unrecognized named-value: 'secrets'. Located at
 *     position 1 within expression: secrets.TOKEN != ''
 *
 * and the failure mode is nasty: the run dies in 0s with **zero jobs**, the
 * run name shows up as the file path instead of the workflow name, and none
 * of the workflow's triggers fire — not even `workflow_dispatch`, so you
 * cannot trigger it by hand either. One typo silently disables a whole
 * workflow, and the only clue is "This run likely failed because of a
 * workflow file issue".
 *
 * This script reproduces the documented context-availability table for the
 * keys where contexts are restricted:
 * https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability
 *
 * Keys that accept the full context set (`run:`, `with:`, `name:`, …) are
 * deliberately not checked — no restriction applies there.
 *
 * Usage: node scripts/check-workflows.mjs [dir]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/** Every context GitHub recognises, per the reference above. */
const ALL_CONTEXTS = [
  'github', 'env', 'vars', 'secrets', 'job', 'steps', 'needs',
  'inputs', 'matrix', 'strategy', 'runner',
];

// Allowed contexts per key — transcribed from the docs table.
const WORKFLOW_ENV = ['github', 'secrets', 'inputs', 'vars'];
const WORKFLOW_CONCURRENCY = ['github', 'inputs', 'vars'];
const WORKFLOW_IF = ['github', 'inputs', 'vars'];
const JOB_IF = ['github', 'needs', 'vars', 'inputs'];
const JOB_ENV = ['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs'];
const JOB_CONCURRENCY = ['github', 'needs', 'strategy', 'matrix', 'inputs', 'vars'];
const STEP_IF = ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'steps', 'inputs'];
const STEP_ENV = ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'steps', 'inputs'];

const violations = [];
let checked = 0;

/** Drop `'single quoted'` string literals so text inside them isn't scanned. */
function stripStringLiterals(expr) {
  return String(expr).replace(/''/g, '').replace(/'[^']*'/g, " '' ");
}

/** Context names referenced as `ctx.something` in an expression. */
function contextsUsed(expr) {
  const used = new Set();
  for (const token of stripStringLiterals(expr).split(/[^A-Za-z_0-9.]+/)) {
    if (!token.includes('.')) continue;
    const head = token.split('.')[0];
    if (ALL_CONTEXTS.includes(head)) used.add(head);
  }
  return used;
}

function check(key, expr, allowed, file) {
  if (expr == null) return;
  if (typeof expr !== 'string' && typeof expr !== 'boolean' && typeof expr !== 'number') return;
  checked++;
  for (const ctx of contextsUsed(expr)) {
    if (allowed.includes(ctx)) continue;
    violations.push({ file, key, ctx, allowed, expr: String(expr) });
  }
}

function checkMapEntries(key, map, allowed, file) {
  if (!map || typeof map !== 'object') return;
  for (const [name, value] of Object.entries(map)) {
    check(`${key}.${name}`, value, allowed, file);
  }
}

function auditDocument(doc, file) {
  if (!doc || typeof doc !== 'object') return;

  check('if', doc.if, WORKFLOW_IF, file);
  check('concurrency', doc.concurrency && typeof doc.concurrency === 'object' ? doc.concurrency.group : undefined, WORKFLOW_CONCURRENCY, file);
  checkMapEntries('env', doc.env, WORKFLOW_ENV, file);

  const jobs = doc.jobs;
  if (!jobs || typeof jobs !== 'object') return;

  for (const [jobId, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') continue;

    check(`jobs.${jobId}.if`, job.if, JOB_IF, file);
    check(`jobs.${jobId}.concurrency`, job.concurrency && typeof job.concurrency === 'object' ? job.concurrency.group : undefined, JOB_CONCURRENCY, file);
    checkMapEntries(`jobs.${jobId}.env`, job.env, JOB_ENV, file);

    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const [i, step] of steps.entries()) {
      if (!step || typeof step !== 'object') continue;
      const label = step.name ? `"${step.name}"` : (step.uses || `[${i}]`);
      const where = `jobs.${jobId}.steps[${label}]`;
      check(`${where}.if`, step.if, STEP_IF, file);
      checkMapEntries(`${where}.env`, step.env, STEP_ENV, file);
    }
  }
}

function main() {
  const target = process.argv[2] || '.github/workflows';
  let files;
  try {
    const st = statSync(target);
    files = st.isDirectory()
      ? readdirSync(target).filter((f) => /\.ya?ml$/i.test(f)).sort().map((f) => join(target, f))
      : [target];
  } catch (err) {
    console.error(`check-workflows: cannot read ${target}: ${err.message}`);
    process.exit(1);
  }

  for (const file of files) {
    let doc;
    try {
      doc = yaml.load(readFileSync(file, 'utf8'));
    } catch (err) {
      violations.push({ file, key: '(file)', ctx: 'YAML', allowed: [], expr: err.message.split('\n')[0] });
      continue;
    }
    auditDocument(doc, file);
  }

  for (const v of violations) {
    if (v.ctx === 'YAML') {
      console.error(`✖ ${v.file}\n    not valid YAML: ${v.expr}`);
      continue;
    }
    console.error(
      `✖ ${v.file}\n` +
      `    ${v.key}: the '${v.ctx}' context is not available here\n` +
      `      expression: ${v.expr}\n` +
      `      allowed:    ${v.allowed.join(', ')}`,
    );
    if (v.ctx === 'secrets' && /\.if$/.test(v.key)) {
      console.error(
        '      fix: read the secret through env: in a step, then gate on that\n' +
        '           step\'s output (if: ${{ steps.<id>.outputs.<name> == \'true\' }})',
      );
    }
  }

  if (violations.length) {
    console.error(`\ncheck-workflows: ${violations.length} problem(s) in ${files.length} file(s) — GitHub would reject these workflows.`);
    process.exit(1);
  }
  console.log(`check-workflows: OK — ${files.length} file(s), ${checked} expression(s) checked.`);
}

main();
