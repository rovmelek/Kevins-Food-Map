# Kevin's Food Map

Restaurants on a Google Map. Left panel: search by name, a **Filter** button to pick one or more food types, and cards sorted by distance. Right panel: the map, showing whatever the filter shows. Adding, editing and archiving happen in the password-protected **Manage** window.

> Renamed from NASC Food on 2026-10-18. The server command and service are now `kevins-food-map`. If you installed the old `nasc-food` service, remove it first: `sudo systemctl disable --now nasc-food && sudo rm -f /etc/systemd/system/nasc-food.service /usr/local/bin/nasc-food && sudo systemctl daemon-reload`, then pull and run `bin/kevins-food-map install`.

## Run it

Needs Node 22 or newer; Node 24.7+ is recommended, because it stores the admin password with Argon2id (older Node falls back to scrypt). No packages to install.

```sh
cp .env.example .env && chmod 600 .env   # then fill in the key and office location
npm run set-password      # admin password for the Manage window
npm start                 # http://127.0.0.1:3000
npm test
```

Other settings in `.env`: `PORT` (default 3000), `HOST` (default `127.0.0.1`, local only), `DATA_FILE` (default `data/restaurants.json`).

Location permission only works on `localhost` or HTTPS. If it is denied, the list is sorted from the office location in `.env` (`OFFICE_LAT`, `OFFICE_LNG`), or from the center of ZIP 98683 if those are not set.

## Run on a server (VPS)

On a Linux server with systemd (e.g. Ubuntu), install it as a service so it starts on boot and restarts itself after a crash:

```sh
git clone https://github.com/rovmelek/Kevins-Food-Map.git && cd Kevins-Food-Map
cp .env.example .env && chmod 600 .env   # add your key and office location
bin/kevins-food-map install     # asks for sudo; adds the `kevins-food-map` command
                                # (runs as you; to use another user: install --user NAME)
kevins-food-map set-password
kevins-food-map start
```

| Command | What it does |
| --- | --- |
| `kevins-food-map start` / `stop` / `restart` | control the service |
| `kevins-food-map status` | is it running, and recent log lines |
| `kevins-food-map logs` | follow the log (Ctrl+C to exit) |
| `kevins-food-map set-password` | set or change the Manage password (then `restart`) |
| `kevins-food-map test` | run the automated tests |
| `kevins-food-map update` | pull new code, run the tests, restart if they pass; if they fail or you press Ctrl+C, go back to the previous code |
| `kevins-food-map move /new/folder` | move the app folder (code, `.env`, restaurant list, backups) and point the service and command there; same disk only (it prints copy steps otherwise), and the service user must be able to reach the new place |
| `kevins-food-map uninstall` | remove the service (keeps your data) |

The server only listens on `127.0.0.1:3000`. To reach it from the internet, put a web server with HTTPS in front of it; location sharing in browsers only works over HTTPS. With [Caddy](https://caddyserver.com/), which gets certificates automatically, the whole config is:

```
food.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Behind a proxy like this (keep the default `HOST=127.0.0.1` so nobody can reach the app around the proxy), add `TRUST_PROXY=1` to `.env` so the login lockout sees visitors' real addresses. (The server uses the last `X-Forwarded-For` address, the one your proxy adds, so a visitor can't fake it.) Before going public, set daily quotas on the key, and read the key notes under "Google setup".

Install as a normal user with sudo, not as root, so the service doesn't run as root. Install from a path without spaces.

**Updates and the restaurant list.** The list on the server is the live one. `kevins-food-map update` sets it aside, pulls the new code, and puts it back, so an update never fails on it or replaces it. Changes to `data/restaurants.json` made in GitHub are not applied on the server; the update says so when that happens. To move the list to a new server, copy that file. Over SSH, run the update inside `tmux` or `screen`, so a dropped connection can't interrupt it halfway (it would roll back, but the service may stay stopped if `sudo` needs a password).

**Backups.** Before the first change of each day, the server copies the list to `data/backups/restaurants-YYYY-MM-DD.json` and keeps the last 14. To undo a mistake, stop the server, copy a backup over `data/restaurants.json`, and start it again.

**Monitoring.** `GET /healthz` answers 200 `{"ok":true}`, or 503 if the last save to disk failed. The log (`kevins-food-map logs`) has one line per API request and the details of any error.

## Google setup

In Google Cloud Console, enable billing and these two APIs, then create a key:

| API | Used for | Where |
| --- | --- | --- |
| Maps JavaScript API | the map and markers | browser |
| Places API (New) | phone, address, food type for each pasted link | server |

One key is enough: put it in `GOOGLE_MAPS_API_KEY`, and under **API restrictions** allow only Maps JavaScript API and Places API (New). The key is visible to anyone who opens the page, so before making the site public, either set daily quotas (which cap the damage if it's copied) or split it into two keys: `GOOGLE_MAPS_BROWSER_KEY` (Websites restriction, Maps JavaScript API only) and `GOOGLE_PLACES_SERVER_KEY` (IP address restriction, Places API (New) only). A single key can't carry both restrictions, because Google allows one application restriction per key and a Websites restriction is meant for browser calls. When the site runs behind a proxy (`TRUST_PROXY=1`) with a single key, the server warns about this at startup.

Cost (Google pricing page, checked 2026-10-17): asking for the phone number puts each lookup in the "Text Search Enterprise" SKU, with 1,000 free per month and $35 per 1,000 after. The app looks up a place once when it is added, not on every page view. Map loads are billed separately under Maps JavaScript API.

When zoomed out, the map hides Google's own places, transit and road icons so the restaurant pins stand out; from zoom level 16 in (`DETAIL_ZOOM` in `public/app.js`) it shows Google's normal map so nearby businesses are visible again. This uses built-in style settings that need no extra setup. If you set `GOOGLE_MAPS_MAP_ID`, Google ignores those settings and uses the style attached to that map ID in Cloud console instead.

## How a link becomes a card

1. `maps.app.goo.gl/...` is a redirect. The server follows it (browsers can't read cross-site redirects) and only ever follows it to Google Maps hosts.
2. The long URL contains the place name and its pin (`!3d<lat>!4d<lng>`).
3. The server searches Places for that name near the pin and keeps the result only if it is within 300 m, so a same-named place elsewhere is never picked.
4. Food type comes from the Places type (`chinese_restaurant` becomes Chinese), else from words in the name (Szechuan, sushi, pho...). Change it in Manage → Restaurants; manual choices survive a refresh.

Links are checked before anything is added. Anything that isn't a Google Maps link is refused (in a bulk paste, other links are listed as skipped). A Maps link to a bare map position, a search or directions is refused because it doesn't name a place, and so is a link without the place's location. With a Places key, the place must also exist on Google at the link's pin and have a food-and-drink type (any `*_restaurant`, cafe, bakery, bar, pub, dessert shop and the like; the list is `FOOD_TYPES` in `lib/parse.js`), so a grocery store or gas station is refused. If Google can't be reached, the link fails and can be retried rather than being added unchecked. Without a Places key only the link itself can be checked, and the result says so.

Without a Places key, cards still get the name and pin from the link, with no phone or address. Once a key works, "↻ Details" in Manage → Restaurants looks it up again.

Cards show Google's star rating and review count when Places has them, with Google's attribution under the list. They are saved when a restaurant is added, so they don't update by themselves: tick restaurants in Manage → Restaurants and press **Update from Google** to fetch fresh ones (one lookup each). Restaurants added before ratings existed need this once. The rating comes in the same "Text Search Enterprise" lookup as the phone number, so it adds no cost (Text Search docs, checked 2026-10-17).

## Data

Restaurants are stored in `data/restaurants.json`, shared by everyone who uses the same server, and tracked in git so the list moves with the code. On a server the live copy wins over git; see "Updates and the restaurant list" above.

## Manage window and password

Anyone can view the list and map. **Manage** asks for the admin password, then has two tabs: **Add** (one link or a bulk paste) and **Restaurants** (search, change food type, refresh details, select all/none, archive). The server checks the login on every change, so hiding the button is not the only protection.

Archiving hides a restaurant from the list and map but keeps it in `data/restaurants.json` with an `archivedAt` date. Under Restaurants → **Archived** you can restore it, or delete it forever (the only real delete, with a confirmation). Adding the link of an archived restaurant again restores it.

- `npm run set-password` asks for the password twice (at least 10 characters) and writes only its hash to `ADMIN_PASSWORD_HASH` in `.env`. Restart the server after changing it. Until a password is set, nobody can make changes.
- The hash is Argon2id (OWASP's first choice: 19 MiB memory, 2 passes) using Node's built-in `crypto.argon2`, which needs Node 24.7 or newer. On older Node it uses scrypt (OWASP's next choice, N=2^17). No packages are involved either way. A hash made with Argon2id won't verify on older Node; run `set-password` again if you downgrade. `set-password` leaves `.env` readable only by you.
- A login lasts 12 hours in an HttpOnly, SameSite=Strict cookie, marked Secure when served over HTTPS. Sessions live in memory, so a restart logs you out.
- Five wrong passwords from one address within 15 minutes lock it out for 15 minutes (IPv6 addresses count per /64). Every attempt counts before the password is checked, and only two checks run at once, so a burst of guesses can't get around the limit or overload the server. The trade-off: while someone floods the login from many addresses, your own login may answer "Busy, try again in a moment."; wait and retry, or block them at the proxy.
- The page sends a strict Content Security Policy (Google's recommended one for Maps), so injected scripts can't run, and it can't be framed by other sites.
- Over plain HTTP the password crosses the network unencrypted, so use HTTPS (see the Caddy example above) anywhere but your own machine.
