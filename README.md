<div align="center">

# 📱 OmniRoute Mobile

**A native mobile app for [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — the free AI gateway.**

One endpoint → **358 AI providers** → 150+ free tiers → 19 routing strategies.
OmniRoute Mobile wraps the *entire* OmniRoute dashboard in a native Android/iOS shell:
every feature, tab and menu from the web app lives in this app, and the OmniRoute
source is compiled end-to-end by GitHub workflows.

</div>

---

## What you get

| | |
|---|---|
| **Native tab bar** | `Home` (dashboard) · `Chat` (Playground) · `Models` (catalog) · `Providers` · `More` |
| **All features menu** | `More → All Features`: **88 features** in 9 sections — OmniProxy (endpoints, API keys, combos, all 14 compression engines, tools, integrations), Analytics, Costs (free tiers, radar), Monitoring (logs, audit, system), Dev Tools, Agentic (MCP, A2A, memory, skills, plugins), Other (gamification, batch), Configuration (all 12 settings pages), Help |
| **In-app web views** | Every feature opens in-app on your gateway; cookies are shared, so you sign in once and roam everywhere |
| **Gateway awareness** | Live status pill (online/offline, latency), connection test, offline error states, retry, open-in-browser |
| **CI-compiled source** | GitHub workflows compile the OmniRoute source (Next.js build + Docker gateway image) and the app itself (Android APK → GitHub Releases, iOS via EAS) |

The app is a **native shell around a gateway server** — the same architecture as
OmniRoute's own Electron desktop app and PWA. The gateway does the routing
(provider keys, fallbacks, compression, DB); the phone never needs API keys.

## Architecture

```
┌─────────────────────────────── GitHub workflows ───────────────────────────────┐
│                                                                                │
│  omniroute-web.yml            android-apk.yml                ios-eas.yml       │
│  ┌──────────────────┐         ┌────────────────────┐         ┌──────────────┐  │
│  │ clone OmniRoute  │         │ npm ci             │         │ eas build    │  │
│  │ npm ci           │         │ expo prebuild      │         │ (EAS cloud,  │  │
│  │ next build + CLI │ ──APK──▶│ gradle assembleRel │         │ Apple creds) │  │
│  │ docker image     │         │ → GitHub Release   │         └──────────────┘  │
│  └─────────────────┘         └────────────────────┘                           │
│           │                                                                    │
└───────────┼────────────────────────────────────────────────────────────────────┘
            ▼
   ┌─────────────────┐        ┌──────────────────────────────┐
   │ OmniRoute       │  HTTPS │  OmniRoute Mobile (this app) │
   │ gateway         ◀────────┤  Expo / React Native shell   │
   │ (Docker / VPS /  │        │  ┌────────────────────────┐  │
   │ omniroute.online)│        │  │ tabs + feature catalog │  │
   └─────────────────┘        │  │ WebView (session shared)│  │
                              │  └────────────────────────┘  │
                              └──────────────────────────────┘
```

## Quick start (user)

1. **Get the app**
   - Android: latest APK in [GitHub Releases](https://github.com/evrahimkhan/Omniroute_mobile/releases)
     (produced by the *Build Android APK* workflow — see [CI pipeline](#ci-pipeline) for
     what triggers a build today).
   - iOS: see [Building the iOS app](#building-the-ios-app-eas) — run the *Build iOS (EAS)*
     workflow with an `EAS_TOKEN`, then install the internal IPA.
2. **Get a gateway**
   - Public: `https://omniroute.online` (default in the app)
   - Self-hosted from the compiled source:
     ```bash
     docker pull ghcr.io/<your-github-user>/omniroute-mobile:main   # built by the workflow
     docker run -d --name omniroute -p 20128:20128 \
       ghcr.io/<your-github-user>/omniroute-mobile:main
     ```
   - Or download the `omniroute-build-<sha>` artifact from the workflow run and run the
     standalone server it contains.
3. **Connect**: open the app → enter your gateway URL → **Test** → **Connect** → sign in to
   the dashboard once. All 88 features are under `More → All Features` (with search).

> Self-hosted on a LAN? Use `http://<machine-ip>:20128` (plain HTTP on Wi-Fi works; the
> gateway serves the dashboard over HTTP). For remote access put it behind a reverse proxy
> with TLS, or use a tunnel.

## Local gateway (hosting OmniRoute on the phone)

The app is working toward hosting the npm OmniRoute **on the device**, so a
self-hosted gateway needs no server, Docker, or Termux — see
[docs/LOCAL_GATEWAY.md](docs/LOCAL_GATEWAY.md) for the full design, the verified
platform constraints, and what is expected to degrade.

How it fits together:

- **The Node runtime ships inside the APK.** Android 10+ will not execute
  anything the app can write, so `libnode.so` (Node 24.20.0, from
  `nodejs-mobile`) is placed in `modules/node-runtime/android/src/main/jniLibs/<abi>/`
  and extracted by the installer into the executable `/data/app` path — Google's
  documented approach. `npm run runtime:fetch` does the placement; CI then
  asserts the built APK really contains it, and that the JNI bridge was built
  and packaged with it (`npm run runtime:verify`).
- **A local Expo module bridges JS to the runtime** (`modules/node-runtime`):
  Kotlin `NodeRuntime` over a small C++ shim that calls `node::Start` on a
  dedicated thread, with the environment (`TMPDIR`, `HOME`, …) set before boot
  and stdout/stderr redirected into a log the app can read back.
- **The gateway itself is downloaded after install** (~121 MB tarball → 431 MB
  unpacked), because bundling it would blow past store size limits.
- **It runs in-process** — the CLI's daemon mode uses `child_process`, which is
  blocked on mobile. SQLite falls back to Node's built-in `node:sqlite` or
  bundled WASM, and native addons (`sharp`, `onnxruntime-node`, …) are lazily
  imported behind `try/catch`, so their absence degrades features rather than
  breaking the server.
- **Installing happens inside the runtime, not in the app.**
  `gateway/bootstrap.mjs` downloads the payload, verifies its checksum, unpacks
  it, and boots it — the runtime already has `fetch`/`crypto`/`zlib`, so the app
  needs no download manager or unzipper. It is embedded into the bundle as a
  string by `npm run gateway:embed` (CI fails if that constant is stale), and it
  has to boot the server as well, because the runtime starts only once per app
  process.
- **The app's side is small** (`lib/gatewayInstaller.ts`): write the script,
  start the runtime on it, then poll `/healthz` until the gateway answers — so
  the URL saved into settings is one that actually responds.

> Status: phases 1–3 (runtime packaging, the JNI bridge, and the install flow)
> are implemented; the UI lands next. Everything a machine without a phone can
> verify *is* verified — CI compiles the native code with the NDK and checks what
> the APK contains, and the installer was exercised end to end against the real
> published payload (byte-identical to system `tar`, then a real boot) — but
> **nothing has yet run inside an Android app process**, and the payload is still
> npm's 2.6 GB tree rather than the standalone build planned in
> [docs/LOCAL_GATEWAY.md](docs/LOCAL_GATEWAY.md) §5b.

## CI pipeline

| Workflow | Trigger | Produces |
|---|---|---|
| **App CI** (`app-ci.yml`) | every push to `arena/01a0e9f8-omniroute-mobile` + every PR | workflow-file audit + typecheck + Hermes bundle (fast compile gate for the app) |
| **Build Android APK** (`android-apk.yml`) | push to `arena/01a0e9f8-omniroute-mobile` + **manual dispatch** (`version`, `create_release`) | `OmnirouteMobile-v<version>-b<build>.apk` artifact + **GitHub Release** |
| **Build OmniRoute source** (`omniroute-web.yml`) | **manual dispatch** (`ref`, `docker`, `dockerhub` inputs) | `omniroute-build-<sha>.tar.gz` artifact (`.build/` + `dist/` — same layout as upstream's build) + Docker image `ghcr.io/<owner>/omniroute-mobile:sha-<sha>` / `:main` (+ Docker Hub if secrets set) |
| **Build iOS (EAS)** (`ios-eas.yml`) | **manual dispatch** (`profile`, `submit`) | IPA on EAS (skipped unless `EAS_TOKEN` secret exists) |

> **On the push trigger.** This repo's default branch is a working branch
> (`arena/01a0e73e-omniroute-mobile`), and there is no `main` — so the `push` triggers in
> `app-ci.yml` and `android-apk.yml` point at `arena/01a0e9f8-omniroute-mobile`, the branch
> these fixes were developed on. That means every push to that branch runs App CI **and**
> publishes a GitHub Release with a fresh APK.
>
> If you move development to another branch, update the `branches:` list in those two files
> to match (or re-create `main` and point them back at it). Everything else in the pipeline —
> the OmniRoute source build and the iOS/EAS build — is manual-dispatch only and is unaffected.
>
> Until recently none of the three build workflows could run *at all*: each referenced the
> `secrets` context inside an `if:` expression, which makes GitHub reject the entire
> workflow file (`Unrecognized named-value: 'secrets'`) before any job is scheduled — the run
> dies in 0s with zero jobs, the name shows as the file path, and the workflow's triggers stop
> firing, including `workflow_dispatch`. That is fixed, and `scripts/check-workflows.mjs`
> (run by App CI via `npm run workflows:check`) now audits GitHub's context-availability rules
> so this class of breakage is caught in a PR instead of silently disabling a workflow.

The source-build workflow uses the exact recipe from OmniRoute's own CI
(Node 24, `npm run build:release`, 10 GB swap step, Turbopack) so the compiled
source always matches the upstream project. It is **manual-only** on purpose:
OmniRoute's upstream project disabled hosted push triggers for this build
(their #11946) because the hosted 7 GB runner OOMs on this tree in most
attempts. Run it from the Actions tab whenever you want a fresh compiled
source / gateway image — public repos get free Actions minutes.

### Repo secrets (all optional)

| Secret | Used by | Purpose |
|---|---|---|
| `EAS_TOKEN` | Build iOS (EAS) | enable iOS builds |
| `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | Build OmniRoute source (dispatch with `dockerhub: true`) | mirror the gateway image to your Docker Hub |
| `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | Build Android APK | sign the APK with a release key (Play Store) |

## Building the iOS app (EAS)

1. `npm i -g eas-cli && eas login`
2. In this repo: `eas init` (links the project to your account)
3. `eas credentials` (or let EAS manage certificates)
4. Add your `EAS_TOKEN` to the repo: `eas secret:create --name EAS_TOKEN` (or via the
   GitHub UI)
5. Run **Build iOS (EAS)** from the Actions tab — pick a profile:
   - `development` — dev client
   - `preview` — internal distribution IPA (TestFlight-style)
   - `production` — store build; `submit: true` pushes to App Store Connect

## Development

```bash
npm install
npx expo start            # Expo Go on a phone, or a dev client
npm run typecheck         # tsc --noEmit
npm run apk               # prebuild + gradle assembleRelease locally
```

- The feature catalog (`lib/features.ts`) mirrors the dashboard navigation from
  `src/shared/constants/sidebarVisibility/sections.ts` in the OmniRoute repo —
  re-sync it when you bump the compiled source.
- Native projects (`android/`, `ios/`) are **generated** by `expo prebuild` in CI
  and git-ignored; commit `app.json`, `eas.json`, and the `expo.config`-level
  changes only.
- Theme colors mirror the dashboard (`#0b0f1a` background, orange accent).

## Repo layout

```
app/                  expo-router screens
  (tabs)/             Home · Chat · Models · Providers · More
  feature/[...path]   catch-all → any gateway route
  settings.tsx        server URL, test, clear data, about
components/           OmniWebview, GatewayTab, ConnectionGate, ServerPill
lib/                  features catalog, gateway probes, settings store, theme
scripts/              CI helpers (version stamp, APK signing, workflow audit)
.github/workflows/    source compiler · Android APK · iOS EAS
```

## Credits & license

- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) by [diegosouzapw](https://github.com/diegosouzapw) — MIT
- OmniRoute Mobile — MIT (see [LICENSE](LICENSE))
