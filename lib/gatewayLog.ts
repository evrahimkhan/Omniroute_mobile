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
    if (match(/^reusing the previously downloaded payload/)) {
      return { kind: 'reusing', label: 'Reusing the download from last time…' };
    }
    if (match(/^verifying checksum/)) {
      return { kind: 'verifying', label: 'Verifying the download…' };
    }
    if (match(/^checksum ok/)) return { kind: 'verifying', label: 'Download verified' };
    if (match(/^warning: GATEWAY_PAYLOAD_SHA256 is not set/)) {
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

/** Last few meaningful log lines, for when something goes wrong. */
export function gatewayLogTail(log: string, lines = 8): string {
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
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
    return { phase: 'failed', error: progress.detail };
  }
  if (progress.kind === 'installed' || progress.kind === 'starting') {
    return { phase: 'starting' };
  }
  return { phase: 'installing' };
}
