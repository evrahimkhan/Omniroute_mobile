# Native UI

The app used to be a shell around a `WebView` showing the gateway's dashboard.
It is now a phone app: native screens over the gateway's HTTP API, with no web
view anywhere in the process. This document is the migration record — what moved,
what is still dashboard-only and why, and how the claim is checked.

The rule the rewrite is built on: **a surface is either a real native screen or it
is honestly absent.** Nothing here lists a feature that secretly opens a web page,
because a dead-end row is worse than a missing one — it hides where the app's
coverage actually ends.

## The shape

Five native tabs, plus routes pushed on top of them:

| Tab | Screen | What it is |
| --- | --- | --- |
| Home | `app/(tabs)/index.tsx` | Health, uptime, memory, error rate, providers on, recent requests |
| Playground | `app/(tabs)/chat.tsx` | Streaming chat against any connected model |
| Models | `app/(tabs)/models.tsx` | The whole catalog, searchable and filterable |
| Providers | `app/(tabs)/providers.tsx` | Every connection, with on/off |
| More | `app/(tabs)/more.tsx` | Searchable catalog of the app's own screens + About |

Pushed routes: `/keys`, `/logs`, `/combos`, `/settings`, `/sign-in`.

The UI kit (`components/ui/kit.tsx`, `Sheet.tsx`, `Toast.tsx`) is a handful of
primitives — Screen, Card, ListRow, StatTile, Badge, Chip, Button, Field,
SearchField, ToggleRow, KeyValue, the loading/empty/error states, a bottom sheet,
a promise-based `confirm`, a `PromptSheet` and a toast queue. It depends only on
React Native primitives, `@expo/vector-icons` and `lib/theme.ts`, so there is no
UI framework to keep in step with Expo.

## Migration table

Nine dashboard surfaces exist as native screens. The rest are grouped below with
the reason they stayed; the full 94-item dashboard navigation that used to live in
`lib/features.ts` is the reference list.

### Moved

| Dashboard surface | Native screen | Gateway API |
| --- | --- | --- |
| Overview / Health / Runtime | Home (`/(tabs)`) | `GET /api/health`, `GET /api/telemetry/summary?windowMs=` |
| Providers | Providers (`/(tabs)/providers`) | `GET /api/providers`, `PATCH /api/providers {ids,isActive}` |
| Model Catalog | Models (`/(tabs)/models`) | `GET /api/models?all=true` |
| API Keys | `/keys` | `GET/POST /api/keys`, `DELETE /api/keys/:id` |
| Logs (request log) | `/logs` | `GET /api/usage/call-logs?search=&status=&limit=` |
| Playground | Playground (`/(tabs)/chat`) | `POST /v1/chat/completions` (fallback `/api/v1/...`), SSE |
| Combos (view) | `/combos` | `GET /api/combos` |
| Settings (connection) | `/settings` | `GET /api/auth/status`; local URL from the embedded runtime |
| Security (session) | `/sign-in` | `POST /api/auth/login`, `POST /api/auth/logout` |
| Sidebar / navigation | More (`/(tabs)/more`) | none — it is the app's own index |

### Deliberately not moved

| Dashboard area | Examples | Why, and what it would take |
| --- | --- | --- |
| Combo authoring | Combo Studio, Engine Combos | The builder is ordering, conditions and per-member weights across a canvas. A cut-down list editor would either write wrong combos or refuse most of what the dashboard can express. Read-only view shipped instead. |
| Context compression | Headroom, CCR, LLMLingua, Caveman, RTK, Session Dedup, Ultra | Eleven tuners whose effects are measured elsewhere (Compression analytics). Each is a form over config with no feedback loop on a phone. |
| Routing and resilience | Global Routing, Resilience, Advanced, Feature Flags | High-blast-radius settings: a wrong routing rule sends every request to the wrong provider. Needs the dashboard's validation context and history. |
| Provider onboarding | 358-provider directory, OAuth flows, quotas, free-tier rankings, Radar | Adding a provider is an interactive OAuth/credential dance in a browser tab. The app shows the result — a provider appears in the list and can be switched on or off. |
| CLI / agent surfaces | CLI Code, CLI Agents, ACP/Cloud Agents, Conductor, Orchestration, Agent Bridge | These manage processes that do not run on the phone. |
| Analytics and cost | Usage, Combo Health, Utilization, Cache, Search, Evals, Costs, Pricing, Budget | Chart-heavy and read-mostly; the parts a phone needs (error rate, recent calls, tokens, cost) are already on Home and Logs. |
| Observability beyond requests | Console, Timeline, Proxy Logs, Conversations, Audit, MCP/A2A Audit, Translator | Streaming text views with long rows; the request log covers the common question ("did my call work, and why not"). |
| Content and account | Media, Batch Jobs, Files, Memory, AgentSkills, OmniSkills, MCP/A2A Server, Plugins, Leaderboard, Profile, Tokens, Gamification | Not phone-shaped, or account management that is naturally done once at a desk. |
| Appearance and storage | Storage, Appearance, Sidebar, Cache | Cosmetic or device-local to the dashboard's own host. |

The dashboard remains the place to configure those, and the app never opens it —
that was the point of the rewrite. Reaching it deliberately means opening the
gateway's address in a browser.

## The client

Everything a screen does goes through `lib/api/`:

- `client.ts` — `apiRequest`/`createApi` with a 15-second timeout, query building,
  and three error kinds the UI can act on: needs-a-session, unreachable (names the
  URL it tried, and how long it waited) and timed out. Upstream messages are read
  from `{error:{message}}`, `{error}` and `{message}`.
- `shape.ts` — tolerant readers. The gateway is a moving target with several
  response shapes per route, so readers return `undefined` rather than inventing a
  default: a blank cell is honest, a wrong number is not.
- `resources.ts` — view models and requests for health, telemetry, providers,
  models, keys, combos and call logs.
- `chat.ts` — an SSE decoder (pure and exported for tests) plus a streaming client
  that probes `/v1/chat/completions` once, remembers the answer, and degrades to a
  non-streaming call when the runtime gives no readable body.
- `auth.ts`, `context.tsx` — the session and the providers/hooks screens use.

Two behaviours worth knowing, both learned the hard way:

- **There is no cookie jar in React Native's `fetch`.** The `set-cookie` from
  `POST /api/auth/login` is captured, stored under `omniroute.session.v1` in
  AsyncStorage, and replayed as a `Cookie` header. `401` means the screen should
  offer sign-in; `403` means the route is loopback-only and the gateway must be
  reached at `127.0.0.1`.
- **A gateway that is not there is a state, not an error page.** Every screen
  renders a legible message and a retry, keeps its last good data visible while
  refreshing, and never blocks on a request that has not returned.

## Verification

`npm run api:test` (61 assertions) compiles the real client and runs it against a
fake gateway on loopback — a real HTTP server, not a stubbed fetch. It covers URL
building (`192.168.1.10:20128` is `http`, not `https`), each reader against the
shapes the gateway actually returns, the error surfaces above, cookie capture and
replay, mid-UTF-8 SSE chunk splitting, and the path fallback.

It also asserts the migration itself, so the rewrite cannot quietly regress:

- no file under `app/`, `components/` or `lib/` imports a web view;
- `react-native-webview` is not a dependency;
- `lib/webData.ts`, `lib/features.ts` and `app/feature/` do not exist;
- every one of the ten destinations in `lib/destinations.ts` resolves to a screen
  file that exists.

`npm run api:test` runs in the App CI workflow alongside the typecheck and the
Metro bundle, so a screen that imports a missing module or a menu entry that points
at a deleted route fails CI rather than a phone.

## Not yet proven on hardware

Nothing has been built since b60, so the native screens have not run on a device.
When a build exists, the checks that matter are: the tab bar renders and each tab
loads against a local gateway; the Playground streams and Stop actually aborts; the
keys sheet copies a secret to the clipboard; Logs filters server-side; and the app
still shows a legible message with the gateway stopped and with it started but the
phone in flight mode.
