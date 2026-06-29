# PLAN — Zero-Tap 3-Stat Ambient View on a realme/ColorOS Home Screen

> **STATUS (2026-06-30): shipped, widget approach.** Built `/api/ambient.json` + a compact
> `/ambient?w=1` layout. Phone uses **AnyWidget** (website-as-widget) pointed at `…?w=1` (small
> tile, not full wallpaper). Laptop uses a small corner widget: **Rainmeter** (Windows/Dhruv,
> installed+verified) / **Conky** (Linux/Ria — Rainmeter is Windows-only; see CO-FOUNDER-SETUP
> §6a). Full-screen wallpaper (Phase 1/2 below) was the original idea; the small widget won out.
> See HANDOFF §15.

Goal: the 3 stats (laptop time, phone time, tokens + notional cost) are visible the instant the
phone is unlocked, behind the app icons, with no tap and no app open. Two phases: a zero-build
"web page as live wallpaper" route first, then a KLWP + JSON-endpoint route as the reliable backup.

Reuse target (already deployed): `https://dashboard-five-beta-46.vercel.app/ambient?k=<SECRET>&person=dhruv`
— renders 3 big dark stats, auth = token in URL, JS auto-refresh every 60s (`AutoRefresh seconds={60}`
in `app/ambient/auto-refresh.js`).

Device reality: ColorOS kills background apps aggressively; custom lock-screen / AOD content is
**not** possible on ColorOS — we target the home screen only.

---

## 0. What we build vs. what the user does on-device

| | We build (code/repo) | User does (on phone) |
|---|---|---|
| **Phase 1** | Nothing. Reuse existing `/ambient` page. | Install a URL→live-wallpaper app, paste the `/ambient?k=...&person=dhruv` URL, set as live wallpaper, apply ColorOS battery whitelist. |
| **Phase 2** | New route `app/api/ambient.json/route.js` + one `middleware.js` allow-branch. Deploy. | Install KLWP + Pro Key, import a `.klwp` preset (or build 3 text items + 1 Flow), set as live wallpaper, apply ColorOS battery whitelist. |

Phase 1 needs **zero engineering**. Phase 2 needs ~30 lines of code + a deploy.

---

## PHASE 1 — Web page as live wallpaper (try first, zero build)

### 1.1 App ranking (URL → full-screen live wallpaper, behind icons)
ColorOS still runs standard Android `WallpaperService`, so a WebView-backed live-wallpaper app
renders behind the icon grid and keeps the page's JS (`setTimeout`/`fetch`) running while the home
screen is visible.

- **#1 Lively Wallpapers-With Website** (`com.nuko.livewebwallpaper`, "nukora") — one-click "set any
  webpage as live wallpaper," WebView engine. Free, Android 7+. Actively maintained (releases
  Jun 2026). The page's own 60s JS refresh runs, so no extra setting. Con: WebView wallpapers are
  the first thing ColorOS suspends → battery whitelist mandatory.
- **#2 WebLiveWallpaper / LiveWebWallpaper** — free WebView wallpaper apps, same model; older / less
  clearly maintained. Fallback if #1 misbehaves.
- **#3 DIY WallpaperService+WebView** — canonical pattern, proof the mechanism is standard; not
  zero-build, last resort only.
- **Widget alternative (a tile, not full wallpaper):** WebsiteWidget (`com.websitewidget.app`) or
  Widgery (`com.urysoft.widgery`) — any URL as a home-screen widget with auto-update. Zero-tap if on
  the primary home page, but ColorOS throttles WebView widgets harder than wallpapers — styling
  preference, not the primary path.

### 1.2 Setup on ColorOS (Lively Wallpapers, #1)
1. Install **Lively Wallpapers-With Website**.
2. Open → "set website / custom URL".
3. Paste: `https://dashboard-five-beta-46.vercel.app/ambient?k=<SECRET>&person=dhruv`.
4. If it exposes a refresh interval, set **off/longest** (the page self-refreshes every 60s; don't double up).
5. Apply → Set as wallpaper → **Home screen**.
6. Confirm the 3 dark stats render behind the icons.

### 1.3 ColorOS battery / autostart whitelist (mandatory)
ColorOS is a top "don't-kill-my-app" offender; without these it suspends the WebView and numbers freeze.
1. **Auto-launch:** Settings → Apps → Auto Launch → enable the app.
2. **Allow background activity:** Settings → Apps → App Management → [app] → Battery usage → **Allow background activity** (not "Restrict").
3. **Don't optimize:** Settings → Battery → App battery management → [app] → **Don't optimize**.
4. **High performance:** Settings → Battery → Battery mode → **High performance** (disable Super power saving).
5. **Lock in Recents:** Recents → swipe down / lock the app card.
6. **Disable "Sleep standby optimization."**

### 1.4 Verification checklist
- [ ] Unlock → 3 stats visible behind icons, zero tap.
- [ ] Header shows today's IST date + person.
- [ ] Move a number on the laptop, wait ≥60s, re-unlock → number changed (JS refresh alive).
- [ ] Lock 30 min, unlock → current, not stuck.
- [ ] After 3-4h + "clear all recents," unlock → still rendered + fresh.
- [ ] Overnight → new IST day rolled over.
- [ ] Battery: wallpaper app not a top-3 drainer.

### 1.5 Fallback triggers → go to Phase 2 (if any persist after whitelist)
- Stale numbers >5 min while active (WebView suspended).
- Blank/black wallpaper after screen-off (process killed, not reloaded).
- Reload-flash / "data unavailable" on every unlock.
- Battery drain / phone warm.
- App broken after a ColorOS update.

---

## PHASE 2 — KLWP live wallpaper + a JSON endpoint we build (reliable backup)

KLWP draws native text (not a WebView), so ColorOS leaves it alone far more, and it fetches a tiny
JSON every few minutes instead of a whole page.

### 2.1 Engineering spec — shared helper + route (Codex #3: extract, don't copy-paste)
First extract the ambient data path into a server-only helper so `/ambient` (page) and
`/api/ambient.json` (route) share ONE source of truth (no drift):

```js
// activity-pipeline/dashboard/lib/ambient.js   (server-only)
import 'server-only';
import { rpc } from './db';
import { istToday } from '../app/format';

export function ambientTokenOk(k) {                 // fail closed (Codex confirmed guard is right)
  const t = process.env.AMBIENT_TOKEN?.trim();
  return !!t && t.length >= 32 && k === t;
}
export const AMBIENT_SEC_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};
export async function getAmbientSummary(person = 'dhruv') {
  const today = istToday();
  const [act, tok] = await Promise.all([
    rpc('dashboard_summary', { p_person: person, p_from: today, p_to: today }),
    rpc('token_summary', { p_person: person, p_from: today, p_to: today, p_bucket: 'day' }),
  ]);
  return {
    person, date: today,
    laptop_min: Number(act?.laptop_min) || 0,
    phone_min: Number(act?.phone_min) || 0,
    tokens: Number(tok?.total_tokens) || 0,
    cost: Number(tok?.total_cost) || 0,
  };
}
```
Then the route is tiny, and `app/ambient/page.js` is refactored to call the same helper:

```js
// activity-pipeline/dashboard/app/api/ambient.json/route.js
import { NextResponse } from 'next/server';
import { ambientTokenOk, getAmbientSummary, AMBIENT_SEC_HEADERS } from '../../../lib/ambient';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  if (!ambientTokenOk(req.nextUrl.searchParams.get('k')))
    return new NextResponse('Not found', { status: 404 });   // fail closed, no redirect
  try {
    const body = await getAmbientSummary(req.nextUrl.searchParams.get('person') || 'dhruv');
    return NextResponse.json(body, { headers: AMBIENT_SEC_HEADERS });
  } catch {
    return NextResponse.json({ error: 'data_unavailable' }, { status: 503, headers: AMBIENT_SEC_HEADERS });
  }
}
```
- JSONPath targets for KLWP: `$.laptop_min`, `$.phone_min`, `$.tokens`, `$.cost`, `$.date`.

### 2.2 `middleware.js` change (Codex #2: don't duplicate a non-boundary)
Do NOT add a second token-checking branch in middleware. Instead add `/api/ambient.json` to the
existing `PUBLIC` set so middleware passes it untouched — the route handler is the **sole** auth +
header boundary (consistent with the "middleware is optimistic only" comment already in the file):
```js
const PUBLIC = new Set(['/login', '/api/login', '/api/ambient.json']);
```
Deploy to Vercel. Verify: `curl 'https://dashboard-five-beta-46.vercel.app/api/ambient.json?k=<SECRET>&person=dhruv'`
→ compact JSON; wrong/empty `k` → 404; `curl -I` shows no-store/no-referrer/noindex and no redirect to `/login`.

### 2.3 KLWP on-device setup
`wg([url], filter, params)` with the `json` filter takes a JSONPath. Steps:
1. Install **KLWP Live Wallpaper Maker** + **KLWP Pro Key** (Pro required to import presets).
2. New preset, dark bg, 3 Text items + labels reading globals: `gv(laptop)`, `gv(phone)`, `gv(tokens)`, `gv(cost)`.
3. **Flow** (Editor → Flows → Trigger = periodic ~5 min) with a **Web Get** on
   `https://dashboard-five-beta-46.vercel.app/api/ambient.json?k=<SECRET>&person=dhruv` + Set-Global actions:
   `wg('…/api/ambient.json?k=…', json, $.laptop_min)` (and `$.phone_min`, `$.tokens`, `$.cost`, `$.date`).
   - Simpler inline alt (no Flow): put `$wg('…', json, $.laptop_min)$` directly in each Text formula.
4. Set as wallpaper → **Home screen**.
5. **(Codex #1) Do NOT bake the token into a shared `.klwp`.** If you export/hand off a preset, put
   the token in a KLWP **Global** (or a Komponent input) and enter it **on-device after import** — so
   the exported file carries the URL *without* the secret. Recommended: use a **separate**
   `AMBIENT_JSON_TOKEN` for this endpoint (not the `/ambient` page token) so a leaked preset is
   revoked independently by rotating just that one. (If you keep it single-user and never share the
   preset, reusing `AMBIENT_TOKEN` is acceptable — but the "enter on device" rule still applies.)

### 2.4 ColorOS battery whitelist (KLWP) — same as 1.3
Apply 1.3 to KLWP + the Pro Key app. KLWP's ~5-min Flow timer only fires if ColorOS doesn't deep-sleep it.

### 2.5 Verification checklist
- [ ] `curl` correct token → JSON; wrong → 404; headers no-store/no-referrer/noindex; not redirected to /login.
- [ ] KLWP preview shows the 4 values (Flow ran).
- [ ] Home screen → 3 stats, zero tap.
- [ ] Move a number, wait ~5-6 min, unlock → updated.
- [ ] Screen-off 30+ min + recents clear → recovers within one timer cycle.
- [ ] Next IST day → date + stats roll over.

---

## Test plan (both phases)
1. Endpoint unit (P2): correct token → 200 + `{person,date,laptop_min,phone_min,tokens,cost}`; empty `k` → 404; short/unset `AMBIENT_TOKEN` → 404 (fail-closed); bad `person` → zeros, not error.
2. Header check: `curl -I` confirms no-store + no-referrer + noindex on `/api/ambient.json`, not redirected to `/login`.
3. Render: wallpaper visible behind icons on first unlock (both phases).
4. Freshness soak: 4h, induce activity, confirm updates (P1=60s JS, P2=~5min Flow).
5. Kill-resilience: clear recents, lock 30 min, unlock — recover without manual reopen.
6. Day-rollover: IST `today` flips (centralized in `istToday()`).
7. Battery: 24h, wallpaper app not a top drainer (P2 should beat P1).

---

## Security notes
- Token-in-URL is the whole auth; both `/ambient` and `/api/ambient.json` check `?k=` vs `AMBIENT_TOKEN`
  (`.trim()`, len ≥ 32, fail closed) at middleware AND route (middleware optimistic only; route is the boundary).
- Leak surface: token rides in the wallpaper-app config, KLWP Flow URL, history, Referer. Mitigations in
  place: `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`.
- No PWA manifest for these routes (would persist/leak the tokenized URL).
- Rotation: single shared token = treat like a password; rotate `AMBIENT_TOKEN` in Vercel + re-paste if leaked.
- HTTPS only.

## Codex review (independent) — incorporated
Codex confirmed the mechanics are sound (branch order, 404 from middleware, dotted
`app/api/ambient.json` segment, `req.nextUrl` in a Next 15 route handler, and importing
`istToday()` from the non-client `app/format.js` are all fine). Three design findings, all folded in:

| # | Finding (conf) | Resolution in this plan |
|---|---|---|
| 1 | Token leak under-modeled — `.klwp` export / KLWP formulas / device config carry the secret; `no-store`/`no-referrer` don't help (10) | §2.3 step 5: never bake the token into a shared preset (enter on-device); use a separate `AMBIENT_JSON_TOKEN` for independent rotation. |
| 2 | New middleware branch duplicates a non-boundary (8) | §2.2: add `/api/ambient.json` to `PUBLIC`; route handler is the sole auth/header boundary. |
| 3 | Route is copy-paste of the page data path → drift (8) | §2.1: extract `lib/ambient.js` (`ambientTokenOk` + `getAmbientSummary` + headers); both the page and the route use it. |

No cross-model tension; no real bug found. Plan is implementation-ready for when/if Phase 1 falls back to Phase 2.

## NOT in scope
- Lock-screen / AOD custom content on ColorOS (confirmed impossible; home screen only).
- Per-user / rotating tokens, OAuth, login (single shared `AMBIENT_TOKEN`).
- Charts, history, interactivity (3 stats + date only).
- iOS / other OEM skins.
- New backend aggregation (reuse `dashboard_summary` + `token_summary` unchanged).
