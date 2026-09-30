#!/usr/bin/env node
/**
 * Checks that the JavaScript surface, the Kotlin implementation and the manifest
 * describe the same gateway runtime.
 *
 * Why this exists: `modules/node-runtime` is four files in three languages that
 * have to agree, and nothing else reads them together:
 *
 *   - `index.ts` declares what JS may call; `index.web.ts` stubs it;
 *   - `NodeRuntimeModule.kt` implements it as Expo `Function`/`AsyncFunction`;
 *   - `NodeRuntimeHost.kt` shapes the status map JS reads by field name;
 *   - `GatewayService.kt` + `AndroidManifest.xml` are the only reason the
 *     gateway survives the app being backgrounded — and a manifest typo (a
 *     missing `foregroundServiceType`, a service that is not declared at all)
 *     fails at *runtime*, on a phone, as a crash or a silent stop, not at build
 *     time.
 *
 * Gradle compiles the Kotlin, but nothing compiles the *names*: rename a JS
 * method or a status field and both files still build. This check is the cheap
 * half of that contract, and it runs in App CI where there is no Android SDK.
 *
 * It deliberately does not try to be a Kotlin parser. It matches the surfaces
 * those files promise to each other, and every assertion names the file it read.
 *
 *   node scripts/check-runtime-contract.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(ROOT, 'modules', 'node-runtime');

const FILES = {
  index: join(MODULE, 'index.ts'),
  web: join(MODULE, 'index.web.ts'),
  types: join(MODULE, 'src', 'NodeRuntime.types.ts'),
  module: join(MODULE, 'android', 'src', 'main', 'java', 'expo', 'modules', 'noderuntime', 'NodeRuntimeModule.kt'),
  host: join(MODULE, 'android', 'src', 'main', 'java', 'expo', 'modules', 'noderuntime', 'NodeRuntimeHost.kt'),
  service: join(MODULE, 'android', 'src', 'main', 'java', 'expo', 'modules', 'noderuntime', 'GatewayService.kt'),
  prefs: join(MODULE, 'android', 'src', 'main', 'java', 'expo', 'modules', 'noderuntime', 'StartPrefs.kt'),
  manifest: join(MODULE, 'android', 'src', 'main', 'AndroidManifest.xml'),
  installer: join(ROOT, 'lib', 'gatewayInstaller.ts'),
  log: join(ROOT, 'lib', 'gatewayLog.ts'),
  card: join(ROOT, 'components', 'LocalGatewayCard.tsx'),
  bootstrap: join(ROOT, 'gateway', 'bootstrap.mjs'),
};

const sources = Object.fromEntries(
  Object.entries(FILES).map(([key, path]) => [key, readFileSync(path, 'utf8')])
);

const failures = [];
const check = (label, ok, detail = '') => {
  process.stdout.write(`  ${ok ? '✓' : '✖'} ${label}${ok || !detail ? '' : ` — ${detail}`}\n`);
  if (!ok) failures.push(label);
};

/** Names declared in the TS class, e.g. `  readLog(maxBytes: number): ...` */
function tsMethods(source) {
  const names = new Set();
  const body = source.slice(source.indexOf('declare class'), source.indexOf('export default'));
  for (const match of body.matchAll(/^ {2,}([A-Za-z][A-Za-z0-9]*)\(/gm)) names.add(match[1]);
  return names;
}

/** Names exposed by the web stub, whether or not it is a function. */
function webMethods(source) {
  const names = new Set();
  const body = source.slice(source.indexOf('const stub'), source.indexOf('} satisfies'));
  for (const match of body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)(?::|\()/gm)) names.add(match[1]);
  return names;
}

/** Expo `Function("name")` / `AsyncFunction("name")` declarations. */
function kotlinMethods(source) {
  const names = new Set();
  for (const match of source.matchAll(/(?:Async)?Function\("([A-Za-z][A-Za-z0-9]*)"\)/g)) names.add(match[1]);
  return names;
}

/** Keys of a Kotlin `mapOf(...)` / JSON object literal: `"key" to` or `"key"`. */
function kotlinKeys(source, from) {
  const keys = new Set();
  const body = from === undefined ? source : source.slice(source.indexOf(from));
  for (const match of body.matchAll(/"([a-zA-Z][a-zA-Z0-9]*)"\s+to\s/g)) keys.add(match[1]);
  return keys;
}

/** Field names of a TS interface. */
function tsFields(source, interfaceName) {
  const start = source.indexOf(`export interface ${interfaceName}`);
  if (start < 0) return new Set();
  const body = source.slice(start + 1, source.indexOf('\n}', start));
  const fields = new Set();
  for (const match of body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)) fields.add(match[1]);
  return fields;
}

const indexMethods = tsMethods(sources.index);
const webStubMethods = webMethods(sources.web);
const kotlin = kotlinMethods(sources.module);

process.stdout.write('runtime contract:\n');

// ---------------------------------------------------------------- JS ⇄ Kotlin
const missingInKotlin = [...indexMethods].filter((name) => !kotlin.has(name));
check(
  'every JS method exists on the Kotlin module',
  missingInKotlin.length === 0,
  missingInKotlin.join(', ')
);

const missingInWeb = [...indexMethods].filter((name) => !webStubMethods.has(name));
check(
  'the web stub implements the same JS surface',
  missingInWeb.length === 0,
  missingInWeb.join(', ')
);

check(
  'the exit event is declared, typed and emitted under one name',
  sources.module.includes('Events("onExit")') &&
    sources.module.includes('sendEvent("onExit"') &&
    sources.types.includes('onExit: (event: NodeExitEvent)'),
  'Events("onExit") in Kotlin, onExit in NodeRuntimeEvents, sendEvent("onExit") when the runtime exits'
);

// ------------------------------------------------------------- status fields
const statusFields = tsFields(sources.types, 'NodeRuntimeStatus');
const statusKeys = kotlinKeys(sources.host, 'fun status(');
const missingInStatus = [...statusFields].filter((field) => !statusKeys.has(field));
check(
  'the status map carries every field the JS type promises',
  missingInStatus.length === 0,
  missingInStatus.join(', ')
);

const pathFields = tsFields(sources.types, 'NodePaths');
const pathKeys = kotlinKeys(sources.module, 'private fun appPaths()');
const missingInPaths = [...pathFields].filter((field) => !pathKeys.has(field));
check(
  'getPaths() returns every field NodePaths declares',
  missingInPaths.length === 0,
  missingInPaths.join(', ')
);

// -------------------------------------------------------------- start options
const optionFields = tsFields(sources.types, 'StartOptions');
const optionKeys = new Set([
  ...[...sources.module.matchAll(/options\["([a-zA-Z][a-zA-Z0-9]*)"\]/g)].map((m) => m[1]),
]);
const unknownOptions = [...optionFields].filter((field) => !optionKeys.has(field));
check(
  'every StartOptions field is read by the Kotlin module',
  unknownOptions.length === 0,
  unknownOptions.join(', ')
);

// ------------------------------------------------------------- the keep-alive
check(
  'foreground hosting is wired end to end',
  optionKeys.has('foreground') &&
    sources.module.includes('GatewayService.start(context)') &&
    sources.module.includes('StartPrefs.save(context, request)') &&
    sources.service.includes('startForeground('),
  'JS passes foreground → the module saves the request and starts the service → the service calls startForeground'
);

check(
  'the saved request is cleared everywhere it should be',
  sources.module.includes('StartPrefs.clear(context)') && // failed start
    sources.service.includes('StartPrefs.clear(this)') &&
    (sources.service.match(/StartPrefs\.clear\(this\)/g) ?? []).length >= 3, // exit, no-request, stop
  'a request must not outlive the runtime: cleared on a failed start, on exit, and on stop'
);

check(
  'the service resumes the runtime after the process is recreated',
  sources.service.includes('if (!NodeRuntimeHost.isRunning)') &&
    sources.service.includes('StartPrefs.read(this)') &&
    sources.service.includes('NodeRuntimeHost.start(this, request)'),
  'a sticky restart has no JavaScript: StartPrefs is the only thing that knows what to run'
);

check(
  'stopping ends the process, because the runtime cannot be stopped',
  sources.service.includes('Process.killProcess(Process.myPid())') &&
    sources.module.includes('GatewayService.requestStop(') &&
    sources.index.includes('stopHosting(reason: string)'),
  'nodejs-mobile has no stop API, so stop = end the process; the app must say so first'
);

// ------------------------------------------------------------ notification API
check(
  'the notification channel is created before it is used',
  sources.service.includes('createNotificationChannel') && sources.service.includes('ensureChannel()'),
  'Android 8+ drops a notification posted to a channel that does not exist'
);

check(
  'the notification offers a way to stop hosting',
  sources.service.includes('Notification.Action.Builder') && sources.service.includes('ACTION_STOP'),
  'otherwise the only way to stop is to force-stop the app'
);

// ------------------------------------------------------------------ manifest
const manifest = sources.manifest;
check(
  'the service is declared in the module manifest',
  /<service\s+android:name="\.GatewayService"/.test(manifest),
  'a service that is not declared cannot be started, and startForegroundService throws'
);

check(
  'the declared service class exists in Kotlin',
  sources.service.includes('class GatewayService : Service()'),
  'the manifest names it by convention (.GatewayService in this package)'
);

check(
  'the foreground service type is declared and used consistently',
  /android:foregroundServiceType="specialUse"/.test(manifest) &&
    sources.service.includes('ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE'),
  'Android 14+ throws from startForeground if the type is missing on either side'
);

check(
  'the permissions a foreground service needs are declared',
  manifest.includes('android.permission.FOREGROUND_SERVICE') &&
    manifest.includes('android.permission.FOREGROUND_SERVICE_SPECIAL_USE') &&
    manifest.includes('android.permission.POST_NOTIFICATIONS'),
  'the service will not start without the first two; the notification is hidden without the third'
);

check(
  'the special-use subtype property is declared',
  manifest.includes('PROPERTY_SPECIAL_USE_FGS_SUBTYPE'),
  'Android 14+ requires a subtype explanation for specialUse services'
);

// --------------------------------------------------------------- host ⇄ module
check(
  'the module no longer owns runtime state',
  !/startedOnce/.test(sources.module) && sources.host.includes('private val startedOnce'),
  'the process-wide host owns it, because the service can outlive the JS module'
);

check(
  'the module delegates start/stop/status to the host',
  sources.module.includes('NodeRuntimeHost.start(context, request)') &&
    sources.module.includes('NodeRuntimeHost.status(') &&
    sources.module.includes('NodeRuntimeHost.readLog(') &&
    sources.module.includes('NodeRuntimeHost.clearLog('),
  'otherwise a start from the service would be invisible to the app'
);

check(
  'runtime exits are forwarded to JavaScript',
  sources.module.includes('OnCreate { NodeRuntimeHost.addExitListener(') &&
    sources.module.includes('OnDestroy { NodeRuntimeHost.removeExitListener('),
  'registered for the module lifetime, because the runtime outlives a single app session'
);

// ------------------------------------------------- app ⇄ bootstrap invocation
//
// This handshake is the most expensive one to get wrong: when it failed on a
// real phone the bootstrap loaded, did nothing and exited 0, so the app
// reported a crash that had not happened and the log was empty. Both halves are
// asserted here because neither language's compiler can see the other.
const runFlag = sources.installer.match(/export const GATEWAY_RUN_FLAG = '([^']+)'/)?.[1];

// The same class of agreement as the flag: two files, two languages, one file
// name. The card reads what the bootstrap writes, so a rename on one side would
// show up as "the gateway printed nothing" — the failure this whole section
// exists to make impossible.
const gatewayLogName = sources.bootstrap.match(/const GATEWAY_LOG_NAME = '([^']+)'/)?.[1];
const installerLogName = sources.installer.match(/const GATEWAY_LOG_FILE = '([^']+)'/)?.[1];

check(
  'both sides agree on the gateway log file name',
  Boolean(gatewayLogName) && gatewayLogName === installerLogName,
  `the bootstrap writes it and the app reads it (bootstrap ${JSON.stringify(
    gatewayLogName
  )}, app ${JSON.stringify(installerLogName)})`
);

check(
  'the bootstrap writes its own log, not just stdout',
  sources.bootstrap.includes('appendToGatewayLog(line)') &&
    sources.bootstrap.includes('writeFileSync(file, \'\')'),
  'a file only the gateway writes cannot be buried by the app\'s other output'
);

check(
  'the app reads the gateway log for state',
  sources.installer.includes('NodeRuntime.readFile(gatewayLogPath(), maxBytes)'),
  'the gateway writes it, and only the gateway writes it'
);

// The firehose may be read for a crash report, and must never decide state: it
// collects every writer in the app, so a tail of it can be nothing but WebView
// noise. Asserted on the function bodies, because "readLog appears somewhere in
// this file" is satisfied by the display path alone.
const bodyOf = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return '';
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
};
const stateLog = bodyOf(sources.installer, 'readGatewayLog');
const displayLog = bodyOf(sources.installer, 'readRuntimeOutput');

check(
  'state never comes from the process-wide runtime log',
  stateLog.length > 0 && !stateLog.includes('NodeRuntime.readLog('),
  'a 64 KB tail of it can be all WebView noise, which is how an error became "nothing happened"'
);

check(
  'the crash-report view reads it, after the last runtime start',
  displayLog.includes('NodeRuntime.readLog(') &&
    displayLog.includes('lastIndexOf(marker)') &&
    sources.installer.includes('const runtimeTail = await readRuntimeOutput()'),
  'a native death leaves its last words there and nowhere else'
);

check(
  'the app reads the boot record instead of only watching the runtime die',
  sources.installer.includes("const BOOT_LOG_FILE = 'boot.log'") &&
    sources.installer.includes('readBootRecord()') &&
    sources.installer.includes('describeBootTrace(bootRecord)') &&
    sources.bootstrap.includes("const BOOT_LOG_NAME = 'boot.log'") &&
    sources.bootstrap.includes('function bootTrace('),
  'a process killed outright writes nothing on the way out, so the record has to be written before the step'
);

// The record is only worth writing because it is flushed: appendFileSync would
// leave the last line in a buffer that a SIGKILL takes with it.
check(
  'the boot record is flushed, not buffered',
  sources.bootstrap.includes('fsyncSync(fd)') &&
    sources.bootstrap.includes('const fd = openSync(bootLogPath, \'a\')'),
  'an unflushed write is a write that never happened'
);

check(
  'the record is read verbatim for a boot in progress, and interpreted only after a death',
  sources.log.includes('export function bootRecordStep(') &&
    sources.installer.includes('const bootStep = bootRecordStep(bootRecord)') &&
    sources.card.includes("phase === 'failed' && state?.bootTrace") &&
    sources.card.includes("state?.bootStep && (phase === 'starting' || phase === 'installing')"),
  'while the process is alive the record cannot say whether it died in that step or is working on it'
);

check(
  'the service is started before the runtime, not after',
  sources.module.indexOf('GatewayService.start(context)') <
    sources.module.indexOf('NodeRuntimeHost.start(context, request)'),
  'the payload boots under foreground protection, which is when the OS is most likely to reclaim the process'
);

check(
  'a failed start leaves no notification behind',
  sources.module.includes('GatewayService.abandon(context)') &&
    sources.service.includes('fun abandon(context: Context)'),
  'the service is up before the runtime starts, so the failure path has to undo it — without ending the process'
);

check(
  'the app asks Android why the previous run ended',
  sources.host.includes('getHistoricalProcessExitReasons(context.packageName, 0, 16)') &&
    /\.reason != ApplicationExitInfo\.REASON_USER_REQUESTED/.test(sources.host) &&
    sources.host.includes('"previousExit" to context?.let { previousExit(it) }') &&
    sources.types.includes('previousExit: string | null;') &&
    sources.installer.includes('previousExit: status.previousExit ?? null'),
  'a process killed for memory writes nothing anywhere; this is the only account of it that exists'
);

check(
  'that diagnostic survives the API guard',
  sources.host.includes('Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R') &&
    sources.host.includes('runCatching { previousExitFrom(context) }'),
  'ApplicationExitInfo is API 30+, and a diagnostic must never be the reason a start fails'
);

check(
  'the runtime log says what memory the process had',
  sources.host.includes('"[node-runtime] ${memoryFacts(context)}"') &&
    sources.host.includes('ActivityManager.MemoryInfo()'),
  'a runtime killed for memory leaves no other evidence at all'
);

// The kill this whole section exists for: V8 sizes its heap from the device's
// memory unless told otherwise, so with `largeHeap` it is free to grow past what
// Android will tolerate — and that kill leaves nothing behind.
check(
  'node is given a heap limit derived from the app\'s real budget',
  sources.host.includes('Runtime.getRuntime().maxMemory()') &&
    sources.host.includes('--max-old-space-size=${heapCapMb(context)}'),
  'an unbounded V8 heap is a silent low-memory kill waiting for a big payload'
);

check(
  'the limit is placed where node parses options, not after the script',
  sources.host.includes('listOf("node") + nodeFlags + request.scriptPath + request.args') &&
    sources.host.includes('(nodeFlags + request.args).joinToString(" ")'),
  'after the script name an option is just an argument, and the cap never applies'
);

check(
  'a wrong budget cannot produce a heap too small to start node',
  sources.host.includes('MIN_HEAP_CAP_MB') &&
    sources.host.includes('.coerceAtLeast(MIN_HEAP_CAP_MB)') &&
    sources.host.includes('runCatching { Runtime.getRuntime().maxMemory()'),
  'a failed read or a nonsense number must not turn into a boot that cannot fit'
);

check(
  'the native crash dump is captured, not just the signal number',
  sources.host.includes('ApplicationExitInfo.REASON_CRASH_NATIVE -> "it crashed in native code') &&
    sources.host.includes('info.traceInputStream') &&
    sources.host.includes('private fun crashTrace(') &&
    sources.host.includes('Regex("^\\\\s*#\\\\d+ ")'),
  'a native crash is the one failure no log of ours can describe, and the tombstone names the library'
);

check(
  'the signals are named in words',
  ['SIGILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS'].every((name) => sources.host.includes(name)),
  '"killed by signal 11" is true and useless; each of these points somewhere different'
);

check(
  'the payload is checked for native libraries built for another CPU',
  sources.bootstrap.includes('function inspectNativeLibraries(') &&
    sources.bootstrap.includes('function elfMachine(') &&
    sources.bootstrap.includes('are built for ') &&
    sources.bootstrap.indexOf('inspectNativeLibraries(appDir)') <
      sources.bootstrap.lastIndexOf('bootTrace(`loading ${entry}`)'),
  'the payload is built on an x86-64 runner; a prebuilt native module that travels to an arm64 phone crashes it'
);

check(
  'the two stack defaults agree, and neither is small',
  (sources.module.match(/DEFAULT_STACK_MB = (\d+)/) ?? [])[1] ===
    (sources.host.match(/DEFAULT_STACK_MB = (\d+)/) ?? [])[1] &&
    Number((sources.host.match(/DEFAULT_STACK_MB = (\d+)/) ?? [])[1]) >= 16,
  'the frames under JavaScript recursion live on the native stack, and running out is a SIGSEGV'
);

check(
  'the app can still be allowed a large heap',
  manifest.includes('largeHeap'),
  'a Next server booting on a phone is what the flag exists for'
);

check(
  'the phase is decided by the runtime state, not the log alone',
  sources.installer.includes('deriveGatewayPhase({') &&
    !sources.installer.includes("fromLog.phase === 'starting' ||"),
  'a log line records what happened once; it is not evidence of what is happening now'
);

// The runtime's own markers get their own file for the same reason: a 64 KB tail
// of node.log can be all WebView noise, and then the app cannot tell whether the
// script was handed over — the distinction the whole of §5f rests on.
const runtimeLogName = sources.host.match(/RUNTIME_LOG_FILE_NAME = "([^"]+)"/)?.[1];
const appRuntimeLogName = sources.installer.match(/const RUNTIME_LOG_FILE = '([^']+)'/)?.[1];

check(
  'both sides agree on the runtime marker file name',
  Boolean(runtimeLogName) && runtimeLogName === appRuntimeLogName,
  `NodeRuntimeHost writes it and the app reads it (host ${JSON.stringify(
    runtimeLogName
  )}, app ${JSON.stringify(appRuntimeLogName)})`
);

check(
  'the runtime writes its markers twice: to node.log and to that file',
  sources.host.includes('appendToLog(logFilePath, line)') &&
    sources.host.includes('appendToLog(runtimeLogPath(context), line)'),
  'one copy for a crash report, one the app can always find'
);

check(
  'the app passes a run flag to the runtime',
  Boolean(runFlag) && sources.installer.includes('args: [GATEWAY_RUN_FLAG]'),
  'in argv, because the script path does not reliably identify the script'
);

check(
  'the bootstrap reads the flag the app sends',
  Boolean(runFlag) &&
    sources.bootstrap.includes(`RUN_FLAG = '${runFlag}'`) &&
    sources.bootstrap.includes('process.argv.includes(RUN_FLAG)'),
  `these two spellings are the whole handshake (currently ${JSON.stringify(runFlag)})`
);

check(
  'the bootstrap does not trust the script path alone',
  sources.bootstrap.includes(
    'realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))'
  ),
  'Node resolves symlinks for import.meta.url but not argv[1], and Android symlinks app data dirs'
);

check(
  'the bootstrap says it started before anything can fail',
  sources.bootstrap.includes('starting on node ${process.version}'),
  'so an empty log means the script never ran, not that it failed silently'
);

// --------------------------------------------------------------------- report
if (failures.length) {
  process.stderr.write(`\n✖ runtime-contract: ${failures.length} problem(s)\n`);
  process.stderr.write('\nThese files must agree with each other:\n');
  for (const [key, path] of Object.entries(FILES)) process.stderr.write(`  ${key.padEnd(8)} ${path}\n`);
  process.exit(1);
}

process.stdout.write(
  `\nruntime-contract — OK (${indexMethods.size} JS methods, ${statusFields.size} status fields, ` +
    `manifest, bootstrap invocation + both logs checked)\n`
);
