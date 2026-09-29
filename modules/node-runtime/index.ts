/**
 * Embedded Node.js runtime — the native half of on-device gateway hosting.
 *
 * The runtime itself (`libnode.so`) is packaged into the APK by
 * `scripts/fetch-node-runtime.mjs`; this module starts a script inside it and
 * streams the runtime's log back to JavaScript. See docs/LOCAL_GATEWAY.md.
 *
 * Availability is not guaranteed: a build made without the fetch step simply
 * reports `available: false`, so callers must branch on it rather than assume.
 */

import { NativeModule, requireNativeModule } from 'expo';

import type {
  NodePaths,
  NodeRuntimeEvents,
  NodeRuntimeStatus,
  StartOptions,
} from './src/NodeRuntime.types';

declare class NodeRuntimeModule extends NativeModule<NodeRuntimeEvents> {
  /** True when the native runtime is present in this build and loaded. */
  isAvailable(): boolean;
  /** Why the runtime is unavailable, or null when it is fine. */
  getUnavailableReason(): string | null;
  /** Version reported by the embedded runtime ("unavailable" when absent). */
  getRuntimeVersion(): string;
  /** Current lifecycle state. */
  getStatus(): NodeRuntimeStatus;
  /** Directories the app may use for the gateway. */
  getPaths(): NodePaths;
  /**
   * Minimal filesystem access, because React Native has none of its own and the
   * app needs to write the gateway's bootstrap script and read its install
   * marker. Paths outside the app's own storage are rejected.
   */
  fileExists(path: string): boolean;
  writeFile(path: string, contents: string): Promise<string>;
  /** File contents, or `null` when it does not exist. Reads the tail past `maxBytes`. */
  readFile(path: string, maxBytes: number): Promise<string | null>;
  deleteDir(path: string): Promise<boolean>;
  /**
   * Start the runtime. Resolves once the thread is up — not once the gateway
   * inside it is listening; poll the gateway URL for that.
   *
   * Rejects if the runtime is missing, already started (it can only start once
   * per process), or the script does not exist.
   */
  start(options: StartOptions): Promise<NodeRuntimeStatus>;
  /** Tail of the runtime's stdout/stderr. */
  readLog(maxBytes: number): Promise<string>;
  /** Truncate the runtime log. */
  clearLog(): Promise<void>;
}

export default requireNativeModule<NodeRuntimeModule>('NodeRuntime');

export type { NodePaths, NodeRuntimeEvents, NodeRuntimeStatus, StartOptions };
