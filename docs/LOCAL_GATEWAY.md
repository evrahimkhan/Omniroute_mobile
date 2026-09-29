# Local Gateway — hosting the npm OmniRoute inside the app

Status: **All four phases implemented; unverified on hardware, and the payload
still needs its own build job (§5b).**
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
│  libnode.so  (Node 24.20.0, per-ABI)   ← in jniLibs, extractNativeLibs   │
│  libnoderuntime_jni.so                 ← the JNI shim, built from source │
│                                                                         │
│  modules/node-runtime   Kotlin NodeRuntime ⇄ C++ node::Start on a thread │
│                                                                         │
│  app storage:                                                           │
│    files/node-runtime/bootstrap.mjs   the installer (embedded as a       │
│                                       string in the JS bundle)          │
│    files/node-runtime/node.log        runtime stdout/stderr → app reads  │
│    files/node-runtime/app/            payload, downloaded after install  │
│    <HOME>/.omniroute/                 gateway state (DB, secrets)        │
│                                       ← HOME is filesDir, set pre-boot  │
│                                                                         │
│  lib/gatewayInstaller.ts → writes the script, starts it, polls /healthz  │
│                                                                         │
│  WebView (existing)  →  http://127.0.0.1:20128  (+ its own 20131/20132)  │
└─────────────────────────────────────────────────────────────────────────┘
```

Sizes: runtime ≈ 18 MB per ABI in the APK. The payload is the open item —
npm's full tree is 2.6 GB, which the standalone build in §5b is meant to
replace — hence the "install after the APK" flow rather than shipping it.



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
- **Phase 2 — JNI bridge (done).** Local Expo module `modules/node-runtime`:
  Kotlin `NodeRuntime` over a C++ shim (`node-runtime-jni.cpp`) that starts
  libnode with `node::Start` on a dedicated thread. See §5a for the contract.
  The *mechanics* are verified off-device (the shim compiles against the real
  Node headers, links, and exports the JNI symbols Kotlin looks for — CI does
  this with the NDK on every build), but **nothing here has run on a phone yet**:
  whether the runtime actually boots inside an Android app process is the open
  question.
- **Phase 3 — install flow (done).** `gateway/bootstrap.mjs` downloads
  the payload, verifies its checksum, unpacks it, and boots it — all inside the
  embedded runtime, so the app needs no download manager or unzipper. The app
  side (`lib/gatewayInstaller.ts`) writes that script into app storage, starts
  the runtime on it, and polls `/healthz` until the gateway actually answers.
  The payload itself is still npm's 2.6 GB tree until the standalone build lands
  — see §5b for what that means and what replaces it.
- **Phase 4 — UI/UX (this change).** "Host it on this phone" card
  (`components/LocalGatewayCard.tsx`): availability, status, install progress,
  "Use this gateway", "Remove", and a collapsible view of the runtime log. It
  appears in Settings under **LOCAL GATEWAY**, and collapsed on the first-run
  connection screen for anyone who has no gateway to point at yet.

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
- **C++20.** Node 24's headers use `concept`/`requires` and
  `std::contiguous_iterator_tag`; built as C++17 the compile dies inside
  `cppgc/macros.h` and `v8-memory-span.h` before it reaches our code. (This is
  easy to miss locally: a distro Node 22 only ships the lean public headers,
  while the published archive ships Node 24's full include tree.)
- **The module must use the app's NDK.** A library that compiles C++ falls back
  to AGP's *default* NDK version if it does not set one, and that is usually not
  the NDK the SDK actually has. `expo-modules-core` sets `ndkVersion`/`ndkPath`
  from the root project, guarded with `hasProperty`; this module copies that.

What CI proves on every APK build: the archive downloads, the runtime exports
`node::Start`, CMake compiles the shim against the real headers for both device
ABIs, and the resulting APK contains `lib/<abi>/libnode.so` **and**
`lib/<abi>/libnoderuntime_jni.so`. What it cannot prove is that any of it runs.

### 5b. The payload: what "installing" means

The published `omniroute@3.8.50` tarball contains **zero `node_modules`
entries**, and `dist/server.js` does `require('next')`,
`require('next/dist/server/lib/start-server')` and `require('./http-method-guard.cjs')`.
`dist/.build/next/` holds `BUILD_ID`, the route manifests, `server/` and
`static/`, but it is **not** a Next.js standalone output, so the tarball alone
cannot boot. `bin/cli/commands/serve.mjs` is no help either: it `spawn`s a child
process in both `runDaemon()` and `runWithoutRecovery()`, which is exactly what
Android does not let a mobile runtime do.

**The runtime itself is fine.** Booted directly, with the dependency tree
present, `dist/server.js` comes up in-process on Node 24, runs its migrations,
answers `/healthz`, `/api/health/ping`, `/api/health`, `/dashboard`,
`/api/providers` and `/api/models`, and shuts down gracefully on SIGTERM. It
also opens two extra loopback ports of its own (20131 for the embed WS proxy,
20132 for the live dashboard WebSocket) and keeps its state under `$HOME`, which
is why the JNI bridge sets `HOME` to the app's files dir.

So the only question is where the dependency tree comes from. Measured, both
ways:

| | Size | Files | Where the work happens |
|---|---|---|---|
| Full npm tree (`--omit=dev`) | 2.6 GB | 125,106 | resolved on-device or shipped whole |
| `omniroute` package alone | 481 MB | 21,898 | — |
| That package, packed for the phone | 115.6 MB (431.6 MB raw) | 21,898 | CI, once per payload update |

2.6 GB is not a payload anyone should download to a phone, and resolving it
on-device (option 1 below) means the phone does the work *and* keeps the bytes.

**The chosen route is upstream's own standalone build.** The published package
ships the tooling for it — `scripts/build/build-next-isolated.mjs` plus
`assembleStandalone.mjs` (951 lines, with the copy list in one place), and
`package.json` chains `build` → `postbuild: colocate-standalone.mjs`. That is
the path their **Electron** build already uses to get a self-contained server,
and there is a backend-only variant: `OMNIROUTE_BUILD_BACKEND_ONLY=1`
(`npm run build:backend`), which exists precisely to leave the dashboard UI code
out. The result is a directory with its own `standalone/node_modules`, which is
what the app should download.

Consequences, recorded now so the next step does not rediscover them — and
**the pipeline that produces this payload is implemented in `omniroute-web.yml`**, as five steps appended to the
build job, gated by the workflow's `payload` input (on by default):

1. *Locate the standalone server* — `next build` puts the output wherever the
   build script was pointed, and `colocate-standalone.mjs` moves it afterwards,
   so the step searches the whole checkout for a directory containing
   `server.js` (pruning vendored trees, which are 125k files) and ranks the
   candidates: `.next/BUILD_ID` plus its own `node_modules` first, then
   `node_modules` alone. Both tests are only a preference — the boot check
   decides — but a candidate missing them is warned about by name. A build with
   no `server.js` at all fails here, listing what the build *did* produce,
   rather than half an hour later in the publish step.
2. *Pack the gateway payload* — `scripts/pack-payload.mjs` writes
   `omniroute-payload.tar.gz` plus a `…tar.gz.json` manifest
   (`{entry, sha256, bytes, uncompressedBytes, files}`). The writer is
   deterministic — sorted entries, fixed mtime/uid/gid, one mode bit, pax
   records only for names over 100 bytes — so the same tree always packs to the
   same digest. Packing the real npm package twice produced byte-identical
   archives (21,898 files, 431.6 MB → 115.6 MB).
3. *Boot the payload before publishing it* — extracts the archive with the
   app's own extractor and runs the entry as a child process, polling
   `/healthz` for up to 120 s. A payload that does not come up is never
   published, so the job proves itself instead of needing a second opinion.
   This is also the step that would catch a missing dependency tree.
4. *Publish the gateway payload* — `gh release` on the fixed tag
   `gateway-payload`, with `--clobber`, uploading both the archive and the
   manifest. The release notes are rewritten on every dispatch from the
   manifest itself, so they name the upstream ref and commit the payload was
   built from, the run that packed it, the file count and the digest. Assets on
   a tag like this are replaced in place, so notes left over from the first
   upload would be worse than none.
5. Upload both as a run artifact, so an unpublishable payload can still be
   inspected.

Two decisions worth keeping:

- **A fixed tag, never `latest`.** `releases/latest` moves when an APK release
  is published, which would silently repoint the payload URL of every installed
  app. `lib/gatewayInstaller.ts` builds the URL from the tag.
- **The app fetches the digest instead of pinning it.** `EXPO_PUBLIC_GATEWAY_PAYLOAD_SHA256`
  stays empty on purpose: pinning a digest into the APK would break every
  payload update until a new APK shipped. The app fetches `…tar.gz.json` from
  the same release and verifies the download against it, which catches the
  realistic failure (a truncated or corrupted transfer) but not a compromised
  host — the bootstrap's log line says exactly that.

The installer accepts either payload shape. `gateway/bootstrap.mjs` treats
`GATEWAY_ENTRY` as a preference, not a path: it tries the configured entry, then
`dist/server.js`, then `server.js`, and logs when it picks something other than
the default. That covers a packaged npm tree (`dist/server.js`) and a Next
standalone tree (`server.js`) with no configuration change, and it re-resolves
the entry on later runs, so an install made by an earlier build still starts.

**Not yet done:** the job has never been dispatched (`workflow_dispatch`-only),
so the payload CI produces has not been downloaded by a phone.

Rejected: **resolving dependencies on the device.** It needs a registry
round-trip, the full 2.6 GB of disk, and an answer for the optional native
packages (`onnxruntime-node`, `better-sqlite3`, …) that cannot be compiled on
Android at all — all of it to arrive at a worse copy of what CI can produce once.

### 5c. The install flow

`gateway/bootstrap.mjs` runs inside the embedded runtime and does the whole
install, then boots. Deciding factors:

- **The download happens in Node, not in the app.** The runtime already has
  `fetch`, `crypto` and `zlib`. The app has none of those on the native side —
  adding a downloader and an unzipper would mean two more native dependencies,
  for a job the runtime can already do.
- **It must boot the server too.** The runtime starts once per process, so
  there is no second chance to run something else after installing. Install and
  boot are therefore one script, not two.
- **The app ships that script as a string.** `scripts/embed-gateway-bootstrap.mjs`
  turns `gateway/bootstrap.mjs` into a generated constant, and CI fails if the
  constant is stale. The alternative — a script literal in a `.ts` file — cannot
  be run or tested by Node.
- **Progress is a log**, because that is the only channel the runtime has back
  to the app. The bootstrap prints deterministic lines (`downloading`,
  `extracting…`, `install complete`, `starting …`, `FAILED: …`) and the app
  tails them; the native module exposes the log file for exactly this.

Install is deliberately crash-safe and restartable:

- Downloads go to `<gatewayDir>/payload.tar.gz.part` and only get renamed once
  the checksum matches.
- If a previous run downloaded the payload and failed later, the next run
  **reuses** it rather than re-downloading 100+ MB on someone's mobile data —
  but only when it can re-verify the checksum.
- Extraction goes to `app.new/`, and only replaces `app/` once it is complete
  and contains the entry script. A crash mid-extract leaves the previous install
  intact.
- The tarball is deleted after a successful install; keeping it would double the
  footprint for no benefit.
- The archive's own paths are checked against the destination before anything is
  written, so a crafted entry (`../../…`) cannot escape the install directory.
- npm tarballs nest everything under `package/`, hand-rolled bundles do not. The
  installer detects a single unambiguous nesting level and normalises it away.

Verified locally against the real, published payload (see the numbers in §5b):
the extractor's output is **byte-identical to system `tar`** for all 21,898
files, 0 skipped entries, and a full run — download, checksum, extract, boot —
was exercised end to end, as was the re-run path that skips a completed install.
None of that is a substitute for a device; it does mean the logic is not being
seen for the first time on someone's phone.

### 5d. What the card says, and why

Three places where the honest answer is not the obvious one:

- **"Stop waiting" stops the *wait*, not the install.** The runtime runs on its
  own thread, so cancelling the wait leaves the download and unpack running in
  the background; the card says so by going back to showing progress rather than
  claiming to have stopped anything.
- **A failed start cannot be retried in-app.** The embedded runtime starts once
  per process and cannot be restarted after it exits, so the card tells the user
  to reopen the app instead of offering a Retry button that would fail.
- **"Remove" deletes the payload, not the user's data.** The database lives under
  `HOME` (`.omniroute/`), outside the gateway directory, so removal keeps the
  dashboard data and sign-in. Removing while the runtime is running is refused
  rather than silently pulling files out from under a live process.

The card also states the things a phone cannot do (image processing, browser
automation, anything that spawns) rather than letting those surface later as
mysterious failures.

Progress comes from the runtime log, which is the only channel a native runtime
has back to the app. That makes `lib/gatewayLog.ts` a contract with
`gateway/bootstrap.mjs`, and a contract that can break silently — it has done so
twice, first with `already installed` against `gateway already installed`, then
with `warning: GATEWAY_PAYLOAD_SHA256 is not set` against
`warning: no checksum available (…)`. `npm run gateway:test` asserts the parser
against the real log lines in CI and reports which line drifted; each sample it
uses also carries an *anchor*, the text its meaning depends on, which must still
appear in the bootstrap, so a reworded message fails rather than passing on a
stale copy.

The install chain has its own gate. `npm run payload:install-test` builds two
fixture payloads (a standalone tree, and an npm tree whose root also contains a
decoy `server.js`), serves them over loopback with their checksum manifests, and
runs the real `gateway/bootstrap.mjs` against each as the app would: download,
verify, extract, install, boot. It asserts which entry was chosen, that the
payload's own process came up *and answered `/healthz`*, and that a second run
with no URL reuses the install and still resolves the entry. That last part is
not hypothetical — the first end-to-end run against a standalone payload failed
at `payload does not contain dist/server.js`, after a successful download and
extract.

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
| Untested on a real device | Every part of phases 1–3 that a machine *can* verify is verified (CI builds the native code and checks the APK's contents; the installer is exercised end to end against the real payload), but nothing has run inside an Android app process yet. That is the next milestone, and it is a hardware one. |
| First-run download is big | Partly solved. §5b's pipeline packs the tree in CI — the packaged npm tree comes to 115.6 MB gzipped, and the standalone build it is meant to carry is smaller — and the digest is published next to it, so the app verifies what it downloads. Until the job is dispatched, "install" still means npm's tree, so treat it as Wi-Fi-only. |
| The app and the payload drift apart | The bootstrap is the app's contract with the payload; it is versioned with the app, but the payload URL is not pinned to a version yet, so "latest" can move under an installed app. Pinning both to one release is part of the CI job in §5b. |
| Native exec from app storage | Avoided entirely — the runtime lives in the APK's lib dir. |
