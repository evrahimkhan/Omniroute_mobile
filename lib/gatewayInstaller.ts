/**
 * Hosting the OmniRoute gateway on the device.
 *
 * "Installing" here means: download a prebuilt payload, verify it, unpack it,
 * and start it inside the embedded Node runtime — all of it on the phone, after
 * the APK is installed. The work is done by `gateway/bootstrap.mjs`, running in
 * that runtime; this module is the app's thin side of it:
 *
 *   1. write the bootstrap script into app storage (the app ships it as a
 *      string, because the script is what downloads everything else),
 *   2. start the runtime on it, passing the payload URL/checksum through the
 *      environment — the only place the runtime reads configuration from,
 *   3. watch the log for progress, then poll `/healthz` until the gateway
 *      answers, so callers get a URL that is actually serving.
 *
 * Why the download happens in Node rather than in the app: the runtime already
 * has fetch, crypto and zlib, so the app needs no download manager, no
 * unzipper, and no additional native dependency to install a 100+ MB payload.
 *
 * See docs/LOCAL_GATEWAY.md for the design and its constraints.
 */

import { PermissionsAndroid, Platform } from 'react-native';

import NodeRuntime from '../modules/node-runtime';
import { BOOTSTRAP_SCRIPT } from './gateway/bootstrapScript.generated';
import {
  bootRecordStep,
  deriveGatewayPhase,
  describeBootTrace,
  describeGatewayLog,
  describeRuntimeExit,
  gatewayLogTail,
  type GatewayProgress,
} from './gatewayLog';

export { gatewayLogTail, gatewayProgress, type GatewayProgress } from './gatewayLog';

/** The gateway's default port, and the loopback URL the WebView points at. */
export const LOCAL_GATEWAY_PORT = 20128;
export const LOCAL_GATEWAY_URL = `http://127.0.0.1:${LOCAL_GATEWAY_PORT}`;

/**
 * Where the payload comes from.
 *
 * A *fixed* release tag, deliberately: the app also publishes APK releases, and
 * `releases/latest` would flip to whichever came last — so a routine APK release
 * would break every installed app's ability to fetch the payload.
 *
 * Override at build time with `EXPO_PUBLIC_GATEWAY_PAYLOAD_URL` (useful for
 * testing a local build).
 */
const PAYLOAD_TAG = 'gateway-payload';
const RELEASE_BASE = `https://github.com/evrahimkhan/Omniroute_mobile/releases/download/${PAYLOAD_TAG}`;

/**
 * Tells the bootstrap it is being run as a program, not imported.
 *
 * It is passed as an argv flag rather than inferred from the script's path
 * because the path cannot be relied on: Node resolves symlinks for
 * `import.meta.url` but not for `argv[1]`, and Android symlinks its app-data
 * directories. Without the flag, a mismatch makes the bootstrap load, do
 * nothing and exit 0 — which is indistinguishable from a crash on the phone.
 * Mirrors `RUN_FLAG` in `gateway/bootstrap.mjs`; the contract check keeps the
 * two spellings in step.
 */
export const GATEWAY_RUN_FLAG = '--gateway-run';

export const DEFAULT_PAYLOAD_URL =
  process.env.EXPO_PUBLIC_GATEWAY_PAYLOAD_URL ?? `${RELEASE_BASE}/omniroute-payload.tar.gz`;

/**
 * Where to read the expected checksum from, when the app does not pin one.
 * CI publishes this manifest next to the archive.
 */
export const DEFAULT_PAYLOAD_SHA256_URL =
  process.env.EXPO_PUBLIC_GATEWAY_PAYLOAD_SHA256_URL ?? `${RELEASE_BASE}/omniroute-payload.tar.gz.json`;

/**
 * A sha256 baked into this build, if one was given at build time.
 *
 * Empty by default, and that is the intended default: the payload is published
 * independently of the app, so pinning a digest here would mean every payload
 * update breaks every installed app. Left empty, the bootstrap instead fetches
 * the manifest CI publishes — which catches a truncated or corrupted download
 * (the realistic failure) but not a compromised host. Pinning protects against
 * the latter, at the cost of having to ship a new app for each payload change.
 */
export const PAYLOAD_SHA256 = (process.env.EXPO_PUBLIC_GATEWAY_PAYLOAD_SHA256 ?? '').trim().toLowerCase();

const BOOTSTRAP_FILE = 'bootstrap.mjs';
const MARKER_FILE = 'install.json';

export type GatewayPhase =
  /** This build has no embedded runtime (web, or an APK built without it). */
  | 'unavailable'
  /** Nothing installed yet. */
  | 'idle'
  /** Downloading or unpacking the payload. */
  | 'installing'
  /** Installed; the runtime is up and the server is booting. */
  | 'starting'
  /** The gateway is answering on /healthz. */
  | 'ready'
  /** The runtime exited, or the bootstrap reported a failure. */
  | 'failed';

export interface GatewayState {
  phase: GatewayPhase;
  /**
   * A foreground service is holding the process, so the gateway keeps serving
   * with the app closed.
   */
  keepAlive: boolean;
  /** A payload is installed and looks complete. */
  installed: boolean;
  /** When the payload was installed (marker's timestamp). */
  installedAt: string | null;
  /** Tail of the gateway's log plus the runtime's markers — what the state is read from. */
  logTail: string;
  /**
   * What the runtime process itself printed during its most recent run — the
   * payload server's own output, and whatever a native crash said.
   *
   * Display only, never state: this comes from the process-wide stdout capture,
   * so it also carries every other writer in the app. Kept separate so noise can
   * never again bury the lines the app reasons about.
   */
  runtimeTail: string;
  /** Present when the phase is `failed`. */
  error?: string;
  /**
   * The runtime started and is over. Distinguishes "node is done, so this
   * process can never host again" from a failure that has nothing to do with
   * the runtime — an install that could not download, say — where telling the
   * user to reopen the app would be wrong advice.
   */
  runtimeExited: boolean;
  /**
   * Android's account of the last abnormal exit, when there is one.
   *
   * The only account of a process the system killed: such a process writes
   * nothing to any log before it is gone. Android keeps the reason, so the card
   * can say "the system killed it for memory" instead of leaving everyone to
   * guess.
   */
  previousExit: string | null;
  /**
   * What the last line of the boot record means, when there is a record.
   *
   * Answers the question the other channels cannot: how far the boot got before
   * the process was killed outright. Null when nothing was ever recorded (a
   * runtime that never started) and on a genuinely clean boot.
   */
  bootTrace: string | null;
  /**
   * The last step the boot record names, verbatim — the same fact as
   * {@link bootTrace} without the conclusion drawn from it.
   *
   * Shown while the boot is still in progress, when "it died while loading" would
   * be a guess: a step recorded minutes ago and a step being worked on right now
   * read identically in the file, and only the runtime's state tells them apart.
   */
  bootStep: string | null;
  /** The URL to point the WebView at once the phase is `ready`. */
  url: string;
}

export interface StartGatewayOptions {
  /** Defaults to {@link DEFAULT_PAYLOAD_URL}. */
  payloadUrl?: string;
  /** Defaults to {@link PAYLOAD_SHA256} (usually empty). */
  payloadSha256?: string;
  /** Defaults to {@link DEFAULT_PAYLOAD_SHA256_URL}; ignored when a digest is pinned. */
  payloadSha256Url?: string;
  /** Reinstall even if the same payload is already installed. */
  force?: boolean;
  /** Defaults to {@link LOCAL_GATEWAY_PORT}. */
  port?: number;
  /**
   * Keep the gateway running while the app is in the background. Defaults to
   * true, because a gateway that stops when the app is not on screen is not
   * really hosting anything — the user can turn it off.
   */
  keepAlive?: boolean;
}

/**
 * Shown when hosting stops because the runtime cannot be shut down in-process:
 * nodejs-mobile has no stop API, so stopping means ending the process.
 */
export const STOPPED_REASON =
  'The gateway process was stopped. Reopen the app to start it again.';

export function isLocalGatewaySupported(): boolean {
  return NodeRuntime.isAvailable();
}

/** Why the local gateway cannot run here, or `null` if it can. */
export function localGatewayUnavailableReason(): string | null {
  return NodeRuntime.isAvailable()
    ? null
    : NodeRuntime.getUnavailableReason() ??
        'This build has no embedded Node runtime, so the gateway cannot run on the device.';
}

function bootstrapPath(): string {
  return `${NodeRuntime.getPaths().gatewayDir}/${BOOTSTRAP_FILE}`;
}

function markerPath(): string {
  return `${NodeRuntime.getPaths().gatewayDir}/${MARKER_FILE}`;
}

interface InstallMarker {
  url?: string;
  sha256?: string | null;
  installedAt?: string;
}

async function readMarker(): Promise<InstallMarker | null> {
  if (!NodeRuntime.fileExists(markerPath())) return null;
  try {
    const raw = await NodeRuntime.readFile(markerPath(), 64 * 1024);
    return raw ? (JSON.parse(raw) as InstallMarker) : null;
  } catch {
    // A marker we cannot parse means "not installed", which is safe: it
    // re-installs rather than trusting a half-written file.
    return null;
  }
}

/** Tail of the runtime log; the bootstrap's progress lands here. */
/** The gateway's own log, written by the bootstrap. Mirrors its GATEWAY_LOG_NAME. */
const GATEWAY_LOG_FILE = 'gateway.log';

/**
 * The runtime's markers, written by `NodeRuntimeHost`. Mirrors its
 * RUNTIME_LOG_FILE_NAME.
 *
 * A separate file because `node.log` is the process's captured stdout/stderr:
 * everything in the app that writes there (Android WebView, most visibly) lands
 * in it, and a tail read of 64 KB can miss the markers entirely on a busy run —
 * which is how "the gateway printed nothing" used to be reported for a gateway
 * that had failed with a specific, printed reason.
 */
const RUNTIME_LOG_FILE = 'runtime.log';

/**
 * The bootstrap's boot record. Mirrors its BOOT_LOG_NAME.
 *
 * Written only by the bootstrap, and written *ahead* of each step with an fsync,
 * so unlike the process-wide capture it is both trustworthy as evidence and
 * still there when the process is killed outright.
 */
const BOOT_LOG_FILE = 'boot.log';

function gatewayLogPath(): string {
  return `${NodeRuntime.getPaths().gatewayDir}/${GATEWAY_LOG_FILE}`;
}

function runtimeLogPath(): string {
  return `${NodeRuntime.getPaths().gatewayDir}/${RUNTIME_LOG_FILE}`;
}

function bootLogPath(): string {
  return `${NodeRuntime.getPaths().gatewayDir}/${BOOT_LOG_FILE}`;
}

/**
 * The log the card shows and the state machine reads.
 *
 * Two sources, because they answer different questions: the gateway's own log
 * (did the script run, and what did it do) and the runtime's markers (was the
 * script even handed over, and how did node end). Neither is conclusive alone —
 * an empty gateway log only means something next to a runtime that started.
 */
/**
 * The runtime's own output for its most recent run, for a crash report.
 *
 * `node.log` is the process's captured stdout/stderr and therefore full of other
 * writers (Android WebView, React Native). Everything before the last
 * `[node-runtime] starting node` marker belongs to an earlier run or to the app
 * warming up, so that is where this starts — the payload server's output and any
 * native abort message land after it.
 */
export async function readRuntimeOutput(maxBytes = 64 * 1024): Promise<string> {
  const raw = await NodeRuntime.readLog(maxBytes).catch(() => '');
  if (!raw) return '';
  const marker = '[node-runtime] starting node';
  const at = raw.lastIndexOf(marker);
  const relevant = at === -1 ? raw : raw.slice(at);
  const lines = relevant.split('\n');
  return lines.slice(-40).join('\n').trim();
}

/**
 * The boot record, as text.
 *
 * Small on purpose (a dozen lines), and read on its own so a crash report can
 * quote it without the firehose's noise. Never used to decide state: it says how
 * a *previous* process died, which the runtime's own status already covers.
 */
export async function readBootRecord(maxBytes = 32 * 1024): Promise<string> {
  return (await NodeRuntime.readFile(bootLogPath(), maxBytes).catch(() => '')) ?? '';
}

export async function readGatewayLog(maxBytes = 64 * 1024): Promise<string> {
  const runtimeLog = await NodeRuntime.readFile(runtimeLogPath(), maxBytes).catch(() => null);
  const gatewayLog = await NodeRuntime.readFile(gatewayLogPath(), maxBytes).catch(() => null);

  // Gateway first: it is the narrative (what the install is doing). The runtime
  // markers answer the questions the gateway cannot — whether node was handed
  // the script at all, and how it ended.
  return [gatewayLog ?? '', runtimeLog ?? ''].filter(Boolean).join('\n');
}

/** Current state, derived from the native runtime, the marker and the log. */
export async function gatewayState(): Promise<GatewayState> {
  const url = LOCAL_GATEWAY_URL;
  if (!NodeRuntime.isAvailable()) {
    return {
      phase: 'unavailable',
      installed: false,
      installedAt: null,
      keepAlive: false,
      runtimeExited: false,
      previousExit: null,
      bootTrace: null,
      bootStep: null,
      logTail: '',
      runtimeTail: '',
      error: localGatewayUnavailableReason() ?? undefined,
      url,
    };
  }

  const status = NodeRuntime.getStatus();
  const keepAlive = Boolean(status.keepAlive);
  const marker = await readMarker();
  const log = await readGatewayLog();
  const runtimeTail = await readRuntimeOutput();
  const bootRecord = await readBootRecord();
  const bootTrace = describeBootTrace(bootRecord);
  const bootStep = bootRecordStep(bootRecord);
  const fromLog = describeGatewayLog(log);

  if (status.exited || fromLog.phase === 'failed') {
    return {
      phase: 'failed',
      installed: Boolean(marker),
      installedAt: marker?.installedAt ?? null,
      keepAlive: false,
      runtimeExited: Boolean(status.exited),
      previousExit: status.previousExit ?? null,
      bootTrace,
      bootStep,
      logTail: log,
      runtimeTail,
      // A printed failure is its own explanation. Without one, the runtime's exit
      // is all we have — and the boot record says where in the boot it happened,
      // which is the difference between "the payload is broken" and "the phone
      // ran out of memory".
      error:
        fromLog.error ??
        [describeRuntimeExit(status.exitCode, log), status.running ? null : bootTrace]
          .filter(Boolean)
          .join(' '),
      url,
    };
  }

  const phase = deriveGatewayPhase({
    running: status.running,
    exited: Boolean(status.exited),
    hasMarker: Boolean(marker),
    log,
  }) as GatewayPhase;

  return {
    phase,
    installed: Boolean(marker),
    installedAt: marker?.installedAt ?? null,
    keepAlive,
    runtimeExited: Boolean(status.exited),
    previousExit: status.previousExit ?? null,
    bootTrace,
    bootStep,
    logTail: log,
    runtimeTail,
    url,
  };
}

/**
 * Ask for the permission the keep-alive notification needs on Android 13+.
 *
 * Denial is not fatal — the foreground service still runs, it just cannot show
 * its notification, and the notification is how the user sees that the phone is
 * hosting something (and how they stop it). So this asks, then carries on
 * either way rather than blocking the install on an answer.
 */
async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
  try {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    // Some ROMs throw instead of answering; the service is unaffected.
    return false;
  }
}

/**
 * Start the embedded runtime on the bootstrap script. Resolves as soon as the
 * runtime thread is up — *not* when the gateway is serving, because a first run
 * downloads and unpacks a large payload and can take minutes. Use
 * {@link waitForLocalGateway} for that.
 *
 * Throws if the runtime is missing, if it was already started (it can only
 * start once per app process), or if the bootstrap script cannot be written.
 */
export async function startLocalGateway(options: StartGatewayOptions = {}): Promise<void> {
  if (!NodeRuntime.isAvailable()) {
    throw new Error(localGatewayUnavailableReason() ?? 'Embedded runtime unavailable');
  }

  const status = NodeRuntime.getStatus();
  if (status.running) return; // already started; nothing to do
  if (status.exited) {
    throw new Error(
      'The gateway runtime already ran and exited in this app session. Close and reopen the app to start it again.'
    );
  }

  const paths = NodeRuntime.getPaths();
  const scriptPath = bootstrapPath();
  await NodeRuntime.writeFile(scriptPath, BOOTSTRAP_SCRIPT);

  const payloadUrl = options.payloadUrl ?? DEFAULT_PAYLOAD_URL;
  const sha = (options.payloadSha256 ?? PAYLOAD_SHA256).trim().toLowerCase();
  const shaUrl = options.payloadSha256Url ?? DEFAULT_PAYLOAD_SHA256_URL;
  const port = options.port ?? LOCAL_GATEWAY_PORT;

  const env: Record<string, string> = {
    GATEWAY_DIR: paths.gatewayDir,
    GATEWAY_PORT: String(port),
    GATEWAY_HOST: '127.0.0.1',
  };
  if (options.keepAlive ?? true) await requestNotificationPermission();

  if (payloadUrl) env.GATEWAY_PAYLOAD_URL = payloadUrl;
  // A pinned digest wins; otherwise let the bootstrap fetch the published
  // manifest, so a download that arrives corrupt is still caught.
  if (sha) env.GATEWAY_PAYLOAD_SHA256 = sha;
  else if (shaUrl) env.GATEWAY_PAYLOAD_SHA256_URL = shaUrl;
  if (options.force) env.GATEWAY_FORCE_INSTALL = '1';
  // How the *last* process ended, when Android will say. A fatal signal is the
  // one piece of the previous death the bootstrap cannot know on its own: a
  // process that segfaults writes nothing about its own death, and its boot record
  // ends at the same line whether the kernel killed it or a swipe did, because
  // neither path gets to log. Telling them apart is what makes "it died while
  // serving" countable — see the strike policy in gateway/bootstrap.mjs.
  if (status.previousExit && /SIGSEGV|SIGILL|SIGBUS|SIGABRT/.test(status.previousExit)) {
    env.GATEWAY_PREV_DEATH = 'fatal-signal';
  }

  // Empty both logs before starting, so the card can never show a previous
  // attempt's failure as this one's — including when the runtime starts and
  // produces no output at all, which is the case that has no other signal.
  await Promise.all([
    NodeRuntime.writeFile(gatewayLogPath(), ''),
    NodeRuntime.writeFile(runtimeLogPath(), ''),
  ]);

  await NodeRuntime.start({
    scriptPath,
    args: [GATEWAY_RUN_FLAG],
    workingDirectory: paths.gatewayDir,
    logFilePath: paths.logFilePath,
    env,
    foreground: options.keepAlive ?? true,
  });
}

/**
 * Stop hosting and release the process.
 *
 * Nothing after this runs: the runtime cannot be stopped in-process, so the
 * only way to stop a gateway is to end the app. Callers should warn first (the
 * card asks for confirmation) and must not await anything after it.
 */
export function stopLocalGateway(reason: string = STOPPED_REASON): void {
  if (!NodeRuntime.isAvailable()) return;
  NodeRuntime.stopHosting(reason);
}

export interface WaitForGatewayOptions {
  /** How long to wait for /healthz. First runs download and unpack, so be generous. */
  timeoutMs?: number;
  /** Poll interval. */
  intervalMs?: number;
  /** Called on every poll, for progress UI. */
  onProgress?: (state: GatewayState) => void;
  /** Called before each poll, so callers can stop waiting (unmount, cancel). */
  shouldContinue?: () => boolean;
}

/**
 * Poll the local gateway until it answers, and return its URL.
 *
 * Returning the URL only after `/healthz` responds means callers can save it
 * straight into settings: a URL that does not answer would drop the user into a
 * broken WebView.
 */
export async function waitForLocalGateway(
  options: WaitForGatewayOptions = {}
): Promise<string> {
  // Generous on purpose: a first install downloads the published payload and
  // unpacks ~44,000 files, which takes minutes even on good Wi-Fi and much
  // longer on a phone that is also doing something else. The caller can stop
  // waiting at any time (the install itself carries on), so a long window costs
  // nothing except a spinner that stays up.
  const { timeoutMs = 45 * 60 * 1000, intervalMs = 1000, onProgress, shouldContinue } = options;
  const deadline = Date.now() + timeoutMs;
  let lastState: GatewayState | null = null;

  while (Date.now() < deadline) {
    if (shouldContinue && !shouldContinue()) {
      throw new Error('Cancelled');
    }

    const state = await gatewayState();
    lastState = state;
    onProgress?.(state);

    if (state.phase === 'failed') {
      throw new Error(state.error ?? 'The gateway failed to start');
    }

    try {
      const res = await fetch(`${LOCAL_GATEWAY_URL}/healthz`);
      if (res.ok) return LOCAL_GATEWAY_URL;
    } catch {
      // Not up yet — expected while the payload downloads and unpacks.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const tail = lastState ? gatewayLogTail(lastState.logTail) : '';
  throw new Error(
    `Timed out waiting for the local gateway after ${Math.round(timeoutMs / 1000)}s.` +
      (tail ? `\nLast output:\n${tail}` : '')
  );
}

/**
 * Remove the installed gateway: the payload, the install marker and the log.
 *
 * The database lives in the app's own `HOME` (`<filesDir>/.omniroute`), not in
 * the gateway directory, so this does **not** delete the user's dashboard data —
 * that is a separate, more deliberate action. Refuses while the runtime is
 * running, because deleting the directory out from under it would leave a
 * process writing to unlinked files.
 */
export async function uninstallLocalGateway(): Promise<void> {
  if (!NodeRuntime.isAvailable()) return;
  const status = NodeRuntime.getStatus();
  if (status.running) {
    throw new Error('Stop the app (or wait for the runtime to exit) before removing the install.');
  }
  const paths = NodeRuntime.getPaths();
  await NodeRuntime.deleteDir(paths.gatewayDir);
}
