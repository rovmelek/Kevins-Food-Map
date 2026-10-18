'use strict';
// NASC Food front end: left panel (search, filter, cards) + right map, and a
// password-protected Manage window for adding, editing and archiving.

const state = {
  restaurants: [],
  config: null,
  origin: null,        // { lat, lng, label, isUser }
  search: '',
  cuisine: '',
  selectedId: null,
  loggedIn: false,
  passwordSet: false,
  manageView: 'add',   // 'add' | 'restaurants'
  editSearch: '',
  checked: new Set(),  // ids ticked in the Manage list
  archived: [],        // archived restaurants, loaded only when logged in
  editShow: 'listed',  // 'listed' | 'archived'
  busy: false,         // a Manage action is running; other actions wait
};
const map = { api: null, instance: null, markers: new Map(), info: null, PinOverlay: null };

const ICONS = {
  Japanese: '🍣', Chinese: '🥟', Korean: '🍲', Thai: '🍜', Vietnamese: '🍜', Indian: '🍛', Italian: '🍝',
  Mexican: '🌮', Pizza: '🍕', Burgers: '🍔', Barbecue: '🍖', Cafe: '☕', Drinks: '🧋', Bakery: '🥐',
  Seafood: '🦐', Steakhouse: '🥩', Sandwiches: '🥪', Vegetarian: '🥗', Breakfast: '🥞', Dessert: '🍨',
  Dumpling: '🥟', Noodles: '🍜', 'Middle Eastern': '🥙', Mediterranean: '🫒', Greek: '🥙', French: '🥖', American: '🍔', 'Fast food': '🍟',
};
const iconFor = c => (Object.hasOwn(ICONS, c) ? ICONS[c] : '🍽️');

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Links we render must be https; anything else (javascript:, data:) becomes inert.
const safeUrl = u => (/^https:\/\//i.test(String(u ?? '')) ? String(u) : '#');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Google's star rating as five stars filled to the exact value, plus the
// review count, linking to the place on Google Maps where the reviews are.
function ratingHtml(r) {
  const rating = Number(r.rating);
  if (r.rating == null || !Number.isFinite(rating)) return '';
  const count = Number.isFinite(Number(r.ratingCount)) && r.ratingCount != null ? Number(r.ratingCount) : null;
  const pct = Math.max(0, Math.min(100, rating / 5 * 100));
  const label = `Google rating ${rating.toFixed(1)} out of 5${count != null ? `, ${count.toLocaleString()} reviews` : ''}`;
  return `<a class="rating" href="${esc(safeUrl(r.mapsUrl))}" target="_blank" rel="noopener" aria-label="${esc(label)}" title="${esc(label)}">` +
    `<span class="rating-num">${rating.toFixed(1)}</span><span class="stars" style="--pct:${pct}%" aria-hidden="true">★★★★★</span>` +
    `${count != null ? `<span aria-hidden="true">(${count.toLocaleString()})</span>` : ''}</a>`;
}

// A 401 means the login expired: the Manage window switches to the login
// form with a note, and callers can ignore the error (err.handled).
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.loggedIn) {
    state.loggedIn = false;
    renderManage();
    $('loginError').textContent = 'Your login expired. Log in again.';
    if ($('manageDialog').open) $('password').focus();
    throw Object.assign(new Error(data.error || 'Logged out'), { handled: true });
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const restaurantUrl = (id, suffix = '') => `/api/restaurants/${encodeURIComponent(id)}${suffix}`;

// Re-render a container without losing keyboard focus: put focus back on the
// same control of the same row (by data-id and data-act) afterwards.
function keepFocus(root, render) {
  const a = document.activeElement;
  const inside = a && a !== root && root.contains(a);
  const id = inside ? a.closest('[data-id]')?.dataset.id : null;
  const act = inside ? a.dataset.act : null;
  render();
  if (!id) return;
  const row = root.querySelector(`[data-id="${CSS.escape(id)}"]`);
  (row?.querySelector(`[data-act="${act}"]`) || row?.querySelector('button, input'))?.focus();
}

// ---- distance & filtering --------------------------------------------------

function distanceKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function formatDistance(km) {
  const mi = km * 0.621371;
  return mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
}

function visible() {
  const q = state.search.trim().toLowerCase();
  return state.restaurants
    .filter(r => !q || r.name.toLowerCase().includes(q))
    .filter(r => !state.cuisine || r.cuisine === state.cuisine)
    .map(r => ({ ...r, km: state.origin ? distanceKm(state.origin, r) : null }))
    .sort((a, b) => (a.km ?? 0) - (b.km ?? 0) || a.name.localeCompare(b.name));
}

// ---- rendering -------------------------------------------------------------

function renderFilterOptions() {
  const sel = $('cuisineFilter');
  const counts = new Map();
  for (const r of state.restaurants) counts.set(r.cuisine, (counts.get(r.cuisine) || 0) + 1);
  const names = [...counts.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  if (state.cuisine && !counts.has(state.cuisine)) state.cuisine = '';
  sel.innerHTML = `<option value="">All food types (${state.restaurants.length})</option>` +
    names.map(n => `<option value="${esc(n)}">${iconFor(n)} ${esc(n)} (${counts.get(n)})</option>`).join('');
  sel.value = state.cuisine;
  // Suggestions when changing a food type in Manage, so typos don't create
  // a new category.
  const known = new Set([...names, ...Object.keys(ICONS)]);
  $('cuisineOptions').innerHTML = [...known].sort().map(n => `<option value="${esc(n)}"></option>`).join('');
}

function renderOrigin(note = '') {
  const el = $('origin');
  if (!state.origin) { el.textContent = ''; return; }
  if (state.origin.isUser) {
    el.textContent = 'Sorted by distance from your location.';
  } else {
    el.innerHTML = `Sorted by distance from ${esc(state.origin.label)}. <button id="useLoc" type="button">Use my location</button>` +
      (note ? ` <span class="origin-note">${esc(note)}</span>` : '');
    $('useLoc').onclick = () => locateUser(true);
  }
}

function renderList() {
  const items = visible();
  // A selected restaurant that the search or filter hides is deselected, so
  // its popup doesn't linger.
  if (state.selectedId && !items.some(r => r.id === state.selectedId)) { state.selectedId = null; map.info?.close(); }
  const list = $('list');
  keepFocus(list, () => {
    list.innerHTML = items.length ? items.map(r => {
      const selected = r.id === state.selectedId;
      return `
      <li class="card${selected ? ' selected' : ''}" data-id="${esc(r.id)}">
        <div class="icon" aria-hidden="true">${iconFor(r.cuisine)}</div>
        <div>
          <button type="button" class="name card-main" data-act="select" aria-pressed="${selected}">${esc(r.name)}</button>
          ${ratingHtml(r) ? `<p class="meta">${ratingHtml(r)}</p>` : ''}
          <p class="meta">${r.phone ? `📞 <a href="tel:${esc(String(r.phone).replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>` : '📞 Phone not available'}</p>
          <p class="meta">📍 ${r.address ? esc(r.address) : 'Address not available'}</p>
        </div>
        <div class="side">
          <span>${r.km != null ? formatDistance(r.km) : ''}</span>
          <span class="tag">${esc(r.cuisine)}</span>
        </div>
      </li>`;
    }).join('') : `<li class="empty">${state.restaurants.length ? 'No restaurants match.' : 'No restaurants yet. Use “Manage” to add Google Maps links.'}</li>`;
  });
  const status = items.length === state.restaurants.length ? plural(items.length, 'restaurant') : `${items.length} of ${plural(state.restaurants.length, 'restaurant')} shown`;
  if ($('listStatus').textContent !== status) $('listStatus').textContent = status;
  // Google's attribution, shown whenever a rating is on screen.
  $('ratingNote').hidden = !items.some(r => ratingHtml(r));
  renderMarkers(items);
}

function renderAll() { renderFilterOptions(); renderOrigin(); renderList(); renderEditList(); }

// ---- map -------------------------------------------------------------------

function showMapNotice(html) { const n = $('mapNotice'); n.innerHTML = html; n.hidden = false; }

const MAP_LOAD_TIMEOUT_MS = 15000;

function loadMap() {
  const key = state.config.browserKey;
  if (!key) {
    showMapNotice('<div><b>Map not configured.</b><br>Set GOOGLE_MAPS_API_KEY in .env and restart the server.<br>The list on the left still works.</div>');
    return;
  }
  const failed = () => showMapNotice('<div>Could not load Google Maps. Check your connection, then reload the page.<br>The list on the left still works.</div>');
  // If the script loads but never starts the map (blocked or empty), say so
  // instead of leaving a blank area.
  const timer = setTimeout(() => { if (!map.instance) failed(); }, MAP_LOAD_TIMEOUT_MS);
  window.gm_authFailure = () => showMapNotice(`<div><b>Google rejected the Maps API key.</b><br>
    Check that billing and Maps JavaScript API are enabled, and that the key's Websites restriction includes
    <code>${esc(location.origin)}</code>. The browser console (F12) names the exact error.</div>`);
  window.__initMap = () => {
    clearTimeout(timer);
    initMap().catch(err => {
      console.error(err);
      showMapNotice(`<div><b>The map failed to start.</b><br>${esc(err.message)}</div>`);
    });
  };
  const s = document.createElement('script');
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__initMap`;
  s.async = true;
  s.onerror = () => { clearTimeout(timer); failed(); };
  document.head.appendChild(s);
}

// Zoomed out, hide Google's own places, transit and road icons so only our
// pins stand out; from DETAIL_ZOOM in, show Google's normal map so nearby
// businesses and stops are visible. JSON styles only apply when no map ID is
// set (with GOOGLE_MAPS_MAP_ID, style the map in Cloud console instead).
const DETAIL_ZOOM = 16;
const QUIET_STYLE = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
];
const PIN_HEIGHT = 50;

async function initMap() {
  const { Map, InfoWindow, OverlayView } = await google.maps.importLibrary('maps');
  map.PinOverlay = makePinOverlay(OverlayView);
  map.instance = new Map($('map'), {
    center: latLng(state.origin || state.config.office), zoom: 12,
    ...(state.config.mapId ? { mapId: state.config.mapId } : { styles: QUIET_STYLE }),
    clickableIcons: false, mapTypeControl: false, streetViewControl: false,
  });
  $('mapNotice').hidden = true; // a slow load may have shown the timeout notice
  if (!state.config.mapId) {
    let detailed = false;
    map.instance.addListener('zoom_changed', () => {
      const want = map.instance.getZoom() >= DETAIL_ZOOM;
      if (want !== detailed) { detailed = want; map.instance.setOptions({ styles: want ? [] : QUIET_STYLE }); }
    });
  }
  map.info = new InfoWindow({ pixelOffset: new google.maps.Size(0, -Math.round(PIN_HEIGHT * 1.3)) });
  map.info.addListener('closeclick', deselect);   // the popup's ✕
  map.instance.addListener('click', deselect);    // a click on empty map
  map.api = google.maps;
  renderList();
  fitToVisible();
}

const latLng = r => ({ lat: r.lat, lng: r.lng });

// Our pins are plain HTML drawn on an OverlayView, so they work with or
// without a map ID and look the same everywhere.
function makePinOverlay(OverlayView) {
  return class PinOverlay extends OverlayView {
    constructor(position, el) { super(); this.position = position; this.el = el; }
    onAdd() {
      this.getPanes().overlayMouseTarget.appendChild(this.el);
      // Keep pin clicks from also counting as a click on the map (which deselects).
      OverlayView.preventMapHitsAndGesturesFrom?.(this.el);
    }
    draw() {
      const p = this.getProjection()?.fromLatLngToDivPixel(this.position);
      if (p) { this.el.style.left = `${p.x}px`; this.el.style.top = `${p.y}px`; }
    }
    onRemove() { this.el.remove(); }
  };
}

function renderMarkers(items) {
  if (!map.instance) return;
  const keep = new Set(items.map(r => r.id));
  for (const [id, m] of map.markers) if (!keep.has(id)) { m.setMap(null); map.markers.delete(id); }
  for (const r of items) {
    let m = map.markers.get(r.id);
    if (!m) {
      const el = pinElement();
      const open = e => { e.preventDefault(); e.stopPropagation(); select(r.id, { fromMap: true }); };
      el.addEventListener('click', open);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(e); });
      m = new map.PinOverlay(new map.api.LatLng(r.lat, r.lng), el);
      map.markers.set(r.id, m);
    }
    // Details can change after "Update from Google": keep the pin in step.
    if (m.at !== `${r.lat},${r.lng}`) { m.at = `${r.lat},${r.lng}`; m.position = new map.api.LatLng(r.lat, r.lng); if (m.getMap()) m.draw(); }
    if (m.el.title !== r.name) { m.el.title = r.name; m.el.setAttribute('aria-label', r.name); }
    if (!m.getMap()) m.setMap(map.instance);
    const selected = r.id === state.selectedId;
    m.el.querySelector('.pin-glyph').textContent = iconFor(r.cuisine);
    m.el.classList.toggle('selected', selected);
    m.el.setAttribute('aria-pressed', selected);
    m.el.style.zIndex = selected ? 1000 : Math.round(1000 - r.lat * 10); // southern pins in front
  }
}

// A teardrop pin with the food-type icon in a white circle. CSS shifts it so
// the tip sits on the restaurant's location.
function pinElement() {
  const el = document.createElement('div');
  el.className = 'pin';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.innerHTML = `<svg viewBox="0 0 40 50" aria-hidden="true"><path d="M20 49C20 49 2 30.5 2 19a18 18 0 0 1 36 0C38 30.5 20 49 20 49z"/><circle cx="20" cy="19" r="12.5"/></svg><span class="pin-glyph" aria-hidden="true"></span>`;
  return el;
}

function fitToVisible() {
  if (!map.instance) return;
  const items = visible();
  if (!items.length) return;
  if (items.length === 1) { map.instance.setCenter(latLng(items[0])); map.instance.setZoom(15); return; }
  const b = new map.api.LatLngBounds();
  items.forEach(r => b.extend(latLng(r)));
  map.instance.fitBounds(b, 40);
}

function deselect() {
  if (!state.selectedId) return;
  state.selectedId = null;
  map.info?.close();
  renderList();
}

// Selecting the restaurant that's already selected clears it instead.
function select(id, { fromMap = false, toggle = true } = {}) {
  if (toggle && state.selectedId === id) { deselect(); return; }
  state.selectedId = id;
  const r = state.restaurants.find(x => x.id === id);
  renderList();
  if (fromMap) document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (!map.instance || !r) return;
  map.instance.panTo(latLng(r));
  map.info.setContent(`<div class="info"><h3>${esc(r.name)}</h3>${ratingHtml(r) ? `<p>${ratingHtml(r)}</p>` : ''}${r.phone ? `<p>${esc(r.phone)}</p>` : ''}${r.address ? `<p>${esc(r.address)}</p>` : ''}<p><a href="${esc(safeUrl(r.mapsUrl))}" target="_blank" rel="noopener">Open in Google Maps</a></p></div>`);
  map.info.setPosition(latLng(r));
  map.info.open({ map: map.instance, shouldFocus: false });
}

// ---- location --------------------------------------------------------------

function useOffice() {
  const o = state.config.office;
  state.origin = { lat: o.lat, lng: o.lng, label: o.name, isUser: false };
}

function locateUser(explicit = false) {
  if (!('geolocation' in navigator)) { if (explicit) renderOrigin('This browser can’t share its location.'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'your location', isUser: true };
    renderAll();
  }, err => {
    if (explicit) renderOrigin(err.code === 1 ? 'Location permission was denied.' : 'Couldn’t get your location.');
  }, { timeout: 10000, maximumAge: 300000 });
}

// ---- manage (login, add, edit, archive) ----------------------------------

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function setStatus(msg, isError = false) {
  $('editStatus').textContent = msg;
  $('editStatus').classList.toggle('error', isError);
}
// Errors in Manage show in the window; an expired login is handled by api().
function showError(err) {
  if (err.handled) return;
  if (state.manageView === 'add') $('addResults').innerHTML = `<li class="error">✕ ${esc(err.message)}</li>`;
  else setStatus(err.message, true);
}

function focusManage() {
  const target = !state.loggedIn ? $('password') : state.manageView === 'add' ? currentAddInput() : $('editSearch');
  target.focus();
}

async function openManage() {
  $('toast').hidden = true;
  $('addResults').innerHTML = '';
  setStatus('');
  $('loginError').textContent = '';
  const session = await api('/api/auth/session');
  state.loggedIn = session.loggedIn;
  state.passwordSet = session.passwordSet;
  if (state.loggedIn) await reloadRestaurants();
  renderManage();
  $('manageDialog').showModal();
  focusManage();
}

function renderManage() {
  $('loginView').hidden = state.loggedIn;
  $('manageView').hidden = !state.loggedIn;
  $('logoutBtn').hidden = !state.loggedIn;
  $('password').disabled = $('loginSubmit').disabled = !state.passwordSet;
  $('loginHint').innerHTML = state.passwordSet
    ? 'Enter the admin password to add, edit or archive restaurants.'
    : 'No admin password is set yet. On the server, run <code>npm run set-password</code> (or <code>nasc-food set-password</code>), then restart it.';
  document.querySelectorAll('#manageView [role=tab]').forEach(t => {
    const on = t.dataset.view === state.manageView;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
  });
  $('addPane').hidden = state.manageView !== 'add';
  $('editPane').hidden = state.manageView !== 'restaurants';
  renderEditList();
}

// Tabs follow the ARIA tabs pattern: arrow keys, Home and End move between them.
function onTabKey(e) {
  const tabs = [...document.querySelectorAll('#manageView [role=tab]')];
  const i = tabs.indexOf(e.target);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next == null) return;
  e.preventDefault();
  const tab = tabs[(next + tabs.length) % tabs.length];
  state.manageView = tab.dataset.view;
  renderManage();
  tab.focus();
}

async function submitLogin(e) {
  e.preventDefault();
  $('loginSubmit').disabled = true;
  $('loginError').textContent = '';
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    state.loggedIn = true;
    $('password').value = '';
    await reloadRestaurants();
    renderManage();
    focusManage();
  } catch (err) {
    $('loginError').textContent = err.message;
    $('password').select();
  } finally {
    $('loginSubmit').disabled = !state.passwordSet;
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  state.loggedIn = false;
  state.checked.clear();
  state.archived = [];
  $('manageDialog').close();
  toast('Logged out.');
}

const addMode = () => document.querySelector('input[name=addMode]:checked').value;
const currentAddInput = () => (addMode() === 'single' ? $('singleInput') : $('bulkInput'));
function onAddModeChange() {
  $('singleInput').hidden = addMode() !== 'single';
  $('bulkInput').hidden = addMode() !== 'bulk';
  currentAddInput().focus();
}

async function reloadRestaurants() {
  [state.restaurants, state.archived] = await Promise.all([api('/api/restaurants'), api('/api/restaurants/archived')]);
  renderAll();
}

// Adds the pasted link(s) and lists the outcome of each in the window, which
// stays open for more. Failed links stay in the box to fix or retry.
async function submitAdd(e) {
  e.preventDefault();
  const input = currentAddInput();
  const out = $('addResults');
  if (!input.value.trim()) return;
  $('addSubmit').disabled = true;
  out.innerHTML = '<li>Looking up places…</li>';
  try {
    const { results } = await api('/api/restaurants', { method: 'POST', body: JSON.stringify({ text: input.value }) });
    const changed = results.some(r => r.status === 'added' || r.status === 'restored');
    const failed = results.filter(r => r.status === 'error');
    if (changed) await reloadRestaurants();
    // Stay open so more can be added; the result shows here and the map updates behind.
    const warning = results.find(r => r.warning)?.warning;
    out.innerHTML = results.map(r => {
      if (r.status === 'added') return `<li class="added">✓ Added ${esc(r.restaurant.name)}</li>`;
      if (r.status === 'restored') return `<li class="added">✓ Restored from the archive: ${esc(r.restaurant.name)}</li>`;
      if (r.status === 'duplicate') return `<li class="duplicate">• Already listed: ${esc(r.restaurant.name)}</li>`;
      if (r.status === 'skipped') return `<li class="duplicate">• Skipped ${esc(r.url)}: not a Google Maps link</li>`;
      return `<li class="error">✕ ${esc(r.url)}: ${esc(r.error)}</li>`;
    }).join('') + (warning ? `<li class="duplicate">${esc(warning)}</li>` : '');
    input.value = failed.length && addMode() === 'bulk' ? failed.map(r => r.url).join('\n') : failed.length ? input.value : '';
    input.focus();
    if (changed) fitToVisible();
  } catch (err) {
    out.innerHTML = err.handled ? '' : `<li class="error">✕ ${esc(err.message)}</li>`;
  } finally {
    $('addSubmit').disabled = false;
  }
}

const editSource = () => (state.editShow === 'archived' ? state.archived : state.restaurants);

function editItems() {
  const q = state.editSearch.trim().toLowerCase();
  return editSource().filter(r => !q || r.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const TOOLS = [
  ['refresh', 'Update from Google', () => state.editShow === 'listed' && state.config.placesEnabled],
  ['archive', 'Archive', () => state.editShow === 'listed'],
  ['restore', 'Restore', () => state.editShow === 'archived'],
  ['purge', 'Delete forever', () => state.editShow === 'archived'],
];

function renderEditList() {
  if (!$('editList') || !state.config) return;
  const items = editItems();
  const inArchive = state.editShow === 'archived';
  // Only rows you can see stay ticked, so an action never hits something
  // hidden by the search or the other view.
  const shown = new Set(items.map(r => r.id));
  for (const id of state.checked) if (!shown.has(id)) state.checked.delete(id);
  const n = state.checked.size, busy = state.busy;
  $('listedCount').textContent = `(${state.restaurants.length})`;
  $('archivedCount').textContent = `(${state.archived.length})`;
  const tool = t => document.querySelector(`#editPane [data-tool="${t}"]`);
  tool('all').textContent = `Select all (${items.length})`;
  tool('all').disabled = busy || !items.length || n === items.length;
  tool('none').disabled = busy || !n;
  for (const [t, label, show] of TOOLS) {
    tool(t).hidden = !show();
    tool(t).disabled = busy || !n;
    tool(t).textContent = n ? `${label} (${n})` : label;
  }
  const empty = inArchive ? (state.archived.length ? 'No archived restaurants match.' : 'Nothing archived. Archived restaurants show up here and can be restored.')
    : (state.restaurants.length ? 'No restaurants match.' : 'No restaurants yet.');
  const list = $('editList');
  keepFocus(list, () => {
    list.innerHTML = items.length ? items.map(r => `
    <li class="edit-row${state.checked.has(r.id) ? ' checked' : ''}" data-id="${esc(r.id)}">
      <input type="checkbox" class="check" data-act="check" aria-label="Select ${esc(r.name)}" ${state.checked.has(r.id) ? 'checked' : ''} ${busy ? 'disabled' : ''}>
      <span class="icon small" aria-hidden="true">${iconFor(r.cuisine)}</span>
      <div class="edit-main">
        <p class="name">${esc(r.name)}</p>
        <p class="meta">${inArchive ? `Archived ${esc(new Date(r.archivedAt).toLocaleDateString())}` : r.address ? esc(r.address) : 'Address not available'}</p>
      </div>
      <div class="edit-actions">${inArchive ? '' : editActions(r, busy)}</div>
    </li>`).join('') : `<li class="empty">${empty}</li>`;
  });
}

const editActions = (r, busy) => `
        <button type="button" class="tag" data-act="cuisine" aria-label="Food type: ${esc(r.cuisine)}. Change" ${busy ? 'disabled' : ''}>${esc(r.cuisine)} ✎</button>
        ${!r.enriched && state.config.placesEnabled ? `<button type="button" class="tag" data-act="refresh" title="Look up phone and address again" ${busy ? 'disabled' : ''}>↻ Details</button>` : ''}`;

// Runs one Manage action at a time; everything else is disabled meanwhile.
// Afterwards focus goes back to the control you used, or the nearest one
// still usable, rather than being lost.
async function exclusive(fn) {
  if (state.busy) return;
  const from = document.activeElement;
  state.busy = true;
  renderEditList();
  try { await fn(); } catch (err) { showError(err); } finally {
    state.busy = false;
    renderEditList();
    const a = document.activeElement;
    const lost = !a || a === document.body || a === $('manageDialog') || a.disabled;
    if (lost && $('manageDialog').open && state.loggedIn) {
      const usable = b => b && b.isConnected && !b.disabled && !b.hidden;
      (usable(from) ? from : [...document.querySelectorAll('#editPane .list-tools button')].find(usable) || $('editSearch')).focus();
    }
  }
}

// The food type is edited in place, with suggestions from the existing ones.
// The new value shows at once and the save runs in the background, so the
// rest of the window stays usable (a click that ended the edit still lands).
function editCuisine(row, r) {
  const actions = row.querySelector('.edit-actions');
  actions.innerHTML = `<input class="cuisine-input" data-act="cuisine" list="cuisineOptions" maxlength="40" value="${esc(r.cuisine)}" aria-label="Food type for ${esc(r.name)}">`;
  const input = actions.querySelector('input');
  input.select();
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    const old = r.cuisine, next = input.value.trim();
    if (save && next && next !== old) r.cuisine = next;
    // Only this row changes, so whatever was clicked to end the edit stays put.
    const hadFocus = document.activeElement === input;
    actions.innerHTML = editActions(r, state.busy);
    if (hadFocus) actions.querySelector('[data-act="cuisine"]')?.focus();
    if (r.cuisine === old) return;
    api(restaurantUrl(r.id), { method: 'PATCH', body: JSON.stringify({ cuisine: next }) }).then(updated => {
      // The list may have been reloaded meanwhile; update whichever copy is shown.
      Object.assign(state.restaurants.find(x => x.id === r.id) || r, updated);
      Object.assign(r, updated);
      renderAll();
      setStatus(`Changed ${r.name} to ${r.cuisine}.`);
    }, err => {
      r.cuisine = old;
      renderAll();
      showError(err);
    });
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } // don't close the window
  });
  input.addEventListener('blur', () => finish(true));
}

function onEditClick(e) {
  const tool = e.target.closest('[data-tool]')?.dataset.tool;
  if (tool) return onEditTool(tool);
  const row = e.target.closest('.edit-row');
  if (!row || state.busy || e.target.closest('.cuisine-input')) return;
  const id = row.dataset.id;
  const r = editSource().find(x => x.id === id);
  if (!r) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'cuisine') return editCuisine(row, r);
  if (act === 'refresh') {
    return exclusive(async () => {
      const { restaurant, warning } = await api(restaurantUrl(id, '/refresh'), { method: 'POST' });
      Object.assign(r, restaurant);
      renderAll();
      setStatus(warning || `Updated ${r.name} from Google.`, !!warning);
    });
  }
  // Anywhere else on the row toggles its checkbox.
  if (state.checked.has(id)) state.checked.delete(id); else state.checked.add(id);
  renderEditList();
}

async function onEditTool(tool) {
  if (state.busy) return;
  setStatus('');
  if (tool === 'all' || tool === 'none') {
    if (tool === 'all') editItems().forEach(r => state.checked.add(r.id)); else state.checked.clear();
    renderEditList();
    // The button just used is now disabled; keep focus nearby instead of losing it.
    const a = document.activeElement;
    if (!a || a === document.body || a.disabled) document.querySelector(`#editPane [data-tool="${tool === 'all' ? 'none' : 'all'}"]`).focus();
    return;
  }
  const ids = [...state.checked];
  if (!ids.length) return;
  if (tool === 'refresh') {
    // One Places lookup each, in turn, to pick up ratings and other changes.
    return exclusive(async () => {
      const failed = [];
      for (const [i, id] of ids.entries()) {
        if (!state.loggedIn) return; // login expired: api() already said so
        const r = state.restaurants.find(x => x.id === id);
        if (!r) continue;
        setStatus(`Updating ${i + 1} of ${ids.length}: ${r.name}…`);
        try { Object.assign(r, (await api(restaurantUrl(id, '/refresh'), { method: 'POST' })).restaurant); }
        catch (err) { if (err.handled) return; failed.push(`${r.name}: ${err.message}`); }
      }
      state.checked.clear();
      renderAll();
      const ok = ids.length - failed.length;
      setStatus(`Updated ${plural(ok, 'restaurant')} from Google.` + (failed.length ? ` Failed: ${failed.join('; ')}` : ''), failed.length > 0);
    });
  }
  if (tool === 'purge' && !confirm(`Permanently delete ${plural(ids.length, 'archived restaurant')}? This can't be undone.`)) return;
  return exclusive(async () => {
    const { changed } = await api(`/api/restaurants/${tool}`, { method: 'POST', body: JSON.stringify({ ids }) });
    if (ids.includes(state.selectedId)) { state.selectedId = null; map.info?.close(); }
    state.checked.clear();
    await reloadRestaurants();
    const done = { archive: 'Archived', restore: 'Restored', purge: 'Permanently deleted' }[tool];
    setStatus(`${done} ${plural(changed, 'restaurant')}.` + (tool === 'archive' && changed ? ` Find ${changed === 1 ? 'it' : 'them'} under Archived to restore.` : ''));
  });
}

function onListClick(e) {
  const card = e.target.closest('.card');
  if (!card || e.target.closest('a')) return;
  select(card.dataset.id);
}

// ---- boot ------------------------------------------------------------------

async function init() {
  const dlg = $('manageDialog');
  $('manageBtn').onclick = () => openManage().catch(err => toast(err.message));
  $('manageClose').onclick = $('manageDone').onclick = () => dlg.close();
  // Clicking the dimmed backdrop closes the window; a drag that merely ends
  // there (e.g. selecting text in a field) doesn't.
  let downOnBackdrop = false, upOnBackdrop = false;
  dlg.addEventListener('mousedown', e => { downOnBackdrop = e.target === dlg; });
  dlg.addEventListener('mouseup', e => { upOnBackdrop = e.target === dlg; });
  dlg.addEventListener('click', e => { if (e.target === dlg && downOnBackdrop && upOnBackdrop) dlg.close(); downOnBackdrop = upOnBackdrop = false; });
  $('logoutBtn').onclick = () => logout().catch(err => toast(err.message));
  $('loginView').onsubmit = submitLogin;
  document.querySelectorAll('#manageView [role=tab]').forEach(t => {
    t.onclick = () => { state.manageView = t.dataset.view; renderManage(); };
    t.onkeydown = onTabKey;
  });
  document.querySelectorAll('input[name=addMode]').forEach(r => r.onchange = onAddModeChange);
  $('addForm').onsubmit = submitAdd;
  document.querySelectorAll('input[name=editShow]').forEach(r => r.onchange = () => {
    state.editShow = r.value; state.checked.clear(); setStatus(''); renderEditList();
  });
  $('editSearch').oninput = e => { state.editSearch = e.target.value; renderEditList(); };
  $('editPane').onclick = e => onEditClick(e);
  $('search').oninput = e => { state.search = e.target.value; renderList(); };
  $('cuisineFilter').onchange = e => { state.cuisine = e.target.value; renderList(); fitToVisible(); };
  $('list').onclick = onListClick;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dlg.open) deselect(); });

  [state.config, state.restaurants] = await Promise.all([api('/api/config'), api('/api/restaurants')]);
  useOffice();
  renderAll();
  loadMap();
  locateUser();
}

init().catch(err => { $('list').innerHTML = `<li class="empty">Could not load: ${esc(err.message)}</li>`; });
