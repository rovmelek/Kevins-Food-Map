'use strict';
// NASC Food front end: left panel (add, search, filter, cards) + right map.

const state = {
  restaurants: [],
  config: null,
  origin: null,        // { lat, lng, label, isUser }
  search: '',
  cuisine: '',
  selectedId: null,
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
    list.innerHTML = `<li class="empty">${state.restaurants.length ? 'No restaurants match.' : 'No restaurants yet. Use “+ Add” to paste Google Maps links.'}</li>`;
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
          <button class="tag" data-act="cuisine" title="Change food type">${esc(r.cuisine)}</button>
          ${!r.enriched && state.config.placesEnabled ? '<button class="tag" data-act="refresh" title="Look up phone and address again">↻ Details</button>' : ''}
          <button class="del" data-act="delete" title="Remove" aria-label="Remove ${esc(r.name)}">✕</button>
        </div>
      </li>`).join('');
  }
  renderMarkers(items);
}

function renderAll() { renderFilterOptions(); renderOrigin(); renderList(); }

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
    onAdd() { this.getPanes().overlayMouseTarget.appendChild(this.el); }
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

function select(id, { fromMap = false } = {}) {
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

// ---- add / edit / delete ---------------------------------------------------

let addMode = 'single';
function setMode(mode) {
  addMode = mode;
  document.querySelectorAll('.tab').forEach(t => { const on = t.dataset.mode === mode; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  $('singleInput').hidden = mode !== 'single';
  $('bulkInput').hidden = mode !== 'bulk';
  (mode === 'single' ? $('singleInput') : $('bulkInput')).focus();
}

async function submitAdd(e) {
  e.preventDefault();
  const text = addMode === 'single' ? $('singleInput').value : $('bulkInput').value;
  const out = $('addResults');
  if (!text.trim()) return;
  $('addSubmit').disabled = true;
  out.innerHTML = '<li>Looking up places…</li>';
  try {
    const { results } = await api('/api/restaurants', { method: 'POST', body: JSON.stringify({ text }) });
    out.innerHTML = results.map(r => {
      if (r.status === 'added') return `<li class="added">✓ Added ${esc(r.restaurant.name)}${r.warning ? ` (${esc(r.warning)})` : ''}</li>`;
      if (r.status === 'duplicate') return `<li class="duplicate">• Already listed: ${esc(r.restaurant.name)}</li>`;
      return `<li class="error">✕ ${esc(r.url)}: ${esc(r.error)}</li>`;
    }).join('');
    if (results.some(r => r.status === 'added')) {
      state.restaurants = await api('/api/restaurants');
      if (addMode === 'single') $('singleInput').value = '';
      else $('bulkInput').value = '';
      renderAll();
      fitToVisible();
    }
  } catch (err) {
    out.innerHTML = `<li class="error">✕ ${esc(err.message)}</li>`;
  } finally {
    $('addSubmit').disabled = false;
  }
}

async function onListClick(e) {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  const r = state.restaurants.find(x => x.id === id);
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
  if (act === 'delete') {
    if (!confirm(`Remove ${r.name} from the list?`)) return;
    await api(`/api/restaurants/${id}`, { method: 'DELETE' });
    state.restaurants = state.restaurants.filter(x => x.id !== id);
    if (state.selectedId === id) { state.selectedId = null; map.info?.close(); }
    renderAll();
    return;
  }
  select(id);
}

// ---- boot ------------------------------------------------------------------

async function init() {
  $('addToggle').onclick = () => {
    const p = $('addPanel'); p.hidden = !p.hidden;
    $('addToggle').setAttribute('aria-expanded', String(!p.hidden));
    if (!p.hidden) setMode(addMode);
  };
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => setMode(t.dataset.mode));
  $('addForm').onsubmit = submitAdd;
  $('search').oninput = e => { state.search = e.target.value; renderList(); };
  $('cuisineFilter').onchange = e => { state.cuisine = e.target.value; renderList(); fitToVisible(); };
  $('list').onclick = e => onListClick(e).catch(err => alert(err.message));
  $('list').onkeydown = e => { if (e.key === 'Enter' && e.target.classList.contains('card')) select(e.target.dataset.id); };

  [state.config, state.restaurants] = await Promise.all([api('/api/config'), api('/api/restaurants')]);
  useOffice();
  renderAll();
  loadMap();
  locateUser();
}

init().catch(err => { $('list').innerHTML = `<li class="empty">Could not load: ${esc(err.message)}</li>`; });
