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

export type { NodeRuntimeEvents, NodeRuntimeStatus, StartOptions };
