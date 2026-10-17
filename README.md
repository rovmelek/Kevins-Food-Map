# NASC Food

Restaurants on a Google Map. Left panel: search by name, filter by food type, and cards sorted by distance. Right panel: the map, showing whatever the filter shows. Adding, editing and deleting happen in the password-protected **Manage** window.

## Run it

Needs Node 18.17 or newer. No packages to install.

```sh
cp .env.example .env      # then fill in the key and office location
npm run set-password      # admin password for the Manage window
npm start                 # http://127.0.0.1:3000
npm test
```

Location permission only works on `localhost` or HTTPS. If it is denied, the list is sorted from the office location in `.env` (`OFFICE_LAT`, `OFFICE_LNG`), or from the center of ZIP 98683 if those are not set.

## Run on a server (VPS)

On a Linux server with systemd (e.g. Ubuntu), install it as a service so it starts on boot and restarts itself after a crash:

```sh
git clone https://github.com/rovmelek/NASC-Food.git && cd NASC-Food
cp .env.example .env      # add your key and office location
bin/nasc-food install     # asks for sudo; adds the `nasc-food` command
nasc-food set-password
nasc-food start
```

| Command | What it does |
| --- | --- |
| `nasc-food start` / `stop` / `restart` | control the service |
| `nasc-food status` | is it running, and recent log lines |
| `nasc-food logs` | follow the log (Ctrl+C to exit) |
| `nasc-food set-password` | set or change the Manage password (then `restart`) |
| `nasc-food test` | run the automated tests |
| `nasc-food update` | `git pull`, run the tests, restart if they pass |
| `nasc-food uninstall` | remove the service (keeps your data) |

The server only listens on `127.0.0.1:3000`. To reach it from the internet, put a web server with HTTPS in front of it; location sharing in browsers only works over HTTPS. With [Caddy](https://caddyserver.com/), which gets certificates automatically, the whole config is:

```
food.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Behind a proxy like this, add `TRUST_PROXY=1` to `.env` so the login lockout sees visitors' real addresses. Before going public, add your domain to the key's Websites restriction and set daily quotas.

## Google setup

In Google Cloud Console, enable billing and these two APIs, then create a key:

| API | Used for | Where |
| --- | --- | --- |
| Maps JavaScript API | the map and markers | browser |
| Places API (New) | phone, address, food type for each pasted link | server |

One key is enough: put it in `GOOGLE_MAPS_API_KEY`, and under **API restrictions** allow only Maps JavaScript API and Places API (New). The key is visible to anyone who opens the page, so before making the site public, either set daily quotas (which cap the damage if it's copied) or split it into two keys: `GOOGLE_MAPS_BROWSER_KEY` (Websites restriction, Maps JavaScript API only) and `GOOGLE_PLACES_SERVER_KEY` (IP address restriction, Places API (New) only). A single key can't carry both restrictions, because Google allows one application restriction per key and a Websites restriction is meant for browser calls.

Cost (Google pricing page, checked 2026-10-17): asking for the phone number puts each lookup in the "Text Search Enterprise" SKU, with 1,000 free per month and $35 per 1,000 after. The app looks up a place once when it is added, not on every page view. Map loads are billed separately under Maps JavaScript API.

When zoomed out, the map hides Google's own places, transit and road icons so the restaurant pins stand out; from zoom level 16 in (`DETAIL_ZOOM` in `public/app.js`) it shows Google's normal map so nearby businesses are visible again. This uses built-in style settings that need no extra setup. If you set `GOOGLE_MAPS_MAP_ID`, Google ignores those settings and uses the style attached to that map ID in Cloud console instead.

## How a link becomes a card

1. `maps.app.goo.gl/...` is a redirect. The server follows it (browsers can't read cross-site redirects) and only ever follows it to Google Maps hosts.
2. The long URL contains the place name and its pin (`!3d<lat>!4d<lng>`).
3. The server searches Places for that name near the pin and keeps the result only if it is within 300 m, so a same-named place elsewhere is never picked.

Links are checked before anything is added. Anything that isn't a Google Maps link is refused (in a bulk paste, other links are listed as skipped). A Maps link to a bare map position, a search or directions is refused because it doesn't name a place. With a Places key, the place must also exist on Google at the link's pin and have a food-and-drink type (any `*_restaurant`, cafe, bakery, bar, pub, dessert shop and the like; the list is `FOOD_TYPES` in `lib/parse.js`), so a grocery store or gas station is refused. If Google can't be reached, the link fails and can be retried rather than being added unchecked. Without a Places key only the link itself can be checked, and the result says so.
4. Food type comes from the Places type (`chinese_restaurant` becomes Chinese), else from words in the name (Szechuan, sushi, pho...). Change it in Manage → Restaurants; manual choices survive a refresh.

Without a Places key, cards still get the name and pin from the link, with no phone or address. Once a key works, "↻ Details" in Manage → Restaurants looks it up again.

## Data

Restaurants are stored in `data/restaurants.json`, shared by everyone who uses the same server, and tracked in git so the list moves with the code.

## Manage window and password

Anyone can view the list and map. **Manage** asks for the admin password, then has two tabs: **Add** (one link or a bulk paste) and **Restaurants** (search, change food type, refresh details, select all/none, archive). The server checks the login on every change, so hiding the button is not the only protection.

Archiving hides a restaurant from the list and map but keeps it in `data/restaurants.json` with an `archivedAt` date. Under Restaurants → **Archived** you can restore it, or delete it forever (the only real delete, with a confirmation). Adding the link of an archived restaurant again restores it.

- `npm run set-password` asks for the password twice (at least 10 characters) and writes only its hash to `ADMIN_PASSWORD_HASH` in `.env`. Restart the server after changing it. Until a password is set, nobody can make changes.
- The hash is Argon2id (OWASP's first choice: 19 MiB memory, 2 passes) using Node's built-in `crypto.argon2`, which needs Node 24 or newer. On older Node it uses scrypt (OWASP's next choice, N=2^17). No packages are involved either way. A hash made on Node 24 won't verify on older Node; run `set-password` again if you downgrade.
- A login lasts 12 hours in an HttpOnly, SameSite=Strict cookie, marked Secure when served over HTTPS. Sessions live in memory, so a restart logs you out.
- Five wrong passwords from one address lock it out for 15 minutes.
- Over plain HTTP the password crosses the network unencrypted, so use HTTPS (see the Caddy example above) anywhere but your own machine.
