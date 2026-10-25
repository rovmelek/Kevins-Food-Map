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
  - [HTTPS with Caddy, step by step](#https-with-caddy-step-by-step)
  - [Running with Docker](#running-with-docker)
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

Anyone can view the list and the map. The map opens centred on the visitor (or on the office, when the visitor doesn't share their location or has no listed restaurant within 40 km), zoomed to show the restaurants within 20 km (or 40 km, if none are that close); restaurants much farther away, in other cities or countries, are on the map but outside that first view. Choosing food types in **Filter** moves the map to the matching restaurants, again preferring nearby ones.

The **country** menu (shown once restaurants are in more than one country) lists each country with its number of restaurants. Picking one shows only that country's restaurants in the list and on the map, and moves the map to show all of them; **Filter** then counts food types in that country. "All countries" goes back to the nearby view.

The map moves with one finger on a phone and zooms with the mouse wheel on a computer, without the "use two fingers" or "use Ctrl + scroll" prompts. On a phone held upright, the map takes the top of the screen and the list the rest, and the list scrolls on its own; held sideways, the list and the map sit side by side. On a narrow screen the header is one line: search, country, **Filter** and **Manage** are icons, and the search icon opens the search box over the title (its ✕ clears the search and closes it). An icon stays highlighted while its search or filter is on, and the country icon shows the picked country's code.

**Manage** asks for the admin password and has three tabs:

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

**Node version.** The service keeps the Node it was installed with; `update` and `move` don't change it unless it has been removed. After a Node.js security release, upgrade Node, then check what the service runs: `systemctl cat kevins-food-map` shows the Node program as the first word of the `ExecStart=` line, and running that path with `--version` shows its version. If it is already the new version (for example Node from apt, upgraded in place), `kevins-food-map restart` is enough; otherwise switch as below. To switch, install the new Node somewhere the service user can run it (for example under `/usr/local`), then rerun `bin/kevins-food-map install` from a shell whose `node` is the new one, without `sudo` in front.

### HTTPS with Caddy, step by step

The app only listens on the server itself (`127.0.0.1:3000`), and it speaks plain HTTP. To let people reach it from the internet, safely and with the padlock in the browser, you put a **web server** in front of it. The web server answers visitors on the normal web ports, handles HTTPS, and passes each request on to the app. This is called a *reverse proxy*.

This guide uses [Caddy](https://caddyserver.com/), because it gets and renews the HTTPS certificate for you, and its whole configuration is a few lines. (nginx or Apache work too; see [Other web servers](#other-web-servers) below.)

**Who runs what.** Nothing here runs as root.

| Program | Runs as | Started by |
| --- | --- | --- |
| The app (`kevins-food-map`) | your own user, or a dedicated user ([Install as a service](#install-as-a-service)) | its systemd service, from `bin/kevins-food-map install` |
| Caddy | the `caddy` user, created by Caddy's package | its systemd service, set up by Caddy's package |

You type the commands below as your normal user. Commands that change the system start with `sudo`, which asks for your password. Never start Caddy by hand with `sudo caddy run`; let its service run it.

**What you need first**
- The app installed and running as a service ([Install as a service](#install-as-a-service)). Check with `kevins-food-map status`.
- A domain name you control, for example `food.example.com`. Every place below that says `food.example.com`, use your own name instead.
- An Ubuntu or Debian server that is reachable from the internet.

#### Step 1: Point your domain at the server

1. Find your server's public IP address. Your hosting company shows it, or run `curl -4 ifconfig.me` on the server.
2. At the company where you bought the domain, open its **DNS** settings and add a record:
   - Type: `A`
   - Name: `food` (for `food.example.com`), or `@` to use the bare domain (`example.com`)
   - Value: your server's IP address

   If a record with that name already exists (type `A`, `AAAA` or `CNAME`, often a "parking" record from the registrar), change it or delete it. A leftover `AAAA` record pointing somewhere else stops Caddy from getting a certificate.
3. Optional: to also accept the `www.` address, add a second `A` record pointing at the same IP address, named `www.food` (for `www.food.example.com`) or `www` (if you used `@`).
4. Wait until it works. From any computer, `nslookup food.example.com` should show your server's IP address. This can take a few minutes, sometimes longer.

Do this **before** starting Caddy, because Caddy asks for the certificate as soon as it starts, and that only works once the name points at your server.

#### Step 2: Open the web ports

Visitors and the certificate service must be able to reach ports 80 (HTTP) and 443 (HTTPS).
- Check the server's own firewall with `sudo ufw status`.
  - If it says `Status: inactive`, skip this; nothing is blocked.
  - If it says `Status: active`, run:
    ```sh
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    sudo ufw allow 443/udp    # for HTTP/3, which Caddy also offers
    ```
  - Don't turn the firewall on (`sudo ufw enable`) as part of this. If you ever do, run `sudo ufw allow OpenSSH` first, or you can lock yourself out of the server.
- If your hosting company has its own firewall in its web control panel, allow ports 80 and 443 there too.
- Do **not** open port 3000. The app must only be reachable through Caddy.

#### Step 3: Install Caddy

First check that no other web server is already using the web ports:

```sh
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

- If it shows only a heading line, the ports are free; continue below.
- If it lists `apache2` or `nginx`, another web server is already running. If it hosts other websites, keep it and use it instead of Caddy (see [Other web servers](#other-web-servers)). If it hosts nothing you need, turn it off for good with `sudo systemctl disable --now apache2` (or `nginx`) and continue.
- If it lists `caddy`, Caddy is already installed; skip to Step 4.
- If it lists anything else, find out what that program is before going on.

Then copy and paste these lines one by one (if a line asks whether to overwrite a file, answer `y`; if `apt` asks "Do you want to continue?", press Enter). They add Caddy's official package source, then install it (from Caddy's install guide for Debian and Ubuntu):

```sh
sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Caddy now runs as a service called `caddy` and starts by itself after a reboot. Check it with `systemctl status caddy --no-pager`; it should say `active (running)`.

#### Step 4: Tell Caddy about your site

Caddy reads its settings from the file `/etc/caddy/Caddyfile`. Replace that file with this app's example (change the folder in the first line to wherever you installed the app):

```sh
cd ~/Kevins-Food-Map       # the app's folder (with a dedicated user: cd /srv/kevins-food-map)
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
```

Put your domain name in it, in place of `food.example.com` everywhere (replace `food.yourdomain.com` here with your real name):

```sh
sudo sed -i 's/food\.example\.com/food.yourdomain.com/g' /etc/caddy/Caddyfile
```

Check that the replacement worked; this should print `0`:

```sh
grep -c example.com /etc/caddy/Caddyfile
```

Then open the file to look at it:

```sh
sudo nano /etc/caddy/Caddyfile
```

- If you did **not** create the `www.` DNS record in Step 1, delete the last block (the lines from `www.` to the closing `}`). Otherwise Caddy keeps trying, and failing, to get a certificate for it.
- If you changed `PORT` in the app's `.env`, change `3000` to that number.

Save with Ctrl+O and Enter, then leave with Ctrl+X.

The important part of the file is just this:

```caddyfile
food.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
```

It means: "for visitors to `food.example.com`, compress the answers and pass everything on to the app on this server." Caddy adds the HTTPS certificate, sends `http://` visitors to `https://`, and tells the app each visitor's real address.

Check the file for typing mistakes, then load it:

```sh
caddy validate --config /etc/caddy/Caddyfile   # should end with "Valid configuration"
sudo systemctl reload caddy
```

#### Step 5: Tell the app it is behind Caddy

Open the app's `.env` file:

```sh
cd ~/Kevins-Food-Map       # the app's folder (with a dedicated user: cd /srv/kevins-food-map)
nano .env                  # with a dedicated user: sudo -u foodmap nano .env
```

1. Find the line `# TRUST_PROXY=1` and delete the `# ` in front of it, so it reads `TRUST_PROXY=1`. If there is no such line, add `TRUST_PROXY=1` on a new line at the end.
2. Leave the line `# HOST=0.0.0.0 ...` exactly as it is, with its `#`. If you find a line starting with `HOST=` **without** a `#`, it must say `HOST=127.0.0.1`; otherwise delete that line.

Save with Ctrl+O and Enter, leave with Ctrl+X, then restart the app: `kevins-food-map restart`.

- Without a `HOST` line the app listens only on the server itself, so it can only be reached through Caddy. That is what you want.
- `TRUST_PROXY=1` makes the app read each visitor's address from the header Caddy adds. Without it, every visitor looks like the same address (Caddy's), and one person's wrong passwords would lock everyone out of Manage. Only set it when Caddy (or another proxy) is in front, because without a proxy anyone could fake that header.

#### Step 6: Check that it works

1. Open `https://food.example.com` in your browser (with your domain). You should see the map with the padlock in the address bar.
2. Open `http://food.example.com` (without the "s"). You should land on the `https://` address.
3. Open **Manage** and log in.
4. Optional: `curl -I https://food.example.com` should show `200` on its first line. Run it from another computer if you can; on some hosts a server can't reach its own public address, so a failure from the server itself proves nothing.

Before you tell people the address, read [Google setup](#google-setup). A public site should use two keys: a map key with a **Websites** restriction that includes your new address (`https://food.example.com/*`), and a separate server key for Places. Don't put a Websites restriction on a single shared key; it blocks the Places lookups.

#### When something goes wrong

| What you see | What to do |
| --- | --- |
| The browser can't connect at all | Check Step 1 (`nslookup` shows your server's IP) and Step 2 (ports 80 and 443 open, also in the hosting company's firewall). Then look at Caddy's log: `sudo journalctl -u caddy -n 50 --no-pager`. |
| A security or SSL error instead of the page | Caddy couldn't get the certificate yet, usually because of DNS or a closed port. Fix that, then run `sudo systemctl reload caddy` and look at the log (above). |
| `systemctl status caddy` says `failed`, and the log says "address already in use" | Another web server has the ports. See the check at the start of Step 3, then run `sudo systemctl restart caddy`. |
| The page loads, but the map stays grey or says Google Maps can't load | Your map key's **Websites** restriction doesn't include the new address. In Google Cloud console, add `https://food.example.com/*` (with your domain) to it. Also check that Maps JavaScript API is enabled on the key and billing is turned on; see [Google setup](#google-setup). |
| "502 Bad Gateway" | Caddy works, but the app isn't running. Run `kevins-food-map status`, and `kevins-food-map logs` for the reason. |
| `caddy validate` shows an error | It names the line with the mistake. A missing `}` is the most common one. |
| Wrong passwords lock out everybody at once | `TRUST_PROXY=1` is missing from `.env`, or the app wasn't restarted after adding it (Step 5). |
| You changed the Caddyfile and nothing happened | Run `sudo systemctl reload caddy`. |

**Day-to-day Caddy commands**

| Command | What it does |
| --- | --- |
| `systemctl status caddy --no-pager` | Is Caddy running? |
| `sudo systemctl reload caddy` | Load an edited Caddyfile without stopping the site. |
| `sudo journalctl -u caddy -n 50 --no-pager` | The last 50 lines of Caddy's log. |
| `caddy validate --config /etc/caddy/Caddyfile` | Check the Caddyfile for mistakes. |

Caddy renews the certificate by itself before it expires; there is nothing to do. Updating the app (`kevins-food-map update`) doesn't touch Caddy, and updating Caddy (`sudo apt update && sudo apt upgrade`) doesn't touch the app.

#### Other web servers

nginx or Apache work as well, especially if one is already running on the server. They don't get certificates by themselves (use `certbot`), and they must send the visitor's address (for the login lockout) and the protocol (so the login cookie is marked secure). For nginx that means, inside the HTTPS `server` block:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Then check and load it: `sudo nginx -t && sudo systemctl reload nginx`.

For Apache, enable its proxy modules (`sudo a2enmod proxy proxy_http headers`), and inside the `<VirtualHost *:443>` block that `certbot --apache` creates add:

```apache
ProxyPreserveHost On
ProxyPass / http://127.0.0.1:3000/
ProxyPassReverse / http://127.0.0.1:3000/
RequestHeader set X-Forwarded-Proto "https"
```

Then check it and restart Apache (needed once after enabling modules): `sudo apachectl configtest && sudo systemctl restart apache2`. Apache adds `X-Forwarded-For` by itself, but not `X-Forwarded-Proto`; without that line the login cookie isn't marked secure.

Set `TRUST_PROXY=1` in `.env` and leave `HOST` at its default, as in Step 5. The app uses the last `X-Forwarded-For` entry, the one your proxy adds, so a visitor can't fake their address. Before going public, also read the key notes in [Google setup](#google-setup).

### Running with Docker

This is another way to run the app on a server, instead of [Install as a service](#install-as-a-service) plus [HTTPS with Caddy](#https-with-caddy-step-by-step). Use one of the two on a server, not both. Docker runs two **containers**, small sealed-off boxes that each hold one program and everything it needs:

- **app**: this app, on Node 24. It can't be reached from outside the server; visitors only reach it through Caddy.
- **caddy**: the [Caddy](https://caddyserver.com/) web server. It answers visitors on the web ports, gets the HTTPS certificate, and passes requests on to the app.

The files for this are in the repository: `Dockerfile` (how to build the app's container) and the `docker/` folder (`compose.yml` says how the two containers run together, and `Caddyfile.example` is an example of Caddy's settings). The server needs only Docker, not Node or Caddy.

**Who runs what**

| Program | Runs as | Started by |
| --- | --- | --- |
| Docker itself | root (it is a system service) | systemd, set up when you install Docker |
| The app container | your own user | Docker, from `docker compose up -d` |
| The Caddy container | your own user, allowed to use ports 80 and 443 and nothing more | Docker, from `docker compose up -d` |

You type every command as your normal user. Commands with `sudo` in front ask for your password. Both containers start again by themselves after a crash or a reboot.

**What lives on the server, outside the containers.** None of it is in git, so `git pull` never touches it. A container can be deleted and rebuilt at any time; everything that matters is here:

| File or folder (in the app's folder) | What it holds |
| --- | --- |
| `.env` | Your Google keys, the office location and the Manage password (as a hash). The app can read it but not change it. |
| `docker/.env` | Which user the containers run as. A different file from the `.env` above. |
| `docker/Caddyfile` | Caddy's settings, with your domain name. |
| `docker-data/app/` | The live restaurant list, `settings.json` and the daily backups. |
| `docker-data/caddy/` | Caddy's certificates. |

**What you need first**
- An Ubuntu server that is reachable from the internet.
- A domain name you control, for example `food.example.com`. Wherever this guide says `food.yourdomain.com`, use your own name.
- Your two Google keys, a map key and a server key ([Google setup](#google-setup)).

#### Docker step 1: Make room on the server

If this server already runs the app as a service, or Caddy installed with `apt` (from the guides above), turn them off first, or they keep the web ports busy. Skip a line for anything you never installed:

```sh
kevins-food-map stop && kevins-food-map uninstall   # the app's service (your data is kept)
sudo systemctl disable --now caddy                  # Caddy installed with apt
```

Then check that nothing else uses the web ports:

```sh
sudo ss -ltnp '( sport = :80 or sport = :443 )'
```

It should show only a heading line. If it lists `apache2` or `nginx`, read the start of [Step 3: Install Caddy](#step-3-install-caddy) for what to do.

#### Docker step 2: Point your domain at the server and open the ports

Do [Step 1](#step-1-point-your-domain-at-the-server) and [Step 2](#step-2-open-the-web-ports) of the Caddy guide: the DNS record, and ports 80 and 443. Wait until `nslookup food.yourdomain.com` shows your server's IP address.

Good to know: ports that Docker opens are not blocked by the `ufw` firewall, even if `ufw` says they are, so with Docker the `ufw` commands are optional. The hosting company's own firewall still matters. That is fine here, because Docker opens only 80 and 443. Port 3000 is never opened; the app is reachable only through Caddy.

#### Docker step 3: Install Docker

These commands come from Docker's install guide for Ubuntu. They add Docker's official package source, then install Docker and its `compose` command. If `apt` asks "Do you want to continue?", press Enter.

First these lines:

```sh
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

Then this block, pasted all at once (everything from `sudo tee` down to `EOF`):

```sh
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

Then install Docker and try it:

```sh
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run hello-world      # should print "Hello from Docker!"
```

So that you don't have to type `sudo` before every `docker` command, add yourself to the `docker` group, then log out and back in:

```sh
sudo usermod -aG docker $USER
```

Be aware that anyone in the `docker` group can do anything on the server, as if they were root. Add only yourself. If you'd rather not, skip this and put `sudo` in front of every `docker` command below.

Check: after logging back in, `docker compose version` prints a version number.

#### Docker step 4: Get the app and fill in `.env`

If you are switching from the service on this same server and its folder is `~/Kevins-Food-Map`, rename the old folder first, so the new copy can take its name: `mv ~/Kevins-Food-Map ~/Kevins-Food-Map-old`. Wherever the old folder is, this guide calls it `~/Kevins-Food-Map-old` from now on; use its real place if it is somewhere else.

```sh
cd ~
git clone https://github.com/rovmelek/Kevins-Food-Map.git
cd Kevins-Food-Map
cp .env.example .env && chmod 600 .env
nano .env
```

In `.env`, fill in `GOOGLE_MAPS_API_KEY` (the map key), `GOOGLE_PLACES_SERVER_KEY` (the server key; remove the `#` in front of that line) and the office location, as in [Configuration](#configuration) and [Google setup](#google-setup). Leave out `HOST`, `PORT`, `TRUST_PROXY` and `DATA_FILE`: the Docker setup sets them itself, and ignores them in `.env`. Leave `ADMIN_PASSWORD_HASH` alone; step 7 fills it in. Save with Ctrl+O and Enter, leave with Ctrl+X.

If you are switching from the service, copy its `.env` instead of filling in a new one: `cp ~/Kevins-Food-Map-old/.env .env`. If the old folder belongs to a dedicated user (`/srv/kevins-food-map`), use `sudo cp /srv/kevins-food-map/.env .env && sudo chown "$USER": .env`.

#### Docker step 5: Tell Docker which user to run as, and make the data folders

Still in the app's folder (`~/Kevins-Food-Map`). Copy these lines exactly; they fill in your own user number by themselves:

```sh
printf 'APP_UID=%s\nAPP_GID=%s\n' "$(id -u)" "$(id -g)" > docker/.env
cat docker/.env      # shows two lines, for example APP_UID=1000 and APP_GID=1000; not 0
mkdir -p docker-data/app docker-data/caddy/data docker-data/caddy/config
```

If it shows `APP_UID=0`, you are logged in as root, and the containers would run as root: log in as your normal user and start again from step 4.

Make the folders **before** the first start. If Docker has to create them, they belong to root, and the containers can't write to them.

Then put a restaurant list in. Pick one:
- **Start from the list in the repository:** `cp data/restaurants.json docker-data/app/`
- **Bring your existing list** from the service: `cp ~/Kevins-Food-Map-old/data/restaurants.json docker-data/app/`. If you changed anything in Manage → Settings, also `cp ~/Kevins-Food-Map-old/data/settings.json docker-data/app/`. To keep the old daily backups too: `cp -r ~/Kevins-Food-Map-old/data/backups docker-data/app/`. If the old folder belongs to a dedicated user, use `sudo cp` and then `sudo chown -R "$USER": docker-data/app`.

Without a list the app starts empty.

#### Docker step 6: Tell Caddy your domain name

```sh
cp docker/Caddyfile.example docker/Caddyfile
sed -i 's/food\.example\.com/food.yourdomain.com/g' docker/Caddyfile    # use your real name
grep -c example.com docker/Caddyfile                                   # should print 0
```

The important part of the file is just this:

```caddyfile
food.yourdomain.com {
	encode zstd gzip
	reverse_proxy app:3000
}
```

It means: "for visitors to this name, compress the answers and pass everything on to the app container." Caddy adds the HTTPS certificate, sends `http://` visitors to `https://`, and tells the app each visitor's real address.

If you also created the `www.` DNS record (Caddy guide, Step 1), open the file with `nano docker/Caddyfile` and remove the `#` at the start of the last three lines. Save with Ctrl+O and Enter, leave with Ctrl+X.

#### Docker step 7: Build the app and set the Manage password

From here on, type the commands in the `docker` folder:

```sh
cd ~/Kevins-Food-Map/docker
docker compose build                     # builds the app's container; takes a minute the first time
docker compose run --rm set-password     # type the Manage password twice (at least 10 characters)
```

If you copied an old `.env` that already has a password, you can skip `set-password`.

#### Docker step 8: Start it

```sh
docker compose up -d
docker compose ps
```

`docker compose ps` lists `app` and `caddy`. Wait a few seconds and run it again, until `app` says `(healthy)`.

Then check it as in [Step 6](#step-6-check-that-it-works) of the Caddy guide: open `https://food.yourdomain.com`, look for the padlock, and log in to **Manage**. Your map key's **Websites** restriction must include the new address, and Places needs its own server key ([Google setup](#google-setup)).

#### Docker: day-to-day commands

Type these in the `docker` folder (`cd ~/Kevins-Food-Map/docker`).

| Command | What it does |
| --- | --- |
| `docker compose ps` | Are both containers running? `app` should say `(healthy)`. |
| `docker compose logs -f app` | Follow the app's log (Ctrl+C to exit). Use `caddy` in place of `app` for Caddy's log. |
| `docker compose restart app` | Do this after editing `.env`. |
| `docker compose restart caddy` | Do this after editing `docker/Caddyfile`. |
| `docker compose run --rm set-password` | Change the Manage password; then `docker compose restart app`. |
| `docker compose run --rm app node --test "test/*.test.js"` | Run the automated tests inside the container. |
| `docker compose down` | Stop and remove both containers. Your data stays; `docker compose up -d` starts them again. |

**Updating the app**

```sh
cd ~/Kevins-Food-Map
git rev-parse HEAD > ~/food-map-previous-version   # notes which version you have now
git pull
cd docker
docker compose build --pull     # --pull also fetches the newest Node 24
docker compose run --rm app node --test "test/*.test.js"    # the last lines should say "fail 0"
docker compose up -d                                        # only if the tests passed
```

The running site keeps working until the last line, which swaps in the new version. If the tests fail (then skip that line), or the site misbehaves after the update, go back to the version you noted:

```sh
cd ~/Kevins-Food-Map && git reset --hard "$(cat ~/food-map-previous-version)"
cd docker && docker compose build && docker compose up -d
```

`git pull` never changes the live list, because the live list is in `docker-data/app/`, not in `data/`. To update Caddy too: `docker compose pull caddy && docker compose up -d`.

**Node.js security releases.** When Node.js announces security fixes, run the update above even if the app's code hasn't changed: `--pull` rebuilds the app on the newest Node 24. Afterwards, `docker compose exec app node --version` shows the version in use. If it still shows the old version, Docker's Node image hasn't been updated yet (this can take a day after the announcement); run the update again later.

**Backups.** Before the first change of each day, the app copies the list into `docker-data/app/backups/` and keeps the last 14. To undo a mistake, in the `docker` folder (`ls ../docker-data/app/backups` lists them; use the date you want):

```sh
docker compose stop app
cp ../docker-data/app/backups/restaurants-2026-01-31.json ../docker-data/app/restaurants.json
docker compose start app
```

For a full backup of the server, keep a copy of `.env`, `docker/Caddyfile` and the whole `docker-data/` folder.

**Moving to another server.**
1. On the new server, do step 1, the ports part of step 2 (not the DNS record yet), step 3, step 4 without filling in `.env`, and the `printf` line of step 5 (your user number may be different there).
2. On the old server, stop the site, so that no change made in Manage gets lost: `cd ~/Kevins-Food-Map/docker && docker compose down`.
3. On the new server, copy the files over (replace `you@old-server` with your login on the old server):
   ```sh
   cd ~/Kevins-Food-Map
   scp you@old-server:Kevins-Food-Map/.env .
   scp you@old-server:Kevins-Food-Map/docker/Caddyfile docker/
   scp -r you@old-server:Kevins-Food-Map/docker-data .
   chmod 600 .env
   ```
4. Point the DNS record at the new server's IP address (Caddy guide, [Step 1](#step-1-point-your-domain-at-the-server)). In Google Cloud console, also change the server key's **IP addresses** to the new server's (`curl -4 ifconfig.me` there), or adding restaurants fails.
5. On the new server, do steps 7 (only `docker compose build`) and 8.

#### Docker: when something goes wrong

| What you see | What to do |
| --- | --- |
| `permission denied` and `docker.sock` | You aren't in the `docker` group yet: log out and back in, or put `sudo` in front. |
| `no configuration file provided` | You aren't in the `docker` folder: `cd ~/Kevins-Food-Map/docker`. |
| Saving in Manage fails ("Couldn't save"), and `docker compose logs app` says `EACCES` or "permission denied" | The `docker-data` folders belong to root (Docker created them before step 5, or they were copied with `sudo`). Run `sudo chown -R "$(id -u):$(id -g)" ../docker-data` and then `docker compose restart`. |
| `caddy` keeps restarting, and its log says "address already in use" | Another web server has the ports; see Docker step 1. |
| A security or SSL error instead of the page | Caddy couldn't get the certificate yet, usually because of DNS or a closed port (Docker step 2). Look at `docker compose logs caddy`, fix the cause, then `docker compose restart caddy`. |
| "502 Bad Gateway" | Caddy works, but the app isn't running. `docker compose logs app` shows why. |
| The map stays grey | The map key's **Websites** restriction doesn't include the new address; see [Google setup](#google-setup). |
| Adding says `Requests from referer <empty> are blocked` | The key used for Places has a **Websites** restriction. Give Places its own server key; see [Google setup](#google-setup). |
| Adding says the key has an `IP address restriction` that the call violates | The server key doesn't list the address the server calls Google from. Add the server's addresses (`curl -4 ifconfig.me` and `curl -6 ifconfig.me`) to the server key's **IP addresses**. |
| You edited `.env` or the Caddyfile and nothing changed | Restart that container (see the table above). |

The app's log lists each visitor's address. Visitors who arrive over IPv6 show up as one shared `172.x.x.x` address, because this setup doesn't give the containers IPv6. Then one such person's wrong passwords would lock all of them out of Manage. To avoid it, give your domain only an `A` record (IPv4), as in Step 1, and no `AAAA` record.

### Data, updates and backups

- **The live list.** `data/restaurants.json` is tracked in git so the list can travel with the code, but the copy on the server is the live one. `kevins-food-map update` sets it aside, pulls, and puts it back, so an update never replaces it; if GitHub has a different version, the update says so and keeps the server's. To move the list to another server, copy the file. (With Docker, the live list is `docker-data/app/restaurants.json`; see [Running with Docker](#running-with-docker).)
- **With Docker** all of this lives in `docker-data/app/` instead of `data/`; see [Running with Docker](#running-with-docker). The rest of this list is about the service.
- **Settings.** `data/settings.json` is never committed (`.gitignore`). `update` leaves it alone and `move` takes it along. If you point `DATA_FILE` at another folder inside the repo, ignore `settings.json` there too.
- **Backups.** Before the first change of each day the server copies the list to `data/backups/restaurants-YYYY-MM-DD.json` and keeps the last 14. To undo a mistake: stop the service, copy a backup over `data/restaurants.json`, start it again. Settings are not backed up.
- **Updating over SSH.** Run the update inside `tmux` or `screen`. A dropped connection would roll it back, but the service may stay stopped if `sudo` asks for a password.

### Monitoring

- `GET /healthz` returns `200 {"ok":true,"restaurants":N}`, or `503` if the last save to disk failed. When `data/settings.json` is damaged it adds `"settings":"damaged"` and still returns 200, because the site keeps working on the `.env` values.
- `kevins-food-map logs` (with Docker: `docker compose logs app`) shows one line per API request (with the visitor's IP address), every settings change, and the details of any error.

## Google setup

In Google Cloud console, enable billing and these two APIs, then create a key:

| API | Used for | Called from |
| --- | --- | --- |
| Maps JavaScript API | the map and its pins | the browser |
| Places API (New) | name, phone, address, website, food type and rating for each added link | the server |

**One key or two.** One key in `GOOGLE_MAPS_API_KEY` works for trying the app out; under **API restrictions** allow only those two APIs, and give it **no** application restriction. The browser needs the key to draw the map, so anyone who opens the page can see it, and with one key they could also run Places lookups on your bill. Google allows only one kind of application restriction per key, and the two callers need different ones: the map runs in visitors' browsers, which say which website they are on, while Places lookups come from your server, which doesn't. So a **Websites** restriction on a single key makes every add fail with `Requests from referer <empty> are blocked`.

For a public site, use two keys (in Google Cloud console: **APIs & Services → Credentials**; **Create credentials → API key** makes a new one, and clicking a key's name opens its settings):

| Key | In `.env` | Application restriction | API restriction |
| --- | --- | --- | --- |
| Map key | `GOOGLE_MAPS_API_KEY` (or `GOOGLE_MAPS_BROWSER_KEY`) | **Websites**: `https://food.yourdomain.com/*` | Maps JavaScript API only |
| Server key | `GOOGLE_PLACES_SERVER_KEY` | **IP addresses**: your server's public addresses (what `curl -4 ifconfig.me` prints on the server, plus `curl -6 ifconfig.me` if it prints one) | Places API (New) only |

When `GOOGLE_PLACES_SERVER_KEY` is set, Places uses it and the map uses the other key. Restart the app after editing `.env`; Google may take up to 5 minutes to apply a key's new settings. With a single key and `TRUST_PROXY=1`, the server warns at startup. Daily quotas are a further safety net: **Google Maps Platform → Quotas**, choose **Places API (New)**, and lower **SearchTextRequest per day**.

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
- **`public/`**: the whole front end, with no build step and no framework. The site icon is `favicon.svg`, with PNG copies for browsers and phones that don't use SVG icons (`favicon-32.png`, `apple-touch-icon.png`); the server lets browsers cache these for a day.
- **`bin/kevins-food-map`** and **`deploy/kevins-food-map.service.in`**: the service script and the hardened systemd unit it installs.
- **`scripts/set-password.js`**: writes the password hash to `.env`.

### How a link becomes a restaurant

1. A `maps.app.goo.gl/...` short link is a redirect. The server follows it (browsers can't read cross-site redirects), and only to Google Maps hosts.
2. The long URL holds the place name and its location (the pin `!3d<lat>!4d<lng>`, else the map position). A link with no place name (a bare map position or directions) or no location is refused.
3. With a Places key, the server searches Places for that name near the pin and keeps the result only if it is within 300 m, so a same-named place elsewhere is never picked. It must also have a food-and-drink type (any `*_restaurant`, cafe, bakery, bar and the like; the list is `FOOD_TYPES` in `lib/parse.js`), so a grocery store or a gas station is refused. If Google can't be reached, the link fails and can be retried; it is never added unchecked.
4. Without a Places key, only the link itself is checked, and the restaurant gets the name and pin from it with no phone or address. The result says so; **Update from Google** fills in the rest once a key works.
5. The food type comes from the Places type (`chinese_restaurant` becomes Chinese), otherwise from words in the name (Szechuan, sushi, pho and so on).
6. The country is Google's country code from the place's address details. For a restaurant without a stored country (for example one added without a Places key), the list reads the country from its address instead (`countryFromAddress` in `lib/parse.js`), which handles Google's English and Chinese or Japanese address orders. One with no recognisable country is listed under "Country unknown".
7. **Duplicates.** A link already in the list, the same Google place ID, the same Google CID, or the same name (ignoring case) within about 50 m counts as the same restaurant. The same link twice in one paste is processed once. A duplicate is reported as "Already listed", and an archived one is restored instead of added again.

### Data model

`data/restaurants.json` is a JSON array. Each restaurant looks like this:

```json
{
  "id": "uuid",
  "name": "Szechuan Brothers Chinese Restaurant",
  "lat": 45.6176, "lng": -122.5347,
  "cuisine": "Chinese", "cuisineManual": false,
  "types": ["chinese_restaurant", "restaurant"],
  "phone": "(360) 555-0100", "address": "…", "country": "US", "website": "https://…",
  "rating": 4.5, "ratingCount": 320,
  "placeId": "…", "cid": "…", "featureId": "…",
  "mapsUrl": "https://maps.google.com/?cid=…",
  "enriched": true,
  "sourceUrl": "https://maps.app.goo.gl/…",
  "addedAt": "2025-01-01T12:00:00.000Z",
  "archivedAt": "2025-02-01T12:00:00.000Z"
}
```

`archivedAt` is only present on archived restaurants. `enriched` is true once Places details were fetched. `phoneManual` and `addressManual` mark values edited by hand. `country` is a two-letter ISO 3166 code, or missing or `null` when Google didn't give one.

`data/settings.json` is an object with at most `office` (`{ name, lat, lng }`) and `mapId` (a string; `""` means the built-in style). A missing key means "use the `.env` value".

### HTTP API

All responses are JSON; errors are `{ "error": "…" }` with a status code (400 bad input, 401 not logged in or wrong password, 403 cross-site, 404/405 unknown route or method, 413 request too large, 415 not JSON, 429 locked out or busy, 500 saving failed, 502 Google unreachable, 503 no password set). Routes marked "login" need the session cookie from `/api/auth/login`. Every non-GET request must have `Content-Type: application/json`.

| Method and path | Login | Purpose |
| --- | --- | --- |
| `GET /api/config` | | Browser key, map ID, office, whether Places is enabled. |
| `GET /api/restaurants` | | Listed (not archived) restaurants. A missing `country` is filled in from the address. |
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
- **Docker.** Both containers run as the server user named in `docker/.env`, never as root, with no extra privileges (Caddy may only use ports 80 and 443). The app's container is read-only except for `docker-data/app`, reads `.env` read-only, can't see Caddy's certificates, and is not published on any port. Secrets stay out of the image (`.dockerignore`).
- **HTTPS.** Over plain HTTP the password crosses the network unencrypted, so use HTTPS anywhere but your own machine ([HTTPS with Caddy, step by step](#https-with-caddy-step-by-step)).
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
| The map doesn't load | `GOOGLE_MAPS_API_KEY` (or `GOOGLE_MAPS_BROWSER_KEY`) is set, Maps JavaScript API is enabled, and the map key's **Websites** restriction includes your address. The browser console shows Google's exact error. |
| Restaurants have no phone or address | No Places key is set. Set one, then select them and press **Update from Google**. (With a key that Google refuses, adding fails with Google's error instead.) |
| Adding fails with an `IP address restriction` error | The server key doesn't list the address the server calls Google from. Add the server's addresses (`curl -4 ifconfig.me` and `curl -6 ifconfig.me`) to the server key's **IP addresses**. |
| "Use my location" does nothing | Location sharing only works on `localhost` or HTTPS, and the visitor must allow it. |
| Manage says no password is set | Run `kevins-food-map set-password` (or `npm run set-password`), then restart. With Docker: `docker compose run --rm set-password`, then `docker compose restart app`. |
| Adding fails with `Requests from referer <empty> are blocked` | The key used for Places has a **Websites** restriction, which only works for the map. Give Places its own server key ([Google setup](#google-setup)). |
| "Too many wrong passwords" | Wait 15 minutes, or restart the server to clear the lockout (with Docker: `docker compose restart app`). Behind a proxy, make sure `TRUST_PROXY=1` is set, or everyone shares the proxy's address. |
| `/healthz` returns 503 | The last save failed; `kevins-food-map logs` shows why (usually disk space or permissions on `data/`). With Docker: `docker compose logs app`, and see [Docker: when something goes wrong](#docker-when-something-goes-wrong). |
| A leftover `nasc-food` service from an older install | Remove it: `sudo systemctl disable --now nasc-food && sudo rm -f /etc/systemd/system/nasc-food.service /usr/local/bin/nasc-food && sudo systemctl daemon-reload`, then run `bin/kevins-food-map install`. |

## License

GPL-3.0-only. See [LICENSE](LICENSE).
