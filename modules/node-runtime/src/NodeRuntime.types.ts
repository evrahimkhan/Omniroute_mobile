/**
 * Public types for the embedded Node runtime module.
 *
 * Mirrors `NodeRuntimeModule.kt` — if a field is added there, add it here.
 */

/** Where the runtime is in its (unresettable) lifecycle. */
export interface NodeRuntimeStatus {
  /** The native runtime is present in this build and loaded. */
  available: boolean;
  /** Started and not yet exited. */
  running: boolean;
  /** Started and then finished. */
  exited: boolean;
  /** Node's exit code once it has finished, otherwise null. */
  exitCode: number | null;
  /** Version reported by the runtime, or "unavailable". */
  version: string;
  /** Entry script of the current/last run. */
  scriptPath: string | null;
  /** Epoch ms of the last `start()`. */
  startedAt: number | null;
  /** Where the runtime's stdout/stderr is being written. */
  logFilePath: string | null;
  /** The app's process id — node runs in-process, so this is shared. */
  pid: number;
  /**
   * How the previous run of the app ended, when it ended abnormally — the only
   * account of a process that was killed for memory, which writes nothing to any
   * log. Null on API < 30 and after an ordinary exit.
   */
  previousExit: string | null;
  /**
   * A foreground service is holding the process so the gateway keeps serving
   * with the app closed.
   */
  keepAlive: boolean;
}

export interface StartOptions {
  /** Absolute path of the script to run (its `node_modules` is resolved relative to it). */
  scriptPath: string;
  /** Extra argv entries after the script path. */
  args?: string[];
  /** Working directory; defaults to the script's directory. */
  workingDirectory?: string;
  /** Extra environment variables. TMPDIR/HOME/NODE_ENV are always set. */
  env?: Record<string, string>;
  /** Defaults to `<filesDir>/node-runtime/node.log`. */
  logFilePath?: string;
  /** V8 needs a deep stack; clamped to 2–64 MB. Defaults to 8. */
  stackSizeMb?: number;
  /**
   * Keep the gateway running while the app is in the background, by starting a
   * foreground service that holds the process. The user sees a notification
   * (Android requires it) with a **Stop** action. Defaults to false.
   */
  foreground?: boolean;
}

export interface NodeExitEvent {
  code: number;
  scriptPath: string;
}

/**
 * Directories the app may write to. `gatewayDir` is where the local gateway
 * lives (payload, bootstrap script, log); `nativeLibraryDir` is where Android
 * extracted the runtime, and is readable but not writable.
 */
export interface NodePaths {
  filesDir: string;
  cacheDir: string;
  gatewayDir: string;
  logFilePath: string;
  nativeLibraryDir: string;
}

export type NodeRuntimeEvents = {
  onExit: (event: NodeExitEvent) => void;
};

/**
 * Why hosting stopped, when it was not the runtime failing on its own. Passed
 * to `stopHosting()` so the reason is written to the runtime log.
 */
export type StopReason = string;
