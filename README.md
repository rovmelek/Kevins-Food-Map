# NASC Food

Restaurants on a Google Map. Left panel: add links (one or bulk paste), search by name, filter by food type, and cards sorted by distance. Right panel: the map, showing whatever the filter shows.

## Run it

Needs Node 18.17 or newer. No packages to install.

```sh
cp .env.example .env      # then fill in the key and office location
npm start                 # http://127.0.0.1:3000
npm test
```

Location permission only works on `localhost` or HTTPS. If it is denied, the list is sorted from the office location in `.env`.

## Google setup

In Google Cloud Console, enable billing and these two APIs, then create a key:

| API | Used for | Where |
| --- | --- | --- |
| Maps JavaScript API | the map and markers | browser |
| Places API (New) | phone, address, food type for each pasted link | server |

Create two keys. The browser key (`GOOGLE_MAPS_BROWSER_KEY`) is visible to anyone who opens the page, so give it the Websites restriction (e.g. `http://localhost:3000`) and only Maps JavaScript API. The server key (`GOOGLE_PLACES_SERVER_KEY`) gets only Places API (New), plus an IP address restriction once hosted; Google advises IP restrictions for server-side keys, and a Websites-restricted key is meant for browser calls.

Cost (Google pricing page, checked 2026-10-17): asking for the phone number puts each lookup in the "Text Search Enterprise" SKU, with 1,000 free per month and $35 per 1,000 after. The app looks up a place once when it is added, not on every page view. Map loads are billed separately under Maps JavaScript API.

`DEMO_MAP_ID` is the default map ID. Google documents it for testing; create your own map ID (JavaScript type) for real use and set `GOOGLE_MAPS_MAP_ID`.

## How a link becomes a card

1. `maps.app.goo.gl/...` is a redirect. The server follows it (browsers can't read cross-site redirects) and only ever follows it to Google Maps hosts.
2. The long URL contains the place name and its pin (`!3d<lat>!4d<lng>`).
3. The server searches Places for that name near the pin and keeps the result only if it is within 300 m, so a same-named place elsewhere is never picked.
4. Food type comes from the Places type (`chinese_restaurant` becomes Chinese), else from words in the name (Szechuan, sushi, pho...). Click the tag on a card to change it; manual choices survive a refresh.

Without a Places key, cards still get the name and pin from the link, with no phone or address. Once a key works, the "↻ Details" button on a card looks it up again.

## Data

Restaurants are stored in `data/restaurants.json`, shared by everyone who uses the same server. The add, edit and delete endpoints have no login, so don't expose the server publicly without putting access control in front of it.
