import * as api from './api.js';
import { fetchLinkPreview } from './linkPreview.js';
import {
  CARD_TYPES, CARD_OPPORTUNITIES, SUGGESTED_TAGS, QUICK_FILTERS,
  escapeHtml, timeAgo, formatDateRange,
} from './config.js';

// ============================================================
// State
// ============================================================
const state = {
  trip: null,
  destinations: [],
  cardPins: [],         // every located card across all destinations (for the catalogue map)
  destination: null,    // currently open destination
  cards: [],            // all cards for the open destination
  view: 'catalogue',    // 'catalogue' | 'destination'
  catView: 'tiles',     // 'tiles' | 'map'   (catalogue)
  catMapLayer: 'favs',  // 'dest' | 'favs' | 'all'
  destView: 'map',      // 'browse' | 'grid' | 'map'
  browseIndex: 0,
  filter: 'all',
  opportunity: 'all',
  activeTags: new Set(),
  tagsOpen: false,
  query: '',
  dismissedInsights: JSON.parse(localStorage.getItem('rolodex_dismissed_insights') || '[]'),
  whoami: localStorage.getItem('rolodex_whoami') || '',
  leafletMap: null,     // destination map
  catMap: null,         // catalogue map
  selectedMapCard: null,
  selectedGridCard: null,
};

const app = document.getElementById('app');

// ============================================================
// Boot
// ============================================================
async function boot() {
  if (!api.isConfigured()) {
    renderConfigNeeded();
    return;
  }

  if (!state.whoami) {
    state.whoami = promptWhoAmI();
  }

  renderShell();
  await loadCatalogue();
}

function promptWhoAmI() {
  const name = window.prompt("What's your name? (shown on cards you add — you can change this later)", 'Joss') || 'Joss';
  localStorage.setItem('rolodex_whoami', name);
  return name;
}

function renderConfigNeeded() {
  app.innerHTML = `
    <main style="max-width:560px; margin:80px auto; text-align:center;">
      <div style="font-size:38px; margin-bottom:12px;">🗂️</div>
      <h1 style="font-family:var(--font-display); font-size:26px; margin:0 0 12px;">Almost there</h1>
      <p style="color:var(--ink-soft); line-height:1.6;">
        Add your Supabase project URL and anon key to <code>js/config.js</code>, run
        <code>schema.sql</code> in your Supabase SQL editor, then reload this page.
        See <code>README.md</code> for the full setup steps.
      </p>
    </main>`;
}

// ============================================================
// Shell (topbar stays constant, main content swaps)
// ============================================================
function renderShell() {
  app.innerHTML = `
    <div class="topbar">
      <div class="brand" id="brand-home"><span class="mark">✦</span> Traveldex</div>
      <button class="whoami" id="whoami-btn">${escapeHtml(state.whoami)}</button>
    </div>
    <main id="main"></main>
  `;
  document.getElementById('brand-home').addEventListener('click', () => goToCatalogue());
  document.getElementById('whoami-btn').addEventListener('click', () => {
    const name = window.prompt('Your name:', state.whoami);
    if (name) { state.whoami = name; localStorage.setItem('rolodex_whoami', name); renderTopbar(); }
  });
}

function renderTopbar() {
  const who = document.getElementById('whoami-btn');
  if (who) who.textContent = state.whoami;
}

// ============================================================
// Catalogue view
// ============================================================
async function loadCatalogue() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="empty-state"><div class="glyph">✦</div><p>Loading your journey…</p></div>`;
  try {
    state.trip = await api.fetchTrip();
    if (!state.trip) {
      main.innerHTML = `
        <div class="empty-state">
          <div class="glyph">🗺️</div>
          <h3>No trip yet</h3>
          <p>Run <code>seed-portugal.sql</code> in Supabase to try the prototype, or create a trip row directly in the trips table.</p>
        </div>`;
      return;
    }
    state.destinations = await api.fetchDestinations(state.trip.id);
    state.cardPins = await fetchPinsSafe();
  } catch (err) {
    main.innerHTML = errorBlock(err);
    return;
  }
  renderCatalogue();
}

// Pins are a nice-to-have — never let a pin failure block the catalogue.
async function fetchPinsSafe() {
  try {
    return await api.fetchCardPins(state.destinations.map(d => d.id));
  } catch (err) {
    console.error(err);
    return [];
  }
}

// Quietly re-fetch counts and pins (e.g. after adding cards) and only
// re-render if something actually changed.
async function refreshCatalogueData() {
  if (!state.trip) return;
  try {
    const before = JSON.stringify([state.destinations, state.cardPins]);
    const destinations = await api.fetchDestinations(state.trip.id);
    const pins = await api.fetchCardPins(destinations.map(d => d.id));
    if (JSON.stringify([destinations, pins]) === before) return;
    state.destinations = destinations;
    state.cardPins = pins;
    if (state.view === 'catalogue') renderCatalogue();
  } catch (err) {
    console.error(err);
  }
}

function destroyDestMap() {
  if (state.leafletMap) { state.leafletMap.remove(); state.leafletMap = null; }
}

function destroyCatMap() {
  if (state.catMap) { state.catMap.remove(); state.catMap = null; }
}

function showCatalogue() {
  state.view = 'catalogue';
  destroyDestMap();
  renderCatalogue();
  refreshCatalogueData();
}

function goToCatalogue() {
  history.pushState({ view: 'catalogue' }, '', '#');
  showCatalogue();
}

// Where a destination's pin goes: its own lat/lng if set, otherwise the
// average position of its located cards, otherwise nowhere.
function destinationLatLng(d) {
  if (d.lat != null && d.lng != null) return [Number(d.lat), Number(d.lng)];
  const pins = state.cardPins.filter(p => p.destination_id === d.id);
  if (!pins.length) return null;
  const lat = pins.reduce((s, p) => s + Number(p.lat), 0) / pins.length;
  const lng = pins.reduce((s, p) => s + Number(p.lng), 0) / pins.length;
  return [lat, lng];
}

function renderCatalogue() {
  destroyCatMap();

  const totalCards = state.destinations.reduce((sum, d) => sum + (d.rolodex_cards?.[0]?.count || 0), 0);
  const totalDays = state.destinations.reduce((sum, d) => sum + (d.planned_days || 0), 0);

  const main = document.getElementById('main');
  const header = `
    <div class="catalogue-header">
      <div>
        <p class="eyebrow">Our journey</p>
        <h1>${escapeHtml(state.trip.name)}</h1>
        <p class="sub">${state.destinations.length} destinations · ${totalCards} things saved${totalDays ? ' · ' + totalDays + ' days planned' : ''}</p>
      </div>
      <div class="seg" role="tablist" aria-label="Destinations view">
        <button class="seg-btn ${state.catView === 'tiles' ? 'active' : ''}" data-catview="tiles"><span class="ic">▦</span><span class="lbl">Tiles</span></button>
        <button class="seg-btn ${state.catView === 'map' ? 'active' : ''}" data-catview="map"><span class="ic">🌍</span><span class="lbl">Map</span></button>
      </div>
    </div>`;

  if (state.catView === 'map') {
    const unmapped = state.destinations.filter(d => !destinationLatLng(d)).length;
    const layers = [
      { id: 'dest', label: 'Destinations' },
      { id: 'favs', label: 'Favourites & must-dos' },
      { id: 'all',  label: 'All ideas' },
    ];
    main.innerHTML = `
      ${header}
      <div class="cat-map-bar">
        <div class="chip-scroll">
          ${layers.map(l => `<button class="chip ${state.catMapLayer === l.id ? 'active' : ''}" data-layer="${l.id}">${l.label}</button>`).join('')}
        </div>
        ${unmapped ? `<span class="cat-map-note">${unmapped} destination${unmapped === 1 ? '' : 's'} not on the map yet — add a location via ✎ Edit</span>` : ''}
        <button class="tbtn" id="add-dest-map">+ Add destination</button>
      </div>
      <div class="cat-map-wrap"><div id="cat-map"></div></div>
    `;
    document.getElementById('add-dest-map').addEventListener('click', openAddDestinationSheet);
    main.querySelectorAll('[data-layer]').forEach(el => {
      el.addEventListener('click', () => { state.catMapLayer = el.dataset.layer; renderCatalogue(); });
    });
    renderCatalogueMap();
  } else {
    const tiles = state.destinations.map(d => `
      <div class="dest-tile" data-id="${d.id}">
        <div class="tile-tab">${d.rolodex_cards?.[0]?.count || 0} saved</div>

        <div
          class="tile-image"
          ${d.cover_image
            ? `style="background-image: url('${escapeHtml(d.cover_image)}')"`
            : ''}
        >
          ${!d.cover_image ? `<span>${d.flag || '✦'}</span>` : ''}
        </div>

        <div class="tile-body">
          <h3>${escapeHtml(d.name)}</h3>
          <p class="tile-meta">
            ${formatDateRange(d.planned_start, d.planned_end)}
            ${d.planned_days ? ' · ' + d.planned_days + ' days' : ''}
          </p>
          <p class="tile-desc">${escapeHtml(d.short_description || '')}</p>
        </div>
      </div>
    `).join('');

    main.innerHTML = `
      ${header}
      <div class="dest-grid">
        ${tiles}
        <button class="add-dest-tile" id="add-dest">
          <span class="plus">+</span>
          <span>Add a destination</span>
        </button>
      </div>
    `;

    main.querySelectorAll('.dest-tile').forEach(tile => {
      tile.addEventListener('click', () => openDestination(tile.dataset.id));
    });
    document.getElementById('add-dest').addEventListener('click', openAddDestinationSheet);
  }

  main.querySelectorAll('[data-catview]').forEach(el => {
    el.addEventListener('click', () => {
      state.catView = el.dataset.catview;
      renderCatalogue();
    });
  });
}

// ---------- Catalogue map ----------
const PIN_COLOURS = { must_do: '#FF5B45', favourite: '#E0527A', other: '#7D8A96' };

function renderCatalogueMap() {
  const el = document.getElementById('cat-map');
  if (!el || !window.L) return;

  const map = L.map(el, { scrollWheelZoom: true, worldCopyJump: true });
  state.catMap = map;

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_4mve_1_9f1f0f7d045dfba544a094b3',
    { attribution: '© OpenStreetMap, © CARTO', maxZoom: 19 }
  ).addTo(map);

  const bounds = [];
  const destById = Object.fromEntries(state.destinations.map(d => [d.id, d]));

  // Card dots first, so destination labels sit on top
  if (state.catMapLayer !== 'dest') {
    const pins = state.cardPins.filter(p => {
      if (p.status === 'not_for_us') return false;
      if (state.catMapLayer === 'favs') return p.status === 'favourite' || p.status === 'must_do';
      return true;
    });

    pins.forEach(p => {
      const colour = PIN_COLOURS[p.status] || PIN_COLOURS.other;
      const dest = destById[p.destination_id];
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: 6, weight: 2, color: '#fff', fillColor: colour, fillOpacity: 0.95,
      }).addTo(map);

      const statusInfo = CARD_STATUSES[p.status];
      marker.bindPopup(`
        <strong>${escapeHtml(p.title)}</strong><br>
        <small>${dest ? escapeHtml((dest.flag || '') + ' ' + dest.name) : ''}${statusInfo && p.status !== 'new' ? ' · ' + statusInfo.icon + ' ' + escapeHtml(statusInfo.label) : ''}</small><br>
        <button class="tbtn map-pop-btn" data-open-dest="${p.destination_id}" data-open-card="${p.id}">Open ↗</button>
      `);
      marker.on('popupopen', e => {
        const btn = e.popup.getElement()?.querySelector('[data-open-dest]');
        if (btn) btn.addEventListener('click', () => openDestination(btn.dataset.openDest, btn.dataset.openCard));
      });

      bounds.push([p.lat, p.lng]);
    });
  }

  // Destination pins
  state.destinations.forEach(d => {
    const pos = destinationLatLng(d);
    if (!pos) return;
    const count = d.rolodex_cards?.[0]?.count || 0;

    const marker = L.marker(pos, {
      icon: L.divIcon({
        className: 'dest-pin-wrap',
        html: `<div class="dest-pin">
                 <span class="dp-flag">${d.flag || '✦'}</span>
                 <span class="dp-name">${escapeHtml(d.name)}</span>
                 <span class="dp-count">${count}</span>
               </div>`,
        iconSize: [0, 0],
      }),
      title: d.name,
      keyboard: true,
    }).addTo(map);

    marker.on('click', () => openDestination(d.id));
    bounds.push(pos);
  });

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 6 });
  } else {
    map.setView([20, 10], 2);
  }
}

function errorBlock(err) {
  console.error(err);
  return `
    <div class="empty-state">
      <div class="glyph">⚠️</div>
      <h3>Something went wrong</h3>
      <p>${escapeHtml(err.message || String(err))}</p>
    </div>`;
}

// ============================================================
// Destination view
// ============================================================
async function openDestination(id, focusCardId = null) {
  state.view = 'destination';
  state.destView = 'map';
  state.browseIndex = 0;
  state.filter = 'all';
  state.opportunity = 'all';
  state.activeTags = new Set();
  state.tagsOpen = false;
  state.query = '';
  state.selectedMapCard = null;
  state.selectedGridCard = null;
  destroyCatMap();
  if (location.hash !== `#${id}`) history.pushState({ view: 'destination', id }, '', `#${id}`);

  const main = document.getElementById('main');
  main.innerHTML = `<div class="empty-state"><div class="glyph">✦</div><p>Opening…</p></div>`;

  try {
    state.destination = await api.fetchDestination(id);
    state.cards = await api.fetchCards(id);
  } catch (err) {
    main.innerHTML = errorBlock(err);
    return;
  }

  // Arriving from a pin on the catalogue map: land on that card
  if (focusCardId) {
    state.selectedMapCard = state.cards.find(c => c.id === focusCardId) || null;
  }
  renderDestination();
}

function getFilteredCards() {
  let list = [...state.cards];
  const f = QUICK_FILTERS.find(f => f.id === state.filter);
  if (f && f.id !== 'all') {
    if (f.type) list = list.filter(c => c.type === f.type);
    if (f.typeIn) list = list.filter(c => f.typeIn.includes(c.type));
  }
  if (state.opportunity !== 'all') {
    list = list.filter(c => c.opportunity === state.opportunity);
  }
  if (state.activeTags.size > 0) {
    list = list.filter(c => c.tags?.some(t => state.activeTags.has(t)));
  }
  if (state.query.trim()) {
    const q = state.query.trim().toLowerCase();
    list = list.filter(c =>
      c.title?.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.note?.toLowerCase().includes(q) ||
      c.location_name?.toLowerCase().includes(q) ||
      c.tags?.some(t => t.toLowerCase().includes(q))
    );
  }
  return list;
}

function computeInsights() {
  // Emergent themes: surface tag clusters and location-name clusters
  // that have crossed a small threshold, if not already dismissed.
  const insights = [];
  const locCounts = {};
  state.cards.forEach(c => {
    if (c.location_name) {
      const key = c.location_name.split(',')[0].trim();
      locCounts[key] = (locCounts[key] || 0) + 1;
    }
  });
  Object.entries(locCounts).forEach(([loc, count]) => {
    if (count >= 3) {
      const id = `loc:${loc}`;
      if (!state.dismissedInsights.includes(id)) {
        insights.push({ id, text: `You're developing a thing for <strong>${escapeHtml(loc)}</strong>. ${count} saved ideas.` });
      }
    }
  });
  return insights.slice(0, 1); // one at a time — quiet, not nagging
}

function renderDestination() {
  const d = state.destination;
  const allTags = [...new Set(state.cards.flatMap(c => c.tags || []))].sort();
  const insights = computeInsights();
  const tagCount = state.activeTags.size;
  const newCount = state.cards.filter(c => c.status === 'new').length;

  const views = [
    { id: 'map',    icon: '📍', label: 'Map' },
    { id: 'grid',   icon: '▦',  label: 'Grid' },
    { id: 'browse', icon: '🗂️', label: 'Browse' },
  ];

  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="dest-bar">
      <div class="dest-bar-left">
        <button class="icon-btn sm" id="back-btn" title="All destinations" aria-label="Back to all destinations">←</button>
        <span class="flag">${d.flag || '✦'}</span>
        <h1>${escapeHtml(d.name)}</h1>
        <span class="count">${state.cards.length} saved</span>
        <button class="icon-btn sm" id="edit-destination" title="Edit destination" aria-label="Edit destination">✎</button>
      </div>

      <div class="dest-bar-right">
        ${newCount ? `
          <button class="tbtn accent" id="triage-btn" title="Sort new ideas">
            <span class="ic">✨</span><span class="lbl">Sort new</span><span class="count-badge">${newCount}</span>
          </button>` : ''}
        <div class="seg" role="tablist" aria-label="View">
          ${views.map(v => `
            <button class="seg-btn ${state.destView === v.id ? 'active' : ''}" data-destview="${v.id}" title="${v.label}">
              <span class="ic">${v.icon}</span><span class="lbl">${v.label}</span>
            </button>`).join('')}
        </div>
        <button class="tbtn" id="surprise-btn" title="Surprise me"><span class="ic">🎲</span><span class="lbl">Surprise me</span></button>
      </div>
    </div>

    <div class="filter-row compact">
      <div class="chip-scroll">
        ${QUICK_FILTERS.map(f => `<button class="chip ${state.filter === f.id ? 'active' : ''}" data-filter="${f.id}">${f.label}</button>`).join('')}
      </div>

      ${allTags.length ? `
        <button class="chip tags-toggle ${state.tagsOpen ? 'open' : ''} ${tagCount ? 'has-active' : ''}" id="tags-toggle" aria-expanded="${state.tagsOpen ? 'true' : 'false'}">
          # Tags${tagCount ? ` <span class="badge">${tagCount}</span>` : ''} <span class="caret">${state.tagsOpen ? '▴' : '▾'}</span>
        </button>` : ''}

      <div class="search-box">
        <span class="search-ic">⌕</span>
        <input type="text" id="search-input" placeholder="Search…" value="${escapeHtml(state.query)}" />
      </div>
    </div>

    <div class="opp-filter-row">
      <button class="chip ${state.opportunity === 'all' ? 'active' : ''}" data-opp="all">Any opportunity</button>
      ${Object.entries(CARD_OPPORTUNITIES).map(([k, v]) =>
        `<button class="chip ${state.opportunity === k ? 'active' : ''}" data-opp="${k}">${v.icon} ${v.label}</button>`
      ).join('')}
    </div>

    ${allTags.length && state.tagsOpen ? `
      <div class="tag-filter-row">
        ${allTags.map(t => `<button class="chip tag ${state.activeTags.has(t) ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
        ${tagCount ? `<button class="chip clear-tags" id="clear-tags">Clear</button>` : ''}
      </div>` : ''}

    ${insights.length ? `
      <div class="insight-banner slim" data-insight="${insights[0].id}">
        <span>${insights[0].text}</span>
        <button class="dismiss" data-dismiss="${insights[0].id}" aria-label="Dismiss">✕</button>
      </div>` : ''}

    <div id="dest-content"></div>
  `;

  document.getElementById('edit-destination').addEventListener('click', openEditDestinationSheet);
  document.getElementById('back-btn').addEventListener('click', goToCatalogue);
  document.getElementById('surprise-btn').addEventListener('click', () => surpriseMe());

  const triageBtn = document.getElementById('triage-btn');
  if (triageBtn) triageBtn.addEventListener('click', openTriage);

  // View switcher. Keeps the selected card when moving between grid and map,
  // clears it when going to Browse.
  main.querySelectorAll('[data-opp]').forEach(el => {
    el.addEventListener('click', () => { state.opportunity = el.dataset.opp; renderDestination(); });
  });
  
  main.querySelectorAll('[data-destview]').forEach(el => {
    el.addEventListener('click', () => {
      state.destView = el.dataset.destview;

      if (state.destView === 'grid' && state.selectedMapCard) {
        state.selectedGridCard = state.selectedMapCard;
      }
      if (state.destView === 'map' && state.selectedGridCard) {
        state.selectedMapCard = state.selectedGridCard;
      }
      if (state.destView === 'browse') {
        state.selectedGridCard = null;
        state.selectedMapCard = null;
      }

      renderDestination();
    });
  });

  main.querySelectorAll('[data-filter]').forEach(el => {
    el.addEventListener('click', () => { state.filter = el.dataset.filter; renderDestination(); });
  });

  const tagsToggle = document.getElementById('tags-toggle');
  if (tagsToggle) tagsToggle.addEventListener('click', () => {
    state.tagsOpen = !state.tagsOpen;
    renderDestination();
  });

  main.querySelectorAll('[data-tag]').forEach(el => {
    el.addEventListener('click', () => {
      const t = el.dataset.tag;
      if (state.activeTags.has(t)) state.activeTags.delete(t); else state.activeTags.add(t);
      renderDestination();
    });
  });

  const clearTags = document.getElementById('clear-tags');
  if (clearTags) clearTags.addEventListener('click', () => {
    state.activeTags = new Set();
    renderDestination();
  });

  const dismissBtn = main.querySelector('[data-dismiss]');
  if (dismissBtn) dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.dismissedInsights.push(dismissBtn.dataset.dismiss);
    localStorage.setItem('rolodex_dismissed_insights', JSON.stringify(state.dismissedInsights));
    renderDestination();
  });

  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', debounce(() => {
    state.query = searchInput.value;
    renderDestContent();
  }, 200));

  renderDestContent();
}

function renderDestContent() {
  const container = document.getElementById('dest-content');
  if (!container) return;

  const filtered = getFilteredCards();

  if (state.destView === 'grid') {
    renderGridView(container, filtered);
  } else if (state.destView === 'map') {
    renderMapView(container, filtered);
  } else {
    renderBrowseView(container, filtered);
  }
}

function renderGridView(container, list) {
  if (!list.length) {
    container.innerHTML = emptyForFilter();
    return;
  }

  // If the selected card is no longer in the filtered list,
  // clear the selection.
  if (
    state.selectedGridCard &&
    !list.some(c => c.id === state.selectedGridCard.id)
  ) {
    state.selectedGridCard = null;
  }

  container.innerHTML = `
    <div class="grid-card-layout">

      <div class="grid-panel">
        <div class="card-grid">
          ${list.map(cardTileHtml).join('')}
        </div>
      </div>

      <div class="grid-card-panel" id="grid-card-panel">
        ${
          state.selectedGridCard
            ? browseCardHtml(state.selectedGridCard)
            : `
              <div class="empty-state">
                <div class="glyph">▦</div>
                <p>Select a card to see more</p>
              </div>
            `
        }
      </div>

    </div>
  `;

  // Highlight selected card
  container.querySelectorAll('.rcard').forEach(el => {
    const isSelected = state.selectedGridCard?.id === el.dataset.id;

    el.classList.toggle('selected', isSelected);

    el.addEventListener('click', () => {
      const card = state.cards.find(c => c.id === el.dataset.id);
      if (!card) return;

      state.selectedGridCard = card;
      touchViewed(card.id);

      renderGridView(container, list);
    });
  });

  // Wire actions in the right-hand detail panel
  if (state.selectedGridCard) {
    wireBrowseCardActions(state.selectedGridCard);
  }
}

function emptyForFilter() {
  return `
    <div class="empty-state">
      <div class="glyph">🗂️</div>
      <h3>Nothing here yet</h3>
      <p>Try a different filter, or add something new with the button below.</p>
    </div>`;
}

function cardTileHtml(c) {
  const typeInfo = CARD_TYPES[c.type] || CARD_TYPES.other;
  const opp = CARD_OPPORTUNITIES[c.opportunity];
  const bg = c.image_url ? `style="background-image:url('${escapeHtml(c.image_url)}')"` : '';
  return `
    <div class="rcard" data-id="${c.id}">
      <div class="tab">${typeInfo.icon} ${typeInfo.label}</div>
      ${opp ? `<div class="status-mark" title="${opp.label}">${opp.icon}</div>` : ''}
      <div class="thumb" ${bg}>${c.image_url ? '' : typeInfo.icon}</div>
      <div class="rc-body">
        <h4>${escapeHtml(c.title)}</h4>
        ${c.note ? `<p class="rc-note">"${escapeHtml(c.note)}"</p>` : (c.description ? `<p class="rc-desc">${escapeHtml(truncate(c.description, 90))}</p>` : '')}
        <div class="rc-tags">${(c.tags || []).slice(0, 3).map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>
        ${c.source ? `<div class="rc-source">${escapeHtml(c.source)}</div>` : ''}
      </div>
    </div>`;
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n).trim() + '…' : s; }

// ---------- Browse (flip through) ----------
function renderBrowseView(container, list) {
  if (!list.length) { container.innerHTML = emptyForFilter(); return; }
  if (state.browseIndex >= list.length) state.browseIndex = 0;
  const c = list[state.browseIndex];
  touchViewed(c.id);

  container.innerHTML = `
    <div class="browse-wrap">
      <div class="browse-counter">Card ${state.browseIndex + 1} of ${list.length}</div>
      <div class="browse-stage">
        ${browseCardHtml(c)}
      </div>
      <div class="browse-nav">
        <button class="nav-btn" id="prev-btn">←</button>
        <button class="surprise-inline" id="surprise-inline-btn">🎲 Surprise me</button>
        <button class="nav-btn" id="next-btn">→</button>
      </div>
    </div>
  `;
  document.getElementById('prev-btn').addEventListener('click', () => {
    state.browseIndex = (state.browseIndex - 1 + list.length) % list.length;
    renderDestContent();
  });
  document.getElementById('next-btn').addEventListener('click', () => {
    state.browseIndex = (state.browseIndex + 1) % list.length;
    renderDestContent();
  });
  document.getElementById('surprise-inline-btn').addEventListener('click', () => surpriseMe());
  wireBrowseCardActions(c);
}

function browseCardHtml(c) {
  const typeInfo = CARD_TYPES[c.type] || CARD_TYPES.other;
  const bg = c.image_url ? `style="background-image:url('${escapeHtml(c.image_url)}')"` : '';
  const opportunityOptions =
    `<option value="">— No opportunity —</option>` +
    Object.entries(CARD_OPPORTUNITIES).map(([k, v]) =>
      `<option value="${k}" ${c.opportunity === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('');

  return `
    <div class="browse-card entering">
      <div class="thumb" ${bg}>${c.image_url ? '' : typeInfo.icon}</div>
      <div class="bc-body">
        <div class="tab">${typeInfo.icon} ${typeInfo.label}</div>
        <h3>${escapeHtml(c.title)}</h3>
        ${c.note ? `<p class="bc-note">"${escapeHtml(c.note)}"</p>` : ''}
        ${c.description ? `<p class="bc-desc">${escapeHtml(c.description)}</p>` : ''}
        <div class="bc-tags">${(c.tags || []).map(t => `<span class="rc-tags"><span>${escapeHtml(t)}</span></span>`).join('')}</div>
        <select class="status-select" id="bc-opportunity">${opportunityOptions}</select>
        <div class="bc-actions">
          <button class="tbtn" id="bc-edit">✎ Edit</button>

          ${c.url ? `
            <a class="tbtn"
              href="${escapeHtml(c.url)}"
              target="_blank"
              rel="noopener">
              ↗ Open
            </a>
          ` : ''}

          ${c.lat ? `
            <button class="tbtn" id="bc-view-map">
              📍 Map
            </button>
          ` : ''}

          <button class="tbtn" id="bc-delete">
            🗑 Remove
          </button>
        </div>
        <div class="bc-meta">
          <span>${c.added_by ? 'Added by ' + escapeHtml(c.added_by) : ''}</span>
          <span>${timeAgo(c.created_at)}</span>
        </div>
      </div>
    </div>`;
}

function wireBrowseCardActions(c) {
  const oppSel = document.getElementById('bc-opportunity');
  if (oppSel) oppSel.addEventListener('change', async () => {
    const value = oppSel.value || null;
    c.opportunity = value;
    const local = state.cards.find(x => x.id === c.id);
    if (local) local.opportunity = value;
    try {
      await api.updateCard(c.id, { opportunity: value });
      showToast(value ? `Tagged ${CARD_OPPORTUNITIES[value].label}` : 'Opportunity cleared');
    } catch (err) { showToast('Could not save — will retry when back online'); }
  });
  const delBtn = document.getElementById('bc-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!window.confirm(`Remove "${c.title}"? This can't be undone.`)) return;
    try {
      await api.deleteCard(c.id);
      state.cards = state.cards.filter(x => x.id !== c.id);
      if (state.selectedMapCard?.id === c.id) state.selectedMapCard = null;
      if (state.selectedGridCard?.id === c.id) state.selectedGridCard = null;
      showToast('Removed');
      renderDestination();
    } catch (err) { showToast('Could not remove — try again'); }
  });
  const mapBtn = document.getElementById('bc-view-map');
  if (mapBtn) {
    mapBtn.addEventListener('click', () => {
      state.selectedMapCard = c;
      state.selectedGridCard = null;
      state.destView = 'map';
      renderDestination();
    });
  }
  const editBtn = document.getElementById('bc-edit');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      openEditCardSheet(c);
    });
  }
}

// ============================================================
// Location search (shared by card + destination sheets)
// ============================================================
function locationFieldHtml({ input, results, clear, value = '', placeholder }) {
  return `
    <div class="location-search-wrap">
      <div class="location-input-wrap">
        <span class="location-icon">📍</span>
        <input
          type="text"
          id="${input}"
          value="${escapeHtml(value)}"
          placeholder="${escapeHtml(placeholder || 'Search for a place or address...')}"
          autocomplete="off"
        />
        <button type="button" class="location-clear" id="${clear}" aria-label="Clear location" ${value ? '' : 'hidden'}>×</button>
      </div>
      <div class="location-results" id="${results}" hidden></div>
    </div>`;
}

function wireLocationSearch({ input, lat, lng, results, clear, withContext = true }) {
  const locationInput = document.getElementById(input);
  const latEl = document.getElementById(lat);
  const lngEl = document.getElementById(lng);
  const resultsEl = document.getElementById(results);
  const clearBtn = document.getElementById(clear);

  let timer = null;

  locationInput.addEventListener('input', () => {
    clearTimeout(timer);

    const query = locationInput.value.trim();
    clearBtn.hidden = !query;

    // If the user changes the location manually,
    // don't retain the old coordinates.
    latEl.value = '';
    lngEl.value = '';

    if (query.length < 3) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      return;
    }

    resultsEl.hidden = false;
    resultsEl.innerHTML = `<div class="location-loading">Searching places…</div>`;

    timer = setTimeout(async () => {
      try {
        const found = await searchLocation(query, withContext);

        if (!found.length) {
          resultsEl.innerHTML = `<div class="location-empty">No places found.</div>`;
          return;
        }

        resultsEl.innerHTML = found.map((result, index) => `
          <button type="button" class="location-result" data-location-index="${index}">
            <span class="location-result-icon">📍</span>
            <span class="location-result-text">
              <strong>${escapeHtml(result.display_name.split(',')[0])}</strong>
              <small>${escapeHtml(result.display_name.split(',').slice(1).join(',').trim())}</small>
            </span>
          </button>
        `).join('');

        resultsEl.querySelectorAll('[data-location-index]').forEach(button => {
          button.addEventListener('click', () => {
            const result = found[Number(button.dataset.locationIndex)];
            locationInput.value = result.display_name.split(',')[0];
            latEl.value = result.lat;
            lngEl.value = result.lon;
            resultsEl.hidden = true;
            clearBtn.hidden = false;
          });
        });
      } catch (err) {
        console.error(err);
        resultsEl.innerHTML = `<div class="location-empty">Couldn't search for that place.</div>`;
      }
    }, 400);
  });

  clearBtn.addEventListener('click', () => {
    locationInput.value = '';
    latEl.value = '';
    lngEl.value = '';
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
    clearBtn.hidden = true;
    locationInput.focus();
  });
}

// ============================================================
// Edit card sheet
// ============================================================
function openEditCardSheet(card) {
  const overlay = document.createElement('div');

  overlay.className = 'sheet-overlay';
  overlay.id = 'edit-card-overlay';

  let tags = [...(card.tags || [])];

  overlay.innerHTML = `
    <div class="sheet">

      <div class="sheet-head">
        <div>
          <p class="eyebrow">Edit card</p>
          <h2>${escapeHtml(card.title)}</h2>
        </div>

        <button class="sheet-close" id="ec-close">✕</button>
      </div>

      <div class="field">
        <label>Title</label>
        <input type="text" id="ec-title" value="${escapeHtml(card.title || '')}" />
      </div>

      <div class="field">
        <label>Why did we save this?</label>
        <textarea id="ec-note" class="field-large" placeholder="This looks absolutely bonkers...">${escapeHtml(card.note || '')}</textarea>
      </div>

      <div class="field">
        <label>Description</label>
        <textarea id="ec-description" class="field-large" placeholder="What is this?">${escapeHtml(card.description || '')}</textarea>
      </div>

      <div class="field">
        <label>Type</label>

        <div class="capture-tabs">
          ${Object.entries(CARD_TYPES).map(([key, info]) => `
            <button class="capture-tab ${card.type === key ? 'active' : ''}" data-type="${key}">
              ${info.icon} ${info.label}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="field">
        <label>Opportunity</label>
        <select id="ec-opportunity">
          <option value="">— None —</option>
          ${Object.entries(CARD_OPPORTUNITIES).map(([key, info]) => `
            <option value="${key}" ${card.opportunity === key ? 'selected' : ''}>${info.icon} ${info.label}</option>
          `).join('')}
        </select>
      </div>

      <div class="field">
        <label>Link</label>
        <input type="url" id="ec-url" value="${escapeHtml(card.url || '')}" placeholder="https://..." />
      </div>

      <div class="field">
        <label>Source</label>
        <input type="text" id="ec-source" value="${escapeHtml(card.source || '')}" placeholder="Website, publication, friend..." />
      </div>

      <div class="field">
        <label>Image URL</label>
        <input type="url" id="ec-image" value="${escapeHtml(card.image_url || '')}" placeholder="https://..." />
      </div>

      <div class="field location-field">
        <label>Location</label>

        ${locationFieldHtml({
          input: 'ec-location',
          results: 'ec-location-results',
          clear: 'ec-location-clear',
          value: card.location_name || '',
        })}

        <p class="field-hint">Start typing a place and choose the matching location.</p>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Latitude</label>
          <input type="number" step="any" id="ec-lat" value="${card.lat ?? ''}" />
        </div>

        <div class="field">
          <label>Longitude</label>
          <input type="number" step="any" id="ec-lng" value="${card.lng ?? ''}" />
        </div>
      </div>

      <div class="field">
        <label>Tags</label>
        <div class="editable-tags" id="ec-tags"></div>
      </div>

      <div class="sheet-footer">
        <button class="btn-secondary" id="ec-cancel">Cancel</button>
        <button class="btn-primary" id="ec-save">Save changes</button>
      </div>

    </div>
  `;

  document.body.appendChild(overlay);

  let selectedType = card.type || 'other';

  const renderTags = () => {
    const container = document.getElementById('ec-tags');

    container.innerHTML = `
      ${tags.map(tag => `
        <button class="editable-tag" data-tag="${escapeHtml(tag)}">
          ${escapeHtml(tag)} <span>×</span>
        </button>
      `).join('')}

      <button class="editable-tag add" id="ec-add-tag">+ Add tag</button>
    `;

    container.querySelectorAll('[data-tag]').forEach(btn => {
      btn.addEventListener('click', () => {
        tags = tags.filter(t => t !== btn.dataset.tag);
        renderTags();
      });
    });

    document.getElementById('ec-add-tag').addEventListener('click', () => {
      const value = prompt('Add a tag');
      if (!value) return;
      const tag = value.startsWith('#') ? value : `#${value}`;
      if (!tags.includes(tag)) {
        tags.push(tag);
        renderTags();
      }
    });
  };

  renderTags();

  wireLocationSearch({
    input: 'ec-location',
    lat: 'ec-lat',
    lng: 'ec-lng',
    results: 'ec-location-results',
    clear: 'ec-location-clear',
  });

  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('ec-close').addEventListener('click', () => overlay.remove());
  document.getElementById('ec-cancel').addEventListener('click', () => overlay.remove());

  overlay.querySelectorAll('[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedType = btn.dataset.type;
      overlay.querySelectorAll('[data-type]').forEach(b =>
        b.classList.toggle('active', b.dataset.type === selectedType));
    });
  });

  document.getElementById('ec-save').addEventListener('click', async () => {
    const button = document.getElementById('ec-save');

    const patch = {
      title: document.getElementById('ec-title').value.trim(),
      note: document.getElementById('ec-note').value.trim() || null,
      description: document.getElementById('ec-description').value.trim() || null,
      type: selectedType,
      opportunity: document.getElementById('ec-opportunity').value || null,
      url: document.getElementById('ec-url').value.trim() || null,
      source: document.getElementById('ec-source').value.trim() || null,
      image_url: document.getElementById('ec-image').value.trim() || null,
      location_name: document.getElementById('ec-location').value.trim() || null,
      lat: document.getElementById('ec-lat').value ? Number(document.getElementById('ec-lat').value) : null,
      lng: document.getElementById('ec-lng').value ? Number(document.getElementById('ec-lng').value) : null,
      tags
    };

    if (!patch.title) {
      alert('A card needs a title.');
      return;
    }

    button.disabled = true;
    button.textContent = 'Saving…';

    try {
      const updated = await api.updateCard(card.id, patch);

      const index = state.cards.findIndex(c => c.id === card.id);
      if (index >= 0) state.cards[index] = updated;

      // Keep the selected card in sync so the side panel shows the new values
      if (state.selectedMapCard?.id === card.id) state.selectedMapCard = updated;
      if (state.selectedGridCard?.id === card.id) state.selectedGridCard = updated;

      state.destination = { ...state.destination };

      overlay.remove();
      renderDestination();
      showToast('Card updated');

    } catch (err) {
      button.disabled = false;
      button.textContent = 'Save changes';
      alert('Could not save: ' + (err.message || err));
    }
  });
}

function openBrowseAt(cardId) {
  const list = getFilteredCards();
  const idx = list.findIndex(c => c.id === cardId);
  state.destView = 'browse';
  state.browseIndex = idx >= 0 ? idx : 0;
  renderDestination();
}

function surpriseMe() {
  const list = getFilteredCards();
  if (!list.length) return;
  let idx = Math.floor(Math.random() * list.length);
  if (list.length > 1 && idx === state.browseIndex) idx = (idx + 1) % list.length;
  state.browseIndex = idx;
  state.destView = 'browse';
  renderDestination();
}

function touchViewed(id) { api.touchLastViewed(id); }

// ============================================================
// Triage — sort "New" cards one at a time
// ============================================================
// Left → right: from "no" to "yes". Keys 1–5 match the button order.
const TRIAGE_OPTIONS = ['not_for_us', 'maybe', 'curious', 'favourite', 'must_do'];

let triage = null; // { queue, index, history, counts, onKey }

function openTriage() {
  const queue = state.cards.filter(c => c.status === 'new').map(c => c.id);
  if (!queue.length) { showToast('Nothing new to sort'); return; }

  triage = { queue, index: 0, history: [], counts: {}, onKey: null };

  const overlay = document.createElement('div');
  overlay.className = 'triage-overlay';
  overlay.id = 'triage-overlay';
  document.body.appendChild(overlay);

  triage.onKey = handleTriageKey;
  document.addEventListener('keydown', triage.onKey);

  renderTriage();
}

function closeTriage() {
  if (!triage) return;
  document.removeEventListener('keydown', triage.onKey);
  document.getElementById('triage-overlay')?.remove();
  triage = null;
  if (state.view === 'destination') renderDestination();
}

function handleTriageKey(e) {
  if (!triage || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'Escape') { closeTriage(); return; }
  if (triage.index >= triage.queue.length) return;
  if (k >= '1' && k <= '5') { triageDecide(TRIAGE_OPTIONS[Number(k) - 1]); return; }
  if (k === 'ArrowRight' || k === 's' || k === 'S') { triageSkip(); return; }
  if (k === 'ArrowLeft' || k === 'z' || k === 'Z' || k === 'Backspace') { triageUndo(); }
}

function renderTriage() {
  const el = document.getElementById('triage-overlay');
  if (!el || !triage) return;

  const total = triage.queue.length;
  if (triage.index >= total) { renderTriageDone(el); return; }

  const id = triage.queue[triage.index];
  const c = state.cards.find(x => x.id === id);
  if (!c) { // deleted elsewhere — step past it
    triage.history.push({ id: null });
    triage.index++;
    renderTriage();
    return;
  }

  touchViewed(c.id);

  const typeInfo = CARD_TYPES[c.type] || CARD_TYPES.other;
  const bg = c.image_url ? `style="background-image:url('${escapeHtml(c.image_url)}')"` : '';
  const pct = Math.round((triage.index / total) * 100);

  el.innerHTML = `
    <div class="triage-top">
      <button class="sheet-close" id="tr-close" aria-label="Close">✕</button>
      <div class="triage-progress">
        <div class="triage-bar"><span style="width:${pct}%"></span></div>
        <p>${triage.index + 1} of ${total} · ${escapeHtml(state.destination.name)}</p>
      </div>
      <button class="tbtn" id="tr-undo" ${triage.history.length ? '' : 'disabled'}>↶ Undo</button>
    </div>

    <div class="triage-stage">
      <div class="triage-card">
        <div class="thumb" ${bg}>${c.image_url ? '' : typeInfo.icon}</div>
        <div class="tc-body">
          <div class="tab">${typeInfo.icon} ${typeInfo.label}</div>
          <h3>${escapeHtml(c.title)}</h3>
          ${c.note ? `<p class="bc-note">"${escapeHtml(c.note)}"</p>` : ''}
          ${c.description ? `<p class="bc-desc">${escapeHtml(truncate(c.description, 320))}</p>` : ''}
          ${(c.tags || []).length ? `<div class="bc-tags">${c.tags.map(t => `<span class="rc-tags"><span>${escapeHtml(t)}</span></span>`).join('')}</div>` : ''}
          <div class="tc-meta">
            <span>${[c.source, c.added_by ? 'added by ' + c.added_by : '', timeAgo(c.created_at)].filter(Boolean).map(escapeHtml).join(' · ')}</span>
            ${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">↗ Open link</a>` : ''}
          </div>
        </div>
      </div>

      <div class="triage-actions">
        ${TRIAGE_OPTIONS.map((s, i) => `
          <button class="triage-btn s-${s}" data-status="${s}">
            <span class="ti">${CARD_STATUSES[s].icon}</span>
            <span class="tl">${CARD_STATUSES[s].label}</span>
            <kbd>${i + 1}</kbd>
          </button>`).join('')}
      </div>

      <button class="triage-skip" id="tr-skip">Skip for now →</button>
      <p class="triage-hint">Keys: 1–5 to choose · → skip · Z undo · Esc close</p>
    </div>
  `;

  document.getElementById('tr-close').addEventListener('click', closeTriage);
  document.getElementById('tr-undo').addEventListener('click', triageUndo);
  document.getElementById('tr-skip').addEventListener('click', triageSkip);
  el.querySelectorAll('[data-status]').forEach(btn => {
    btn.addEventListener('click', () => triageDecide(btn.dataset.status));
  });
}

function renderTriageDone(el) {
  const decided = Object.entries(triage.counts).filter(([, n]) => n > 0);
  const remaining = state.cards.filter(c => c.status === 'new').length;

  el.innerHTML = `
    <div class="triage-top">
      <button class="sheet-close" id="tr-close" aria-label="Close">✕</button>
      <div class="triage-progress"><div class="triage-bar"><span style="width:100%"></span></div></div>
      <button class="tbtn" id="tr-undo" ${triage.history.length ? '' : 'disabled'}>↶ Undo</button>
    </div>
    <div class="triage-stage">
      <div class="empty-state">
        <div class="glyph">${remaining ? '👌' : '🎉'}</div>
        <h3>${remaining ? 'That\'s the pass' : 'All sorted'}</h3>
        <p>${decided.length
          ? decided.map(([s, n]) => `${CARD_STATUSES[s].icon} ${n} ${escapeHtml(CARD_STATUSES[s].label)}`).join(' &nbsp;·&nbsp; ')
          : 'Nothing sorted this time.'}</p>
        <div class="triage-done-actions">
          ${remaining ? `<button class="btn-secondary" id="tr-again">Review ${remaining} skipped</button>` : ''}
          <button class="btn-primary" id="tr-finish">Back to ${escapeHtml(state.destination.name)}</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('tr-close').addEventListener('click', closeTriage);
  document.getElementById('tr-finish').addEventListener('click', closeTriage);
  document.getElementById('tr-undo').addEventListener('click', triageUndo);
  const again = document.getElementById('tr-again');
  if (again) again.addEventListener('click', () => {
    triage.queue = state.cards.filter(c => c.status === 'new').map(c => c.id);
    triage.index = 0;
    triage.history = [];
    renderTriage();
  });
}

function triageDecide(status) {
  if (!triage || triage.index >= triage.queue.length) return;
  const id = triage.queue[triage.index];
  const card = state.cards.find(c => c.id === id);
  if (!card) { triage.history.push({ id: null }); triage.index++; renderTriage(); return; }

  const prev = card.status;
  card.status = status;
  triage.history.push({ id, prev, status });
  triage.counts[status] = (triage.counts[status] || 0) + 1;
  triage.index++;
  renderTriage();

  api.updateCard(id, { status }).catch(() => {
    card.status = prev;
    triage.counts[status] = Math.max(0, (triage.counts[status] || 1) - 1);
    showToast(`Couldn't save "${truncate(card.title, 30)}" — it's still New`);
  });
}

function triageSkip() {
  if (!triage || triage.index >= triage.queue.length) return;
  triage.history.push({ id: triage.queue[triage.index], skipped: true });
  triage.index++;
  renderTriage();
}

function triageUndo() {
  if (!triage || !triage.history.length) return;
  const entry = triage.history.pop();
  triage.index = Math.max(0, triage.index - 1);

  if (entry.id && !entry.skipped) {
    const card = state.cards.find(c => c.id === entry.id);
    if (card) card.status = entry.prev;
    triage.counts[entry.status] = Math.max(0, (triage.counts[entry.status] || 1) - 1);
    api.updateCard(entry.id, { status: entry.prev }).catch(() => showToast('Could not undo — try again'));
  }
  renderTriage();
}

// ---------- Map view ----------
function renderMapView(container, list) {
  const withLoc = list.filter(c => c.lat != null && c.lng != null);

  destroyDestMap();

  container.innerHTML = `
    ${state.destination.map_url ? `
      <div class="map-link-note">
        <span>📍 Full trip mapping lives in Google My Maps.</span>
        <a class="tbtn"
          href="${escapeHtml(state.destination.map_url)}"
          target="_blank"
          rel="noopener">
          ↗ Open My Maps
        </a>
      </div>
    ` : ''}

    <div class="map-card-layout">
      <div class="map-panel">
        <div id="leaflet-map"></div>
      </div>

      <div class="map-card-panel" id="map-card-panel">
        ${
          state.selectedMapCard
            ? browseCardHtml(state.selectedMapCard)
            : `
              <div class="empty-state">
                <div class="glyph">📍</div>
                <p>Select a location on the map</p>
              </div>
            `
        }
      </div>
    </div>

    ${!withLoc.length
      ? '<p style="color:var(--text-muted); font-size:13px;">None of the visible cards have a location yet.</p>'
      : ''}
  `;

  if (!window.L) return;

  if (state.selectedMapCard) {
    wireBrowseCardActions(state.selectedMapCard);
  }

  const mapEl = document.getElementById('leaflet-map');

  const map = L.map(mapEl, {
    scrollWheelZoom: true
  });

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_4mve_1_9f1f0f7d045dfba544a094b3',
    {
      attribution: '© OpenStreetMap, © CARTO',
      maxZoom: 19,
    }
  ).addTo(map);

  if (withLoc.length) {
    const bounds = [];

    withLoc.forEach(c => {
      const isSelected = state.selectedMapCard?.id === c.id;

      const marker = L.circleMarker(
        [c.lat, c.lng],
        {
          radius: isSelected ? 9 : 7,
          weight: isSelected ? 3 : 2,
          color: isSelected ? '#FFDE21' : '#fff',
          fillColor: '#d85c4a',
          fillOpacity: isSelected ? 1 : 0.9,
        }
      ).addTo(map);

      marker.bindPopup(
        `<strong>${escapeHtml(c.title)}</strong>`
      );

      marker.on('click', () => {
        state.selectedMapCard = c;
        renderMapView(container, list);
      });

      bounds.push([c.lat, c.lng]);
    });

    map.fitBounds(bounds, {
      padding: [30, 30],
      maxZoom: 14,
    });
  } else {
    // No located cards yet — centre on the destination's own pin if it has one
    const d = state.destination;
    if (d.lat != null && d.lng != null) map.setView([d.lat, d.lng], 6);
    else map.setView([39.5, -8], 6);
  }

  state.leafletMap = map;
}

// ============================================================
// Capture sheet — the core "+ Add" flow
// ============================================================
let captureDraft = { type: 'other', tags: new Set(), preview: null, opportunity: '' };

function openCaptureSheet() {
  if (!state.destination) return;
  captureDraft = { type: 'other', tags: new Set(), preview: null, opportunity: '' };
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.id = 'capture-overlay';
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <h2>Add to ${escapeHtml(state.destination.name)}</h2>
        <button class="sheet-close" id="capture-close">✕</button>
      </div>

      <div class="field">
        <label>Got a link? Paste it — we'll pull the details</label>
        <input type="url" id="url-input" placeholder="https://…" />
      </div>
      <div id="link-preview-slot"></div>

      <div class="field">
        <label>Title</label>
        <input type="text" id="title-input" placeholder="What is it?" />
      </div>

      <div class="field">
        <label>Your note <span style="text-transform:none; letter-spacing:0;">(optional — why does this matter to you?)</span></label>
        <textarea id="note-input" placeholder="This looks absolutely bonkers…"></textarea>
      </div>

      <div class="field">
        <label>Type</label>
        <div class="capture-tabs" id="type-tabs">
          ${Object.entries(CARD_TYPES).map(([k, v]) => `<button class="capture-tab ${k === captureDraft.type ? 'active' : ''}" data-type="${k}">${v.icon} ${v.label}</button>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>Tags <span style="text-transform:none; letter-spacing:0;">(optional)</span></label>
        <div class="tag-input-row" id="tag-row">
          ${SUGGESTED_TAGS.map(t => `<button class="tag-pill-input" data-tag="${t}">${t}</button>`).join('')}
          <button class="tag-pill-input custom" id="custom-tag-btn">+ custom</button>
        </div>
      </div>

      <div class="sheet-footer">
        <button class="btn-secondary" id="capture-cancel">Cancel</button>
        <button class="btn-primary" id="capture-save">Save card</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('capture-close').addEventListener('click', closeCaptureSheet);
  document.getElementById('capture-cancel').addEventListener('click', closeCaptureSheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCaptureSheet(); });

  const urlInput = document.getElementById('url-input');
  urlInput.addEventListener('change', () => handleUrlPaste(urlInput.value.trim()));

  document.querySelectorAll('#type-tabs .capture-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      captureDraft.type = btn.dataset.type;
      document.querySelectorAll('#type-tabs .capture-tab').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  document.querySelectorAll('#tag-row .tag-pill-input:not(.custom)').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tag;
      if (captureDraft.tags.has(t)) { captureDraft.tags.delete(t); btn.classList.remove('selected'); }
      else { captureDraft.tags.add(t); btn.classList.add('selected'); }
    });
  });
  document.getElementById('custom-tag-btn').addEventListener('click', () => {
    const t = window.prompt('Custom tag (e.g. #day-trip):');
    if (!t) return;
    const tag = t.startsWith('#') ? t : `#${t}`;
    captureDraft.tags.add(tag);
    const row = document.getElementById('tag-row');
    const pill = document.createElement('button');
    pill.className = 'tag-pill-input selected';
    pill.textContent = tag;
    pill.dataset.tag = tag;
    pill.addEventListener('click', () => {
      if (captureDraft.tags.has(tag)) { captureDraft.tags.delete(tag); pill.classList.remove('selected'); }
      else { captureDraft.tags.add(tag); pill.classList.add('selected'); }
    });
    row.insertBefore(pill, document.getElementById('custom-tag-btn'));
  });

  document.getElementById('capture-save').addEventListener('click', saveCaptureCard);
}

async function handleUrlPaste(url) {
  if (!url) return;
  const slot = document.getElementById('link-preview-slot');
  slot.innerHTML = `<div class="link-preview"><div class="lp-loading">Fetching preview…</div></div>`;
  try {
    const preview = await fetchLinkPreview(url);
    captureDraft.preview = { ...preview, url };
    slot.innerHTML = `
      <div class="link-preview">
        ${preview.image ? `<div class="lp-img" style="background-image:url('${escapeHtml(preview.image)}')"></div>` : ''}
        <div class="lp-body">
          <p class="lp-title">${escapeHtml(preview.title)}</p>
          <p class="lp-source">${escapeHtml(preview.source)}</p>
        </div>
      </div>`;
    const titleInput = document.getElementById('title-input');
    if (!titleInput.value) titleInput.value = preview.title;
    // nudge type toward article/video if plausible
    if (/youtube\.com|youtu\.be|vimeo\.com/.test(url)) {
      captureDraft.type = 'video';
      document.querySelectorAll('#type-tabs .capture-tab').forEach(b => b.classList.toggle('active', b.dataset.type === 'video'));
    }
  } catch (err) {
    slot.innerHTML = `<div class="link-preview"><div class="lp-loading">Couldn't fetch a preview — no problem, just fill in the title yourself.</div></div>`;
    captureDraft.preview = { url };
  }
}

function closeCaptureSheet() {
  const overlay = document.getElementById('capture-overlay');
  if (overlay) overlay.remove();
}

async function saveCaptureCard() {
  const title = document.getElementById('title-input').value.trim();
  const note = document.getElementById('note-input').value.trim();
  const url = document.getElementById('url-input').value.trim();

  if (!title) {
    window.alert('Give it at least a title — everything else is optional.');
    return;
  }

  const saveBtn = document.getElementById('capture-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const payload = {
    destination_id: state.destination.id,
    type: captureDraft.type,
    title,
    note: note || null,
    description: captureDraft.preview?.description || null,
    url: url || null,
    source: captureDraft.preview?.source || null,
    image_url: captureDraft.preview?.image || null,
    tags: [...captureDraft.tags],
    opportunity: document.getElementById('opportunity-input').value || null,
    added_by: state.whoami,
  };

  try {
    const created = await api.createCard(payload);
    state.cards.unshift(created);
    closeCaptureSheet();
    showToast('Saved to ' + state.destination.name);
    state.destView = 'browse';
    state.browseIndex = 0;
    state.filter = 'all';
    state.opportunity = 'all';
    state.activeTags = new Set();
    renderDestination();
  } catch (err) {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save card';
    window.alert('Could not save right now: ' + (err.message || err));
  }
}

// ============================================================
// Add destination sheet
// ============================================================
function openAddDestinationSheet() {
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <h2>Add a destination</h2>
        <button class="sheet-close" id="ad-close">✕</button>
      </div>
      <div class="field"><label>Name</label><input type="text" id="ad-name" placeholder="Croatia" /></div>
      <div class="field"><label>Flag emoji</label><input type="text" id="ad-flag" placeholder="🇭🇷" /></div>
      <div class="field"><label>Short description</label><textarea id="ad-desc" placeholder="What's drawing you here?"></textarea></div>

      <div class="field location-field">
        <label>Map location <span class="field-hint">Where its pin sits on the world map (optional)</span></label>
        ${locationFieldHtml({ input: 'ad-location', results: 'ad-location-results', clear: 'ad-location-clear', placeholder: 'Search for a country, region or city…' })}
        <input type="hidden" id="ad-lat" />
        <input type="hidden" id="ad-lng" />
      </div>

      <div class="sheet-footer">
        <button class="btn-secondary" id="ad-cancel">Cancel</button>
        <button class="btn-primary" id="ad-save">Add destination</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('ad-close').addEventListener('click', () => overlay.remove());
  document.getElementById('ad-cancel').addEventListener('click', () => overlay.remove());

  wireLocationSearch({
    input: 'ad-location', lat: 'ad-lat', lng: 'ad-lng',
    results: 'ad-location-results', clear: 'ad-location-clear',
    withContext: false,
  });

  document.getElementById('ad-save').addEventListener('click', async () => {
    const name = document.getElementById('ad-name').value.trim();
    if (!name) { window.alert('Give it a name.'); return; }
    const lat = document.getElementById('ad-lat').value;
    const lng = document.getElementById('ad-lng').value;
    const payload = {
      trip_id: state.trip.id,
      name,
      flag: document.getElementById('ad-flag').value.trim() || '✦',
      short_description: document.getElementById('ad-desc').value.trim() || null,
      sort_order: state.destinations.length,
      lat: lat ? Number(lat) : null,
      lng: lng ? Number(lng) : null,
    };
    try {
      const created = await api.createDestination(payload);
      overlay.remove();
      await loadCatalogue();
      openDestination(created.id);
    } catch (err) {
      window.alert('Could not add destination: ' + (err.message || err));
    }
  });
}

function openEditDestinationSheet() {
  const d = state.destination;
  if (!d) return;

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.id = 'edit-destination-overlay';

  const tags = [...(d.tags || [])];
  const hasPin = d.lat != null && d.lng != null;

  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <div>
          <p class="eyebrow">Destination</p>
          <h2>Edit ${escapeHtml(d.name)}</h2>
        </div>
        <button class="sheet-close" id="ed-close">✕</button>
      </div>

      <div class="field">
        <label>Name</label>
        <input type="text" id="ed-name" value="${escapeHtml(d.name || '')}" placeholder="Portugal" />
      </div>

      <div class="field">
        <label>Flag</label>
        <input type="text" id="ed-flag" value="${escapeHtml(d.flag || '')}" placeholder="🇵🇹" />
      </div>

      <div class="field">
        <label>Short description</label>
        <textarea id="ed-short-description" placeholder="What's drawing you here?">${escapeHtml(d.short_description || '')}</textarea>
      </div>

      <div class="field">
        <label>
          What we're looking for
          <span class="field-hint">The bigger picture — what are you curious about here?</span>
        </label>

        <textarea id="ed-description" class="field-large" placeholder="Slow travel, food, strange little places, architecture...">${escapeHtml(d.description || '')}</textarea>
      </div>

      <div class="field location-field">
        <label>
          Map location
          <span class="field-hint">Where this destination's pin sits on the world map${hasPin ? '' : ' — until you set one, it uses the average of your located cards'}</span>
        </label>
        ${locationFieldHtml({
          input: 'ed-location', results: 'ed-location-results', clear: 'ed-location-clear',
          value: hasPin ? d.name : '',
          placeholder: 'Search for a country, region or city…',
        })}
        <input type="hidden" id="ed-lat" value="${hasPin ? d.lat : ''}" />
        <input type="hidden" id="ed-lng" value="${hasPin ? d.lng : ''}" />
      </div>

      <div class="field-row">
        <div class="field">
          <label>Start</label>
          <input type="date" id="ed-start" value="${d.planned_start || ''}" />
        </div>

        <div class="field">
          <label>End</label>
          <input type="date" id="ed-end" value="${d.planned_end || ''}" />
        </div>
      </div>

      <div class="field">
        <label>Planned days</label>
        <input type="number" id="ed-days" min="0" value="${d.planned_days || ''}" placeholder="21" />
      </div>

      <div class="field">
        <label>Cover image URL</label>
        <input type="url" id="ed-cover" value="${escapeHtml(d.cover_image || '')}" placeholder="https://..." />
      </div>

      <div class="field">
        <label>Google My Maps URL</label>
        <input type="url" id="ed-map" value="${escapeHtml(d.map_url || '')}" placeholder="https://www.google.com/maps/d/..." />
      </div>

      <div class="field">
        <label>Tags</label>
        <div class="editable-tags" id="ed-tags"></div>
      </div>

      <div class="sheet-footer">
        <button class="btn-secondary" id="ed-cancel">Cancel</button>
        <button class="btn-primary" id="ed-save">Save changes</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('ed-close').addEventListener('click', () => overlay.remove());
  document.getElementById('ed-cancel').addEventListener('click', () => overlay.remove());

  wireLocationSearch({
    input: 'ed-location', lat: 'ed-lat', lng: 'ed-lng',
    results: 'ed-location-results', clear: 'ed-location-clear',
    withContext: false,
  });

  function renderTags() {
    const container = document.getElementById('ed-tags');

    container.innerHTML = `
      ${tags.map(tag => `
        <button class="editable-tag" data-tag="${escapeHtml(tag)}">
          ${escapeHtml(tag)} <span>×</span>
        </button>
      `).join('')}

      <button class="editable-tag add" id="ed-add-tag">+ Add tag</button>
    `;

    container.querySelectorAll('[data-tag]').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = tags.indexOf(btn.dataset.tag);
        if (index >= 0) tags.splice(index, 1);
        renderTags();
      });
    });

    document.getElementById('ed-add-tag').addEventListener('click', () => {
      const value = window.prompt('Add a tag');
      if (!value) return;
      const tag = value.startsWith('#') ? value : `#${value}`;
      if (!tags.includes(tag)) {
        tags.push(tag);
        renderTags();
      }
    });
  }

  renderTags();

  document.getElementById('ed-save').addEventListener('click', async () => {
    const button = document.getElementById('ed-save');
    const lat = document.getElementById('ed-lat').value;
    const lng = document.getElementById('ed-lng').value;

    const patch = {
      name: document.getElementById('ed-name').value.trim(),
      flag: document.getElementById('ed-flag').value.trim() || null,
      short_description: document.getElementById('ed-short-description').value.trim() || null,
      description: document.getElementById('ed-description').value.trim() || null,
      planned_start: document.getElementById('ed-start').value || null,
      planned_end: document.getElementById('ed-end').value || null,
      planned_days: Number(document.getElementById('ed-days').value) || null,
      cover_image: document.getElementById('ed-cover').value.trim() || null,
      map_url: document.getElementById('ed-map').value.trim() || null,
      lat: lat ? Number(lat) : null,
      lng: lng ? Number(lng) : null,
      tags
    };

    if (!patch.name) {
      alert('Give the destination a name.');
      return;
    }

    button.disabled = true;
    button.textContent = 'Saving…';

    try {
      const updated = await api.updateDestination(d.id, patch);

      state.destination = updated;

      const index = state.destinations.findIndex(x => x.id === updated.id);
      if (index >= 0) {
        state.destinations[index] = { ...state.destinations[index], ...updated };
      }

      overlay.remove();
      renderDestination();
      showToast('Destination updated');

    } catch (err) {
      button.disabled = false;
      button.textContent = 'Save changes';
      alert('Could not save: ' + (err.message || err));
    }
  });
}

// ============================================================
// Utilities
// ============================================================
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Global FAB — always visible once a trip is loaded
function ensureFab() {
  if (document.getElementById('add-fab')) return;
  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.id = 'add-fab';
  fab.innerHTML = `<span class="plus">+</span> <span class="label">Add</span>`;
  fab.addEventListener('click', () => {
    if (state.view === 'destination') openCaptureSheet();
    else showToast('Open a destination first to add something to it');
  });
  document.body.appendChild(fab);
}

// withContext: bias the search towards the open destination (for cards).
// Destination pins pass false so "Portugal" isn't searched as "Portugal, Portugal".
async function searchLocation(query, withContext = true) {
  if (!query || query.trim().length < 3) return [];

  const destination = withContext ? (state.destination?.name || '') : '';

  const searchQuery = destination
    ? `${query.trim()}, ${destination}`
    : query.trim();

  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?format=jsonv2` +
    `&q=${encodeURIComponent(searchQuery)}` +
    `&limit=5` +
    `&addressdetails=1`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error('Location search failed');
  }

  return response.json();
}

// Back/forward: show the right view without pushing another history entry
window.addEventListener('popstate', () => {
  closeTriage();
  const id = location.hash.replace('#', '');
  if (id) openDestination(id); else showCatalogue();
});

boot().then(() => {
  if (api.isConfigured()) ensureFab();
});