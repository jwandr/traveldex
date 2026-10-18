// ============================================================
// Supabase project config
// Fill these in with your own project's values (Project Settings > API).
// The anon/public key is safe to expose client-side — access control
// is handled by the RLS policies in schema.sql.
// ============================================================
export const SUPABASE_URL = 'https://xvgzbvnaxcdcinoirzwh.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2Z3pidm5heGNkY2lub2lyendoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNjQ2MTgsImV4cCI6MjA5Mjg0MDYxOH0.9-IESH8qeR_bTl85fqTxeo8SPs0BZs5etC3pCXzD_FA';

// Optional: a free microlink.io API key raises the rate limit for
// URL preview fetching. Leave blank to use the unauthenticated tier.
export const MICROLINK_KEY = '';

// ============================================================
// Card types
// ============================================================
export const CARD_TYPES = {
  place:         { label: 'Place',         icon: '📍' },
  food:          { label: 'Food',          icon: '🍽️' },
  activity:      { label: 'Activity',      icon: '🥾' },
  article:       { label: 'Article',       icon: '📰' },
  video:         { label: 'Video',         icon: '🎬' },
  photo:         { label: 'Photo',         icon: '📷' },
  thought:       { label: 'Thought',       icon: '💭' },
  question:      { label: 'Question',      icon: '❓' },
  accommodation: { label: 'Accommodation', icon: '🛏️' },
  neighbourhood: { label: 'Neighbourhood', icon: '🏘️' },
  other:         { label: 'Other',         icon: '✦' },
};

// ============================================================
// Card statuses — how keen we are. Set by Triage; also drives map pins.
// ============================================================
export const CARD_STATUSES = {
  new:        { label: 'New',        icon: '·' },
  curious:    { label: 'Curious',    icon: '🤔' },
  maybe:      { label: 'Maybe',      icon: '🤷' },
  favourite:  { label: 'Very us',    icon: '❤️' },
  must_do:    { label: 'Must do',    icon: '⭐' },
  done:       { label: 'Done',       icon: '✅' },
  not_for_us: { label: 'Not for us', icon: '✕' },
};

// ============================================================
// Card opportunities — deliberately loose, meant to evolve over time
// ============================================================
export const CARD_OPPORTUNITIES = {
  big_ticket:    { label: 'Big Ticket',      icon: '💎' },
  free_low_cost: { label: 'Free & Low Cost', icon: '🪙' },
  local_life:    { label: 'Local Life',      icon: '🧺' },
  food_cooking:  { label: 'Food & Cooking',  icon: '🍳' },
  slow_moments:  { label: 'Slow Moments',    icon: '☕' },
  curiosities:   { label: 'Curiosities',     icon: '🔍' },
};

// Quick-pick tags shown during capture. The user can still type any
// custom tag — this list is just a nudge, not a fixed taxonomy.
export const SUGGESTED_TAGS = [
  '#slow', '#food', '#quirky', '#nature', '#culture',
  '#architecture', '#very-us', '#maybe', '#hiking', '#places',
];

// Filter bar presets — maps a filter id to a predicate description
export const QUICK_FILTERS = [
  { id: 'all',       label: 'All' },
  { id: 'place',     label: 'Places',   type: 'place' },
  { id: 'food',      label: 'Food',     type: 'food' },
  { id: 'link',      label: 'Links',    typeIn: ['article', 'video'] },
  { id: 'photo',     label: 'Photos',   type: 'photo' },
];

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function timeAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const diffMs = Date.now() - d.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export function formatDateRange(start, end) {
  if (!start) return '';
  const opts = { month: 'short', year: 'numeric' };
  const s = new Date(start).toLocaleDateString('en-AU', opts);
  if (!end) return s;
  const e = new Date(end).toLocaleDateString('en-AU', opts);
  return s === e ? s : `${s} – ${e}`;
}
