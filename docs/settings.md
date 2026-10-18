# Design: which settings can be changed in the web page

Manage → Settings lets the admin change the office and the map style. Every other setting stays in `.env`. This document explains why, and how the Settings tab works.

## Principle

Each setting is judged by one question: *if someone guesses or steals the Manage password, what more can they do?* Without the Settings tab they can edit or archive restaurants (the daily backups undo that) and run paid Places lookups through add and refresh. The Settings tab must not raise that ceiling.

A setting stays in `.env` for one of three reasons:
- **Bootstrap:** the server needs it before the web page can exist.
- **Lockout:** a wrong value would lock you out of the page you'd use to fix it.
- **Escalation:** it would give someone with the Manage password more power than they already have.

## Setting by setting

| Setting | In the web page? | Why |
|---|---|---|
| `OFFICE_NAME`, `OFFICE_LAT`, `OFFICE_LNG` | **Yes** | Already public: every visitor's page receives them from `/api/config`. A bad value only moves the point distances are measured from. The location is one field (latitude and longitude set together), and the name only applies with a location. The tab offers "pick on the map" as well as plain number fields, because the picker needs a working map. |
| `GOOGLE_MAPS_MAP_ID` | **Yes** | Public (sent to every browser). A bad ID can change or break the map styling, and clearing it is easy. Three choices: the `.env` value, a given ID, or "no map ID" (the built-in style), stored as an explicit empty value so it can override an ID set in `.env`. |
| `ADMIN_PASSWORD_HASH` | **No:** `kevins-food-map set-password` | A web password change needs either the hash in two places with a fallback, or a server-owned password file. With two places, `set-password` stops working once the web copy overrides `.env`, and an old, possibly stolen password comes back whenever the web copy is missing (after a rollback, a downgrade or a restored backup). It would also let a thief lock the owner out. |
| `GOOGLE_MAPS_API_KEY` | **No** | Not because it is secret: the page sends it to every visitor, so its protection is the website restriction in Google Cloud console. A swapped key can't make visitors run other code (the script always comes from Google, under the page's CSP), and Google doesn't give key owners visitors' data. The reasons: it changes rarely, a bad key breaks the map with no clear fix on the page, and in one-key mode it also pays for the server's Places lookups. |
| `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_PLACES_SERVER_KEY` | **No** | The server key is a real billing secret. A write-only field would be possible, but buys little over editing `.env`. |
| `HOST` | **No** | `0.0.0.0` exposes the server to the network, and a wrong value makes the page unreachable. Needs a restart. |
| `PORT` | **No** | Same lockout problem; needs a restart, and the reverse proxy must change with it. |
| `TRUST_PROXY` | **No, never** | Turned on without a real proxy, anyone can fake their address and the `https` flag in headers: a guesser dodges the lockout with a new fake address on each try, can lock out someone else's address, and can affect the cookie's `Secure` flag. It describes the server's network, which the page can't check. |
| `DATA_FILE` | **No, never** | It decides which file the server reads and writes; from the web that would be "write a file somewhere". |

The browser key, the map ID and the office are visible to anyone who opens the site, so showing them in Settings reveals nothing new.

## How it works

- **Storage.** `settings.json` in the same folder as the restaurant list (derived from `DATA_FILE`, like the backups), written by `lib/settings.js`. Tests point `DATA_FILE` at their own temporary folders, so the test run inside `kevins-food-map update` never touches the live file. The service may write to `data/` but not to `.env` (systemd `ReadWritePaths`), by design.
- **Not in git.** `data/settings.json` is in `.gitignore`. The restaurant list is tracked on purpose and the repository may be public, so this file must not be committed by accident (`git add -A`). `update` only sets aside the restaurant list and leaves this file alone; `move` carries it with the folder.
- **Precedence.** Settings page > environment variables > `.env`. `server.js` records which variables existed before it loaded `.env`, so the tab can say where each default comes from. Under systemd there are no `Environment=` lines, so in practice it is the Settings page over `.env`. The "Server default" choice removes the override.
- **Saving.** Queued, one at a time: a temporary file is written with mode 0600 and flushed, then renamed over the old file. New values apply only once they are on disk. Each change writes one log line, such as `settings changed: office`.
- **Damaged file.** A file that won't parse, can't be read, or holds values that fail the checks below is ignored. The server logs it, shows it in the Settings tab and on `/healthz` (`"settings": "damaged"`, status still 200, because the site works), and runs on the `.env` values. It never crashes on it: a crash at startup would loop until systemd gives up. The next save keeps the bad file as `settings.json.bad-<date and time>`. Falling back is safe only because nothing in this file is security-critical.
- **Checks on the server.**
  - Latitude −90..90 and longitude −180..180, as numbers.
  - Office name: required, at most 80 characters, with control and text-direction characters removed; it is escaped wherever it is shown.
  - Map ID: letters, digits, `-` and `_`, at most 64 characters, or empty.
  - Unknown keys are refused.
- **Protections.**
  - The routes sit under `/api/`, where the login cookie is sent, and require a login.
  - Forged requests are blocked three ways: the JSON-only rule (which forces a browser preflight), the `SameSite=Strict` cookie, and a `Sec-Fetch-Site` check on every change route (allowed when the header is absent, as with curl). It doesn't compare with `Host`, which a reverse proxy may rewrite.
- **Applying changes.** No restart is needed: `/api/config` is sent with `no-store`, so visitors get new values on their next page load. The page where you save updates the office at once. A new map ID needs a reload, because the map is created with it.
- **Two copies.** Two servers sharing one `data/` folder (for example `npm start` on another port next to the service) overwrite each other's settings, just as they would the restaurant list.

## Possible extensions

- **Settings backups.** Copying `settings.json` into the daily backups would be safe (no secrets) and small; it is not done.
- **Web password change, done safely.** The hash would move to a server-owned file that `set-password` also writes, with a one-time migration from `.env`, and a damaged file would lock Manage. Changing it would need the current password (counted by the lockout and sharing its limit on concurrent checks), enforce the 10-character minimum on the server, give the current session a new token and end every other session, and be offered only over HTTPS.
- **Keys in the web page.** Possible as write-only fields, but little benefit for something that changes so rarely.
