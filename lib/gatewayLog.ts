/**
 * Reading the embedded runtime's log.
 *
 * The bootstrap script (`gateway/bootstrap.mjs`) prints one line per milestone
 * plus one per ~8 MB of work, and that log is the only progress channel a native
 * runtime has back to the app (see docs/LOCAL_GATEWAY.md §5c).
 *
 * **Every string the bootstrap prints is matched here, and nowhere else.** A
 * second copy of these markers is how you get a phase that silently never fires
 * — which is exactly what happened once, when `describeGatewayLog` looked for
 * `already installed` while the script printed `gateway already installed`.
 *
 * Everything in this file is a pure function over text: no native imports, so it
 * can be tested on its own.
 */

/** Which part of the install a log line describes. */
export type GatewayProgressKind =
  | 'downloading'
  | 'verifying'
  | 'reusing'
  | 'extracting'
  | 'installed'
  | 'starting'
  | 'failed';

/** Progress worth showing, extracted from the runtime's log. */
export interface GatewayProgress {
  kind: GatewayProgressKind;
  /** Short imperative label: "Downloading…", "Unpacking…". */
  label: string;
  /** The numbers, when there are any. */
  detail?: string;
  /** 0–1 when the log states a percentage, otherwise unknown. */
  fraction?: number;
}

/**
 * Turn the tail of the runtime log into one line of progress.
 *
 * The log is chronological, so the last line we recognise is the current story.
 * Lines we do not recognise are skipped rather than guessed at: a wrong label is
 * worse than the previous, still-true one.
 */
export function gatewayProgress(log: string): GatewayProgress | null {
  const lines = log.split('\n').map((line) => line.trim()).filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('[gateway]')) continue;
    const rest = line.slice(line.indexOf('[gateway]') + '[gateway]'.length).trim();
    const match = (...patterns: RegExp[]) => {
      for (const pattern of patterns) {
        const found = pattern.exec(rest);
        if (found) return found;
      }
      return null;
    };

    // Order matters only where one pattern prefixes another.
    let found = match(/^FAILED: ([\s\S]+)$/);
    if (found) {
      // The stack trace follows on later lines; the first line is the message.
      return { kind: 'failed', label: 'Failed', detail: found[1].split('\n')[0] };
    }
    found = match(/^downloaded ([\d.]+ MB)(?: \((\d+)%\))?$/);
    if (found) {
      const percent = found[2] ? Number(found[2]) : undefined;
      return {
        kind: 'downloading',
        label: 'Downloading…',
        detail: percent === undefined ? found[1] : `${found[1]} (${percent}%)`,
        fraction: percent === undefined ? undefined : percent / 100,
      };
    }
    if (match(/^downloading /)) return { kind: 'downloading', label: 'Starting the download…' };
    found = match(/^payload is ([\d.]+ MB)$/);
    if (found) {
      return { kind: 'downloading', label: 'Downloading…', detail: `payload is ${found[1]}` };
    }
    found = match(/^resuming the download at ([\d.]+ MB)$/);
    if (found) {
      return { kind: 'downloading', label: 'Resuming the download…', detail: found[1] };
    }
    if (match(/^reusing the previously downloaded payload/)) {
      return { kind: 'reusing', label: 'Reusing the download from last time…' };
    }
    if (match(/^verifying checksum/)) {
      return { kind: 'verifying', label: 'Verifying the download…' };
    }
    if (match(/^checksum ok/)) return { kind: 'verifying', label: 'Download verified' };
    if (match(/^warning: no checksum available/)) {
      return { kind: 'verifying', label: 'Downloading without a checksum' };
    }
    found = match(/^extracting… ([\s\S]+)$/);
    if (found) return { kind: 'extracting', label: 'Unpacking…', detail: found[1] };
    found = match(/^extracted ([\s\S]+)$/);
    if (found) return { kind: 'extracting', label: 'Unpacked', detail: found[1] };
    if (match(/^install complete/)) return { kind: 'installed', label: 'Installed' };
    // Deliberately no detail: the line carries an absolute path and a timestamp,
    // which is noise in a one-line progress label.
    if (match(/^gateway already installed at /)) {
      return { kind: 'starting', label: 'Already installed' };
    }
    found = match(/^starting ([\s\S]+)$/);
    if (found) return { kind: 'starting', label: 'Starting the gateway…', detail: found[1] };
  }
  return null;
}

/**
 * A failure's first line, plus where to look when the cause is outside the app.
 *
 * The payload is a release asset built by a separate workflow, so "HTTP 404"
 * here means the release has none — nothing about the phone is wrong, and no
 * amount of retrying will help. Everything else is reported as the runtime
 * wrote it.
 */
function explainFailure(detail: string): string {
  if (/HTTP 40[34]/.test(detail)) {
    return (
      `${detail} — GitHub refused this file for this network. Either the payload has not been ` +
      `published (run the "Build OmniRoute web gateway" workflow with payload on), or this ` +
      `connection is filtering GitHub's download host — try another Wi-Fi or mobile network.`
    );
  }
  return detail;
}

/**
 * Which phase the app is in, from the runtime's real state and the log.
 *
 * The runtime's state decides, and the log only refines it. Deriving the phase
 * from the log alone is how a card gets stuck: after the process died, the last
 * line was `starting server.js on 127.0.0.1:20128`, so a fresh app session — no
 * runtime, nothing running — showed a spinner and "Starting the gateway…"
 * forever, with no way to start anything. A line in a file is a record of what
 * happened once, not evidence of what is happening now.
 */
export function deriveGatewayPhase(input: {
  /** A runtime is up in this process. */
  running: boolean;
  /** A runtime ran in this process and has finished. */
  exited: boolean;
  /** The payload is installed on disk. */
  hasMarker: boolean;
  /** The gateway's own log plus the runtime's markers. */
  log: string;
}): GatewayPhaseName {
  const fromLog = describeGatewayLog(input.log);
  // A printed failure stands on its own: it is a fact about this session's log,
  // which the app truncates at the start of every attempt.
  if (fromLog.phase === 'failed') return 'failed';
  if (input.exited) return 'failed';
  if (input.running) {
    return fromLog.phase === 'installing' ? 'installing' : 'starting';
  }
  // Nothing is running and the runtime has not exited in this process: whatever
  // the log says about a previous attempt, there is no gateway now.
  return 'idle';
}

/**
 * What the last line of the boot record means, in one sentence — or null when
 * there is no record to read.
 *
 * The record (`boot.log`, written by the bootstrap) exists for the one failure
 * every other channel is blind to: the process is killed outright, so nothing
 * catches it, nothing prints and no exit code is ever reported. The app is left
 * holding a log that ends at `starting server.js` and a spinner, which is the
 * same evidence whether the payload called `process.exit`, ran out of memory, or
 * died in native code.
 *
 * The record is written *before* each step, so its last line is the step that was
 * in progress when the process died. That makes the sentence a fact rather than
 * an inference — and the difference matters: "died while loading the server"
 * (a broken payload or a missing native module) and "died after the server
 * loaded, before it answered" (memory, or the server's own init) lead to
 * different fixes.
 *
 * Deliberately keyed on the bootstrap's own wording, so `gateway:test` can hold
 * the two together: every marker this matches is asserted to exist in
 * `gateway/bootstrap.mjs`.
 */
export function bootRecordStep(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  // "07 loading dist/server.js" — the sequence number is the record's own order,
  // and the step is everything after it.
  return lines[lines.length - 1].replace(/^\d+\s+/, '');
}

/**
 * What the last recorded step *means* — only ever shown once the process is gone.
 *
 * Kept separate from {@link bootRecordStep} on purpose: "it died while loading
 * the server" is a conclusion, and the record alone cannot support it while the
 * process is still running. The card shows the verbatim step for a boot in
 * progress and this sentence, which assumes a death, only for one that ended.
 */
export function describeBootTrace(text: string): string | null {
  const last = bootRecordStep(text);
  if (!last) return null;
  const match = (...patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const found = pattern.exec(last);
      if (found) return found;
    }
    return null;
  };

  let found = match(/^the process is exiting \(code (-?\d+)\)$/);
  if (found) {
    return found[1] === '0'
      ? 'The gateway process ended normally, so something stopped it rather than crashed it.'
      : `The gateway process ended itself (exit code ${found[1]}). Something inside the payload called ` +
          `process.exit — that is not a crash, and the payload's own output above says why.`;
  }

  found = match(/^asked to stop \((\w+)\)$/);
  if (found) {
    return `The app was asked to stop (${found[1]}), so the gateway was stopped with it. Android does ` +
      `this to background apps it wants gone: keeping the notification on is what avoids it.`;
  }

  // The two the payload starts with: its own crash, recorded before the end.
  found = match(/^(?:uncaught exception|unhandled rejection): ([\s\S]+)$/);
  if (found) {
    const first = found[1].split('\n')[0].trim();
    return `The gateway process crashed on its own: ${first}`;
  }

  // The addon probe's step, written immediately before each native module is
  // loaded — so when the record stops here, that module is the one that killed
  // the process. A different failure from a bad entry file: the payload was
  // fine, and one of its libraries was not.
  found = match(/^probing ([\s\S]+)$/);
  if (found) {
    return (
      `The process died while loading the payload's native module ${found[1]} — a fatal signal inside ` +
      `that library, which no handler can catch and nothing can log. The gateway moves it aside on the ` +
      `next start and carries on without it, so a second start should come up.`
    );
  }


  found = match(/^loading ([\s\S]+)$/);
  if (found) {
    return (
      `The process died while loading ${found[1]}, before the server printed anything — so it was ` +
      `killed while node was reading the payload, not by an error the server could report. If the ` +
      `message above mentions no memory or signal, the payload itself is the suspect.`
    );
  }

  found = match(/^([\s\S]+) loaded; waiting for the server to answer$/);
  if (found) {
    return `The server module loaded, and the process died before it answered — after the payload was ` +
      `read, so the failure is in starting the server rather than in finding it.`;
  }

  if (match(/^the server is answering$/)) {
    return 'The server answered, and the process died after that — so the gateway ran, and something later stopped it.';
  }
  if (match(/^the server never answered$/)) {
    return 'The server loaded but never answered on its port within the time allowed.';
  }
  if (match(/^installing the payload$/)) {
    return 'The process died during the install, before the payload was in place.';
  }
  if (match(/^the payload is installed$/)) {
    return 'The process died after installing the payload and before starting it.';
  }
  match(/^runtime ready on node /);
  return 'The boot record stopped at the runtime starting, before anything else could be recorded.';
}

/** Last few meaningful log lines, for when something goes wrong. */
export function gatewayLogTail(log: string, lines = 8): string {
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}

/**
 * Did the gateway script print anything at all?
 *
 * The bootstrap's first act is to log a startup banner, so a runtime that has
 * exited with an empty log never reached the script — as opposed to the script
 * running and failing, which always prints `[gateway] FAILED:`.
 */
export function gatewayNeverRan(log: string): boolean {
  return !log.split('\n').some((line) => line.includes('[gateway]'));
}

/**
 * Wording for "the runtime exited", because the two cases mean different things
 * to whoever is looking at the phone.
 *
 * An exit with an empty log is the confusing one: the code is 0, so it reads as
 * a clean shutdown, when in fact nothing ran. Saying so plainly is the
 * difference between "try again" and a bug report with nothing in it.
 */
export function describeRuntimeExit(exitCode: number | null, log: string): string {
  const code = `code ${exitCode ?? 'unknown'}`;
  if (!gatewayNeverRan(log)) return `The embedded runtime exited (${code}).`;
  if (log.includes('[node-runtime] starting node')) {
    return (
      `The embedded runtime exited (${code}) after starting the gateway script, which printed ` +
      `nothing at all — the script in the app and the runtime's view of it disagree. This is a ` +
      `bug, not a bad download: reopen the app and try again.`
    );
  }
  return (
    `The embedded runtime exited (${code}) without starting the gateway script, so the gateway ` +
    `never ran. Reopen the app and try again.`
  );
}

/** The phases a caller can be in; mirrors GatewayPhase in gatewayInstaller. */
export type GatewayPhaseName =
  | 'unavailable'
  | 'idle'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'failed';

/**
 * Which phase the log says we are in.
 *
 * Nothing here is load-bearing for correctness — the install marker and
 * `/healthz` decide the real state. A wrong guess only changes the wording of
 * the progress UI, never the outcome.
 */
export function describeGatewayLog(log: string): { phase: GatewayPhaseName | null; error?: string } {
  const progress = gatewayProgress(log);
  if (!progress) return { phase: null };
  if (progress.kind === 'failed') {
    return { phase: 'failed', error: explainFailure(progress.detail ?? '') };
  }
  if (progress.kind === 'installed' || progress.kind === 'starting') {
    return { phase: 'starting' };
  }
  return { phase: 'installing' };
}
