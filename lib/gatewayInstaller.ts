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

import NodeRuntime from '../modules/node-runtime';
import { BOOTSTRAP_SCRIPT } from './gateway/bootstrapScript.generated';
import { describeGatewayLog, gatewayLogTail, type GatewayProgress } from './gatewayLog';

export { gatewayLogTail, gatewayProgress, type GatewayProgress } from './gatewayLog';

/** The gateway's default port, and the loopback URL the WebView points at. */
export const LOCAL_GATEWAY_PORT = 20128;
export const LOCAL_GATEWAY_URL = `http://127.0.0.1:${LOCAL_GATEWAY_PORT}`;

/**
 * Where the payload comes from. Published by this repo's CI, so it needs no
 * third-party host to be up. Override at build time with
 * `EXPO_PUBLIC_GATEWAY_PAYLOAD_URL` (useful for testing a local build).
 */
export const DEFAULT_PAYLOAD_URL =
  process.env.EXPO_PUBLIC_GATEWAY_PAYLOAD_URL ??
  'https://github.com/evrahimkhan/Omniroute_mobile/releases/latest/download/omniroute-payload.tar.gz';

/**
 * Expected sha256 of the payload. Empty means "install without verification" —
 * the bootstrap warns loudly in that case, because an unverified 100+ MB
 * archive is exactly the thing you do not want to unpack blind.
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
  /** A payload is installed and looks complete. */
  installed: boolean;
  /** When the payload was installed (marker's timestamp). */
  installedAt: string | null;
  /** Tail of the runtime log — the runtime's only channel back to the app. */
  logTail: string;
  /** Present when the phase is `failed`. */
  error?: string;
  /** The URL to point the WebView at once the phase is `ready`. */
  url: string;
}

export interface StartGatewayOptions {
  /** Defaults to {@link DEFAULT_PAYLOAD_URL}. */
  payloadUrl?: string;
  /** Defaults to {@link PAYLOAD_SHA256}. */
  payloadSha256?: string;
  /** Reinstall even if the same payload is already installed. */
  force?: boolean;
  /** Defaults to {@link LOCAL_GATEWAY_PORT}. */
  port?: number;
}

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
export async function readGatewayLog(maxBytes = 64 * 1024): Promise<string> {
  try {
    return await NodeRuntime.readLog(maxBytes);
  } catch {
    return '';
  }
}

/** Current state, derived from the native runtime, the marker and the log. */
export async function gatewayState(): Promise<GatewayState> {
  const url = LOCAL_GATEWAY_URL;
  if (!NodeRuntime.isAvailable()) {
    return {
      phase: 'unavailable',
      installed: false,
      installedAt: null,
      logTail: '',
      error: localGatewayUnavailableReason() ?? undefined,
      url,
    };
  }

  const status = NodeRuntime.getStatus();
  const marker = await readMarker();
  const log = await readGatewayLog();
  const fromLog = describeGatewayLog(log);

  if (status.exited || fromLog.phase === 'failed') {
    return {
      phase: 'failed',
      installed: Boolean(marker),
      installedAt: marker?.installedAt ?? null,
      logTail: log,
      error:
        fromLog.error ??
        `The embedded runtime exited (code ${status.exitCode ?? 'unknown'}).`,
      url,
    };
  }

  let phase: GatewayPhase = 'idle';
  if (fromLog.phase === 'installing') phase = 'installing';
  else if (status.running && marker) phase = 'starting';
  else if (fromLog.phase === 'starting' || (status.running && !marker)) phase = 'starting';

  return {
    phase,
    installed: Boolean(marker),
    installedAt: marker?.installedAt ?? null,
    logTail: log,
    url,
  };
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
  const port = options.port ?? LOCAL_GATEWAY_PORT;

  const env: Record<string, string> = {
    GATEWAY_DIR: paths.gatewayDir,
    GATEWAY_PORT: String(port),
    GATEWAY_HOST: '127.0.0.1',
  };
  if (payloadUrl) env.GATEWAY_PAYLOAD_URL = payloadUrl;
  if (sha) env.GATEWAY_PAYLOAD_SHA256 = sha;
  if (options.force) env.GATEWAY_FORCE_INSTALL = '1';

  await NodeRuntime.start({
    scriptPath,
    workingDirectory: paths.gatewayDir,
    logFilePath: paths.logFilePath,
    env,
  });
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
  const { timeoutMs = 20 * 60 * 1000, intervalMs = 1000, onProgress, shouldContinue } = options;
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
