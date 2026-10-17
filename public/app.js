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
  manageView: 'add',   // 'add' | 'edit'
  editSearch: '',
  checked: new Set(),  // ids ticked in the Manage list
  archived: [],        // archived restaurants, loaded only when logged in
  editShow: 'listed',  // 'listed' | 'archived'
};
const map = { api: null, instance: null, markers: new Map(), info: null, PinOverlay: null };

const ICONS = {
  Japanese: '🍣', Chinese: '🥟', Korean: '🍲', Thai: '🍜', Vietnamese: '🍜', Indian: '🍛', Italian: '🍝',
  Mexican: '🌮', Pizza: '🍕', Burgers: '🍔', Barbecue: '🍖', Cafe: '☕', Drinks: '🧋', Bakery: '🥐',
  Seafood: '🦐', Steakhouse: '🥩', Sandwiches: '🥪', Vegetarian: '🥗', Breakfast: '🥞', Dessert: '🍨',
  Dumpling: '🥟', Noodles: '🍜', 'Middle Eastern': '🥙', Mediterranean: '🫒', Greek: '🥙', French: '🥖', American: '🍔', 'Fast food': '🍟',
};
const iconFor = c => ICONS[c] || '🍽️';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.loggedIn) { state.loggedIn = false; renderManage(); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
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
  const counts = {};
  for (const r of state.restaurants) counts[r.cuisine] = (counts[r.cuisine] || 0) + 1;
  const names = Object.keys(counts).sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  if (state.cuisine && !counts[state.cuisine]) state.cuisine = '';
  sel.innerHTML = `<option value="">All food types (${state.restaurants.length})</option>` +
    names.map(n => `<option value="${esc(n)}">${iconFor(n)} ${esc(n)} (${counts[n]})</option>`).join('');
  sel.value = state.cuisine;
}

function renderOrigin() {
  const el = $('origin');
  if (!state.origin) { el.textContent = ''; return; }
  if (state.origin.isUser) {
    el.textContent = 'Sorted by distance from your location.';
  } else {
    el.innerHTML = `Sorted by distance from ${esc(state.origin.label)}. <button id="useLoc" type="button">Use my location</button>`;
    $('useLoc').onclick = () => locateUser(true);
  }
}

function renderList() {
  const items = visible();
  const list = $('list');
  if (!items.length) {
    list.innerHTML = `<li class="empty">${state.restaurants.length ? 'No restaurants match.' : 'No restaurants yet. Use “Manage” to add Google Maps links.'}</li>`;
  } else {
    list.innerHTML = items.map(r => `
      <li class="card${r.id === state.selectedId ? ' selected' : ''}" data-id="${esc(r.id)}" tabindex="0">
        <div class="icon" aria-hidden="true">${iconFor(r.cuisine)}</div>
        <div>
          <p class="name">${esc(r.name)}</p>
          <p class="meta">${r.phone ? `📞 <a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>` : '📞 Phone not available'}</p>
          <p class="meta">📍 ${r.address ? esc(r.address) : 'Address not available'}</p>
        </div>
        <div class="side">
          <span>${r.km != null ? formatDistance(r.km) : ''}</span>
          <span class="tag">${esc(r.cuisine)}</span>
        </div>
      </li>`).join('');
  }
  renderMarkers(items);
}

function renderAll() { renderFilterOptions(); renderOrigin(); renderList(); renderEditList(); }

// ---- map -------------------------------------------------------------------

function showMapNotice(html) { const n = $('mapNotice'); n.innerHTML = html; n.hidden = false; }

function loadMap() {
  const key = state.config.browserKey;
  if (!key) {
    showMapNotice('<div><b>Map not configured.</b><br>Set GOOGLE_MAPS_API_KEY in .env and restart the server.<br>The list on the left still works.</div>');
    return;
  }
  window.gm_authFailure = () => showMapNotice(`<div><b>Google rejected the Maps API key.</b><br>
    Check that billing and Maps JavaScript API are enabled, and that the key's Websites restriction includes
    <code>${esc(location.origin)}</code>. The browser console (F12) names the exact error.</div>`);
  window.__initMap = () => initMap().catch(err => {
    console.error(err);
    showMapNotice(`<div><b>The map failed to start.</b><br>${esc(err.message)}</div>`);
  });
  const s = document.createElement('script');
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__initMap`;
  s.async = true;
  s.onerror = () => showMapNotice('<div>Could not load Google Maps. Check your connection.</div>');
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
      const p = this.getProjection().fromLatLngToDivPixel(this.position);
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
      const el = pinElement(r.name);
      const open = e => { e.stopPropagation(); select(r.id, { fromMap: true }); };
      el.addEventListener('click', open);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(e); });
      m = new map.PinOverlay(new map.api.LatLng(r.lat, r.lng), el);
      map.markers.set(r.id, m);
    }
    if (!m.getMap()) m.setMap(map.instance);
    const selected = r.id === state.selectedId;
    m.el.querySelector('.pin-glyph').textContent = iconFor(r.cuisine);
    m.el.classList.toggle('selected', selected);
    m.el.style.zIndex = selected ? 1000 : Math.round(1000 - r.lat * 10); // southern pins in front
  }
}

// A teardrop pin with the food-type icon in a white circle. CSS shifts it so
// the tip sits on the restaurant's location.
function pinElement(name) {
  const el = document.createElement('div');
  el.className = 'pin';
  el.title = name;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', name);
  el.innerHTML = `<svg viewBox="0 0 40 50" aria-hidden="true"><path d="M20 49C20 49 2 30.5 2 19a18 18 0 0 1 36 0C38 30.5 20 49 20 49z"/><circle cx="20" cy="19" r="12.5"/></svg><span class="pin-glyph"></span>`;
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
  map.info.setContent(`<div class="info"><h3>${esc(r.name)}</h3>${r.phone ? `<p>${esc(r.phone)}</p>` : ''}${r.address ? `<p>${esc(r.address)}</p>` : ''}<p><a href="${esc(r.mapsUrl)}" target="_blank" rel="noopener">Open in Google Maps</a></p></div>`);
  map.info.setPosition(latLng(r));
  map.info.open({ map: map.instance });
}

// ---- location --------------------------------------------------------------

function useOffice() {
  const o = state.config.office;
  state.origin = { lat: o.lat, lng: o.lng, label: o.name, isUser: false };
}

function locateUser(explicit = false) {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(pos => {
    state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'your location', isUser: true };
    renderAll();
  }, err => {
    if (explicit) alert(err.code === 1 ? 'Location permission was denied. Using the office location.' : 'Could not get your location.');
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

async function openManage() {
  $('toast').hidden = true;
  $('addResults').innerHTML = '';
  $('editStatus').textContent = '';
  $('loginError').textContent = '';
  const session = await api('/api/auth/session');
  state.loggedIn = session.loggedIn;
  state.passwordSet = session.passwordSet;
  if (state.loggedIn) await loadArchived();
  renderManage();
  $('manageDialog').showModal();
  (state.loggedIn ? (state.manageView === 'add' ? currentAddInput() : $('editSearch')) : $('password')).focus();
}

function renderManage() {
  $('loginView').hidden = state.loggedIn;
  $('manageView').hidden = !state.loggedIn;
  $('logoutBtn').hidden = !state.loggedIn;
  $('password').disabled = $('loginSubmit').disabled = !state.passwordSet;
  $('loginHint').innerHTML = state.passwordSet
    ? 'Enter the admin password to add, edit or archive restaurants.'
    : 'No admin password is set yet. On the server, run <code>npm run set-password</code> (or <code>nasc-food set-password</code>), then restart it.';
  document.querySelectorAll('#manageView .tab').forEach(t => {
    const on = t.dataset.view === state.manageView;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  });
  $('addPane').hidden = state.manageView !== 'add';
  $('editPane').hidden = state.manageView !== 'edit';
  renderEditList();
}

async function submitLogin(e) {
  e.preventDefault();
  $('loginSubmit').disabled = true;
  $('loginError').textContent = '';
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    state.loggedIn = true;
    $('password').value = '';
    await loadArchived();
    renderManage();
    currentAddInput().focus();
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
    const added = results.filter(r => r.status === 'added');
    const failed = results.filter(r => r.status === 'error');
    const restored = results.filter(r => r.status === 'restored');
    if (added.length || restored.length) {
      [state.restaurants] = await Promise.all([api('/api/restaurants'), loadArchived()]);
      renderAll();
    }
    // Stay open so more can be added; the result shows here and the map updates behind.
    const warning = added.find(r => r.warning)?.warning;
    out.innerHTML = results.map(r => {
      if (r.status === 'added') return `<li class="added">✓ Added ${esc(r.restaurant.name)}</li>`;
      if (r.status === 'restored') return `<li class="added">✓ Restored from the archive: ${esc(r.restaurant.name)}</li>`;
      if (r.status === 'duplicate') return `<li class="duplicate">• Already listed: ${esc(r.restaurant.name)}</li>`;
      if (r.status === 'skipped') return `<li class="duplicate">• Skipped ${esc(r.url)}: not a Google Maps link</li>`;
      return `<li class="error">✕ ${esc(r.url)}: ${esc(r.error)}</li>`;
    }).join('') + (warning ? `<li class="duplicate">${esc(warning)}</li>` : '');
    input.value = failed.length && addMode() === 'bulk' ? failed.map(r => r.url).join('\n') : failed.length ? input.value : '';
    input.focus();
    if (added.length || restored.length) fitToVisible();
  } catch (err) {
    out.innerHTML = `<li class="error">✕ ${esc(err.message)}</li>`;
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

async function loadArchived() {
  state.archived = await api('/api/restaurants/archived');
}

function renderEditList() {
  if (!$('editList')) return;
  const items = editItems();
  const inArchive = state.editShow === 'archived';
  // Only rows you can see stay ticked, so an action never hits something
  // hidden by the search or the other view.
  const shown = new Set(items.map(r => r.id));
  for (const id of state.checked) if (!shown.has(id)) state.checked.delete(id);
  const n = state.checked.size;
  $('editCount').textContent = `(${state.restaurants.length})`;
  $('listedCount').textContent = `(${state.restaurants.length})`;
  $('archivedCount').textContent = `(${state.archived.length})`;
  const tool = t => document.querySelector(`#editPane [data-tool="${t}"]`);
  tool('all').textContent = `Select all (${items.length})`;
  tool('all').disabled = !items.length || n === items.length;
  tool('none').disabled = !n;
  for (const [t, label, show] of [['archive', 'Archive', !inArchive], ['restore', 'Restore', inArchive], ['purge', 'Delete forever', inArchive]]) {
    tool(t).hidden = !show;
    tool(t).disabled = !n;
    tool(t).textContent = n ? `${label} (${n})` : label;
  }
  const empty = inArchive ? (state.archived.length ? 'No archived restaurants match.' : 'Nothing archived. Archived restaurants show up here and can be restored.')
    : (state.restaurants.length ? 'No restaurants match.' : 'No restaurants yet.');
  $('editList').innerHTML = items.length ? items.map(r => `
    <li class="edit-row${state.checked.has(r.id) ? ' checked' : ''}" data-id="${esc(r.id)}">
      <input type="checkbox" class="check" data-act="check" aria-label="Select ${esc(r.name)}" ${state.checked.has(r.id) ? 'checked' : ''}>
      <span class="icon small" aria-hidden="true">${iconFor(r.cuisine)}</span>
      <div class="edit-main">
        <p class="name">${esc(r.name)}</p>
        <p class="meta">${inArchive ? `Archived ${esc(new Date(r.archivedAt).toLocaleDateString())}` : r.address ? esc(r.address) : 'Address not available'}</p>
      </div>
      <div class="edit-actions">${inArchive ? '' : `
        <button type="button" class="tag" data-act="cuisine" title="Change food type">${esc(r.cuisine)} ✎</button>
        ${!r.enriched && state.config.placesEnabled ? '<button type="button" class="tag" data-act="refresh" title="Look up phone and address again">↻ Details</button>' : ''}`}
      </div>
    </li>`).join('') : `<li class="empty">${empty}</li>`;
}

async function onEditClick(e) {
  const tool = e.target.closest('[data-tool]')?.dataset.tool;
  if (tool) return onEditTool(tool);
  const row = e.target.closest('.edit-row');
  if (!row) return;
  const id = row.dataset.id;
  const r = editSource().find(x => x.id === id);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'cuisine') {
    const next = prompt(`Food type for ${r.name}:`, r.cuisine);
    if (next && next.trim() && next.trim() !== r.cuisine) {
      Object.assign(r, await api(`/api/restaurants/${id}`, { method: 'PATCH', body: JSON.stringify({ cuisine: next }) }));
      renderAll();
    }
    return;
  }
  if (act === 'refresh') {
    const { restaurant, warning } = await api(`/api/restaurants/${id}/refresh`, { method: 'POST' });
    Object.assign(r, restaurant);
    renderAll();
    if (warning) alert(warning);
    return;
  }
  // Anywhere else on the row toggles its checkbox.
  if (state.checked.has(id)) state.checked.delete(id); else state.checked.add(id);
  renderEditList();
}

async function onEditTool(tool) {
  $('editStatus').textContent = '';
  if (tool === 'all') editItems().forEach(r => state.checked.add(r.id));
  if (tool === 'none') state.checked.clear();
  if (tool === 'archive' || tool === 'restore' || tool === 'purge') {
    const n = state.checked.size, s = n === 1 ? '' : 's';
    if (tool === 'purge' && !confirm(`Permanently delete ${n} archived restaurant${s}? This can't be undone.`)) return;
    const ids = [...state.checked];
    const { changed } = await api(`/api/restaurants/${tool}`, { method: 'POST', body: JSON.stringify({ ids }) });
    if (ids.includes(state.selectedId)) { state.selectedId = null; map.info?.close(); }
    state.checked.clear();
    [state.restaurants] = await Promise.all([api('/api/restaurants'), loadArchived()]);
    renderAll();
    const done = { archive: 'Archived', restore: 'Restored', purge: 'Permanently deleted' }[tool];
    $('editStatus').textContent = `${done} ${changed} restaurant${changed === 1 ? '' : 's'}.` +
      (tool === 'archive' ? ` Find ${changed === 1 ? 'it' : 'them'} under Archived to restore.` : '');
    return;
  }
  renderEditList();
}

function onListClick(e) {
  const card = e.target.closest('.card');
  if (!card || e.target.closest('a')) return;
  select(card.dataset.id);
}

// ---- boot ------------------------------------------------------------------

async function init() {
  const dlg = $('manageDialog');
  $('manageBtn').onclick = () => openManage().catch(err => alert(err.message));
  $('manageClose').onclick = $('manageDone').onclick = () => dlg.close();
  // Clicking the dimmed backdrop (the dialog element itself) closes it.
  dlg.addEventListener('click', e => { if (e.target === e.currentTarget) dlg.close(); });
  $('logoutBtn').onclick = () => logout().catch(err => alert(err.message));
  $('loginView').onsubmit = submitLogin;
  document.querySelectorAll('#manageView .tab').forEach(t => t.onclick = () => { state.manageView = t.dataset.view; renderManage(); });
  document.querySelectorAll('input[name=addMode]').forEach(r => r.onchange = onAddModeChange);
  $('addForm').onsubmit = submitAdd;
  document.querySelectorAll('input[name=editShow]').forEach(r => r.onchange = () => {
    state.editShow = r.value; state.checked.clear(); $('editStatus').textContent = ''; renderEditList();
  });
  $('editSearch').oninput = e => { state.editSearch = e.target.value; renderEditList(); };
  $('editPane').onclick = e => onEditClick(e).catch(err => alert(err.message));
  $('search').oninput = e => { state.search = e.target.value; renderList(); };
  $('cuisineFilter').onchange = e => { state.cuisine = e.target.value; renderList(); fitToVisible(); };
  $('list').onclick = onListClick;
  $('list').onkeydown = e => { if (e.key === 'Enter' && e.target.classList.contains('card')) select(e.target.dataset.id); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dlg.open) deselect(); });

  [state.config, state.restaurants] = await Promise.all([api('/api/config'), api('/api/restaurants')]);
  useOffice();
  renderAll();
  loadMap();
  locateUser();
}

init().catch(err => { $('list').innerHTML = `<li class="empty">Could not load: ${esc(err.message)}</li>`; });
