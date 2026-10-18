# Kevin's Food Map

A small web app that shows a shared list of restaurants on a Google Map.

- **Left panel:** search by name, a **Filter** button for one or more food types, and cards sorted by distance from the visitor (or from the office when the visitor doesn't share their location).
- **Right panel:** the map, showing whatever the list shows.
- **Manage window** (password protected): add restaurants from Google Maps links (one at a time or a bulk paste), edit food types, refresh details from Google, archive and restore, and change the office and map style.

It is a single Node.js server with no npm dependencies, a plain HTML/CSS/JavaScript front end, and a JSON file for data.

## Contents

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Using the app](#using-the-app)
- [Running on a server](#running-on-a-server)
- [Google setup](#google-setup)
- [Architecture](#architecture)
- [Security](#security)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Quick start

Requires Node.js 22 or newer. Node 24.7+ is recommended, because the admin password is then hashed with Argon2id (older versions use scrypt). There is nothing to `npm install`.

```sh
git clone https://github.com/rovmelek/Kevins-Food-Map.git && cd Kevins-Food-Map
cp .env.example .env && chmod 600 .env   # add your Google key and office location
npm run set-password                     # the admin password for the Manage window
npm start                                # http://127.0.0.1:3000
```

Browsers only share the visitor's location on `localhost` or over HTTPS.

## Configuration

Server settings live in `.env` (never committed; `.env.example` lists them). Environment variables of the same name take precedence over `.env`. Changes need a restart.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_MAPS_API_KEY` | none | One key for the map (browser) and Places lookups (server). See [Google setup](#google-setup). |
| `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_PLACES_SERVER_KEY` | the key above | Optional split into two keys, recommended for a public site. |
| `GOOGLE_MAPS_MAP_ID` | none (built-in style) | A map ID styled in Google Cloud console. |
| `OFFICE_LAT`, `OFFICE_LNG` | center of ZIP 98683 | Where distances are measured from when the visitor's location isn't available. |
| `OFFICE_NAME` | `NASC office` | The office's name; used only when `OFFICE_LAT` and `OFFICE_LNG` are valid. |
| `ADMIN_PASSWORD_HASH` | none (Manage locked) | Written by `npm run set-password`; never type it by hand. |
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `127.0.0.1` | Address to listen on. Use `0.0.0.0` only to allow other machines on your network. |
| `TRUST_PROXY` | off | Set to `1` only behind a reverse proxy, so the login lockout sees visitors' real addresses. |
| `DATA_FILE` | `data/restaurants.json` | Where the restaurant list is stored. |

The office and the map style can also be changed in **Manage → Settings** (see below), which overrides both `.env` and environment variables, without a restart (a new map style shows after a page reload). Everything else stays in `.env` on purpose: a wrong `HOST` or `PORT` would lock you out of the page you'd fix it from, `TRUST_PROXY` without a real proxy would let anyone bypass the login lockout, and `DATA_FILE` decides which file the server writes. The reasoning for each setting is in [docs/settings.md](docs/settings.md).

## Using the app

Anyone can view the list and the map. **Manage** asks for the admin password and has three tabs:

- **Add:** paste one Google Maps link, or a bulk paste of Markdown or plain text with any number of links (up to 100 at once). Each link gets its own result: added, already listed, restored from the archive, skipped (another kind of link in the paste) or refused with the reason. A paste with no Google Maps links at all is refused. Duplicates are never added twice; see [How a link becomes a restaurant](#how-a-link-becomes-a-restaurant).
- **Restaurants:** search, change a restaurant's food type, select several and **Update from Google** (fresh phone, address and rating), **Archive**. Under **Archived**, restore or **Delete forever** (the only real delete, with a confirmation).
- **Settings:** the office (name and location, typed, pasted as "lat, lng" or picked on the map) and the map style (server default, the built-in clean style, or a map ID). Saved in `data/settings.json`. "Server default" goes back to the `.env` value. The tab shows where each server default comes from (`.env` or an environment variable), and lists the `.env`-only settings with whether each is set, never their values. If `data/settings.json` is damaged, the tab says so and the server runs on the `.env` values; saving replaces the file and keeps the old one as `settings.json.bad-<date and time>`.

Archiving hides a restaurant from the list and map but keeps it in the data file. Adding the link of an archived restaurant again restores it.

Ratings are Google's stars and review count as of when the restaurant was added or last updated from Google; they don't update by themselves. Google's attribution is shown under the list whenever ratings are. In Manage → Restaurants, a restaurant without details has a **↻ Details** button (when a Places key is set) that looks it up again.

A food type you set by hand is kept when the restaurant is updated from Google (so are a phone or address changed through the API).

## Running on a server

### Install as a service

On a Linux server with systemd (for example Ubuntu), the `bin/kevins-food-map` script installs the app as a service that starts on boot and restarts after a crash:

```sh
git clone https://github.com/rovmelek/Kevins-Food-Map.git && cd Kevins-Food-Map
cp .env.example .env && chmod 600 .env
bin/kevins-food-map install     # asks for sudo; also adds the `kevins-food-map` command
kevins-food-map set-password
kevins-food-map start
```

| Command | What it does |
| --- | --- |
| `kevins-food-map start` / `stop` / `restart` | Control the service. |
| `kevins-food-map status` | Whether it is running, and recent log lines. |
| `kevins-food-map logs` | Follow the log (Ctrl+C to exit). |
| `kevins-food-map set-password` | Set or change the Manage password, then `restart`. |
| `kevins-food-map test` | Run the automated tests. |
| `kevins-food-map update` | Pull new code, run the tests, and restart if they pass. If they fail, or you press Ctrl+C, it goes back to the previous code. |
| `kevins-food-map move /new/folder` | Move the app folder (code, `.env`, data, backups) and point the service and command there. Same disk only; for another disk it prints the copy steps. |
| `kevins-food-map uninstall` | Remove the service. Your data is kept. |

**Service user.** Install as a normal user with sudo, not as root. A new service runs as the user who installed it, and reinstalling keeps that user. To use a dedicated user instead, create it, put the app somewhere it can reach (on Ubuntu, other users' home folders are private, so use `/srv`), give it the folder and install with `--user`:

```sh
sudo adduser --system --group foodmap
sudo mkdir /srv/kevins-food-map && sudo chown "$USER": /srv/kevins-food-map
git clone https://github.com/rovmelek/Kevins-Food-Map.git /srv/kevins-food-map
cd /srv/kevins-food-map
cp .env.example .env && chmod 600 .env   # or copy your existing .env (and data/) here
sudo chown -R foodmap: .
bin/kevins-food-map install --user foodmap
```

Install with `--user` checks that the user can read `.env`, write `data/` and run Node, so Node must be installed where that user can run it (for example under `/usr/local`, not in your own home through nvm). The folder's path must not contain spaces or special characters. With a dedicated user, run `sudo kevins-food-map set-password` and `sudo kevins-food-map update` (Node must then also be on sudo's PATH); git and the tests then run as the folder's owner, who needs access to the repository if it is private.

**Node version.** The service keeps the Node it was installed with; `update` and `move` don't change it unless it has been removed. To switch, install the new Node somewhere the service user can run it (for example under `/usr/local`), then rerun `bin/kevins-food-map install` from a shell whose `node` is the new one, without `sudo` in front.

### HTTPS and a reverse proxy

The server listens on `127.0.0.1:3000` by default. To reach it from the internet, put a web server with HTTPS in front of it. With [Caddy](https://caddyserver.com/), which gets certificates automatically, the whole config is:

```caddyfile
food.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Behind a proxy, keep `HOST=127.0.0.1` (so nobody can reach the app around the proxy) and set `TRUST_PROXY=1`. The server then takes the visitor's address from the last `X-Forwarded-For` entry, the one your proxy adds, so a visitor can't fake it. Before going public, read the key notes in [Google setup](#google-setup).

### Data, updates and backups

- **The live list.** `data/restaurants.json` is tracked in git so the list can travel with the code, but the copy on the server is the live one. `kevins-food-map update` sets it aside, pulls, and puts it back, so an update never replaces it; if GitHub has a different version, the update says so and keeps the server's. To move the list to another server, copy the file.
- **Settings.** `data/settings.json` is never committed (`.gitignore`). `update` leaves it alone and `move` takes it along. If you point `DATA_FILE` at another folder inside the repo, ignore `settings.json` there too.
- **Backups.** Before the first change of each day the server copies the list to `data/backups/restaurants-YYYY-MM-DD.json` and keeps the last 14. To undo a mistake: stop the service, copy a backup over `data/restaurants.json`, start it again. Settings are not backed up.
- **Updating over SSH.** Run the update inside `tmux` or `screen`. A dropped connection would roll it back, but the service may stay stopped if `sudo` asks for a password.

### Monitoring

- `GET /healthz` returns `200 {"ok":true,"restaurants":N}`, or `503` if the last save to disk failed. When `data/settings.json` is damaged it adds `"settings":"damaged"` and still returns 200, because the site keeps working on the `.env` values.
- `kevins-food-map logs` shows one line per API request (with the visitor's IP address), every settings change, and the details of any error.

## Google setup

In Google Cloud console, enable billing and these two APIs, then create a key:

| API | Used for | Called from |
| --- | --- | --- |
| Maps JavaScript API | the map and its pins | the browser |
| Places API (New) | name, phone, address, website, food type and rating for each added link | the server |

**One key or two.** One key in `GOOGLE_MAPS_API_KEY` works; under **API restrictions** allow only those two APIs. The browser needs the key to draw the map, so anyone who opens the page can see it. Before making the site public, either set daily quotas on the key, or split it into two keys:

- `GOOGLE_MAPS_BROWSER_KEY`: a **Websites** restriction, Maps JavaScript API only.
- `GOOGLE_PLACES_SERVER_KEY`: an **IP address** restriction, Places API (New) only.

A single key can't carry both restrictions, because Google allows one application restriction per key. With a single key and `TRUST_PROXY=1`, the server warns about this at startup.

**Cost.** Asking Places for the phone number makes each lookup a "Text Search Enterprise" request, which Google bills per 1,000 after a monthly free allowance (see Google's Places pricing page for current numbers). The app looks a place up once when it is added, and again only when you press **Update from Google**, never on page views. The rating comes in the same request at no extra cost. Map loads are billed separately under Maps JavaScript API.

**Map style.** Zoomed out, the built-in style hides Google's own places, transit and road icons so the restaurant pins stand out. From zoom 16 in (`DETAIL_ZOOM` in `public/app.js`) Google's normal map returns so nearby businesses are visible. With a map ID, Google uses the style attached to it in Cloud console instead.

## Architecture

### Components

```text
Browser (public/)                      Server (server.js, lib/)                    Disk (data/)
  index.html, app.js, styles.css  ──►  routes, auth, CSP, static files       ──►  restaurants.json
  Google Maps JavaScript API             lib/resolve.js ──► Google Places API      settings.json
                                         lib/store.js, lib/settings.js              backups/
```

- **`server.js`**: the HTTP server, built on Node's `http` module. It has a small route table, security headers, a per-response CSP nonce, static files, `/healthz` and an access log.
- **`lib/parse.js`**: finds Google Maps links in pasted text and reads the place name, pin and IDs from a Maps URL; decides food types.
- **`lib/resolve.js`**: expands short links (only ever to Google Maps hosts) and looks the place up with Places Text Search near the pin.
- **`lib/store.js`**: the restaurant list. Writes are queued and atomic (temporary file, flush, rename), with daily backups.
- **`lib/settings.js`**: the values changed in Manage → Settings, checked on load and on save.
- **`lib/auth.js`**: password hashing (Argon2id or scrypt), login sessions and the lockout.
- **`public/`**: the whole front end, with no build step and no framework.
- **`bin/kevins-food-map`** and **`deploy/kevins-food-map.service.in`**: the service script and the hardened systemd unit it installs.
- **`scripts/set-password.js`**: writes the password hash to `.env`.

### How a link becomes a restaurant

1. A `maps.app.goo.gl/...` short link is a redirect. The server follows it (browsers can't read cross-site redirects), and only to Google Maps hosts.
2. The long URL holds the place name and its location (the pin `!3d<lat>!4d<lng>`, else the map position). A link with no place name (a bare map position or directions) or no location is refused.
3. With a Places key, the server searches Places for that name near the pin and keeps the result only if it is within 300 m, so a same-named place elsewhere is never picked. It must also have a food-and-drink type (any `*_restaurant`, cafe, bakery, bar and the like; the list is `FOOD_TYPES` in `lib/parse.js`), so a grocery store or a gas station is refused. If Google can't be reached, the link fails and can be retried; it is never added unchecked.
4. Without a Places key, only the link itself is checked, and the restaurant gets the name and pin from it with no phone or address. The result says so; **Update from Google** fills in the rest once a key works.
5. The food type comes from the Places type (`chinese_restaurant` becomes Chinese), otherwise from words in the name (Szechuan, sushi, pho and so on).
6. **Duplicates.** A link already in the list, the same Google place ID, the same Google CID, or the same name (ignoring case) within about 50 m counts as the same restaurant. The same link twice in one paste is processed once. A duplicate is reported as "Already listed", and an archived one is restored instead of added again.

### Data model

`data/restaurants.json` is a JSON array. Each restaurant looks like this:

```json
{
  "id": "uuid",
  "name": "Szechuan Brothers Chinese Restaurant",
  "lat": 45.6176, "lng": -122.5347,
  "cuisine": "Chinese", "cuisineManual": false,
  "types": ["chinese_restaurant", "restaurant"],
  "phone": "(360) 555-0100", "address": "…", "website": "https://…",
  "rating": 4.5, "ratingCount": 320,
  "placeId": "…", "cid": "…", "featureId": "…",
  "mapsUrl": "https://maps.google.com/?cid=…",
  "enriched": true,
  "sourceUrl": "https://maps.app.goo.gl/…",
  "addedAt": "2025-01-01T12:00:00.000Z",
  "archivedAt": "2025-02-01T12:00:00.000Z"
}
```

`archivedAt` is only present on archived restaurants. `enriched` is true once Places details were fetched. `phoneManual` and `addressManual` mark values edited by hand.

`data/settings.json` is an object with at most `office` (`{ name, lat, lng }`) and `mapId` (a string; `""` means the built-in style). A missing key means "use the `.env` value".

### HTTP API

All responses are JSON; errors are `{ "error": "…" }` with a status code (400 bad input, 401 not logged in or wrong password, 403 cross-site, 404/405 unknown route or method, 413 request too large, 415 not JSON, 429 locked out or busy, 500 saving failed, 502 Google unreachable, 503 no password set). Routes marked "login" need the session cookie from `/api/auth/login`. Every non-GET request must have `Content-Type: application/json`.

| Method and path | Login | Purpose |
| --- | --- | --- |
| `GET /api/config` | | Browser key, map ID, office, whether Places is enabled. |
| `GET /api/restaurants` | | Listed (not archived) restaurants. |
| `GET /api/auth/session` | | Whether a password is set and whether you are logged in. |
| `POST /api/auth/login`, `POST /api/auth/logout` | | `{ "password": "…" }` / end the session. |
| `POST /api/restaurants` | login | Add from `{ "text": "…" }` (one or more links) or `{ "url": "…" }`. |
| `GET /api/restaurants/archived` | login | Archived restaurants. |
| `POST /api/restaurants/archive`, `/restore`, `/purge` | login | `{ "ids": [...] }`. Purge only deletes archived ones. |
| `POST /api/restaurants/:id/refresh` | login | Look the place up on Google again. |
| `PATCH /api/restaurants/:id` | login | Change `cuisine`, `phone` or `address`. |
| `DELETE /api/restaurants/:id` | login | Archive one restaurant. |
| `GET /api/settings`, `PUT /api/settings` | login | Read or change the office and map ID; `null` goes back to `.env`. |
| `GET /healthz` | | Health check (see [Monitoring](#monitoring)). |

## Security

- **Login.** Every change requires a login; the server checks it on each request, so hiding the Manage button isn't the only protection. Until a password is set, nobody can make changes.
- **Password storage.** Only a hash is stored: Argon2id (19 MiB memory, 2 passes) with Node's built-in `crypto.argon2` on Node 24.7+, otherwise scrypt (N=2^17). These are OWASP's first and second choices, and no packages are involved. A hash made with Argon2id won't verify on older Node; run `set-password` again after a downgrade. `set-password` needs at least 10 characters and leaves `.env` readable only by its owner.
- **Sessions.** A login lasts 12 hours in an `HttpOnly`, `SameSite=Strict` cookie, marked `Secure` over HTTPS. Sessions are kept in memory, so a restart logs everyone out.
- **Lockout.** Five wrong passwords from one address within 15 minutes lock that address out for 15 minutes (IPv6 counts per /64). Each attempt counts before the password is checked, and at most two checks run at once, so a burst of guesses can't slip past the limit or overload the server. While someone floods the login from many addresses, your own login may answer "Busy, try again in a moment"; wait and retry, or block them at the proxy.
- **Forged requests.** Changes must be JSON, which browsers can't send cross-site without permission, and a request the browser marks as cross-site (`Sec-Fetch-Site`) is refused.
- **Page.** A strict Content Security Policy (Google's recommended one for Maps) with a fresh nonce per page load, so injected scripts can't run; everything shown is escaped first; the page can't be framed by other sites.
- **Service.** The systemd unit runs as the user who installed it or the one given with `--user` (the script warns if that is root), may only write to `data/`, and has no extra privileges, devices or kernel access.
- **HTTPS.** Over plain HTTP the password crosses the network unencrypted, so use HTTPS anywhere but your own machine.
- **Public data.** If the repository is public, so is any restaurant list committed to it.

## Development

```sh
npm test        # or: kevins-food-map test
```

The tests use Node's built-in test runner and need no network. Each test points `DATA_FILE` at its own temporary folder, so running them never touches the live data. GitHub Actions runs them on Node 22 (the scrypt path) and Node 24 (the Argon2id path), and checks the service script's syntax.

Conventions:
- No npm dependencies; use what Node provides.
- The front end has no build step: edit `public/` and reload.
- Anything shown on the page goes through `esc()` (or `textContent`), and links through `safeUrl()`.
- Data writes go through `lib/store.js` or `lib/settings.js`, never straight to the file.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| The map doesn't load | `GOOGLE_MAPS_API_KEY` is set, Maps JavaScript API is enabled, and the key's website restriction includes your address. The browser console shows Google's exact error. |
| Restaurants have no phone or address | No Places key, or Places API (New) isn't enabled on it. Fix the key, then select them and press **Update from Google**. |
| "Use my location" does nothing | Location sharing only works on `localhost` or HTTPS, and the visitor must allow it. |
| Manage says no password is set | Run `kevins-food-map set-password` (or `npm run set-password`), then restart. |
| "Too many wrong passwords" | Wait 15 minutes, or restart the server to clear the lockout. Behind a proxy, make sure `TRUST_PROXY=1` is set, or everyone shares the proxy's address. |
| `/healthz` returns 503 | The last save failed; `kevins-food-map logs` shows why (usually disk space or permissions on `data/`). |
| A leftover `nasc-food` service from an older install | Remove it: `sudo systemctl disable --now nasc-food && sudo rm -f /etc/systemd/system/nasc-food.service /usr/local/bin/nasc-food && sudo systemctl daemon-reload`, then run `bin/kevins-food-map install`. |

## License

GPL-3.0-only. See [LICENSE](LICENSE).
