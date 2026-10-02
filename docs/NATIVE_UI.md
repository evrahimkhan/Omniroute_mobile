# Native UI

The app used to be a shell around a `WebView` showing the gateway's dashboard.
It is now a phone app: native screens over the gateway's HTTP API, with no web
view anywhere in the process. This document is the migration record — what is
native, how the whole dashboard was covered without writing ninety screens by
hand, and how the claim is checked.

The rule the rewrite is built on: **a surface is either a real native screen or it
says why it is not.** Nothing here lists a feature that secretly opens a web page,
because a dead-end row is worse than a missing one — it hides where the app's
coverage actually ends.

## How many surfaces, and what happened to each

The dashboard's sidebar is the product's own definition of "every function". It
has 95 entries, of which 93 are gateway surfaces (the other two are external
links). The app now covers all 93:

| Kind | Count | What it means |
| --- | --- | --- |
| `custom` | 7 | A purpose-built screen (Home, Playground, Models, Providers, API keys, Combos, Logs) |
| `config` | 35 | A settings object: native switches, fields and pickers, written back on change |
| `collection` | 32 | A list of records: search, rows, badges, a detail sheet |
| `stats` | 14 | Numbers: metric tiles, ranked breakdowns, key/value groups |
| `local` | 4 | Not gateway data — the screen explains why (e.g. the dashboard's own theme) |
| `external` | 2 | A link out of the app, opened only when tapped |

Ninety-three surfaces, seven of them written by hand. The other eighty-six are
drawn by three renderers over the gateway's own API, which is what makes the
coverage honest rather than aspirational: there is no page in the dashboard that
the app cannot open, and no page the app fakes.

## The three renderers

`lib/screens/catalog.ts` decides which one draws a surface. It is **generated**
(`scripts/gen-surface-catalog.mjs`) from `scripts/data/dashboard-surfaces.json`,
which is derived from the gateway's own sources — `sidebarVisibility/sections.ts`
for the grouping and labels, and the `/api` route each dashboard page calls,
followed through its imports. `npm run surfaces:test` fails if the catalog and
the snapshot disagree, so the table cannot drift silently.

### `config` — settings as switches, not JSON

The dashboard's settings pages are, over and over, a client component that
fetches one object and PATCHes parts of it back. Some routes are even
**self-describing**: they return `{key, label, description, type, enumValues,
effectiveValue, requiresRestart, source}` per setting, which *is* a form spec.
`lib/api/config.ts` reads that first, then falls back to inferring fields from
the payload's own types, and the screen draws:

- booleans as switches, `enumValues` as chip pickers, numbers as numeric fields,
  long strings as multi-line fields, everything else as read-only text;
- a "needs a restart" note and "from env" provenance where the route reports it;
- a save bar that appears only when something changed, and sends **only the
  changed keys**, nested back into the shape the route expects (`cache.ttl` →
  `{cache:{ttl}}`). Echoing the whole object back would make the app responsible
  for fields it never displayed.

A settings payload that mixes described flags with plain settings gets both:
flags grouped by their own `category`, plain keys underneath.

### `collection` — lists from what the payload actually is

Rows are described by the payload, not by a per-screen schema: a title from the
first human-looking field (`name`, `model`, `provider`, `message`, …), state as
badges (a `status` word, or booleans like `enabled`/`healthy`), and every other
scalar in a detail sheet. Values under secret-looking keys (`apiKey`, `token`,
`authorization`) are masked before they reach the screen — a screenshot should
not leak a key. Wrapper shapes (`{keys:[…]}`, `{items:[…]}`, a bare array) and a
single-object status route all produce something readable.

### `stats` — numbers without the charts

The analytics pages are chart-heavy in the browser. A phone needs the figure, what
it is made of, and which entries dominate: metrics are formatted by what their key
says they are (bytes, durations, fractions, currency), arrays of records become
proportional ranked bars, and nested objects become key/value groups. `parseStats`
is pure and lives in `lib/screens/stats.ts` so it can be tested without a
renderer — a wrong number is worse than no number.

## What changed in the app shell

Five native tabs plus pushed routes. The catalog lives in the **Menu** tab, and
its *shape* matters as much as its contents: the first version of it was native
but web-shaped — the dashboard's whole sidebar taxonomy (OmniProxy, Analytics,
Costs, Dev Tools, "Other Features"…) poured into one scrolling list of
ninety-four rows, which is the web sidebar with a different scroll bar.

So the screen is a phone menu, which means short and drillable:

- the gateway's status, and a way into Settings or sign-in;
- **Everyday** — the six screens used daily (Playground, Models, API keys, Logs,
  Combos, Settings);
- a search box that searches *every* function flat, because a phone search should
  not make you guess which section a setting lives in;
- **nine sections**, each with a plain-language label, a line saying what is
  inside, and a count — one tap from its own list (`/section/[id]`).

The section names the dashboard uses are kept in the catalog as
`SurfaceSection.title` for traceability, but the menu shows `label` and
`subtitle`: internal taxonomy ("Other Features") is not a phone menu. Individual
surfaces still open `/surface/[id]`, which looks the surface up and renders it —
one route, not ninety files.

Screens built for this refactor: Home (health, telemetry, providers, recent
calls), Playground (streaming chat with Stop), Models (searchable catalog),
Providers (search, filter, on/off), More (the catalog), `/keys`, `/logs`,
`/combos`, `/settings`, `/sign-in`, and the generic `/surface/[id]`.

`components/ui/` is a small native kit (cards, rows, chips, sheets, a toast queue,
real loading/empty/error states); `lib/api/` is the client, including a 15-second
timeout, errors classified as needs-sign-in / unreachable / timed-out, and an SSE
chat decoder.

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

`npm run api:test` (102 assertions) compiles the real client and runs it against a
fake gateway on loopback — a real HTTP server, not a stubbed fetch. It covers URL
building (`192.168.1.10:20128` is `http`, not `https`), the readers, the error
surfaces, cookie capture and replay, mid-UTF-8 SSE chunk splitting, chat path
fallback, and then the surfaces themselves: a self-describing settings route
becoming switches and pickers, partial saves being nested correctly, list rows
with masked secrets and honest badges, and statistics parsed into metrics and
ranked breakdowns.

It also asserts the migration itself, so it cannot quietly regress:

- no file under `app/`, `components/` or `lib/` imports a web view;
- `react-native-webview` is not a dependency;
- `lib/webData.ts`, `lib/features.ts` and `app/feature/` do not exist;
- every custom surface's route resolves to a file, every fetching surface names
  an `/api/…` route, every `local` surface explains itself, and the sections
  partition the catalog without losing an entry;
- the menu is a menu: it searches, it opens surfaces through the shared helper,
  it drills into `/section/[id]` rather than listing everything, and it holds no
  more than a screenful of entries.

`npm run surfaces:test` verifies the generated catalog against its snapshot. Both
run in App CI with the typecheck and the Metro bundle, so a surface pointing at a
route that no longer exists fails CI rather than a phone.

### Regenerating the catalog

When the pinned OmniRoute ref moves, the snapshot needs refreshing. The analysis
tool is not committed (it needs a checkout of the upstream source), so the
procedure is: clone upstream, run the analysis over `src/app`, `src/shared` and
`src/i18n`, review the picks it cannot know (routes reached through shared hooks,
surfaces that are not gateway data), write `scripts/data/dashboard-surfaces.json`,
then `npm run surfaces:test` to regenerate and verify. The snapshot records the
version it came from in its `source` field — currently `release/v3.8.52`.

## Not yet proven on hardware

Nothing has been built since b60, so the native screens have not run on a device.
When a build exists, the checks that matter are: the tab bar renders and each tab
loads against a local gateway; the Playground streams and Stop actually aborts;
the keys sheet copies a secret to the clipboard; Logs filters server-side; a
`config` surface saves one toggle and the gateway's dashboard shows the same
value; a `collection` surface opens a record; and the app still shows a legible
message with the gateway stopped and with the phone in flight mode.
