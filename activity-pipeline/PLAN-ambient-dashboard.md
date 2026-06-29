# PLAN — Ambient "Today" view (wallpaper + PWA)

Make the dashboard always-visible: a token-authed read-only `/ambient` page (big
auto-refreshing today numbers) rendered as a **Lively Wallpaper** on the Windows laptop
and installed as a **PWA** on Android. Reuses the existing dashboard + Supabase.

**Decisions (locked with user 2026-06-29):**
- Laptop = **Lively Wallpaper** (free, GPL-3, Chromium URL renderer — confirmed best free pick).
- Phone = **plain "Add to Home Screen" shortcut** to the token URL (no manifest — a manifest
  would publicly leak the token; see Codex review §11). Opens in a browser tab; token lives only
  in the phone's private launcher. Lowest-effort, matches the token-in-URL model.
- Auth = **secret token in the URL** (`/ambient?k=…`). Works in every renderer, no login. Token
  never lands in any public file (no manifest) — only in private device config.
- Person = URL param, default `dhruv`. Auto-refresh every 60s. Metrics = today's active time,
  top apps, tokens burned today. "Doesn't need perfect, just easily accessible."

---

## 1. Why / what changes for the user

Right now you open the dashboard on purpose. After this, your **desktop wallpaper** shows
today's active time, top apps, and token burn — updating itself — and your **phone home
screen** has a one-tap full-screen icon for the same. Glanceable, zero friction.

---

## 2. Auth model (token in URL)

```
  Lively / PWA / any browser
        |  GET /ambient?k=<AMBIENT_TOKEN>&person=dhruv
        v
  middleware.js  ── k === process.env.AMBIENT_TOKEN ?  ──no──>  redirect /login (gated)
        | yes
        v
  app/ambient/page.js (server component, re-checks k -> notFound() on mismatch)
        |  rpc('dashboard_summary', person, today, today)   [reuse]
        |  rpc('token_summary',     person, today, today,'day') [reuse]
        v
  big dark auto-refreshing numbers  (meta/JS refresh 60s)
```

- New env var **`AMBIENT_TOKEN`** = long random secret (Vercel env + `.env.local.example`).
- Middleware allows `/ambient` ONLY when `?k=` matches; everything else stays cookie-gated.
- The page re-validates `k` (defense in depth) and returns `notFound()` (404, doesn't reveal
  the page exists) on mismatch — never renders data without a valid token.
- **Exposure:** a valid link shows only **today's aggregate numbers** (active mins, top app
  names + mins, token totals) for one person. No raw events, no history, no write access.
  Revoke by rotating `AMBIENT_TOKEN` (old links instantly 404).
- Token compare in middleware uses plain `===` (matches the existing cookie check; a 32-char
  random token makes timing attacks impractical). Edge runtime has no `timingSafeEqual`.

---

## 3. Files (≈4)

| File | Change |
|---|---|
| `dashboard/middleware.js` | Allow `/ambient` only when token is valid (see guard below); add security headers (`Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`) to the `/ambient` response. |
| `dashboard/app/ambient/page.js` | NEW server component: `await props.searchParams`, re-validate token, fetch today (both RPCs), render. No third-party scripts on this route. |
| `dashboard/app/ambient/auto-refresh.js` | NEW tiny client component: `location.reload()` every 60s. |
| `dashboard/.env.local.example` | Add `AMBIENT_TOKEN=` placeholder (≥32 random chars). |

No `manifest.json` / icons (would leak the token). Plain A2HS shortcut covers the phone.

**Token guard (used in BOTH middleware and page — Codex #2):**
```js
const token = process.env.AMBIENT_TOKEN?.trim();
const ok = !!token && token.length >= 32 && k === token;  // empty/short env => deny (fail closed)
```

Reuses `lib/db.js` (`rpc`), the `ui.js` formatters (`fmtDuration`, `fmtTokens`, `fmtUSD`, `C`),
both existing RPCs, and the existing IST-today logic.

---

## 4. The ambient page (layout sketch)

```
┌───────────────────────────────────────────┐
│  DHRUV · today        Mon 29 Jun · 21:14   │   (person + IST date/time, muted)
│                                             │
│   💻  4h 12m        📱 2h 03m               │   (huge active-time number; phone)
│   active                                    │
│                                             │
│   🔢  340.2M tokens     ≈ $290 notional     │   (today's token burn)
│                                             │
│   Top: Cursor 2h10 · Chrome 1h05 · Slack 22m│   (top 3 laptop apps today)
└───────────────────────────────────────────┘
        dark, big type, auto-refresh 60s
```

- Server component computes IST `today` (`new Date(Date.now()+5.5h).toISOString().slice(0,10)`),
  calls both RPCs with `from=to=today`.
- `laptop_active_min` is the headline (true hands-on time), `phone_min`, `token_summary.total_tokens`
  + `total_cost` (labeled notional), top 3 from `laptop_apps`.
- Renders with the shared `C` palette + formatters (DRY). `<AutoRefresh seconds={60}/>` at the bottom.

---

## 5. Phone (plain Add-to-Home-Screen, no manifest)

- Android Chrome → open `/ambient?k=…&person=dhruv` → ⋮ → **Add to Home screen**. Chrome
  captures the full URL (including the token) into a private home-screen shortcut. One tap opens
  it. No manifest, so the token is never in a publicly-fetchable file.
- Trade-off (accepted): opens in a normal browser tab (with URL bar), not chrome-less standalone.
  Fine for a glance view; "doesn't need perfect." A standalone PWA would require a cookie
  bootstrap to avoid the manifest leak — deferred (NOT in scope).
- realme/ColorOS: the page is live and light; no background service, so no battery-killer issue.

---

## 6. Test coverage diagram

```
AUTH (middleware + page)
  ├── [TEST] /ambient?k=<correct>           -> 200, renders
  ├── [TEST] /ambient?k=<wrong>             -> 404 (notFound), no data leak
  ├── [TEST] /ambient (no k)                -> 404 / redirect, no data
  ├── [TEST] /ambient?k=<correct>&person=cofounder -> Ria's today
  └── [→E2E] real deploy: correct link renders, rotated token 404s

PAGE DATA
  ├── [TEST] today has data        -> numbers render
  ├── [TEST] today empty (0 rows)  -> shows 0 / "—", no NaN/crash
  ├── [TEST] RPC throws            -> graceful "unavailable", not a stack trace
  └── [TEST] top-apps < 3          -> renders what exists

REFRESH / HEADERS
  ├── [TEST] AutoRefresh reloads after interval (jsdom timer)
  └── [TEST] /ambient response carries Referrer-Policy/no-store/noindex headers
```

Framework note: the dashboard has **no test runner yet**. Given "doesn't need perfect," tests
are specified here as the contract; if we add Vitest later these are the cases. Minimum
verification before ship = the `[→E2E]` deploy checks (correct link 200 + numbers match the
Tokens/Activity views; wrong/rotated token 404; A2HS works on the phone).

---

## 7. Failure modes

| Codepath | Failure | Handling | Visible? |
|---|---|---|---|
| middleware token check | `AMBIENT_TOKEN` unset in env | treat as no-match → gate (never open) | redirect to login |
| page k re-check | wrong/missing k | `notFound()` 404 | generic 404 |
| RPC call | Supabase down / throws | try/catch → "data unavailable" panel | clean message, no trace |
| empty today | no events yet today | coalesced 0s in RPC already | shows 0 |
| stale wallpaper | Lively paused on battery/fullscreen | expected; resumes on desktop | acceptable |

No silent data-loss path. The one security-sensitive path (token check) fails **closed**
(unset/empty token → gated, not open).

---

## 8. NOT in scope (deferred)

- **KLWP/KWGT phone widgets + a `/api/ambient.json` endpoint** — the PWA covers "easily
  accessible" per the decision; the JSON endpoint + Kustom widget is the richer ambient option,
  deferred. (The token page already works as a WebView wallpaper if wanted later.)
- **Rainmeter / Wallpaper Engine / second-monitor kiosk** — Lively is the chosen renderer.
- **Per-user separate tokens / rate-limiting** — single shared `AMBIENT_TOKEN`, rotate to revoke.
  Add per-person tokens only if the single link proves too leaky.
- **Charts/history on the ambient page** — it's a glance view; drill-down stays in the main app.
- **Offline caching (service worker)** — not needed; it's a live page.

## 9. What already exists (reused, not rebuilt)

- `middleware.js` cookie gate → extended, not replaced.
- `dashboard_summary` + `token_summary` RPCs → reused as-is for the today range.
- `lib/db.js` `rpc()` service-key helper → reused.
- `ui.js` `C` palette + `fmtDuration`/`fmtTokens`/`fmtUSD` → reused (DRY).
- IST-today date logic → reused.

## 10. Rollout

1. Add `AMBIENT_TOKEN` (long random) to Vercel env + `.env.local.example`.
2. Build the page + middleware allow + manifest; `npm run build`; deploy.
3. Verify: correct link 200 + numbers match Activity/Tokens views; wrong/rotated token 404;
   `/manifest.json` 200.
4. Laptop: install Lively → set wallpaper to the `/ambient?k=…&person=dhruv` URL.
5. Phone: open the link in Chrome → Add to Home screen.
6. Send Ria her `?person=cofounder&k=…` link (same token) for her wallpaper/PWA.

---

## 11. Codex review (independent outside voice) — all 6 findings incorporated

| # | Finding (conf) | Resolution |
|---|---|---|
| 1 | Token in `manifest.json` `start_url` = public secret leak (10) | **No manifest.** Plain A2HS shortcut; token only in private device config. |
| 2 | Empty/whitespace `AMBIENT_TOKEN` fails OPEN (`''===''`) (10) | Guard: `token = env?.trim(); deny unless token && token.length>=32 && k===token`. |
| 3 | Matcher won't pass `/manifest.json` + icons (9) | Moot — no manifest/icons shipped. |
| 4 | Next 15 `searchParams` is async (10) | `const { k, person } = await props.searchParams`. |
| 5 | URL-token leaks (Referer, logs, launcher); 60s refresh multiplies (8) | `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`; zero third-party scripts on `/ambient`. |
| 6 | CVE-2025-29927 is wrong focus; don't treat middleware as the auth boundary (8) | Keep page-level re-check (defense in depth); any future `/api/ambient*` re-checks the token too. |

No cross-model tension — Codex's findings are all accepted; the only user decision (manifest vs
plain shortcut, §1) resolved to **plain shortcut**. Plan is implementation-ready.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found→fixed | 6 findings, 6 incorporated |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 0 blocking; ~4 files, reuse |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** 6 findings (2 fail-open/leak P1s), all folded in — no manifest, token guard, async searchParams, leak headers.
**VERDICT:** ENG + CODEX CLEARED — ready to implement.
