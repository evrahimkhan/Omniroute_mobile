/**
 * Web fallback for the embedded Node runtime.
 *
 * Metro resolves `.web.ts` first on web, so the browser build gets a stub
 * instead of a `requireNativeModule` crash. The on-device gateway is
 * Android-only by design (docs/LOCAL_GATEWAY.md explains why iOS is out of
 * scope), so "unavailable" is the honest answer here.
 */

import type {
  NodePaths,
  NodeRuntimeEvents,
  NodeRuntimeStatus,
  StartOptions,
} from './src/NodeRuntime.types';

const STATUS: NodeRuntimeStatus = {
  available: false,
  running: false,
  exited: false,
  exitCode: null,
  version: 'unavailable',
  scriptPath: null,
  startedAt: null,
  logFilePath: null,
  pid: -1,
  keepAlive: false,
};

const stub = {
  isAvailable: () => false,
  getUnavailableReason: () =>
    'The embedded Node runtime is Android-only; it is not available on web.',
  getRuntimeVersion: () => 'unavailable',
  getStatus: (): NodeRuntimeStatus => ({ ...STATUS }),
  start: async (_options: StartOptions): Promise<NodeRuntimeStatus> => {
    throw new Error('The embedded Node runtime is not available on web.');
  },
  readLog: async (_maxBytes: number): Promise<string> => '',
  clearLog: async (): Promise<void> => {},
  getPaths: (): NodePaths => ({
    filesDir: '',
    cacheDir: '',
    gatewayDir: '',
    logFilePath: '',
    nativeLibraryDir: '',
  }),
  fileExists: () => false,
  writeFile: async (): Promise<string> => {
    throw new Error('The embedded Node runtime is not available on web.');
  },
  readFile: async (): Promise<string | null> => null,
  deleteDir: async (): Promise<boolean> => false,
  stopHosting: (): void => {},
  addListener: () => ({ remove: () => {} }),
  removeAllListeners: () => {},
} satisfies Record<string, unknown>;

export default stub as unknown as {
  isAvailable(): boolean;
  getUnavailableReason(): string | null;
  getRuntimeVersion(): string;
  getStatus(): NodeRuntimeStatus;
  start(options: StartOptions): Promise<NodeRuntimeStatus>;
  readLog(maxBytes: number): Promise<string>;
  clearLog(): Promise<void>;
  getPaths(): NodePaths;
  fileExists(path: string): boolean;
  writeFile(path: string, contents: string): Promise<string>;
  readFile(path: string, maxBytes: number): Promise<string | null>;
  deleteDir(path: string): Promise<boolean>;
  stopHosting(reason: string): void;
} & NodeRuntimeEvents;

export type { NodePaths, NodeRuntimeEvents, NodeRuntimeStatus, StartOptions };
