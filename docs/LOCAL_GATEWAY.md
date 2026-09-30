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
- **Phase 5 — keep it alive (this change).** A foreground service owns the
  process, so the gateway keeps serving with the app closed — see §5e. The card
  gains a "keep it running in the background" choice, a **Stop hosting** action,
  and the notification doubles as the status line.
- **Phase 4 — UI/UX (done).** "Host it on this phone" card
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

### 5e. Keeping the gateway alive

Phase 3 gets a gateway running; without more, Android reclaims the process within
minutes of the app leaving the screen, so "hosting on the phone" would only be
true while someone is looking at it. This phase makes it actually hold.

**One foreground service, `GatewayService`.** Android's only durable way to keep
a process alive is a foreground service with an ongoing notification. It is
declared in the module's own manifest with `foregroundServiceType="specialUse"`
(Android 14 requires a declared, justified type or `startForeground()` throws),
plus `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE` and
`POST_NOTIFICATIONS` — the last one requested at runtime on Android 13+, because
without it the notification is invisible and the user has no way to see or stop
what the phone is doing.

**The service does not own the runtime — `NodeRuntimeHost` does.** There is
exactly one Node instance per process and it can outlive the UI, so the state
moved out of the Expo module into a process-wide host. Both the module (the user
tapped *Install & start*) and the service (Android restarted the process) start
the runtime through it, and a start from one is visible to the other.

**Resuming after a process kill.** A sticky foreground service can be restarted
by Android after a low-memory kill, with no JavaScript running at all. The
service therefore cannot rely on the app to know what to run: the start request
(script, working directory, env, log path) is persisted to `StartPrefs` before the
runtime starts, and read back on restart. It is cleared when the runtime exits,
when hosting is stopped, and when a start fails — a request that outlived its
runtime would restart a broken install on every process restart.

**Stopping is honest about what it does.** nodejs-mobile has no stop API and the
runtime thread is deliberately not a daemon, so a gateway cannot be shut down
from inside the process. Stopping therefore ends the process
(`Process.killProcess`), from the app or from the notification's **Stop** action;
the card asks first and says the app will close. The installed payload and the
dashboard data (`HOME/.omniroute`) are untouched, and the next launch starts
cleanly.

**The notification repeats the log; it does not interpret it.** Its text is the
newest `[gateway]` line, verbatim, refreshed every few seconds — so a first-run
download is visible from the shade without opening the app. Translating those
lines in Kotlin would mean a second parser for the same log, which is exactly how
the app's parser and the bootstrap drifted apart twice (§5d).

**What is verified, and what is not.** Gradle compiles all of this on every APK
build, and `npm run runtime:verify` asserts the *packaged* result: the merged
manifest really declares the service, its foreground-service type attribute, the
subtype property, the three permissions and the cleartext opt-in. Its check is
honest about its own limit — aapt2 compiles `foregroundServiceType="specialUse"`
to the integer `0x40000000`, so the *value* is not a string in that file and
cannot be read by searching it; that half is asserted on the source manifest
against the constant the Kotlin passes to `startForeground`, by
`npm run runtime:contract`. A failing search prints the manifest's string pool,
so a failure is diagnosable from the CI log alone. `npm run runtime:contract` (App CI, no Android SDK needed)
checks that the JS surface, the Kotlin `Function`/`AsyncFunction` names, the
status-map keys, the manifest and the `StartPrefs` usage agree — drift that
compiles fine and would otherwise fail only on a phone. Not verified: how a real
Android build behaves. Background-start rules (Android 12 restricts starting a
foreground service from the background — satisfied here, because hosting is
always started from a visible screen) and OEM battery managers that kill
foreground services (Xiaomi, Huawei and Samsung are the usual offenders) are the
open risks.

### 5f. Proving the script ran (the one bug a phone found)

The first install on real hardware failed with **"The embedded runtime exited
(code 0)"** and nothing else — no `[gateway]` line, because the card falls back
to that wording when the log has no failure in it. Code 0, empty log, no crash.

The cause was two lines at the bottom of `gateway/bootstrap.mjs`:

```js
const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
```

The intent — "only install and boot when this file is the program, not an
import" — is right. The comparison is not, on Android: **Node resolves symlinks
when it computes `import.meta.url`, but `argv[1]` keeps whatever the caller
typed**, and Android's app-data paths are symlinks of each other (`/data/data` ⇄
`/data/user/0`, depending on version and OEM). So the two strings differed, the
script loaded, `main()` was never called, nothing was printed, and the process
exited **0**. On the phone that is indistinguishable from a crash; in CI it is
invisible, because the same file run from a normal path compares equal.

The fix is in three parts, and only the first is about this bug:

1. **The app says so explicitly.** `lib/gatewayInstaller.ts` passes
   `args: [GATEWAY_RUN_FLAG]` (`--gateway-run`), and the bootstrap treats that
   flag as "run", full stop. No filesystem question to get wrong.
2. **The path comparison asks the filesystem.** For the documented
   `node gateway/bootstrap.mjs`, both sides go through `realpath()`, so a
   symlinked directory no longer decides whether the gateway starts.
3. **The log proves the script ran.** The bootstrap's first act is to log
   `starting on node <version>`, and `NodeRuntimeHost` writes its own
   `[node-runtime] starting …` / `node exited with code N` around the native
   call. An empty log now means the script never ran — a different problem from
   one that failed, and the app says which: `describeRuntimeExit()` words an
   exit with no `[gateway]` line as *"never ran"* rather than as a crash.

Guards: `npm run payload:install-test` boots the real bootstrap **through a
symlinked directory**, with the app's flag and without it (4 assertions; all 4
fail against the previous two-line check). `npm run runtime:contract` asserts
both halves of the flag handshake — the literal in the installer, the one the
bootstrap reads — plus the `realpath` comparison and the startup banner. Layout
of the same lesson as §5d: *if two files must agree at runtime, a checker has to
say so*, because neither compiler can see the other language.

### 5g. Which log the card reads, and why it is not the runtime's

`node.log` is a **process-wide** capture: the runtime has no console on Android,
so the JNI layer points fds 1 and 2 at a file before `node::Start`, and that
file then collects whatever *anything* in the app writes to stdout/stderr.
Android WebView logs a steady stream of its own. The first real device log the
card showed was three lines of `variations_seed_loader` chatter and no gateway
output at all.

That is not just untidy. `readGatewayLog` reads the last 64 KB, the card shows
the last 14 lines of it, and `gatewayNeverRan()` falls back to *"The embedded
runtime exited (code 0)"* when no `[gateway]` line is in that window — so a few
hundred KB of browser noise can push a real `[gateway] FAILED: …` out of view
and make an install that failed for a specific reason look like one that never
ran. Which is what happened, twice, on a phone.

The fix separates the two questions:

  - **`gateway.log`**, written by the bootstrap itself (`appendFileSync`, so it
    cannot be lost to a buffer) and truncated at the start of every run. Only
    the gateway writes it, so nothing can bury its lines. `log()` and `fatal()`
    both go there, and `describeRuntimeExit()` reads the same file.
  - **`node.log`** stays the firehose, for crash reports, and the app takes only
    the `[node-runtime]` lines from it — the markers that say whether the script
    was handed to the runtime and how node ended.
  - The app empties `gateway.log` before each attempt, so a previous failure can
    never be shown as this attempt's — including when the runtime produces no
    output at all, which is the case with no other signal.
  - `restoreStdio()` puts the app's own descriptors back when `node::Start`
    returns, so the firehose stops growing with unrelated app output once the
    runtime is over. (The WebView lines on the phone were timestamped *after*
    the exit, which is how this was noticed.)

`readGatewayLog()` is therefore two sources, and — since the first version of
this still read the firehose — neither of them is `node.log`:

  - `gateway.log`, the gateway's own narrative;
  - `runtime.log`, the `[node-runtime]` markers, written to a file of their own
    by `NodeRuntimeHost` (`markRuntime()`) as well as to `node.log`. A 64 KB tail
    of `node.log` on a busy run is all WebView noise, and then the app cannot say
    whether the script was handed over at all — the one question that separates
    "the install failed" from "nothing ran".

`node.log` is still written, and is the right thing to read for a crash report. Guards: `payload:install-test` asserts the file exists, names
the run, and receives failures too (19 assertions); `runtime:contract` asserts
that both languages name the same file, that the bootstrap writes it and that the
app reads it — the same handshake class as the run flag in §5f.

### 5h. The other things an install can die of on a phone

Two more failure modes were closed while chasing the device install, because
each of them presents as a mystery rather than a message:

  - **Free space.** The published payload is 776 MiB and unpacks into 44,002
    files; the archive and its contents have to fit at once. A doomed install
    used to fail *partway through the unpack*, which reads as a corrupt download
    and costs the app session its one runtime start. `download()` now asks
    `statfs` for the space on the install volume and refuses before writing a
    byte, naming the numbers: `free space 812 MB, need about 2328 MB`. The rule
    is three times the archive (the archive, what it unpacks into, and room to
    breathe), with a 1.5 GB floor when the server sends no `Content-Length`. A
    platform that will not answer `statfs` simply skips the check.
  - **The dead end after a failure.** Once the runtime has exited, it cannot be
    started again in that process, and the card's primary button used to throw
    the guard's sentence — *"the gateway runtime already ran and exited in this
    app session"* — which reads like a bug rather than a next step. It now reads
    **Close the app to try again** when `GatewayState.runtimeExited` is true, and
    asks before ending the process (that is the only way to end hosting, §5e).
    A failure that has nothing to do with the runtime — a download that 404s,
    say — no longer shows the "reopen the app" note at all, because reopening
    would not help.

Also, the APK's version *name* now carries the build number
(`1.0.0-b43`), so a screenshot or Settings → Apps answers "which build is
this?" without a round trip. The release tag is unchanged.

### 5i. A 776 MB download on a phone that is on Wi-Fi

The payload is the largest thing this app ever moves, and the phone is not a
server: Wi-Fi drops, the screen sleeps, Android moves the phone between networks.
Three things had to be true before "just try again" was reasonable advice.

  - **The download resumes.** `download()` looks at the `.part` file, sends
    `Range: bytes=<size>-`, and appends when the server answers `206`. GitHub's
    release assets do. A server that ignores the range, or resumes at an offset
    that does not match what is on disk, is detected (`206`/`Content-Range`
    checked against the file size) and the download restarts cleanly rather than
    producing a subtly corrupt archive. The checksum still covers the reassembled
    file, so a bad resume fails verification instead of installing.
  - **The partial file survives a failure.** It used to be deleted at the start
    of every attempt *and* again on any failure, which made the resume point
    impossible to keep. Now it is deleted only when the payload fails
    *verification* — that file is known bad, and resuming it would loop forever.
    `mismatch.badPayload = true` is what carries that distinction to the cleanup.
  - **A dead connection is noticed.** Android does not reset a dropped Wi-Fi
    connection, it simply stops delivering bytes, so an install could sit on a
    dead socket showing progress for a download that was not happening. 120 s
    without a byte is a stall (`GATEWAY_DOWNLOAD_STALL_MS` overrides it), and the
    message says what to do: *"download stalled after 412.3 MB — nothing arrived
    for 120s. Start it again: the download resumes from where it stopped."*
    A body that ends early without an error is caught too, and says the same.

Guards: `payload:install-test` serves the payload badly on purpose — one URL
drops the socket halfway, another sends headers and then goes quiet. It asserts
that the failure is reported, that the retry asks with a `Range` header, that the
partial file is kept, and that the resumed download verifies and boots (29
assertions; 6 of them fail against the previous `download()`). The log's resume
line is part of the log contract (`gateway:test`), so the card can show
"Resuming the download…" rather than appearing to start over.

### 5j. When GitHub will not serve the file

A phone reported this, in the app's own log:

```
[gateway] starting on node v24.20.0 (pid 28192)
[gateway] fetching the expected checksum…
[gateway] FAILED: Error: could not fetch the expected checksum from
  https://github.com/evrahimkhan/Omniroute_mobile/releases/download/
  gateway-payload/omniroute-payload.tar.gz.json: checksum URL returned HTTP 404
```

The asset exists — `curl` from the open internet gets the same `302` for that
URL that it gets for the payload itself, and a `404` only for a name that is
genuinely absent. Something on that phone's network answered 404 for one GitHub
URL. Whatever it was, the app's response to it was the bug:

  - **An unreachable checksum is no longer fatal.** The manifest is served from
    the same host as the payload, so it catches corruption in transit, not a
    hostile publisher — and gzip's own CRC already catches most corruption.
    Refusing to install because a *checksum* URL is unreachable (a filter, a
    portal, a flaky proxy, a 404) turns defence-in-depth into an outage. The
    install proceeds on the same warning path that already existed for "no
    checksum configured", with the reason included:
    `warning: no checksum available (the manifest at <url> could not be
    fetched: <reason>) — installing without integrity verification`.
    A manifest that *was* fetched and does not match stays fatal: that is
    corruption, not a network problem.
  - **Transient download failures are retried**, three attempts 2 s and 4 s
    apart, resuming between them — so a retry costs the missing bytes, not the
    whole 776 MB. A 4xx is not retried (the server has answered), except 408 and
    429, which are explicitly about trying again.
  - **403/404 on the payload names the URL** and says what to try. "GitHub would
    not serve this file to this network" is different advice from a timeout, and
    a bare "HTTP 404" sends people looking in the wrong place —
    `explainFailure()` in `lib/gatewayLog.ts` now lists both causes.

Guards: `payload:install-test` reproduces the phone's case (a manifest URL that
404s must not stop the install), a 500 that is retried and then succeeds, a
dropped socket that recovers within one attempt, and an endpoint that always
drops to prove the partial file survives for the next run — 34 assertions.

### 5k. A status that does not lie, and a log that survives a death

The first install that got all the way through — download, 44,003 files
extracted, `install complete`, `starting server.js on 127.0.0.1:20128` — ended
with the app process gone. Reopening it showed **"Starting the gateway…"**
forever, with a spinner and no button: the only way out was to remove the
install.

That second part was the app's fault, and it is the more embarrassing half. The
phase was derived from the *log*:

```ts
if (fromLog.phase === 'installing') phase = 'installing';
else if (status.running && marker) phase = 'starting';
else if (fromLog.phase === 'starting' || (status.running && !marker)) phase = 'starting';
```

The third line reads a file from a previous process and reports it as the
present. A line in a log is a record of what happened once; it is not evidence
of what is happening now. `deriveGatewayPhase()` in `lib/gatewayLog.ts` now
decides from the runtime's real state — running, exited, or neither — and lets
the log only *refine* it (installing vs starting). Nothing running and nothing
exited is `idle`, which shows "Installed — not running" and a **Start the
gateway** button. It is a pure function, so `gateway:test` covers the table,
including the exact stale line that trapped the phone.

The first part — the death itself — cannot be fixed from here without evidence,
so the app now collects it:

  - The bootstrap logs `${entry} loaded; waiting for host:port to answer` as soon
    as the payload's server module has been imported, and then polls
    `/healthz` itself, logging `the server is answering on <url>`. That
    distinguishes "never came up" from "came up and later died" in a log that
    outlives the process.
  - The card's expanded log now shows **"What the runtime printed"**: the part of
    `node.log` after the last `[node-runtime] starting node` marker, which is
    where the payload server's stdout and any native abort message land. It is
    display-only — `readGatewayLog()` (state) still refuses to touch the
    process-wide log, and `runtime:contract` asserts that on the function bodies,
    so noise cannot come back into the state machine through the display path.

Nothing has yet proved the runtime survives a Next server boot on hardware with
2.3 GB of payload: the app process died silently on the first attempt, which
points at memory or an OEM task killer rather than a JavaScript error (a
JavaScript error would have printed `[gateway] FAILED:` and did not). The next
attempt's `node.log` tail should say which.

### 5l. Protecting the boot, and describing the death

Two things changed after the first device install that got all the way through
and then took the process with it.

**The keep-alive now protects the boot, not just the idle gateway.** The service
used to be started *after* `NodeRuntimeHost.start()`. The payload's boot — a Next
standalone tree loading 44,003 files — is the most memory-hungry moment this app
has, and an Android process that is not foreground is the first one the system
reclaims. The service is now started **first**, so the whole boot happens under
foreground protection. If the runtime then fails to start, the failure path
undoes it: `StartPrefs.clear()` and `GatewayService.abandon()` — a stop that
leaves the process alone, because killing the app here would turn a recoverable
start failure into a crash. (`requestStop()` is the wrong tool for this: it ends
the process deliberately, which is right from the notification and wrong here.)

**The log now says what memory the process had.** A runtime killed for memory
leaves no message anywhere — no exception, no stack, nothing in any log — so the
numbers are the only evidence there will ever be:

```
[node-runtime] memory: heap limit 512 MB, used 41 MB, device free 1093 MB of
  7602 MB, lowMemory=false, largeHeap=true
```

`NodeRuntimeHost.memoryFacts()` writes that before `node::Start`, into both logs.
The module manifest also sets `android:largeHeap="true"`: a Next server booting
on a phone is exactly the case the flag exists for, and the ceiling it raises is
the one Android enforces.

`describeRuntimeExit()` now keys off `[node-runtime] starting node` specifically,
not any `[node-runtime]` line — the memory line is written before the script is
handed over, so it must not be read as proof that it was.

Guards: `runtime:contract` asserts the ordering (the service's `start()` before
the runtime's), that `abandon()` exists and is used, that the memory line is
written, and that the manifest carries `largeHeap`. `gateway:test` covers the
wording case above.

### 5m. Asking Android why the app disappeared

The device install that got all the way through ended with the app simply gone:
no `[gateway] FAILED:`, no exception, no trace in either log. A process killed
for memory leaves exactly that signature, and no amount of reading my own logs
was going to say more, because a killed process writes nothing before it dies.

Android keeps the reason. `ApplicationExitInfo` (API 30+) records, per app, how
each past process ended and why: `REASON_LOW_MEMORY`, `REASON_CRASH_NATIVE`
(with the signal), `REASON_CRASH`, `REASON_ANR`, `REASON_SIGNALED`,
`REASON_EXCESSIVE_RESOURCE_USAGE`, and so on, plus the time and whether the
process was foreground. `NodeRuntimeHost.previousExit()` asks for the app's own
history (`ActivityManager.getHistoricalProcessExitReasons`) and the card shows the
newest abnormal record under **"Last abnormal exit"** — above the logs, because
that is the question everyone actually has.

The wording carries the time the exit happened and claims no more than that: a
normal exit does not clear the history, so the record can be older than the last
run. One platform bug is worth knowing while reading it — on Android 11 a query
for the app's *own* package comes back empty unless the app holds
`PACKAGE_USAGE_STATS`; 12 and later answer normally, and an empty answer is
treated as "nothing to report".

Two decisions in it worth naming:

  - **Only abnormal endings are reported.** `REASON_USER_REQUESTED` and
    `REASON_OTHER` are filtered out: "the user swiped it away" is not news, and
    reporting it would bury the line that matters.
  - **It can never be the reason a start fails.** The whole thing is behind an
    API-30 guard and a `runCatching`: a diagnostic that throws is worse than no
    diagnostic, and this one runs during app startup.

It is carried as `NodeRuntimeStatus.previousExit` → `GatewayState.previousExit`,
and `runtime:contract` asserts the whole chain (the Android read - by name, the
filter,
the status-map entry, the TS type, the app's pass-through), plus the API guard.
Removing the status-map entry fails two checks.

### 5n. The boot record, and the heap limit that stops the kill

The installation that got furthest on the phone ended the same silent way: the
payload unpacked, `starting server.js on 127.0.0.1:20128` appeared in the log,
and the app was gone. Neither log said another word, and there was nothing to
read afterwards — which is the signature of a process that was killed rather
than one that failed. A killed process writes nothing on the way out.

Two changes follow from that, one for each half of the problem.

**A record written ahead of the step (`boot.log`).** `gateway.log` is already
written synchronously, so it always reaches the line *before* the crash; the
problem is the line after it. So the bootstrap now keeps a separate record and
writes each step *before* taking it:

```
01 runtime ready on node v24.20.0 (pid 8123)
02 installing the payload
03 the payload is installed
04 loading dist/server.js
```

Every line is `open` → `write` → `fsync` → `close`, because an unflushed write
is a write that a SIGKILL takes with it. The last line is therefore a fact about
where the process was, not an inference from what it managed to say. The steps
cover the boot (`loading <entry>`, `<entry> loaded; waiting for the server to
answer`, `the server is answering`) and every way the process can end that node
lets us observe: `the process is exiting (code N)` (which is how a payload's own
`process.exit()` is told apart from a crash), `asked to stop (SIGTERM)` and the
other signalled exits, and `uncaught exception`/`unhandled rejection` with the
message. SIGKILL and a native abort cannot be recorded — which is precisely why
the step is written first.

The app reads it two ways, and the distinction matters. While the boot is still
running the card shows the step **verbatim** (`Boot record: loading
dist/server.js`) — the file cannot say whether a process is working on that step
or died in it, and only the runtime's state can. Once the runtime is gone the
card shows what the record **means** (`How the boot went`), and that sentence is
appended to the failure message in place of the old "the embedded runtime
exited": "died while loading the server, before it printed anything" and "died
after the server loaded, before it answered" point at different causes.

**A heap limit that makes the kill not happen.** The failure this was written
for is memory. With `largeHeap` the app asks for a large heap, and V8 — which
sizes its own heap from the *device's* memory unless someone says otherwise —
is then free to grow into the gigabytes, while Android kills the process far
below that. So node is now started with a cap derived from Android's own
number:

```
--max-old-space-size = ⅔ × Runtime.maxMemory()
```

`Runtime.maxMemory()` is the limit Android enforces on this app (the memory
class, or the large class the manifest asks for), so two thirds of it is a
budget the system will actually honour; the rest is left for the payload's
native modules and the app's own Java side. The point is not only the number:
inside a heap limit V8 *collects* instead of growing, so a boot that was being
killed can now fit — and if it still does not, V8 aborts with `FATAL ERROR:
Reached heap limit`, which prints, instead of the app disappearing. Both
numbers (Android's limit and the cap node was given) are in the runtime log's
`memory:` line, which is what makes a phone report actionable.

No cap is not the same as no limit: the flag is passed to V8 **before** the
script name, because node parses its own options only up to that point — after
it, the option is just an argument to the script. `runtime:contract` asserts the
position, the derivation, the floor and the logged line, and moving the flag
after the script fails it.

`payload:install-test` reproduces the failure end to end with a payload whose
entry calls `process.abort()`: SIGABRT in native code, no JavaScript handler,
nothing in the gateway log — and the record still ends at `loading server.js`,
which is the assertion that keeps this honest.

### 5o. Signal 11: the crash the payload could not report

The next device run reached the point this whole feature was built for — and put
the fault somewhere new. The log shows the payload booting *completely*:

```
[STARTUP] Embedded services bootstrap complete
[INFO] [MEMORY_MANAGER] Registered backend {"id":"sqlite"}
[INFO] [MEMORY_MANAGER] Initialized backend {"id":"sqlite"}
```

and then the app is gone. Android's exit record names it:

```
the last abnormal exit was 2026-10-01 03:24:
it crashed in native code — SIGSEGV (a crash in native code — a library, not the payload's JavaScript)
(while it was in the foreground)
```

Not memory (`lowMemory=false`, device free 2839 MB of 7446 MB), not the heap cap
(512 MB budget, capped to 341 MB, 15 MB used), not the payload's JavaScript — a
segfault in native code, in the foreground, during startup. Two earlier deaths
were `SIGABRT`, which is what node's own fatal-error path raises.

So three changes, all pointed at that class of failure.

**The tombstone is read, not just the signal number.** A native crash is the one
failure no log of ours can describe: the process dies between two instructions.
Android keeps the dump, and `ApplicationExitInfo.getTraceInputStream()` returns
it — the signal and fault address, the abort message, and the backtrace, whose
frames name the *library and offset* that faulted. That is the difference
between "node crashed" and "libonnxruntime.so crashed", and only one of those is
actionable. It is trimmed (a tombstone is truncated, an ANR trace is not) to the
signal line, the abort message and the first frames, and printed under "Last
abnormal exit" with the memory the process was using (`Pss`, `Rss`) — the number
that makes the heap cap's value meaningful.

Signals are also named in words now: `SIGILL` (a library for the wrong CPU),
`SIGABRT` (node's own fatal path, which prints first), `SIGBUS`, `SIGSEGV`,
`SIGKILL`. "Killed by signal 11" was true and useless.

**The payload is checked for native libraries built for another CPU.** This is
the hypothesis the evidence points at, and it is structural: the payload is
assembled on a GitHub runner (**x86-64**) from a Next.js build whose `standalone`
output copies whichever prebuilt native modules `npm ci` installed *there*.
Nothing in that pipeline knows the phone is arm64. `sharp`, `onnxruntime-node`,
`better-sqlite3` and friends ship prebuilds for the platform they were installed
on, and a binary for the wrong CPU travels to the phone inside the payload — the
install succeeds, the payload boots, and the first `require()` that touches the
library dies with no output. CI cannot catch it: the payload is booted on the
runner, where an x86-64 binary is exactly right.

So the bootstrap reads 20 bytes of every `.node`/`.so` in the installed payload
and compares `e_machine` against `process.arch`, before every boot:

```
[gateway] native libraries in the payload: 41, all built for arm64
[gateway] warning: 3 of 41 native libraries in the payload are built for another
          CPU than this phone (arm64): node_modules/sharp/build/Release/sharp-linux-x64.node
          (x86-64), … — loading one of those is a native crash with no output at all
```

It reports rather than refuses: a foreign library that nothing loads is
harmless, and this runs before every boot including ones that work. What it buys
is that the warning is in the log *before* the crash it predicts.

**More native stack.** The 8 MB default predates the payload ever booting. The
gateway is a Next.js server: tens of thousands of modules loaded through chains
of C++ frames, and node's `--stack-size` bounds only *JavaScript* recursion —
the frames under it live on the thread's stack, and running out of that is a
SIGSEGV, not a catchable error. The default is now 32 MB, which costs address
space and nothing else on a 64-bit process. `runtime:contract` asserts the two
declarations of that default agree.

### 5p. The cause: the payload shipped libraries for the wrong CPU

The boot record and the arch scan together produced the answer, and the device
proved it:

```
[gateway] warning: 29 of 63 native libraries in the payload are built for another
          CPU than this phone (arm64): src/mint/proxy/native/build/Release/transform.node
          (x86-64), node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node (x86-64),
          node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.17.6 (x86-64) …
```

**29 of the payload's 63 native libraries were x86-64, and the phone is arm64.**
That is the SIGSEGV, and it is not a subtle bug:

- the payload is assembled on a GitHub runner — x86-64 Linux — by `npm ci` plus a
  Next.js `standalone` build;
- `npm ci` resolves npm's *optional per-platform* native packages for the machine
  that runs it, so `@img/sharp-*`, `@wreq-js/binding-*` and anything node-gyp
  compiled in place are all built for Linux x86-64;
- nothing in that pipeline knows the target is an arm64 phone, and its own boot
  check cannot notice, because the payload boots perfectly *on the runner*, where
  an x86-64 binary is exactly right.

Loading such a library is `SIGSEGV` inside the app's process (node runs
in-process, by design), which is why the app disappeared rather than reporting
anything: node died before it could.

Two fixes, one for each end of the pipeline.

**In the payload build (the cause).** A new step between locating the standalone
tree and packing it runs `scripts/prune-native-libs.mjs`, which deletes every
`.node`/`.so` whose ELF `e_machine` is not arm64, prints what it removed, and then
re-runs itself with `--check` — so a payload that still carries a foreign library
*fails the build*, naming the file, instead of reaching a phone. What replaces a
removed library is whatever the payload already does without it: upstream treats
most of these as optional and warns rather than fails, and the alternative is a
plain `Cannot find module`, which prints and which the app can show. The rules
matter more than the tool: a library for another CPU can never load on a phone,
so deleting it cannot lose a feature that worked.

**On the device (surviving one).** The bootstrap no longer only *reports* foreign
libraries: it moves them out of the install tree into `wrong-arch/` before every
boot, and says so once:

```
[gateway] moved 29 of 63 native libraries out of the payload — they are built for
          another CPU than this phone (arm64), and loading one is a crash with no
          output: …
```

That matters for the payload already installed on a phone: the fix in the
pipeline only helps the *next* download. Moving the files converts a segfault
into a normal module error, and it is also what makes the second fix visible
rather than theoretical — the first boot after this change either gets further or
says which module it now cannot find.

**And the dump is read for a signalled death too.** The device's crash arrived as
`REASON_SIGNALED`, not `REASON_CRASH_NATIVE` — Android classifies a fatal signal
that way when the crash handler did not claim it, which is exactly what a fault
inside a native addon looks like. The tombstone was available the whole time; the
condition now includes both reasons.

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
| Untested on a real device | Every part of phases 1–5 that a machine *can* verify is verified (CI builds the native code and checks the APK's contents, including the merged manifest's foreground-service declarations; the installer is exercised end to end against the real payload; the JS↔Kotlin↔manifest contract is asserted in App CI), but nothing has run inside an Android app process yet. That is the next milestone, and it is a hardware one. |
| Android may still stop the gateway | A foreground service is the strongest thing an app can do, not a guarantee: OEM battery managers (Xiaomi, Huawei, Samsung) kill them anyway, and so can the user. The card reports the real state (`keepAlive`, read from the service) instead of assuming, and the runtime log keeps the reason. |
| First-run download is big | Partly solved. §5b's pipeline packs the tree in CI — the packaged npm tree comes to 115.6 MB gzipped, and the standalone build it is meant to carry is smaller — and the digest is published next to it, so the app verifies what it downloads. Until the job is dispatched, "install" still means npm's tree, so treat it as Wi-Fi-only. |
| The app and the payload drift apart | The bootstrap is the app's contract with the payload; it is versioned with the app, but the payload URL is not pinned to a version yet, so "latest" can move under an installed app. Pinning both to one release is part of the CI job in §5b. |
| Native exec from app storage | Avoided entirely — the runtime lives in the APK's lib dir. |
