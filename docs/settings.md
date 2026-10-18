# Moving `.env` settings into a web Settings page (analysis, 2026-10-18)

## Short answer

Partly: **4 of the 12 settings** the server reads can safely move to a Settings tab in the Manage window, saved by the server in a new file that is never committed: the office name, its latitude and longitude, and the map ID.

The others stay in `.env`, for one of three reasons:
- **Bootstrap:** the server needs it before the web page can exist.
- **Lockout:** a wrong value would lock you out of the page you'd use to fix it.
- **Escalation:** someone who has the Manage password gains more power than they have today.

For each setting I asked one question: *if someone guesses or steals the Manage password, what more can they do?* Today they can edit or delete restaurants (the backups undo that) and run paid Places lookups through add and refresh. A Settings page must not raise that ceiling.

## Setting by setting

| Setting | Web UI? | Why |
|---|---|---|
| `OFFICE_NAME`, `OFFICE_LAT`, `OFFICE_LNG` | **Yes** | Already public: every visitor's page gets them from `/api/config` (`/api/config` in `server.js`). A bad value only moves the fallback point. Latitude and longitude are one field, set or cleared together; the name only applies with a location (otherwise the ZIP 98683 placeholder is used). Offer "pick on the map" plus plain number fields, since the picker needs a working map. Applies at once on the page where it is saved and on every visitor's next page load, with no restart. |
| `GOOGLE_MAPS_MAP_ID` | **Yes** | Public (sent to every browser). A bad ID can change or break the map styling. Three choices: use `.env`'s value, use this ID, or "no map ID" (the app's built-in quiet style), stored as an explicit empty value so it can override an ID set in `.env`. A new map ID needs a page reload. |
| `ADMIN_PASSWORD_HASH` (the Manage password) | **No; keep `kevins-food-map set-password`** | Changing it from the web means either storing the hash in two places, with a fallback, or moving it into a server-owned file. With two places, `set-password` stops working once the web copy overrides `.env`. An old, possibly stolen password also comes back whenever the web copy is missing or unreadable: after a rollback, a downgrade or a restored backup. And a thief with the password could change it and lock you out, which they can't do today. The safe version (one server-owned password file that `set-password` also writes, and that locks Manage if the file is damaged) is doable, but it is real work for something you change rarely. |
| `GOOGLE_MAPS_API_KEY` (one key, your setup) | **No** | Not because it is secret: the page already sends it to every visitor (`/api/config`), so its protection is the website restriction in Google Cloud console. A swapped key can't make visitors run other code (the script always comes from Google, under the page's CSP), and Google doesn't give key owners visitors' locations. The real reasons: you change it about once a year, a bad key breaks the map with no clear fix on the page, and in one-key mode the same key also bills the server's Places lookups. |
| `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_PLACES_SERVER_KEY` (two-key split) | **No** | The server key is a real billing secret. A write-only field (paste it in, never shown back) would be possible, but it buys little over editing `.env` once a year. |
| `HOST` | **No** | `0.0.0.0` exposes the server to the network. A wrong value makes the page unreachable, so it can't be fixed from the page. Needs a restart. |
| `PORT` | **No** | Same lockout problem; needs a restart, and the reverse proxy must change with it. |
| `TRUST_PROXY` | **No, never** | On without a real proxy, anyone can fake their address and the `https` flag in headers: a guesser dodges the lockout with a new fake address each try, can lock out someone else's address, and can affect the cookie's `Secure` flag. It describes the server's network, which the page can't check. |
| `DATA_FILE` | **No, never** | It decides which file the server reads and writes; from the web that is "write a file somewhere". systemd limits writes to `data/`, but a local run has no such limit. |

Note on what's public: the browser key, map ID and office are visible to anyone who opens the site. Showing them in Settings reveals nothing new. Hiding them would not protect them either.

## How it would work

- **File:** `settings.json` next to the restaurant list. It is derived from `DATA_FILE`'s folder, the same way backups are (`lib/store.js:15`), so tests that point `DATA_FILE` at a temp file never touch your live settings.
  - Every test points `DATA_FILE` at its own temp folder, so the test run inside `kevins-food-map update` never reads or writes the live file.
  - The service can already write to `data/` (systemd `ReadWritePaths`), but **not** `.env`. Keep it that way.
- **Not in git:** add `data/settings.json` to `.gitignore`. This is required, not optional:
  - Your repo is public, and `data/restaurants.json` is tracked on purpose.
  - An untracked file in `data/` is easy to commit by accident with `git add -A`.
  - `update` only sets aside the restaurant list, so a tracked settings file would also conflict on pull.
  - `move` carries the file with the folder.
- **Order of precedence**, defined explicitly: real environment variables beat `.env` today, and the new file would sit above both: Settings page > environment > `.env`. Under systemd there are no `Environment=` lines, so in practice it is Settings over `.env`; putting the page above real environment variables only matters for local runs, and the tab labels a default that comes from one. `.env` becomes the default, and the "Server default" choice removes the override. The tab shows both values, so "I changed `.env` and nothing happened" can't surprise you. (The server must record which variables were set before it loaded `.env` to tell them apart.)
- **Saving:** the same temp-file, flush and rename as the restaurant list, with an explicit `mode 0o600`. The restaurant list relies on systemd's umask, which a local run doesn't have.
- **Damaged file:** a file that won't parse, can't be read (e.g. created by a local run as you, then read by the service user), or holds values that fail the save checks below is treated as damaged. The server logs it, shows it in the Settings tab and on `/healthz` as a field with status still 200 (a 503 would tell monitors the site is down while it serves fine), and keeps running on the `.env` values. It must not crash: a crash at startup loops until systemd gives up and the site stays down. The next save keeps the bad file as `settings.json.bad-<date and time>` for inspection. (Falling back is safe only because nothing in this file is security-critical.)
- **Checks on the server:**
  - latitude −90..90 and longitude −180..180;
  - office name at most 80 characters, control characters removed, escaped wherever it is shown (including the new form);
  - map ID limited to letters, digits, `-` and `_`, at most 64 characters.
- **Protections:**
  - the route sits under `/api/` (the login cookie is limited to `Path=/api`) and requires a login;
  - forged requests are blocked by the existing JSON-only rule, which forces a browser preflight (in `handleApi`, `server.js`), plus the `SameSite=Strict` cookie;
  - add a `Sec-Fetch-Site: same-origin` check (allowed if absent) as a second layer, on every change route; not a comparison with `Host`, which a reverse proxy may rewrite;
  - each change writes one access-log line, e.g. "settings changed: office".
- **Backups:** daily backups cover only the restaurant list. Backing up `settings.json` too would be small new code and safe (no secrets); it is not built yet (later work).
- **Two copies running:** `npm start` on another port next to the service, in the same folder, would overwrite each other's settings (on the same port the second one fails to start). That is the same rule as today's list. Editing `settings.json` by hand while the server runs gets overwritten too.

## What it costs

- **Office (with "pick on map") and map ID:** small. One form, one API route, one file, tests. `OFFICE` and `MAP_ID` become changeable at runtime instead of fixed at startup, and the placeholder flag is recomputed on each save. `/api/config` is already sent with `no-store`, so visitors get new values on their next load.
- **Web password change, done safely** (if you want it later): medium. The hash moves to a server-owned file that `set-password` also writes, `.env` is migrated once, and a damaged file locks Manage. Changing the password needs the current one, counted by the login lockout and sharing its limit on concurrent checks; the 10-character minimum is enforced on the server; the current session gets a new token and every other session ends. Over plain HTTP the passwords travel unencrypted, so it would only be offered over HTTPS.
- **Keys in the UI:** medium, for little benefit.

## Recommendation

Build the Settings tab with the office (including "pick on map") and the map ID. Keep the password on `kevins-food-map set-password`, and keep the keys, `HOST`, `PORT`, `TRUST_PROXY` and `DATA_FILE` in `.env`.

The tab can list those `.env` settings with a short note: "edit `.env`, then run `kevins-food-map restart` (or restart `npm start` on a local run)". It shows whether each one is set, without its value. For the browser key that is about tidiness, not secrecy.

## Review

- **Round 1** (independent reviewer, checked against the code): 2 Critical, 6 Major and 9 Minor/Nit. All fixed in this version:
  - **Critical:**
    - The key risk was overstated: a swapped key can't spy on visitors.
    - The web password change had a two-hash fallback that broke `set-password` and could bring back an old password.
  - **Major:**
    - The doc claimed a same-origin check that doesn't exist.
    - A damaged-file crash loop.
    - Tests touching live settings.
    - A secret in backups.
    - File mode.
    - Missing password-change mechanics.
- **Round 2** (fresh reviewer): **0 Critical, 0 Major**; confirmed every round-1 fix against the code. 8 Minor and 6 Nit, all fixed above: the setting count, a three-state map ID, office name without a location, load-time checks and unreadable files, a 200 `/healthz`, precedence notes, reload behaviour, a picker fallback, the proxy-safe origin check, and wording.

## Built (2026-10-18)

The recommendation above is implemented: `lib/settings.js`, `/api/settings` (GET/PUT, login required), Manage → Settings. Not built: settings backups.
