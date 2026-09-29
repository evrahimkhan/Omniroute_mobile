# Local Gateway — hosting the npm OmniRoute inside the app

Status: **Phase 2 (JNI bridge) — implemented, unverified on hardware.**
Goal: after installing the APK, the user taps *Install local gateway* and the app
sets up OmniRoute **on the phone** — no separate server, no Termux, nothing bundled
in the APK except a JavaScript runtime.

This document records what was verified, what is impossible, and why the design
looks the way it does. Every claim below was checked against the actual artifacts
(npm registry metadata, the published `omniroute` tarball, the Node-on-mobile
project, and Android platform rules) — not from memory.

---

## 1. What "hosting" means here

OmniRoute ships on npm as `omniroute` and runs headless; the dashboard listens on
`localhost:20128`. The app already knows how to display that dashboard — it is a
WebView over a gateway URL. So "the app hosts it" reduces to:

1. get a Node.js ≥ 22.22.2 runtime onto the device,
2. get the `omniroute` package onto the device,
3. start its server on `127.0.0.1:20128`,
4. point the existing WebView at it.

## 2. Hard constraints (verified)

| Constraint | Evidence | Consequence |
|---|---|---|
| An app **cannot download an executable after install and run it** | Android 10+ blocks `execve` on files the app can write (SELinux `app_data_file` has no exec). Google: *"Executable code should always be loaded from the application APK… `exec()` continues to be supported for files within the read-only `/data/app` directory. It should be possible to package the binaries into your application's native libs directory and enable `android:extractNativeLibs=true`."* | The **runtime must ship inside the APK**. Only the OmniRoute *payload* can be downloaded post-install. |
| OmniRoute needs Node `>=22.22.2 <23 \|\| >=24.0.0 <27` | `engines` + `bin/nodeRuntimeSupport.mjs` (`SUPPORTED_NODE_RANGE`) in `omniroute@3.8.50` | Rules out the old `nodejs-mobile` (stuck at Node 18.20.4). |
| `child_process.spawn()`/`fork()` hit permission errors on mobile | nodejs-mobile FAQ | The CLI's `runDaemon()` / `runWithSupervisor()` paths are unusable. Must run **in-process**. |
| Native addons need cross-compiling per platform | nodejs-mobile FAQ | `sharp` and friends cannot be compiled on-device. |

## 3. What made this feasible

1. **A maintained Node 24 runtime exists for mobile.**
   `digidem/nodejs-mobile` publishes `nodejs-mobile-android-24.20.0-0.zip`
   (74 MB, all ABIs; `armeabi-v7a`, `arm64-v8a`, `x86_64`) — Node **24.20.0**,
   which satisfies OmniRoute's range. (The upstream `nodejs-mobile` repo is idle
   at Node 18.20.4.) Risk: the fork is young and low-traffic — see §7.

2. **OmniRoute degrades gracefully without native modules.**
   - SQLite is not a blocker — `bin/cli/runtime/sqliteRuntime.mjs` resolves a
     driver through a 5-step fallback:
     bundled `better-sqlite3` → runtime-installed → lazy npm install →
     **`node:sqlite` (Node ≥ 22.5 stdlib)** → **`sql.js` (bundled WASM)**.
     On Node 24 the stdlib and WASM paths always work.
   - `sharp`, `playwright-core` and `tls-client-node` are loaded as **lazy
     external imports wrapped in try/catch**, e.g. the generated chunk
     `[externals]_sharp_1oez0x5._.js` is literally
     `try { var r = await import("sharp"); … } catch (a) { e(a) }`.
     A missing native module rejects an import; it does not crash the server.

3. **There is an in-process server path.**
   `bin/cli/commands/serve.mjs` exposes `runServe()`; `runDaemon()` (which uses
   `spawn`) is only one branch, alongside `runWithoutRecovery()`. The standalone
   entry itself is `dist/server.js`.

## 4. Architecture

```
┌─────────────────────────── Android app (APK) ───────────────────────────┐
│                                                                         │
│  libnode.so  (Node 24.20.0, arm64-v8a)   ← bundled in jniLibs,          │
│                                            extractNativeLibs=true       │
│                                                                         │
│  JNI bridge (Kotlin ⇄ C++)  → starts libnode as a thread, runs a script  │
│                                                                         │
│  app storage (downloaded after install, ~121 MB):                       │
│    files/gateway/pkg/…        omniroute@3.8.50 unpacked                 │
│    files/gateway/data/        DATA_DIR (DB, keys)                       │
│                                                                         │
│  runtime script: import dist/server.js in-process, PORT=20128,          │
│                  HOSTNAME=127.0.0.1                                     │
│                                                                         │
│  WebView (existing)  →  http://127.0.0.1:20128                          │
└─────────────────────────────────────────────────────────────────────────┘
```

Sizes: runtime ≈ 25–30 MB per ABI (the 74 MB zip carries three), OmniRoute
tarball 121 MB compressed / 431 MB unpacked / 21,898 files — hence the
"install after the APK" flow rather than shipping it.

### Why not the alternatives

- **Termux** — rejected by request, and it puts the gateway in another app's
  sandbox with a manual `allow-external-apps` toggle.
- **Compiling OmniRoute from source on device** — no toolchain, and the phone
  would have to run `next build`.
- **Shipping OmniRoute inside the APK** — 431 MB unpacked, and Play/App Store
  size limits.

## 5. Implementation phases

- **Phase 1 — runtime packaging (done).** `expo-build-properties` sets
  `useLegacyPackaging` (→ `android:extractNativeLibs="true"`);
  `scripts/fetch-node-runtime.mjs` downloads the runtime zip and copies
  `libnode.so` per ABI into `modules/node-runtime/android/src/main/jniLibs/<abi>/`,
  plus the public headers into `.../src/main/cpp/include/`. CI asserts the built
  APK really contains the library.
- **Phase 2 — JNI bridge (this change).** Local Expo module `modules/node-runtime`:
  Kotlin `NodeRuntime` over a C++ shim (`node-runtime-jni.cpp`) that starts
  libnode with `node::Start` on a dedicated thread. See §5a for the contract.
  The *mechanics* are verified off-device (the shim compiles against the real
  Node headers, links, and exports the JNI symbols Kotlin looks for — CI does
  this with the NDK on every build), but **nothing here has run on a phone yet**:
  whether the runtime actually boots inside an Android app process is the open
  question.
- **Phase 3 — install flow.** Download the tarball, verify the integrity hash,
  extract, write the bootstrap script, start, poll `/healthz`, save the URL.
  **Blocked on a discovery that changes the plan — see §5b.**
- **Phase 4 — UI/UX.** "Local gateway" card in Settings/onboarding: install
  progress, start/stop, data wipe, and honest messaging about degraded features.

### 5a. The Phase 2 module contract

`modules/node-runtime` is a local Expo module (autolinked by
`expo-modules-autolinking`; no `app.json` entry needed). Native name:
`NodeRuntime`.

| JS | Kotlin | Notes |
|---|---|---|
| `isAvailable()` | checks that both `.so`s loaded | a build without the fetch step reports `false` instead of crashing |
| `getUnavailableReason()` | the `dlopen` error, or `null` | |
| `getRuntimeVersion()` | `NODE_VERSION` from the headers | |
| `getStatus()` | `available / running / exited / exitCode / scriptPath / startedAt / logFilePath / pid` | |
| `start(options)` | starts the thread, returns immediately | resolves once the thread is up, **not** once the gateway listens — poll `127.0.0.1:20128` for that |
| `readLog(maxBytes)` | tail of the runtime's stdout+stderr | |
| `clearLog()` | truncates it | |
| event `onExit` | `{ code, scriptPath }` | |

Decisions worth keeping:

- **`node::Start` on a dedicated thread with an 8 MB stack.** V8 recurses deeply
  and the default thread stack is not enough. `stackSizeMb` is clampable 2–64.
- **The environment is set *before* the runtime boots**, from the JNI side
  (`setenv`), because Node reads `NODE_OPTIONS`, `NODE_ICU_DATA`, `NODE_EXTRA_CA_CERTS`
  and friends during startup — assigning them from JavaScript is too late.
  `TMPDIR` (→ `cacheDir`) is not optional: Android has no `/tmp` and no `TMPDIR`,
  so `os.tmpdir()` throws until it is set. `HOME` → `filesDir`, `NODE_ENV=production`.
- **stdout/stderr are redirected to `files/node-runtime/node.log`** before the
  runtime starts. A native library has no console on Android; without this the
  reason the runtime failed to boot would go nowhere. `readLog()` surfaces it.
- **The runtime starts at most once per process.** nodejs-mobile cannot restart
  a `node::Start` that has returned; `start()` throws on the second call and the
  UI must offer "restart the app" instead of pretending to cycle the gateway.
- **Linked by name, not by path.** The shim links `-lnode` with a `-L` search
  path rather than the absolute path of the `.so`, because the linker records
  `DT_NEEDED` as the soname if present and otherwise as whatever path it was
  given — an absolute build path would not resolve on-device, where the runtime
  is extracted to the app's native library dir. Verified on the built artifact:
  `DT_NEEDED: libnode.so`.
- **`ANDROID_STL=c++_shared`** — `libnode.so` NEEDs `libc++_shared.so` (the
  upstream project says so in its own Android smoke test), and `.so` files never
  carry a static copy of the STL ABI.
- The CMake step **degrades instead of failing**: if no runtime is present for
  the ABI being built (an emulator JS-only dev client, say) it compiles stubs
  that report `available: false`.

### 5b. Phase 3 blocker: the tarball has no dependencies

Verified against the published `omniroute@3.8.50` tarball: it contains **zero
`node_modules` entries**, and `dist/server.js` does `require('next')`,
`require('next/dist/server/lib/start-server')` and `require('./http-method-guard.cjs')`.
`dist/.build/next/` holds `BUILD_ID`, the route manifests, `server/` and
`static/` — but it is **not** a Next.js standalone output (no
`standalone/server.js`, no vendored modules), so importing `dist/server.js`
alone cannot boot. `bin/cli/commands/serve.mjs` has no in-process branch either:
it `spawn`s a child process in both `runDaemon()` and `runWithoutRecovery()`,
which is exactly what we cannot do.

So Phase 3 needs one of:

1. **Install dependencies on-device** — run npm (or an equivalent resolver)
   inside the app against the registry after unpacking. Honest costs: a network
   round-trip for ~77 dependencies, meaningful disk (431 MB unpacked before
   `--omit=dev` prunes anything), and time; needs a real resolution strategy for
   the optional native deps that cannot build on Android.
2. **Publish a self-contained payload** — a `next build`-style output with the
   server dependency tree vendored in, which the app downloads as one archive.
   Puts the work in CI instead of on the phone, and is the only option that
   works offline.

Either way the payload budget is the 431.6 MB / 21,898 files already measured.
This is a Phase 3 decision, not a Phase 2 one — but it must be settled before
the install flow is written, because it decides what "installing" means.

## 6. What will not work on-device

These are expected degradations; the UI must say so rather than pretend:

- Image processing (`sharp`), browser-automation providers
  (`playwright-core`), local ML compression (`onnxruntime-node`), OS keychain
  (`keytar`), and TLS-fingerprint stealth (`tls-client-node`).
- Anything the CLI does by spawning a process (daemon mode, launching external
  CLIs, tray, Redis container management).
- iOS is out of scope for Phase 1–4: no Termux equivalent, `process.exit()`
  is disallowed by App Store rules, and shipping a downloaded payload as
  executable code is not permitted.

## 7. Risks

| Risk | Mitigation |
|---|---|
| `digidem/nodejs-mobile` is a young, low-adoption fork (2 stars at time of writing) | Pin the exact release + verify the artifact checksum in CI; the build recipe is reproducible from upstream Node (`scripts/prepare.sh`), so we can rebuild it ourselves if it stalls. |
| Untested on a real device | Phases 2–3 need a physical/emulated device before we claim it works. |
| First-run download is 121 MB | Require Wi-Fi, show progress, allow cancel/resume; verify integrity before use. |
| Native exec from app storage | Avoided entirely — the runtime lives in the APK's lib dir. |
