# Code review — OmniRoute Mobile

Reviewed at `88b9dbf` ("fix(app): a bare gateway address is not https"). Everything
below was read from source, and the two most consequential findings were **reproduced**
rather than inferred (the commands are in each finding).

Scope: the whole repository — the app (`app/`, `components/`, `lib/`), the on-device
bootstrap (`gateway/bootstrap.mjs`), the Kotlin/JNI runtime module
(`modules/node-runtime/`), the build and CI scripts (`scripts/`) and the four
workflows. `node_modules`, assets and the generated payload are out of scope.

## Second pass — after the dashboard went native (2026-10-03)

Reviewed at `d7c827d`, then against what a phone reported afterwards. The app
changed out from under the first pass: the WebView, its registry, its catch-all
feature route and its data-clearing button are all gone, replaced by 94 native
surfaces. Part of the table below is therefore history, and this section says
which part, in each of three groups: superseded, fixed, still open.

### Superseded — the code they describe no longer exists

| # | Was | Now |
|---|---|---|
| 2 | "Clear dashboard cookies & cache" over-promised | No WebView and no such button; `app/settings.tsx` mentions it only in a comment |
| 3 | Non-`http(s)` navigation was handed to the external browser | There is no in-app browser to navigate |
| 4 | The catch-all feature route re-decoded its path | `app/feature/[...path].tsx` deleted |
| 8 | The WebView registry went stale after a URL change | The registry went with the WebView |
| 11 | `tailOf` could split a UTF-8 sequence | No `tailOf` remains in `lib/` or `gateway/` |

### Fixed

| # | Severity | Finding |
|---|---|---|
| — | **High** | A website's 404 page was read as "signed in", and non-JSON bodies were pasted raw into every screen. Fixed in `a72d978`: HTML is classified on every path, an auth-status 404 means *unknown*, the probe never asks `/`, and the default address is loopback |
| 6 | Medium | The extractor followed symlinks out of the install directory. It now refuses (`refusing to extract outside the install dir`), asserted by `payload:test` |
| 12 | Low | The unreachable `match(...)` in `describeBootTrace` — deleted in this pass. It discarded its own result, so it read like a check and was one never run |
| 14 | **High** | The native-addon probe disabled the last module that *every successful* boot had probed. `diedIn` matched any `probing` line in the boot record, and a boot that came up also leaves such a line — so the second start of a healthy install removed a working library. The record is now read as a death only when the probe line is its **last** line. Shipped in b67, fixed before b68, and pinned by a test that runs two boots of a serving payload |
| 15 | **High** | The session screen collapsed three states into two. `authenticated` is `true`/`false`/`null`, and `null` was rendered as "The gateway is answering this app… nothing to do" — a green all-clear about a gateway that was not running, with the password form hidden behind it. A user read this as "the sign-in button has no functionality" and was right to. The screen now asks the gateway directly (`checkGateway`) and has a separate answer for each of: still checking, nothing answering, a website, needs a session, signed in, and answering-while-session-unknown — and the form is offered in every case where a password could be in play |
| 16 | Medium | Settings drew `shield-check-outline` in the success colour for an unestablished session. Same mistake as 15, one level down: success colour is now reserved for an answer that earned it, and "Signed in (or not needed)" became "Signed in" plus an honest "Session state unknown" |
| 17 | Medium | The probe could not see a death after `listen`. Every library loads, the server comes up and answers, and the process dies later — and no log can say so, because the record ends at `the server is answering` whether the kernel killed it or a swipe did. The app now passes the one fact only Android holds (`GATEWAY_PREV_DEATH`, from `ApplicationExitInfo`), and two fatal deaths *after serving* set aside every optional native module so the gateway comes up without them; one death is a strike, not an action |
| 18 | Medium | The `docs` surface claimed to leave the app for a browser while carrying `/docs` — a path inside the web app, not a URL. Rather than invent a documentation site to open, it is now `local` with a note, like `changelog`. `surface-coverage` refuses the combination again |
| 19 | Low | The probe returned before its own diagnosis when a payload had no `.node` files, so the one case where "nothing here can explain the crash" was worth saying was the case it said nothing about |

### Still open

| # | Severity | Finding |
|---|---|---|
| 1 | **High** | An installed gateway never updates itself. Unchanged, and the only finding that outlived both passes with its severity intact |
| 7 | Medium | Home still runs four poll loops (10 s health, 10 s telemetry, 30 s providers, 15 s logs) while an install is unpacking ~44,000 files on the same device |
| 21 | **High** | node's heap was capped by `Runtime.maxMemory()`, the **Java** budget, giving a Next.js server 341 MB on a phone with 1.9 GB free — it hit the cap and aborted (SIGABRT), which read as another crashing library. Fixed: sized from `availMem/3`, clamped 256–1024 MB, with the contract asserting `maxMemory()` is *not* used |
| 22 | **High** | a `.node` that is not ELF was counted "unreadable" and left in the payload — including the arm64 **Mach-O** onnxruntime binding that segfaulted the first boot. Now classified by magic (Mach-O / universal / PE) and moved out before the first start, so the crash never happens rather than being recovered from |
| 23 | Low | a V8 fatal error left no readable trace in the app; `--report-on-fatalerror` now lands a report the next boot prints and clears |

| 20 | Medium | **Collections are read and delete only.** `lib/api/collection.ts` exposes exactly two verbs — `readCollection` and `deleteRow` — so the 32 collection surfaces can be inspected and removed but never created or edited. The dashboard's forms do all four. This is the largest remaining functional gap against the web UI, and it is a gap in the *engine*, not in a screen: 32 surfaces inherit it |
| 9 | Low | `versionName` is stamped `1.0.0-bNN`, which is not a valid Play version name — harmless while the build is sideloaded, blocking the day it is not |
| 10 | Low | The published manifest's `entry` is still ignored; the bootstrap guesses which of the two shapes it got and logs the answer |
| 13 | Low | `checkGateway` shares one 10 s abort across three probes, so a slow host can exhaust the budget before the third is tried |

### Coverage, measured rather than claimed

"Is every dashboard function actually in the app" is now a check, not a paragraph:
`npm run surfaces:coverage` (CI step 11) compiles the real catalog and asserts that
94 surfaces sit in exactly one of 9 sections, that every section's listing matches
its surfaces, that all 81 data surfaces name an `/api/…` path (never a page — the
class of bug that produced HTML on every screen), that all 7 bespoke routes exist as
files on disk, that every kind has a renderer, that every icon is in the font's
glyph map, and that nothing claims to open a URL it does not have. As of this pass:
35 config, 32 collection, 14 stats, 7 bespoke, 5 app-local, 1 external; 35 with a
documented write method.

What that does **not** prove, stated so nobody has to discover it: it checks shape
and reachability, not per-field fidelity. A config surface renders whatever the
gateway's metadata describes, so a payload whose API differs from the pinned
snapshot (`release/v3.8.52`) will show fewer fields — or a differently shaped stats
screen — without failing anything. That drift is finding 1's problem wearing a
second costume: the app and the installed payload are versioned independently.

## Summary — first pass

The table is the review as it stood at `88b9dbf`, kept in full because four of its
findings were reproduced rather than inferred. Read the section above it first: it
says which rows no longer apply, which are fixed, and adds 14–20.
|---|---|---|---|
| 1 | **High** | payload updates | An installed gateway never updates: the update check cannot fire unless a digest is pinned, which it is not |
| 2 | **High** | privacy / claims | "Clear dashboard cookies & cache" does not clear cookies, and the dialog promises it signs you out |
| 3 | Medium | in-app browser | Every non-`http(s)` navigation (`about:blank`, `blob:`, `data:`) is blocked and handed to the external browser, which drops it |
| 4 | Medium | crash risk | The catch-all feature route decodes its path a second time; a `%` in a route throws `URIError` and takes the screen down |
| 5 | Medium | data / UX | The Settings field is seeded before settings load, so it can display the wrong gateway and Save silently switches away |
| 6 | Medium | security | The tar extractor follows symlinks out of the install directory (defense in depth: the archive is digest-checked, but only when the manifest could be fetched) |
| 7 | Medium | performance | Two independent poll loops read up to ~290 KB per tick (≈430 KB/s) while the phone is trying to unpack 44,000 files |
| 8 | Low-medium | state | The WebView registry is not updated when the gateway URL changes, so "clear data" skips the live view |
| 9 | Low | packaging | `versionName` is stamped `1.0.0-b59`, which is not a valid Play version name |
| 10 | Low | correctness | The published manifest's `entry` is ignored; the bootstrap guesses instead |
| 11 | Low | cosmetics | `tailOf` can split a UTF-8 sequence, producing a replacement character at the top of every truncated log |
| 12 | Low | dead code | One unreachable `match(...)` call in `describeBootTrace` |
| 13 | Low | diagnostics | `checkGateway` shares one 10 s abort budget across three probes |

---

## 1. High — an installed gateway never updates itself

**Where:** `gateway/bootstrap.mjs:1082-1083` (the decision), `:1105` (where the
manifest is fetched — inside the install branch only), `:1201` (what the marker
records).

```js
const markerMatches = Boolean(marker) && (!expectedSha || marker.sha256 === expectedSha);
const upToDate = installed && markerMatches && !force;
```

`expectedSha` comes from `GATEWAY_PAYLOAD_SHA256`, which the app deliberately leaves
**empty** (`lib/gatewayInstaller.ts:89`, documented as intentional so a payload update
does not break installed apps). The app sends `GATEWAY_PAYLOAD_SHA256_URL` instead —
and that manifest is only fetched at `:1105`, *after* this decision, and only when the
process has already decided to install. So with the shipped defaults
`markerMatches` is always true and `upToDate` is always true whenever anything is
installed.

Consequence: **the manifest is never consulted, a changed payload is never noticed, and
the app boots the old payload forever.** The only ways to receive a new payload today
are to tap *Remove it from this phone* or to wipe the app's data — which is exactly how
the b57 native-library pruning reached the test device, not through any update path.

Reproduced:

```
$ env GATEWAY_DIR=/tmp/gatetest \
      GATEWAY_PAYLOAD_URL=https://example.invalid/newer.tar.gz \
      GATEWAY_PAYLOAD_SHA256_URL=https://example.invalid/newer.tar.gz.json \
      node gateway/bootstrap.mjs --gateway-run
[gateway] gateway already installed at /tmp/gatetest/app (2026-09-29T00:00:00.000Z)
[gateway] starting server.js on 127.0.0.1:20997          ← the old payload, and the
                                                          ← manifest was never fetched
```

Same command with a pinned, mismatching digest does download — so the machinery works,
it is simply never reached.

**Fix:** resolve the expected digest *before* the decision — if `expectedSha` is empty
and `shaUrl` is set, fetch the manifest first (it is 182 bytes), compare it with
`marker.sha256`, and treat a mismatch as "reinstall". Keep the current lenient
behaviour when the manifest cannot be fetched (that fallback is right). `docs/
LOCAL_GATEWAY.md:1110` currently claims the opposite of what the code does — "the app
notices the changed digest in the manifest and re-installs before booting" — and must
be corrected either way.

**Also:** the app never passes `force` (`grep -rn "force:" lib components` → only the
declaration), and `gatewayState()` compares nothing against the published manifest. A
cheaper alternative to changing the bootstrap: have the app fetch the manifest when the
card is shown (it already polls state every 2 s) and pass `force: true` when the
published digest differs from the installed marker's.

---

## 2. High — the data-clearing button does not clear cookies

**Where:** `lib/webData.ts:21-38`, promised in `app/settings.tsx:91-116` ("Removes all
cookies and cache used by the dashboard (you will need to sign in again)") and repeated
at `:231-234` ("clearing it signs you out of the dashboard").

What it actually clears: `localStorage`, `sessionStorage`, IndexedDB, and the WebView
HTTP cache (`clearCache(true)`). Cookies are untouched, and a session cookie is what
"sign you out" means. `react-native-webview@14.0.1` does not export a cookie API (no
`CookieManager` in `lib/index.js`), so this cannot be fixed in JS alone.

Consequence: a user handing the phone to someone else, or clearing data before selling
it, is told the session is gone while the dashboard remains authenticated.

**Fix:** add a `clearCookies` function to the `NodeRuntime` module
(`android.webkit.CookieManager.getInstance().removeAllCookies(null)` plus
`flush()`), call it from `clearWebViewData()`, and keep the copy only once that is
true. Until then the label and dialog must say "cache and local storage" and not claim
to sign anyone out.

---

## 3. Medium — the in-app browser blocks every non-HTTP navigation

**Where:** `components/OmniWebview.tsx:95-115`.

```js
targetHost = new URL(target).host;        // "" for about:blank, blob:, data:
if (targetHost !== gateHost) { openURL(target); return false; }
```

Any URL whose host is not the gateway's is opened externally and refused in the
WebView. For an `http(s)` foreign host that is the intended behaviour. For everything
else it is wrong: those URLs have an empty host, `openURL()` cannot handle most of
them, and the navigation is silently dropped.

Reproduced (the same expression the component evaluates):

```
allowed            http://127.0.0.1:20128/dashboard   [host="127.0.0.1:20128"]
BLOCKED+openURL    about:blank                        [host=""]
BLOCKED+openURL    blob:http://127.0.0.1:20128/abc-1  [host=""]
BLOCKED+openURL    data:text/html,<h1>x</h1>          [host=""]
BLOCKED+openURL    javascript:void(0)                 [host=""]
```

A Next.js dashboard uses `about:blank` (popup targets, print flows, some iframe
patterns) and `blob:` (client-side downloads, file previews). Those features break in
the app and work in a browser — the hardest kind of bug to attribute.

**Fix:** only intercept `http:`/`https:` targets; return `true` for everything else
(or handle `blob:`/`data:` explicitly). One `if (!/^https?:/i.test(target)) return true;`
before the host comparison.

---

## 4. Medium — the catch-all route can crash on a `%`

**Where:** `app/feature/[...path].tsx:17-20`.

```js
return `/${segments.map((s) => decodeURIComponent(s)).join('/')}`;
```

`expo-router` has already decoded these params: `LocationProvider.js:61-64` maps
`decodeURIComponent` over every path segment before they reach `useLocalSearchParams`.
Decoding again is both wrong and unsafe:

- a route containing a literal `%` (encoded as `%25` in the URL) arrives as `50%off`,
  and `decodeURIComponent("50%off")` **throws** `URIError: URI malformed` during
  render — an unhandled error, so the screen dies;
- anything containing `%2F` is decoded twice, turning a segment into a path separator.

**Fix:** delete the `decodeURIComponent` call (the values are already decoded), or wrap
it in a `try`/`catch` and fall back to the raw segment.

---

## 5. Medium — Settings can show, and save, the wrong gateway

**Where:** `app/settings.tsx:28` — `useState(settings.serverUrl)`.

The initial value is captured once. `useSettings()` starts from
`DEFAULT_SERVER_URL` and fills in the stored value asynchronously, so any render of
Settings before that lands (a cold start deep-link, a slow storage read) seeds the
field with `https://omniroute.online`. Nothing re-syncs it when the real value arrives,
so a user whose gateway is the local one sees the public URL — and tapping **Save**
silently switches the app away from their own gateway.

**Fix:** gate the screen on `loaded` (as `(tabs)/index.tsx` already does), or
`useEffect(() => setUrl(settings.serverUrl), [settings.serverUrl])`.

---

## 6. Medium — the extractor follows symlinks out of the destination

**Where:** `gateway/bootstrap.mjs:769` (the path check), `:792-801` (symlinks).

The guard is a lexical check on the entry's *name*:

```js
const target = path.resolve(destDir, name);
if (target !== destDir && !target.startsWith(destDir + path.sep)) throw ...
```

That correctly refuses `../../etc/passwd`. It does not defend against the classic
two-step: an entry that creates a symlink `link -> /data/data/<pkg>/files` (allowed —
targets are stored verbatim and never validated), followed by an entry `link/evil` whose
*name* resolves inside `destDir` but whose *write* follows the symlink outside it.
Hardlinks are skipped (`else` branch), which is good, but symlinks are created for any
target.

Severity today is limited by provenance: the archive is a release asset, and its digest
is compared with the published manifest — **except** when that manifest cannot be
fetched, in which case the documented fallback installs with no integrity check at all
(`:1105-1135`). So this is defence in depth rather than a live exploit, but it is the
one place where "verify at the edges" is the whole defence.

**Fix:** refuse a symlink whose resolved target escapes `destDir` (and skip absolute
targets), and/or `lstat` each parent directory before writing a file so a write never
passes through a symlink. The manifest already publishes `files`/`bytes`; comparing
those against the extraction result is a cheap extra sanity check that a truncated or
hostile archive is caught.

---

## 7. Medium — two poll loops read ~290 KB per tick during the install

**Where:** `components/LocalGatewayCard.tsx:62-71` (every 2 s) and
`lib/gatewayInstaller.ts:509-549` (every 1 s while waiting), both calling
`gatewayState()` (`:319-393`), which reads the marker (≤64 KB), `gateway.log` (≤64 KB),
`runtime.log` (≤64 KB), `boot.log` (≤32 KB) and the `node.log` tail (≤64 KB).

That is up to ~290 KB per call, ~1.5 calls/s while the card is on screen with an
install running, plus the install's own extraction of 44,000 files on the same storage
— while `waitForLocalGateway` is what the user is staring at. It works, but it is
self-inflicted slowness on the slowest device in the system, and `node.log` grows
without bound (WebView chatter is written to it continuously).

**Fix:** read `boot.log`/`runtime.log`/`node.log` only when they can have changed
(i.e. not every tick), poll at 5 s while the phase is `installing`, and stop the card's
interval when the phase is `idle` (nothing is happening, and the interval is not what
will notice a change — the button is).

## 8. Low-medium — the WebView registry goes stale after a URL change

**Where:** `components/OmniWebview.tsx:54-57` — the effect that registers the ref
depends on `reloadToken` only; the WebView's `key` includes `settings.serverUrl`.

Changing the gateway remounts the native WebView but does not re-run the effect, so the
registry keeps the dead instance and never learns about the new one: "Clear dashboard
cookies & cache" then operates on an unmounted view (or on nothing). `lib/webData.ts:14`
also silently ignores a `null` ref, hiding it.

**Fix:** add `settings.serverUrl` to the dependency list, or register through a
callback ref (`ref={node => ...}` + cleanup) so registration follows the mounted
instance by construction.

---

## 9. Low — `versionName` is not a version a store would accept

`scripts/stamp-version.mjs` + `android-apk.yml:61-69` stamp the version as
`1.0.0-b59`, which is fine for sideloaded builds (and deliberately legible in a
screenshot) but is not valid for Google Play, which requires a dotted numeric version
name. Worth a note in the release doc so nobody discovers it at upload time.

## 10. Low — the manifest's `entry` is published but ignored

`scripts/pack-payload.mjs:241-250` writes `entry` into the manifest; the app never
passes `GATEWAY_ENTRY`, so the bootstrap `pickEntry(['dist/server.js', 'server.js'])`
guesses. It works today because the guess covers both shapes, but the one field that
would make the contract explicit is unused. Either honour it (pass it through) or stop
publishing it.

## 11. Low — `tailOf` can split a UTF-8 sequence

`NodeRuntimeModule.kt:141-147` slices the last N *bytes* and decodes them, so a tail
that starts mid-character begins with a replacement character. Cosmetic; a
`String(bytes, UTF_8)` after backing off to a lead byte would fix it.

## 12. Low — dead statement

`lib/gatewayLog.ts:263` — `match(/^runtime ready on node /);` — the result is unused.
Harmless, but it reads as if it were doing something.

## 13. Low — one abort budget for three probes

`lib/gateway.ts:36-69` creates a single `AbortController` with one timeout and reuses
it for `/healthz`, `/livez` and `/`. A gateway that stalls on `/healthz` for the whole
budget makes the other two probes fail instantly with `AbortError`, which the UI
reports as a timeout — the right verdict, arrived at for the wrong reason.

---

## Flow walkthrough

**First run (install → boot → connect).** Sound, and the hard-won parts are genuinely
careful: the script is written before starting; the log is truncated so a previous
failure cannot be read as this one's; the payload is staged as `app.new` and swapped, so
a killed extraction never leaves something that looks installed; the marker is written
last; the boot record is written ahead of each step with an fsync, which is the only
reason a native kill is diagnosable at all. Two gaps matter: the update path is dead
(finding 1), and the install re-reads its own logs several times a second (finding 7).

**Connect.** The gate probes `/healthz`, falls back to `/livez` and `/`, and only then
saves — with the right scheme now. But `Connect` does not require a passing test: a
user can save a URL that failed and land in a WebView showing an error overlay. That is
a defensible choice (the gateway may come up later), but the button could warn once.

**Serving.** The dashboard renders in the WebView; foreign hosts open externally
(finding 3 for non-HTTP); the pill re-probes on focus; cookies are shared across tabs
via `sharedCookiesEnabled`, which is what makes "sign in once" work.

**Background.** `GatewayService` holds the process with `specialUse` foreground type,
resumes from `StartPrefs` after a process recreation, and clears the saved request when
node exits so a dead gateway is not resurrected. The stop path (`Process.killProcess`)
is honest about the runtime's one-shot nature. This design is sound; the only unproven
part remains unproven on hardware (keep-alive across a long background period).

**Recovery.** Remove → reinstall is the only way to change payloads today (finding 1);
"the runtime can only start once per process" is enforced in the host and explained in
the UI, which is the right shape for the constraint.

## What is solid

- **The failure-diagnosis design** (`boot.log` written ahead of each step, `runtime.log`
  separated from the process-wide capture, `ApplicationExitInfo` for kills that leave
  nothing) is better than most production code, and it was built from real device
  evidence rather than guessed.
- **Path handling in the Kotlin module** — `appFile()` canonicalises and then refuses
  anything outside `filesDir`/`cacheDir`; the JNI surface is deliberately `private` to
  keep symbol names stable.
- **The contract tests** are real tests: they compile and call the code, bound the
  device-side scan, and assert that the log parser and the bootstrap agree on wording.
  The gaps that remain are the ones with no test at all — the update path (finding 1)
  and the cookie claim (finding 2).

## Suggested fix order

1. **Finding 1** — without it, every future payload fix needs a manual reinstall.
2. **Finding 2** — it is a promise the app does not keep (privacy).
3. Findings 3 and 4 — both are reachable in normal dashboard use.
4. Findings 5–8 — cheap, and each removes a wrong-looking state.
5. The rest when convenient.
