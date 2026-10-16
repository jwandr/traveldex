import * as api from './api.js';
import { fetchLinkPreview } from './linkPreview.js';
import {
  CARD_TYPES, CARD_STATUSES, SUGGESTED_TAGS, QUICK_FILTERS,
  escapeHtml, timeAgo, formatDateRange,
} from './config.js';

// ============================================================
// State
// ============================================================
const state = {
  online: navigator.onLine,
  trip: null,
  destinations: [],
  destination: null,   // currently open destination
  cards: [],            // all cards for the open destination
  view: 'catalogue',    // 'catalogue' | 'destination'
  destView: 'map',   // 'browse' | 'grid' | 'map'
  browseIndex: 0,
  filter: 'all',
  activeTags: new Set(),
  query: '',
  dismissedInsights: JSON.parse(localStorage.getItem('rolodex_dismissed_insights') || '[]'),
  whoami: localStorage.getItem('rolodex_whoami') || '',
  leafletMap: null,
  selectedMapCard: null,
  selectedGridCard: null,
};

const app = document.getElementById('app');

// ============================================================
// Boot
// ============================================================
async function boot() {
  window.addEventListener('online', () => { state.online = true; renderTopbar(); });
  window.addEventListener('offline', () => { state.online = false; renderTopbar(); });

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
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="whoami" id="whoami-btn">${escapeHtml(state.whoami)}</button>
        <div class="status-pill ${state.online ? '' : 'offline'}" id="status-pill">
          <span class="dot"></span> ${state.online ? 'Synced' : 'Offline'}
        </div>
      </div>
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
  const pill = document.getElementById('status-pill');
  if (pill) {
    pill.className = `status-pill ${state.online ? '' : 'offline'}`;
    pill.innerHTML = `<span class="dot"></span> ${state.online ? 'Synced' : 'Offline — changes will sync when you\'re back online'}`;
  }
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
  } catch (err) {
    main.innerHTML = errorBlock(err);
    return;
  }
  renderCatalogue();
}

function goToCatalogue() {
  state.view = 'catalogue';
  history.pushState({ view: 'catalogue' }, '', '#');
  renderCatalogue();
}

function renderCatalogue() {
  const totalCards = state.destinations.reduce((sum, d) => sum + (d.rolodex_cards?.[0]?.count || 0), 0);
  const totalDays = state.destinations.reduce((sum, d) => sum + (d.planned_days || 0), 0);

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

  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="catalogue-header">
      <p class="eyebrow">Our journey</p>
      <h1>${escapeHtml(state.trip.name)}</h1>
      <p class="sub">${state.destinations.length} destinations · ${totalCards} things saved${totalDays ? ' · ' + totalDays + ' days planned' : ''}</p>
    </div>
    <div class="dest-grid">
      ${tiles}
      <button class="add-dest-tile" id="add-dest">
        <span class="plus">+</span>
        <span>Add a destination</span>
      </button>
    </div>
  `;

    // Open destination when a tile is clicked
  main.querySelectorAll('.dest-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      openDestination(tile.dataset.id);
    });
  });

  main.querySelectorAll('[data-destview]').forEach(el => {
    el.addEventListener('click', () => {
      state.destView = el.dataset.destview;

      // Preserve the selected card when moving between
      // grid and map, but clear it when going to Browse.
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
  document.getElementById('add-dest').addEventListener('click', openAddDestinationSheet);
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
async function openDestination(id) {
  state.view = 'destination';
  state.destView = 'map';
  state.browseIndex = 0;
  state.filter = 'all';
  state.activeTags = new Set();
  state.query = '';
  history.pushState({ view: 'destination', id }, '', `#${id}`);

  const main = document.getElementById('main');
  main.innerHTML = `<div class="empty-state"><div class="glyph">✦</div><p>Opening…</p></div>`;

  try {
    state.destination = await api.fetchDestination(id);
    state.cards = await api.fetchCards(id);
  } catch (err) {
    main.innerHTML = errorBlock(err);
    return;
  }
  renderDestination();
}

function getFilteredCards() {
  let list = [...state.cards];
  const f = QUICK_FILTERS.find(f => f.id === state.filter);
  if (f && f.id !== 'all') {
    if (f.type) list = list.filter(c => c.type === f.type);
    if (f.typeIn) list = list.filter(c => f.typeIn.includes(c.type));
    if (f.statusIn) list = list.filter(c => f.statusIn.includes(c.status));
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
  const tagCounts = {};
  state.cards.forEach(c => (c.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
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
  const filtered = getFilteredCards();
  const allTags = [...new Set(state.cards.flatMap(c => c.tags || []))].sort();
  const insights = computeInsights();

  const main = document.getElementById('main');
  main.innerHTML = `
    <button class="back-link" id="back-btn">← All destinations</button>
    <div class="dest-header">
      <div class="title-row">
        <span class="flag">${d.flag || '✦'}</span>
        <h1>${escapeHtml(d.name)}</h1>
        <span class="count">${state.cards.length} thing${state.cards.length === 1 ? '' : 's'} saved</span>
        <button class="icon-btn" id="edit-destination" title="Edit destination">✎</button>
      </div>
      
      <!-- ${d.short_description ? `<p class="desc">${escapeHtml(d.short_description)}</p>` : ''} -->

      <div class="toolbar">
        <button class="tbtn ${state.destView === 'map' ? 'active' : ''}" data-destview="map"><span class="ic">📍</span> Map</button>
        <button class="tbtn ${state.destView === 'grid' ? 'active' : ''}" data-destview="grid"><span class="ic">▦</span> Grid</button>  
        <button class="tbtn ${state.destView === 'browse' ? 'active' : ''}" data-destview="browse"><span class="ic">🗂️</span> Browse</button>
        <button class="tbtn" id="surprise-btn"><span class="ic">🎲</span> Surprise me</button>
      </div>

      ${insights.length ? `
        <div class="insight-banner" data-insight="${insights[0].id}">
          <span>${insights[0].text}</span>
          <button class="dismiss" data-dismiss="${insights[0].id}">✕</button>
        </div>` : ''}
    </div>

    <div class="filter-row">
      ${QUICK_FILTERS.map(f => `<button class="chip ${state.filter === f.id ? 'active' : ''}" data-filter="${f.id}">${f.label}</button>`).join('')}
      <div class="search-box">
        <span style="font-size:13px; color:var(--ink-faint);">⌕</span>
        <input type="text" id="search-input" placeholder="Search this destination…" value="${escapeHtml(state.query)}" />
      </div>
    </div>
    ${allTags.length ? `
      <div class="tag-filter-row">
        ${allTags.map(t => `<button class="chip tag ${state.activeTags.has(t) ? 'active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
      </div>` : ''}

    <div id="dest-content"></div>
  `;

  document.getElementById('edit-destination')
        .addEventListener('click', openEditDestinationSheet);

  document.getElementById('back-btn').addEventListener('click', goToCatalogue);
  document.getElementById('surprise-btn').addEventListener('click', () => surpriseMe());
  main.querySelectorAll('[data-destview]').forEach(el => {
    el.addEventListener('click', () => { state.destView = el.dataset.destview; renderDestination(); });
  });
  main.querySelectorAll('[data-filter]').forEach(el => {
    el.addEventListener('click', () => { state.filter = el.dataset.filter; renderDestination(); });
  });
  main.querySelectorAll('[data-tag]').forEach(el => {
    el.addEventListener('click', () => {
      const t = el.dataset.tag;
      if (state.activeTags.has(t)) state.activeTags.delete(t); else state.activeTags.add(t);
      renderDestination();
    });
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
    const isSelected =
      state.selectedGridCard?.id === el.dataset.id;

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
  const statusInfo = CARD_STATUSES[c.status] || CARD_STATUSES.new;
  const bg = c.image_url ? `style="background-image:url('${escapeHtml(c.image_url)}')"` : '';
  return `
    <div class="rcard" data-id="${c.id}">
      <div class="tab">${typeInfo.icon} ${typeInfo.label}</div>
      ${c.status !== 'new' ? `<div class="status-mark" title="${statusInfo.label}">${statusInfo.icon}</div>` : ''}
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
  const statusOptions = Object.entries(CARD_STATUSES).map(([k, v]) =>
    `<option value="${k}" ${c.status === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('');

  return `
    <div class="browse-card entering">
      <div class="thumb" ${bg}>${c.image_url ? '' : typeInfo.icon}</div>
      <div class="bc-body">
        <div class="tab">${typeInfo.icon} ${typeInfo.label}</div>
        <h3>${escapeHtml(c.title)}</h3>
        ${c.note ? `<p class="bc-note">"${escapeHtml(c.note)}"</p>` : ''}
        ${c.description ? `<p class="bc-desc">${escapeHtml(c.description)}</p>` : ''}
        <div class="bc-tags">${(c.tags || []).map(t => `<span class="rc-tags"><span>${escapeHtml(t)}</span></span>`).join('')}</div>
        <select class="status-select" id="bc-status">${statusOptions}</select>
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
  const statusSel = document.getElementById('bc-status');
  if (statusSel) statusSel.addEventListener('change', async () => {
    const newStatus = statusSel.value;
    c.status = newStatus;
    const local = state.cards.find(x => x.id === c.id);
    if (local) local.status = newStatus;
    try { await api.updateCard(c.id, { status: newStatus }); showToast(`Marked as ${CARD_STATUSES[newStatus].label.toLowerCase()}`); }
    catch (err) { showToast('Could not save — will retry when back online'); }
  });
  const delBtn = document.getElementById('bc-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!window.confirm(`Remove "${c.title}"? This can't be undone.`)) return;
    try {
      await api.deleteCard(c.id);
      state.cards = state.cards.filter(x => x.id !== c.id);
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
        <input
          type="text"
          id="ec-title"
          value="${escapeHtml(card.title || '')}"
        />
      </div>

      <div class="field">
        <label>Why did we save this?</label>
        <textarea
          id="ec-note"
          class="field-large"
          placeholder="This looks absolutely bonkers..."
        >${escapeHtml(card.note || '')}</textarea>
      </div>

      <div class="field">
        <label>Description</label>
        <textarea
          id="ec-description"
          class="field-large"
          placeholder="What is this?"
        >${escapeHtml(card.description || '')}</textarea>
      </div>

      <div class="field">
        <label>Type</label>

        <div class="capture-tabs">
          ${Object.entries(CARD_TYPES).map(([key, info]) => `
            <button
              class="capture-tab ${card.type === key ? 'active' : ''}"
              data-type="${key}">
              ${info.icon} ${info.label}
            </button>
          `).join('')}
        </div>
      </div>

      <div class="field">
        <label>Status</label>

        <select id="ec-status">
          ${Object.entries(CARD_STATUSES).map(([key, info]) => `
            <option
              value="${key}"
              ${card.status === key ? 'selected' : ''}>
              ${info.icon} ${info.label}
            </option>
          `).join('')}
        </select>
      </div>

      <div class="field">
        <label>Link</label>

        <input
          type="url"
          id="ec-url"
          value="${escapeHtml(card.url || '')}"
          placeholder="https://..."
        />
      </div>

      <div class="field">
        <label>Source</label>

        <input
          type="text"
          id="ec-source"
          value="${escapeHtml(card.source || '')}"
          placeholder="Website, publication, friend..."
        />
      </div>

      <div class="field">
        <label>Image URL</label>

        <input
          type="url"
          id="ec-image"
          value="${escapeHtml(card.image_url || '')}"
          placeholder="https://..."
        />
      </div>

      <div class="field location-field">
        <label>Location</label>

        <div class="location-search-wrap">
          <div class="location-input-wrap">
            <span class="location-icon">📍</span>

            <input
              type="text"
              id="ec-location"
              value="${escapeHtml(card.location_name || '')}"
              placeholder="Search for a place or address..."
              autocomplete="off"
            />

            <button
              type="button"
              class="location-clear"
              id="ec-location-clear"
              aria-label="Clear location"
              ${card.location_name ? '' : 'hidden'}
            >×</button>
          </div>

          <div
            class="location-results"
            id="ec-location-results"
            hidden
          ></div>
        </div>

        <p class="field-hint">
          Start typing a place and choose the matching location.
        </p>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Latitude</label>
          <input
            type="number"
            step="any"
            id="ec-lat"
            value="${card.lat ?? ''}"
          />
        </div>

        <div class="field">
          <label>Longitude</label>
          <input
            type="number"
            step="any"
            id="ec-lng"
            value="${card.lng ?? ''}"
          />
        </div>
      </div>

      <div class="field">
        <label>Tags</label>

        <div class="editable-tags" id="ec-tags"></div>
      </div>

      <div class="sheet-footer">
        <button class="btn-secondary" id="ec-cancel">
          Cancel
        </button>

        <button class="btn-primary" id="ec-save">
          Save changes
        </button>
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

      <button class="editable-tag add" id="ec-add-tag">
        + Add tag
      </button>
    `;

    container.querySelectorAll('[data-tag]').forEach(btn => {
      btn.addEventListener('click', () => {
        tags = tags.filter(t => t !== btn.dataset.tag);
        renderTags();
      });
    });

    document.getElementById('ec-add-tag')
      .addEventListener('click', () => {

        const value = prompt('Add a tag');

        if (!value) return;

        const tag = value.startsWith('#')
          ? value
          : `#${value}`;

        if (!tags.includes(tag)) {
          tags.push(tag);
          renderTags();
        }
      });
  };

  renderTags();

  const locationInput = document.getElementById('ec-location');
  const locationResults = document.getElementById('ec-location-results');
  const locationClear = document.getElementById('ec-location-clear');

  let locationSearchTimer = null;

  locationInput.addEventListener('input', () => {
    clearTimeout(locationSearchTimer);

    const query = locationInput.value.trim();

    locationClear.hidden = !query;

    // If the user changes the location manually,
    // don't retain the old coordinates.
    document.getElementById('ec-lat').value = '';
    document.getElementById('ec-lng').value = '';

    if (query.length < 3) {
      locationResults.hidden = true;
      locationResults.innerHTML = '';
      return;
    }

    locationResults.hidden = false;
    locationResults.innerHTML =
      `<div class="location-loading">Searching places…</div>`;

    locationSearchTimer = setTimeout(async () => {
      try {
        const results = await searchLocation(query);

        if (!results.length) {
          locationResults.innerHTML =
            `<div class="location-empty">No places found.</div>`;
          return;
        }

        locationResults.innerHTML = results.map((result, index) => `
          <button
            type="button"
            class="location-result"
            data-location-index="${index}"
          >
            <span class="location-result-icon">📍</span>
            <span class="location-result-text">
              <strong>${escapeHtml(
                result.display_name.split(',')[0]
              )}</strong>
              <small>${escapeHtml(
                result.display_name
                  .split(',')
                  .slice(1)
                  .join(',')
                  .trim()
              )}</small>
            </span>
          </button>
        `).join('');

        locationResults
          .querySelectorAll('[data-location-index]')
          .forEach(button => {
            button.addEventListener('click', () => {
              const result = results[
                Number(button.dataset.locationIndex)
              ];

              locationInput.value =
                result.display_name.split(',')[0];

              document.getElementById('ec-lat').value =
                result.lat;

              document.getElementById('ec-lng').value =
                result.lon;

              locationResults.hidden = true;

              locationClear.hidden = false;
            });
          });

      } catch (err) {
        console.error(err);

        locationResults.innerHTML =
          `<div class="location-empty">
            Couldn't search for that place.
          </div>`;
      }
    }, 400);
  });

  locationClear.addEventListener('click', () => {
    locationInput.value = '';
    document.getElementById('ec-lat').value = '';
    document.getElementById('ec-lng').value = '';
    locationResults.hidden = true;
    locationResults.innerHTML = '';
    locationClear.hidden = true;
    locationInput.focus();
  });

  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('ec-close')
    .addEventListener('click', () => overlay.remove());

  document.getElementById('ec-cancel')
    .addEventListener('click', () => overlay.remove());

  overlay.querySelectorAll('[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedType = btn.dataset.type;

      overlay
        .querySelectorAll('[data-type]')
        .forEach(b => b.classList.toggle(
          'active',
          b.dataset.type === selectedType
        ));
    });
  });

  document.getElementById('ec-save')
    .addEventListener('click', async () => {

      const button = document.getElementById('ec-save');

      const patch = {
        title: document.getElementById('ec-title').value.trim(),
        note: document.getElementById('ec-note').value.trim() || null,
        description:
          document.getElementById('ec-description').value.trim() || null,
        type: selectedType,
        status: document.getElementById('ec-status').value,
        url: document.getElementById('ec-url').value.trim() || null,
        source:
          document.getElementById('ec-source').value.trim() || null,
        image_url:
          document.getElementById('ec-image').value.trim() || null,
        location_name:
          document.getElementById('ec-location').value.trim() || null,
        lat: document.getElementById('ec-lat').value
          ? Number(document.getElementById('ec-lat').value)
          : null,
        lng: document.getElementById('ec-lng').value
          ? Number(document.getElementById('ec-lng').value)
          : null,
        tags
      };

      if (!patch.title) {
        alert('A card needs a title.');
        return;
      }

      button.disabled = true;
      button.textContent = 'Saving…';

      try {
        const updated =
          await api.updateCard(card.id, patch);

        const index =
          state.cards.findIndex(c => c.id === card.id);

        if (index >= 0) {
          state.cards[index] = updated;
        }

        state.destination =
          { ...state.destination };

        overlay.remove();

        renderDestination();

        showToast('Card updated');

      } catch (err) {
        button.disabled = false;
        button.textContent = 'Save changes';

        alert(
          'Could not save: ' +
          (err.message || err)
        );
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

// ---------- Map view ----------
function renderMapView(container, list) {
  const withLoc = list.filter(c => c.lat != null && c.lng != null);

  if (state.leafletMap) {
    state.leafletMap.remove();
    state.leafletMap = null;
  }

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
      ? '<p style="color:var(--ink-faint); font-size:13px;">None of the visible cards have a location yet.</p>'
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
          fillColor: isSelected ? '#d85c4a' : '#d85c4a',
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
    map.setView([39.5, -8], 6);
  }

  state.leafletMap = map;
}

// ============================================================
// Capture sheet — the core "+ Add" flow
// ============================================================
let captureDraft = { type: 'other', tags: new Set(), preview: null };

function openCaptureSheet() {
  if (!state.destination) return;
  captureDraft = { type: 'other', tags: new Set(), preview: null };
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
    status: 'new',
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
  document.getElementById('ad-save').addEventListener('click', async () => {
    const name = document.getElementById('ad-name').value.trim();
    if (!name) { window.alert('Give it a name.'); return; }
    const payload = {
      trip_id: state.trip.id,
      name,
      flag: document.getElementById('ad-flag').value.trim() || '✦',
      short_description: document.getElementById('ad-desc').value.trim() || null,
      sort_order: state.destinations.length,
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
        <input
          type="text"
          id="ed-name"
          value="${escapeHtml(d.name || '')}"
          placeholder="Portugal"
        />
      </div>

      <div class="field">
        <label>Flag</label>
        <input
          type="text"
          id="ed-flag"
          value="${escapeHtml(d.flag || '')}"
          placeholder="🇵🇹"
        />
      </div>

      <div class="field">
        <label>Short description</label>
        <textarea
          id="ed-short-description"
          placeholder="What's drawing you here?"
        >${escapeHtml(d.short_description || '')}</textarea>
      </div>

      <div class="field">
        <label>
          What we're looking for
          <span class="field-hint">
            The bigger picture — what are you curious about here?
          </span>
        </label>

        <textarea
          id="ed-description"
          class="field-large"
          placeholder="Slow travel, food, strange little places, architecture..."
        >${escapeHtml(d.description || '')}</textarea>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Start</label>
          <input
            type="date"
            id="ed-start"
            value="${d.planned_start || ''}"
          />
        </div>

        <div class="field">
          <label>End</label>
          <input
            type="date"
            id="ed-end"
            value="${d.planned_end || ''}"
          />
        </div>
      </div>

      <div class="field">
        <label>Planned days</label>
        <input
          type="number"
          id="ed-days"
          min="0"
          value="${d.planned_days || ''}"
          placeholder="21"
        />
      </div>

      <div class="field">
        <label>Cover image URL</label>
        <input
          type="url"
          id="ed-cover"
          value="${escapeHtml(d.cover_image || '')}"
          placeholder="https://..."
        />
      </div>

      <div class="field">
        <label>Google My Maps URL</label>
        <input
          type="url"
          id="ed-map"
          value="${escapeHtml(d.map_url || '')}"
          placeholder="https://www.google.com/maps/d/..."
        />
      </div>

      <div class="field">
        <label>Tags</label>

        <div class="editable-tags" id="ed-tags">
          ${tags.map(tag => `
            <button class="editable-tag" data-tag="${escapeHtml(tag)}">
              ${escapeHtml(tag)} <span>×</span>
            </button>
          `).join('')}

          <button class="editable-tag add" id="ed-add-tag">
            + Add tag
          </button>
        </div>
      </div>

      <div class="sheet-footer">
        <button class="btn-secondary" id="ed-cancel">
          Cancel
        </button>

        <button class="btn-primary" id="ed-save">
          Save changes
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('ed-close')
    .addEventListener('click', () => overlay.remove());

  document.getElementById('ed-cancel')
    .addEventListener('click', () => overlay.remove());

  function renderTags() {
    const container = document.getElementById('ed-tags');

    container.innerHTML = `
      ${tags.map(tag => `
        <button class="editable-tag" data-tag="${escapeHtml(tag)}">
          ${escapeHtml(tag)} <span>×</span>
        </button>
      `).join('')}

      <button class="editable-tag add" id="ed-add-tag">
        + Add tag
      </button>
    `;

    container.querySelectorAll('[data-tag]').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = tags.indexOf(btn.dataset.tag);
        if (index >= 0) tags.splice(index, 1);
        renderTags();
      });
    });

    document.getElementById('ed-add-tag')
      .addEventListener('click', () => {
        const value = window.prompt('Add a tag');

        if (!value) return;

        const tag = value.startsWith('#')
          ? value
          : `#${value}`;

        if (!tags.includes(tag)) {
          tags.push(tag);
          renderTags();
        }
      });
  }

  renderTags();

  document.getElementById('ed-save')
    .addEventListener('click', async () => {

      const button = document.getElementById('ed-save');

      const patch = {
        name: document.getElementById('ed-name').value.trim(),
        flag: document.getElementById('ed-flag').value.trim() || null,
        short_description:
          document.getElementById('ed-short-description').value.trim() || null,
        description:
          document.getElementById('ed-description').value.trim() || null,
        planned_start:
          document.getElementById('ed-start').value || null,
        planned_end:
          document.getElementById('ed-end').value || null,
        planned_days:
          Number(document.getElementById('ed-days').value) || null,
        cover_image:
          document.getElementById('ed-cover').value.trim() || null,
        map_url:
          document.getElementById('ed-map').value.trim() || null,
        tags
      };

      if (!patch.name) {
        alert('Give the destination a name.');
        return;
      }

      button.disabled = true;
      button.textContent = 'Saving…';

      try {
        const updated =
          await api.updateDestination(d.id, patch);

        state.destination = updated;

        const index =
          state.destinations.findIndex(x => x.id === updated.id);

        if (index >= 0) {
          state.destinations[index] = {
            ...state.destinations[index],
            ...updated
          };
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

async function searchLocation(query) {
  if (!query || query.trim().length < 3) return [];

  const destination = state.destination?.name || '';

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

window.addEventListener('popstate', (e) => {
  const id = location.hash.replace('#', '');
  if (id) openDestination(id); else goToCatalogue();
});

boot().then(() => {
  if (api.isConfigured()) ensureFab();
});
