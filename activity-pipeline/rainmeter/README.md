# Rainmeter desktop widget (laptop corner box)

A tiny bottom-right desktop widget over your own wallpaper showing **today's** Laptop time,
Phone time, and Tokens (+ notional $). Sits on the desktop layer (behind windows), refreshes
every 60s. Reads `GET /api/ambient.json?k=<token>&person=<name>` (preformatted fields, so the
skin needs no math or plugins — just Rainmeter's built-in WebParser).

## Setup (Windows)
1. Install Rainmeter: `winget install Rainmeter.Rainmeter` (or https://www.rainmeter.net/).
2. Copy this `Ambient/` folder into `Documents\Rainmeter\Skins\`.
3. Edit `Ambient.ini` → in `[Variables]`, replace `<AMBIENT_TOKEN>` with the real token
   (and set `person=` to `dhruv` or `cofounder`). The token stays local — never commit it.
4. Rainmeter tray icon → **Refresh all** → load **Ambient**.
5. Right-click the skin → **Position → On Desktop**; drag it to the bottom-right corner.
6. Right-click → **Settings → Load on startup** (and Rainmeter itself auto-starts on login).

## Notes
- `$` figures are notional (API-equivalent, not a bill).
- Phone shows ~0 during the day until the phone's nightly upload (phone uploads once a day).
- To revoke access, rotate `AMBIENT_TOKEN` in Vercel and update the token here.
