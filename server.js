// ================================================================
// ECO EYES VILLAGE — BOOKING SERVER
// Node.js + Express backend
//
// Start with: node server.js  (or: npm start)
// Requires Node.js 18+ (uses built-in fetch)
//
// What this file does:
//   1. Serves all static HTML/CSS/JS files from the project root
//   2. Provides API endpoints for the booking system
//   3. Proxies Hostex API calls (keeps API key server-side)
//   4. Creates Stripe Checkout Sessions for payment
//   5. Stripe webhook → creates Hostex reservation + sends email
// ================================================================

import express   from 'express';
import dotenv    from 'dotenv';
import Stripe    from 'stripe';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Stripe ────────────────────────────────────────────────────
// Only initialize if key looks real (starts with sk_test_ or sk_live_ + 20+ chars)
const _stripeKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = /^sk_(test|live)_\w{20,}/.test(_stripeKey)
  ? new Stripe(_stripeKey, { apiVersion: '2026-03-25.dahlia' })
  : null;
if (stripe) console.log('✅ Stripe initialized (API: 2026-03-25.dahlia)');
else        console.warn('⚠️  Stripe NOT active — STRIPE_SECRET_KEY missing or placeholder');

// ── Stripe webhook — must be registered BEFORE express.json() ─
// Stripe requires the raw (unparsed) body to verify the signature.
// express.json() would consume it first, breaking verification.
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

// ── JSON + static middleware ──────────────────────────────────
app.use(express.json());

// Canonical home URL — 301 redirect /index.html → / to consolidate the home
// page on a single URL (avoids duplicate-content / split analytics).
app.get('/index.html', (req, res) => res.redirect(301, '/'));

// Browsers auto-request /favicon.ico regardless of <link rel="icon">.
// The brand favicon lives at the S3 bucket, so redirect any auto-request
// there to avoid a noisy 404 in the network panel.
app.get('/favicon.ico', (req, res) =>
  res.redirect(302, 'https://eco-eyes-bucket.s3.ap-southeast-1.amazonaws.com/icon-circle.png'));

app.use(express.static(__dirname));   // serves index.html, booking.html etc.

// ── Config ───────────────────────────────────────────────────
const HOSTEX_API_KEY  = process.env.HOSTEX_API_KEY;
const HOSTEX_BASE     = 'https://api.hostex.io/v3';
const BASE_RATE       = parseInt(process.env.NIGHTLY_RATE  || '2700', 10);
const WEEKEND_RATE    = parseInt(process.env.WEEKEND_RATE  || '3500', 10);
// SITE_URL: explicit env var wins; fall back to Vercel's auto-injected URL (needs https:// prefix);
// finally fall back to localhost for local dev.
const SITE_URL = process.env.SITE_URL
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  || 'http://localhost:3000';
console.log('🌐 SITE_URL:', SITE_URL);
let   cachedPropertyId = process.env.HOSTEX_PROPERTY_ID || null;

function calcTotal(checkIn, checkOut) {
  let total = 0;
  const cur = new Date(checkIn + 'T12:00:00');
  const end = new Date(checkOut + 'T12:00:00');
  while (cur < end) {
    const d = cur.getDay();
    total += (d === 5 || d === 6) ? WEEKEND_RATE : BASE_RATE;
    cur.setDate(cur.getDate() + 1);
  }
  return total;
}

// ── Helper: HTML-escape a value before interpolating it into email HTML ──
// Guest name / room name / special requests are end-user input; without
// escaping, a crafted value (e.g. `<script>` or quote-breaking text) becomes
// HTML injection in the emails we send. Mirrors the audit-email escaper.
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Helper: validate a check-in/check-out pair from untrusted input ──
// Returns { ok, error?, nights? }. Rejects malformed dates, reversed/equal
// ranges (which would make calcTotal return 0 → a free/broken booking),
// stays that start in the past, and absurdly long ranges. `nights` is the
// authoritative night count derived from the dates (never trust client nights).
function validateStayDates(checkIn, checkOut) {
  const isISO = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isISO(checkIn) || !isISO(checkOut)) {
    return { ok: false, error: 'Dates must be valid YYYY-MM-DD' };
  }
  const inD  = new Date(checkIn  + 'T12:00:00');
  const outD = new Date(checkOut + 'T12:00:00');
  if (isNaN(inD) || isNaN(outD)) return { ok: false, error: 'Invalid calendar date' };
  const nights = Math.round((outD - inD) / 86400000);
  if (nights < 1)   return { ok: false, error: 'Check-out must be after check-in' };
  if (nights > 60)  return { ok: false, error: 'Stay length exceeds the 60-night maximum' };
  // Allow "today" (guests can book same-day); reject clearly past check-ins.
  const todayStr = new Date().toISOString().slice(0, 10);
  if (checkIn < todayStr) return { ok: false, error: 'Check-in date is in the past' };
  return { ok: true, nights };
}

// Fast lookup of the 10 valid room ids — used to reject unknown roomIds from
// the client before they reach Hostex (defined after ROOMS, see below).
let KNOWN_ROOM_IDS = null;

// Idempotency: referenceIds whose Hostex reservations have already been
// created. Guards against duplicate Stripe webhook deliveries within a warm
// instance; the Hostex existence pre-check in createHostexReservations is the
// cross-instance backstop.
const processedReferenceIds = new Set();

// ── Helper: extract day-level availability records from /availabilities ──
// Hostex returns:
//   { data: { properties: [{ id, availabilities: [{date, available, remarks}, ...] }] } }
// This flattens the nested structure to a list of { date, available, ... } day objects
// that callers can iterate directly. Returns [] for any unexpected shape.
function extractAvailabilityDays(calData) {
  const properties = calData?.data?.properties;
  if (!Array.isArray(properties)) return [];
  return properties.flatMap(p => Array.isArray(p?.availabilities) ? p.availabilities : []);
}

// ── Helper: iterate the dates a guest is actually staying ────
// For a check-in→check-out window, only the nights from check_in through
// (check_out - 1 day) need to be available — the check-out date itself is
// the next guest's check-in and doesn't block our stay.
function stayDateSet(checkIn, checkOut) {
  const set = new Set();
  const cur = new Date(checkIn);
  const end = new Date(checkOut);
  while (cur < end) {
    set.add(cur.toISOString().split('T')[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return set;
}

// ── Helper: is a Hostex day record "blocked"? ──
// Handles the field-name variations Hostex uses across channels/versions.
function isDayBlocked(d) {
  if (d.available === false || d.is_available === false) return true;
  if (d.is_blocked === true || d.blocked === true) return true;
  const status = (d.status || d.availability || '').toString().toLowerCase();
  return ['blocked','unavailable','reserved','booked'].includes(status);
}

// ── Universal Hostex list extractor ──────────────────────────
// Hostex v3 wraps responses as { error_code:200, data: { <key>:[...] } }
// where <key> varies by endpoint (properties, reservations, calendars, ...).
// Add new keys here when a new endpoint is integrated.
function extractList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  // data.data.* — nested object with named array (most common Hostex v3 shape)
  if (data.data?.properties     && Array.isArray(data.data.properties))     return data.data.properties;
  if (data.data?.reservations   && Array.isArray(data.data.reservations))   return data.data.reservations;
  if (data.data?.list           && Array.isArray(data.data.list))           return data.data.list;
  if (data.data?.orders         && Array.isArray(data.data.orders))         return data.data.orders;
  // Calendar endpoint variants — Hostex returns day-level availability under
  // several possible keys depending on the API version / endpoint variant.
  // We accept any of these so isListingAvailable's calendar check actually fires.
  if (data.data?.calendars      && Array.isArray(data.data.calendars))      return data.data.calendars;
  if (data.data?.calendar       && Array.isArray(data.data.calendar))       return data.data.calendar;
  if (data.data?.availability   && Array.isArray(data.data.availability))   return data.data.availability;
  if (data.data?.availabilities && Array.isArray(data.data.availabilities)) return data.data.availabilities;
  if (data.data?.days           && Array.isArray(data.data.days))           return data.data.days;
  if (data.data?.nights         && Array.isArray(data.data.nights))         return data.data.nights;
  // data.data itself is array
  if (data.data                 && Array.isArray(data.data))                return data.data;
  // top-level named arrays
  if (data.properties           && Array.isArray(data.properties))          return data.properties;
  if (data.reservations         && Array.isArray(data.reservations))        return data.reservations;
  if (data.list                 && Array.isArray(data.list))                return data.list;
  if (data.calendars            && Array.isArray(data.calendars))           return data.calendars;
  if (data.calendar             && Array.isArray(data.calendar))            return data.calendar;
  return [];
}

// ================================================================
// SHARED GUEST-CONTACT VALIDATION
// Single source of truth for "is this a real guest payload?". Used by every
// endpoint that creates a Hostex reservation so they can never drift apart.
//
// History: reservation 5-6B95CG5UI (Parnupong thongsuk, 2026-06-12) was
// created with guest_phone:"" and guest_email:"" because the old
// `if (!phone)` check accepted any truthy string — including "+66" (country
// code with no number behind it) or " " (whitespace only). Hostex then
// displayed "No phone number" at check-in. This helper closes that hole.
//
// The function:
//   1. Defensively coerces every field to a string (handles null, numbers,
//      arrays passed in via JSON).
//   2. Strips invisible characters (NBSP  , zero-width ​–‏)
//      so a copy-pasted phone with a non-breaking space behaves the same
//      as a normal one.
//   3. Normalises non-ASCII digits (Thai ๐-๙, Arabic-Indic ٠-٩) so phone
//      validation works regardless of keyboard layout.
//   4. Caps every field length (defence against crafted payloads).
//   5. Requires email to look like an email (TLD, no whitespace).
//   6. Requires phone to contain >= 6 actual digits.
// ================================================================
function normalizeGuestContact({ name, email, phone }) {
  // Step 1 — defensive coercion. Wrap with String(), then trim. Anything
  // that wasn't a usable string (null/undefined/array/object) becomes ''.
  const safe = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') return '';
    return String(v);
  };
  let cleanName  = safe(name);
  let cleanEmail = safe(email);
  let cleanPhone = safe(phone);

  // Step 2 — strip invisible characters that defeat eyeball QA.
  //   NBSP (U+00A0), zero-width chars (U+200B-200F), line/paragraph
  //   separators (U+2028, U+2029), word joiner (U+2060), BOM (U+FEFF),
  //   soft hyphen (U+00AD), and the C0 control range (U+0000-001F) + DEL.
  const stripInvisible = (s) => s
    .replace(/[\u00A0\u200B-\u200F\u2028\u2029\u2060\uFEFF\u00AD]/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '');

  cleanName  = stripInvisible(cleanName).trim();
  cleanEmail = stripInvisible(cleanEmail).trim();
  cleanPhone = stripInvisible(cleanPhone).trim();

  // Step 3 — normalise non-ASCII digits to ASCII so the digit count below
  // works for users typing on a Thai or Arabic keyboard.
  // Thai digits U+0E50..U+0E59, Arabic-Indic digits U+0660..U+0669.
  cleanPhone = cleanPhone
    .replace(/[\u0E50-\u0E59]/g, ch => String(ch.charCodeAt(0) - 0x0E50))
    .replace(/[\u0660-\u0669]/g, ch => String(ch.charCodeAt(0) - 0x0660));

  // Step 4 — length caps. Reject anything obviously crafted to overflow.
  if (cleanName.length  > 200) cleanName  = cleanName.slice(0, 200);
  if (cleanEmail.length > 320) cleanEmail = cleanEmail.slice(0, 320);  // RFC 5321 max
  if (cleanPhone.length > 40)  cleanPhone = cleanPhone.slice(0, 40);

  // Step 5 — content checks
  if (cleanName.length < 2) {
    return { ok: false, error: 'Name is required' };
  }
  if (!/^\S+@\S+\.\S+$/.test(cleanEmail) || cleanEmail.length < 6) {
    return { ok: false, error: 'A valid email address is required' };
  }
  const digitCount = (cleanPhone.match(/\d/g) || []).length;
  if (digitCount < 6) {
    return { ok: false, error: 'Phone number must contain at least 6 digits', detail: { phoneReceived: phone, digitCount } };
  }

  return { ok: true, normalized: { name: cleanName, email: cleanEmail, phone: cleanPhone } };
}


// ── Room definitions ──────────────────────────────────────────
// These are the 10 rooms at Eco Eyes Village. Each is a separate Hostex
// *property* (physical unit). As of 2026-07 Hostex groups all 10 under one
// room type "Glamping Suite" (id 216415) and sells them as a pooled inventory
// on the OTA channels (Airbnb/Booking.com/Agoda/Expedia/Trip.com) — but the
// website still books each room individually against its own property_id, and
// availability/reservations still key on property_id, so that model is intact.
//
// hostexId is the Hostex property id, PINNED here so a dashboard rename (Hostex
// renamed these to "01 The Sun" … "10 The Pluto") can never remap a booking to
// the wrong room. matchRoomsToListings() verifies each id against the live
// property list and falls back to name-matching only if the pinned id is gone.
// hostexName is the planet name still embedded in the (renamed) property title.
const ROOMS = [
  { id: 'sun',     num: '01', en: 'The Sun',     th: 'เดอะ ซัน',       zh: '太阳房',  hostexName: 'The Sun',     hostexId: 11809073 },
  { id: 'moon',    num: '02', en: 'The Moon',    th: 'เดอะ มูน',       zh: '月亮房',  hostexName: 'The Moon',    hostexId: 11963561 },
  { id: 'mercury', num: '03', en: 'The Mercury', th: 'เดอะ เมอร์คิวรี่', zh: '水星房', hostexName: 'The Mercury', hostexId: 11963570 },
  { id: 'earth',   num: '04', en: 'The Earth',   th: 'เดอะ เอิร์ธ',    zh: '地球房',  hostexName: 'The Earth',   hostexId: 11963598 },
  { id: 'mars',    num: '05', en: 'The Mars',    th: 'เดอะ มาร์ส',     zh: '火星房',  hostexName: 'The Mars',    hostexId: 11963599 },
  { id: 'jupiter', num: '06', en: 'The Jupiter', th: 'เดอะ จูปิเตอร์', zh: '木星房',  hostexName: 'The Jupiter', hostexId: 11963600 },
  { id: 'saturn',  num: '07', en: 'The Saturn',  th: 'เดอะ แซทเทิร์น', zh: '土星房',  hostexName: 'The Saturn',  hostexId: 11963601 },
  { id: 'uranus',  num: '08', en: 'The Uranus',  th: 'เดอะ ยูเรนัส',  zh: '天王星房', hostexName: 'The Uranus',  hostexId: 11963602 },
  { id: 'neptune', num: '09', en: 'The Neptune', th: 'เดอะ เนปจูน',   zh: '海王星房', hostexName: 'The Neptune', hostexId: 11963603 },
  { id: 'pluto',   num: '10', en: 'The Pluto',   th: 'เดอะ พลูโต',    zh: '冥王星房', hostexName: 'The Pluto',   hostexId: 11963608 },
];
KNOWN_ROOM_IDS = new Set(ROOMS.map(r => r.id));

// Cache matched hostex IDs per room (populated by matchRoomsToListings)
// Set to null on startup so a fresh fetch always happens on first request.
let roomListingCache = null;

// Cache for blocked-dates endpoint (15-min TTL)
let blockedDatesCache = null;
let blockedDatesCacheTime = 0;

// ================================================================
// HELPER: Fetch from Hostex API
// Auth header format used by Hostex v3: Authorization: {key}
// ================================================================
async function hostexFetch(path, options = {}) {
  const url = `${HOSTEX_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${HOSTEX_API_KEY}`,
      'Content-Type':  'application/json',
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hostex ${res.status} on ${path}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// ================================================================
// HELPER: Get all Hostex listings and match to our 10 rooms
// ================================================================
async function matchRoomsToListings() {
  if (roomListingCache) return roomListingCache;
  console.log('Fetching Hostex listings for room matching...');
  try {
    const data = await hostexFetch('/properties');
    const list = extractList(data);
    console.log(`Found ${list.length} Hostex listing(s)`, list.map(l => l.name || l.title || l.id));

    const idOf = (l) => l.id || l.property_id || l.listing_id;
    roomListingCache = ROOMS.map((room) => {
      // 1) Prefer the pinned property id — but only if it still exists in the
      //    live account (guards against a deleted/replaced property).
      let match = room.hostexId ? list.find(l => idOf(l) === room.hostexId) : null;
      // 2) Fall back to matching the planet name inside the (renamed) title,
      //    e.g. room "The Sun" → property "01 The Sun".
      if (!match) {
        const planet = room.en.toLowerCase().replace('the ', '');
        match = list.find(l => {
          const n = (l.name || l.title || '').toLowerCase();
          return n.includes(room.hostexName.toLowerCase()) || n.includes(planet);
        }) || null;
      }
      // 3) NO positional fallback. A wrong guess would silently book a real
      //    guest into the wrong physical room. Unmatched → null, which makes
      //    availability fail-closed (marked unavailable) and creation refuse.
      if (!match) console.warn(`⚠️  No Hostex property matched room "${room.en}" — it will be treated as unavailable until fixed.`);
      return { ...room, hostexId: match ? idOf(match) : null };
    });
  } catch (e) {
    console.warn('Could not match rooms to listings:', e.message);
    roomListingCache = ROOMS.map(r => ({ ...r, hostexId: null }));
  }
  return roomListingCache;
}

// ================================================================
// HELPER: Get (and cache) the first Hostex property ID
// ================================================================
async function getPropertyId() {
  if (cachedPropertyId) return cachedPropertyId;
  console.log('Fetching Hostex property list...');
  const data = await hostexFetch('/properties');
  const list = extractList(data);
  if (!list.length) throw new Error('No properties found in Hostex account');
  cachedPropertyId = list[0].id || list[0].property_id;
  console.log(`✅ Hostex property ID: ${cachedPropertyId}`);
  return cachedPropertyId;
}

// ================================================================
// HELPER: Check if a specific listing is available for the given dates.
// Queries from 90 days before check-in to catch reservations that
// STARTED before the requested dates but still overlap them.
// ================================================================
async function isListingAvailable(listingId, checkIn, checkOut) {
  const reqIn  = new Date(checkIn);
  const reqOut = new Date(checkOut);

  // ── Source 1: Availabilities — Hostex's calendar/availability endpoint.
  // Catches calendar blocks (Airbnb/Booking.com sync, manual blocks, owner
  // stays) that have no Hostex reservation record. Endpoint requires the
  // plural param `property_ids` (NOT property_id).
  // This is the AUTHORITATIVE source when it returns data.
  let calendarSawBlock = false;
  let calendarHadData  = false;
  try {
    const calData = await hostexFetch(
      `/availabilities?property_ids=${listingId}&start_date=${checkIn}&end_date=${checkOut}`
    );
    const days = extractAvailabilityDays(calData);
    if (days.length > 0) {
      calendarHadData = true;
      // Only check the nights actually being stayed (check_in through
      // check_out-1). The check-out date itself is the next guest's
      // check-in and doesn't block us.
      const stayDates = stayDateSet(checkIn, checkOut);
      calendarSawBlock = days.some(d => stayDates.has(d.date || d.day) && isDayBlocked(d));
      console.log(`  Calendar check listing ${listingId}: ${calendarSawBlock ? '❌ BLOCKED' : '✅ available'} (${days.length} days)`);
      // Calendar is the authoritative source — return immediately when it has data
      return !calendarSawBlock;
    } else {
      console.warn(`  Calendar returned no days for listing ${listingId} — falling back to reservations`);
    }
  } catch (e) {
    console.warn(`  Calendar endpoint failed for ${listingId}:`, e.message);
  }

  // ── Source 2: Reservations — fallback when calendar returned no data.
  // Use the exact requested window (matching /api/availability's working query)
  // — Hostex's date filter is liberal and returns reservations near the window
  // anyway, while a wider window combined with limit=100 risked truncating
  // the actual overlapping reservation past the cap.
  try {
    const data = await hostexFetch(
      `/reservations?property_id=${listingId}&start_date=${checkIn}&end_date=${checkOut}&limit=100`
    );
    const list = extractList(data);
    console.log(`  Reservations for listing ${listingId}: ${list.length} found`);

    // Exclusion list — only skip statuses that definitively free the room.
    const CANCELLED = ['cancelled', 'canceled', 'rejected', 'declined', 'expired', 'no_show', 'noshow'];
    const conflict = list
      .filter(r => !CANCELLED.includes((r.status || '').toLowerCase().replace(/ /g, '_')))
      .some(r => {
        const bIn  = new Date(r.check_in_date  || r.check_in  || r.checkin  || r.start_date);
        const bOut = new Date(r.check_out_date || r.check_out || r.checkout || r.end_date);
        if (isNaN(bIn) || isNaN(bOut)) return false;
        // Standard interval overlap: A starts before B ends AND A ends after B starts
        return reqIn < bOut && reqOut > bIn;
      });

    console.log(`  Reservation overlap check listing ${listingId}: ${conflict ? '❌ CONFLICT' : '✅ available'}`);
    return !conflict;
  } catch (e) {
    console.warn(`  Reservations fetch failed for listing ${listingId}:`, e.message);
    // Fail-closed: both calendar AND reservations failed. Treat as unavailable
    // rather than risk an overbooking. Guest can contact us via LINE/Messenger.
    return false;
  }
}

// ================================================================
// HELPER: Generate a unique booking reference  e.g. EEV-K7MX3P
// ================================================================
function generateRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let ref = 'EEV-';
  for (let i = 0; i < 6; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}

// ================================================================
// API: GET /api/rooms
// Returns all 10 rooms with per-room availability for a date range.
//
// Query params:
//   checkIn   YYYY-MM-DD  (optional — if provided, returns availability)
//   checkOut  YYYY-MM-DD
//
// Returns:
//   { success, rooms: [{ id, num, en, th, zh, available, blocked }] }
// ================================================================
app.get('/api/rooms', async (req, res) => {
  const today  = new Date().toISOString().split('T')[0];
  const future = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
  const start  = req.query.checkIn  || today;
  const end    = req.query.checkOut || future;

  try {
    const rooms = await matchRoomsToListings();

    const roomsWithAvail = await Promise.all(rooms.map(async (room) => {
      let available = true;

      if (room.hostexId && req.query.checkIn && req.query.checkOut) {
        console.log(`Checking availability for ${room.en} (hostexId: ${room.hostexId})`);
        available = await isListingAvailable(room.hostexId, req.query.checkIn, req.query.checkOut);
      } else if (!room.hostexId && req.query.checkIn && req.query.checkOut) {
        // Fail-closed: without a Hostex listing match we cannot verify availability
        // for the requested dates. Mark unavailable rather than risk an overbooking.
        console.warn(`No hostexId matched for ${room.en} — marking unavailable (fail-closed)`);
        available = false;
      }

      return {
        id:        room.id,
        num:       room.num,
        en:        room.en,
        th:        room.th,
        zh:        room.zh,
        hostexId:  room.hostexId,
        available,
        nightlyRate: BASE_RATE,
      };
    }));

    res.json({ success: true, rooms: roomsWithAvail, nightlyRate: BASE_RATE });
  } catch (err) {
    console.error('Rooms error:', err.message);
    // Fail-closed: if we can't reach Hostex at all, mark every room unavailable
    // and surface an error flag so the frontend can show a "contact us" message.
    // This is the deliberate safety policy — overbooking is worse than lost bookings.
    res.json({
      success: false,
      error: 'availability_check_failed',
      message: err.message,
      rooms: ROOMS.map(r => ({ ...r, available: false, blocked: [], nightlyRate: BASE_RATE })),
      nightlyRate: BASE_RATE,
    });
  }
});


// ================================================================
// API: GET /api/availability
// Legacy single-property availability (used as fallback).
// Returns blocked date ranges for Flatpickr.
// ================================================================
app.get('/api/availability', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const future = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0];
    const start  = req.query.start || today;
    const end    = req.query.end   || future;

    const propertyId = await getPropertyId();

    let blockedRanges = [];
    try {
      const data = await hostexFetch(
        `/reservations?property_id=${propertyId}&start_date=${start}&end_date=${end}&limit=100`
      );
      const list = extractList(data);
      const CANCELLED = ['cancelled','canceled','rejected','declined','expired','no_show','noshow'];
      blockedRanges = list
        .filter(r => !CANCELLED.includes((r.status || '').toLowerCase().replace(/ /g,'_')))
        .map(r => ({
          from: r.check_in_date || r.check_in || r.checkin || r.start_date,
          to:   r.check_out_date || r.check_out || r.checkout || r.end_date
        }))
        .filter(r => r.from && r.to);
    } catch (e) {
      console.warn('Reservations fetch failed:', e.message);
    }

    let blockedDates = [];
    try {
      const calData = await hostexFetch(
        `/availabilities?property_ids=${propertyId}&start_date=${start}&end_date=${end}`
      );
      const days = extractAvailabilityDays(calData);
      blockedDates = days.filter(isDayBlocked).map(d => d.date || d.day).filter(Boolean);
    } catch (e) {
      console.warn('Calendar fetch failed:', e.message);
    }

    res.json({ success: true, blocked: blockedRanges, blockedDates, nightlyRate: BASE_RATE });
  } catch (err) {
    console.error('Availability error:', err.message);
    res.json({ success: false, error: err.message, blocked: [], blockedDates: [], nightlyRate: BASE_RATE });
  }
});


// ================================================================
// API: POST /api/booking
// Called when guest submits the booking form.
//
// Body: { name, email, phone, guests, checkIn, checkOut,
//         nights, total, specialRequests, lang }
//
// Flow:
//   1. Validate inputs
//   2. Generate booking reference
//   3. [PAYMENT STEP — SiamPay goes here]
//   4. POST reservation to Hostex
//   5. Send confirmation email via Resend
//   6. Return { success, referenceId, ... }
// ================================================================
app.post('/api/booking', async (req, res) => {
  // `let` (not const) — name/email/phone get reassigned to the normalised,
  // validated versions returned by normalizeGuestContact() below.
  let { name, email, phone, guests, checkIn, checkOut,
        nights, total, specialRequests, lang,
        roomId, roomIds, roomName,
        extraBeds, petCount } = req.body;

  // ── Validation ───────────────────────────────────────────
  if (!checkIn || !checkOut || !guests) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  // Single source of truth — see normalizeGuestContact() near the top of
  // this file. Rejects empty/short phones, mistyped emails, oversized
  // payloads, Unicode-digit attempts at bypass.
  const v = normalizeGuestContact({ name, email, phone });
  if (!v.ok) {
    console.warn(`❌ Booking rejected: ${v.error}`, v.detail || '');
    return res.status(400).json({ success: false, error: v.error });
  }
  // Use the cleaned values downstream so Stripe metadata + Hostex always
  // get the canonical form, not the raw user input.
  ({ name, email, phone } = v.normalized);

  // ── Date validation — never trust client dates or `nights`. Rejects
  //    reversed/equal ranges (calcTotal would return 0), past check-ins and
  //    malformed dates. nightsNum is derived from the dates, not the payload.
  const sd = validateStayDates(checkIn, checkOut);
  if (!sd.ok) {
    return res.status(400).json({ success: false, error: sd.error });
  }
  const nightsNum = sd.nights;

  // ── Room validation — every id must be one of our 10 known rooms. An
  //    unknown id would otherwise fall through to a fallback property in
  //    createHostexReservations and book the wrong (or first) room.
  const allRoomIds = Array.isArray(roomIds) && roomIds.length > 0 ? roomIds : roomId ? [roomId] : [];
  const unknownRooms = allRoomIds.filter(id => !KNOWN_ROOM_IDS.has(id));
  if (unknownRooms.length) {
    return res.status(400).json({ success: false, error: `Unknown room(s): ${unknownRooms.join(', ')}` });
  }
  const roomCount = Math.max(allRoomIds.length, 1);

  // ── Extras — clamp to non-negative so a negative count can't discount the
  //    total below the true room price.
  const extraBedsNum  = Math.max(0, parseInt(extraBeds, 10) || 0);
  const petCountNum   = Math.max(0, parseInt(petCount,  10) || 0);

  const referenceId   = generateRef();
  const perRoomPrice  = calcTotal(checkIn, checkOut);
  const extraBedFee   = extraBedsNum * 1000 * roomCount;
  const petFee        = petCountNum  * nightsNum * 500;
  const serverTotal   = perRoomPrice * roomCount + extraBedFee + petFee;

  try {
    // ── Overbooking guard — re-verify availability right before taking
    //    payment. The client's view can be stale (another guest may have
    //    booked since the page loaded). isListingAvailable fails closed, so a
    //    Hostex error here means "treat as unavailable" rather than overbook.
    if (allRoomIds.length > 0) {
      const rooms = await matchRoomsToListings();
      const unavailable = [];
      for (const rid of allRoomIds) {
        const room = rooms.find(r => r.id === rid);
        const free = room && room.hostexId && await isListingAvailable(room.hostexId, checkIn, checkOut);
        if (!free) unavailable.push(room ? room.en : rid);
      }
      if (unavailable.length) {
        console.warn(`⛔ Booking blocked — no longer available: ${unavailable.join(', ')}`);
        return res.status(409).json({
          success: false,
          error: 'availability_changed',
          message: `Sorry, no longer available for your dates: ${unavailable.join(', ')}`,
        });
      }
    }

    // ── Stripe Checkout Session ──────────────────────────
    if (stripe) {
      const roomLabel = roomName || `${roomCount} room${roomCount !== 1 ? 's' : ''}`;

      // Build description with extras
      let desc = `${checkIn} → ${checkOut} · ${nightsNum} night${nightsNum !== 1 ? 's' : ''} · ${guests} guest${parseInt(guests) > 1 ? 's' : ''}`;
      if (extraBedsNum > 0) desc += ` · Extra bed ×${roomCount}`;
      if (petCountNum  > 0) desc += ` · ${petCountNum} pet${petCountNum > 1 ? 's' : ''}`;

      const session = await stripe.checkout.sessions.create({
        mode:  'payment',
        line_items: [{
          price_data: {
            currency:     'thb',
            unit_amount:  serverTotal * 100,
            product_data: {
              name:        `Eco Eyes Village — ${roomLabel}`,
              description: desc,
              images: ['https://eco-eyes-bucket.s3.ap-southeast-1.amazonaws.com/icon-circle.png'],
            },
          },
          quantity: 1,
        }],
        customer_email: email,
        metadata: {
          referenceId,
          name, email, phone, guests,
          checkIn, checkOut,
          nights:          String(nightsNum),
          roomIds:         JSON.stringify(allRoomIds),
          roomName:        roomName || '',
          specialRequests: specialRequests || '',
          lang:            lang || 'en',
          total:           String(serverTotal),
          extraBeds:       String(extraBedsNum),
          petCount:        String(petCountNum),
        },
        success_url: `${SITE_URL}/booking-confirm.html?ref=${referenceId}&checkIn=${checkIn}&checkOut=${checkOut}&nights=${nightsNum}&total=${serverTotal}&name=${encodeURIComponent(name)}&room=${encodeURIComponent(roomName || roomLabel)}&paid=1`,
        cancel_url:  `${SITE_URL}/booking.html?cancelled=1`,
      });

      console.log(`🔗 Stripe session created: ${referenceId} — ฿${serverTotal}`);
      return res.json({ success: true, requiresPayment: true, checkoutUrl: session.url, ref: referenceId });
    }

    // ── Fallback: no Stripe key set — redirect to preview checkout page ──
    console.warn('⚠️  STRIPE_SECRET_KEY not set — redirecting to checkout preview');
    const nightsNum2 = parseInt(nights, 10) || 1;
    const roomLabel2 = roomName || `${allRoomIds.length} room${allRoomIds.length !== 1 ? 's' : ''}`;
    const previewUrl = `${SITE_URL}/checkout-preview.html?ref=${referenceId}&amount=${serverTotal}&nights=${nightsNum2}&room=${encodeURIComponent(roomLabel2)}&checkIn=${checkIn}&checkOut=${checkOut}&name=${encodeURIComponent(name)}&guests=${guests}`;
    return res.json({ success: true, requiresPayment: true, checkoutUrl: previewUrl, ref: referenceId });

  } catch (err) {
    console.error('❌ Booking error:', err.message);
    if (err.type) console.error('   Stripe error type:', err.type);  // e.g. StripeAuthenticationError
    res.status(500).json({ success: false, error: err.message });
  }
});


// ================================================================
// HELPER: Create Hostex reservations for all selected rooms
// Called both by the Stripe webhook (paid) and the no-Stripe fallback.
// ================================================================
async function createHostexReservations({ allRoomIds, checkIn, checkOut, name, email, phone,
    guests, specialRequests, perRoomPrice, referenceId, nights }) {
  const allRooms  = await matchRoomsToListings();
  const targetIds = allRoomIds.length > 0 ? allRoomIds : [null];

  // ── Idempotency — Stripe delivers checkout.session.completed AT LEAST once,
  //    sometimes more. Without a guard, each delivery creates a fresh set of
  //    Hostex reservations (duplicate bookings). Two layers:
  //    (1) in-memory set — instant, covers rapid retries to a warm instance;
  //    (2) Hostex lookup — survives restarts / other instances by checking
  //        whether a reservation carrying this [Ref: …] already exists.
  if (referenceId && processedReferenceIds.has(referenceId)) {
    console.log(`↩️  ${referenceId}: already processed this instance — skipping duplicate create`);
    return;
  }
  if (referenceId) {
    try {
      const probeId = allRooms.find(r => targetIds.includes(r.id))?.hostexId || await getPropertyId();
      const existing = extractList(await hostexFetch(
        `/reservations?property_id=${probeId}&start_date=${checkIn}&end_date=${checkOut}&limit=100`));
      const refRe = new RegExp(`\\[Ref:\\s*${referenceId}\\b`, 'i');
      if (existing.some(r => refRe.test(String(r.remarks || '')))) {
        console.log(`↩️  ${referenceId}: reservation already exists in Hostex — skipping duplicate create`);
        processedReferenceIds.add(referenceId);
        return;
      }
    } catch (e) {
      // Pre-check is best-effort; if Hostex is unreachable we proceed (the
      // in-memory guard still prevents same-instance duplicates).
      console.warn(`Idempotency pre-check failed for ${referenceId} (proceeding):`, e.message);
    }
  }

  const nightsNum = parseInt(nights, 10) || 1;
  // Rate per night (average across stay); Hostex requires this separate from total
  const rateAmount = Math.round(perRoomPrice / nightsNum);

  // ── B: Structural guarantee that empty contact never reaches Hostex. ──
  // Even if a future endpoint forgets to call normalizeGuestContact() before
  // invoking this helper, the check runs here too — so by construction the
  // Hostex write either uses validated data or uses a glaring placeholder
  // that's impossible to miss in the dashboard.
  //
  // Failure policy: we do NOT skip the reservation (the customer has
  // already paid; losing their booking is worse than logging bad contact).
  // Instead we substitute placeholders that scream "look at me" so the team
  // sees them in Hostex's reservation list and can call/email recovery
  // before check-in.
  const validated = normalizeGuestContact({ name, email, phone });
  let safeName, safeEmail, safePhone;
  let placeholderUsed = false;
  if (validated.ok) {
    safeName  = validated.normalized.name;
    safeEmail = validated.normalized.email;
    safePhone = validated.normalized.phone;
  } else {
    placeholderUsed = true;
    const refTag = referenceId || 'UNKNOWN';
    // Loud, sortable placeholders. "MISSING-CONTACT-" is grep-able across
    // the Hostex dashboard and immediately tells the team this needs follow-up.
    safeName  = name && String(name).trim().length >= 2 ? String(name).trim().slice(0, 200) : `MISSING-NAME-REF-${refTag}`;
    safeEmail = email && /\S+@\S+\.\S+/.test(String(email)) ? String(email).trim() : `MISSING-EMAIL-REF-${refTag}@check-stripe.com`;
    safePhone = (() => {
      const digits = String(phone || '').replace(/\D+/g, '');
      return digits.length >= 6 ? String(phone).trim().slice(0, 40) : `MISSING-PHONE-CHECK-STRIPE-REF-${refTag}`;
    })();
    // ERROR (not warn) — anything subscribing to error-level logs in
    // production will get paged on this.
    console.error(`🚨 Hostex reservation ${refTag} — guest contact failed validation (${validated.error}).`);
    console.error(`   Raw: phone=${JSON.stringify(phone)} email=${JSON.stringify(email)} name=${JSON.stringify(name)}`);
    console.error(`   Written to Hostex as placeholders so the booking still lands. RECOVER FROM STRIPE.`);
  }

  for (const rid of targetIds) {
    const matched    = allRooms.find(r => r.id === rid);
    const propertyId = matched?.hostexId || await getPropertyId();
    // If the requested room had no Hostex match we still create the booking
    // (the guest already paid — losing it is worse) but against a fallback
    // property, which is the WRONG room. Scream so the team re-homes it.
    if (rid && !matched?.hostexId) {
      console.error(`🚨 Room "${rid}" has no Hostex property match — booking ${referenceId || ''} created against fallback property ${propertyId}. MOVE IT TO THE CORRECT ROOM IN HOSTEX.`);
    }
    const remarks    = `${specialRequests ? specialRequests + ' — ' : ''}Paid via Stripe${referenceId ? ` [Ref: ${referenceId}]` : ''}${placeholderUsed ? ' ⚠️ GUEST CONTACT MISSING — see Stripe for real phone/email' : ''}`.trim();
    const result = await hostexFetch('/reservations', {
      method: 'POST',
      body: JSON.stringify({
        property_id:       propertyId,
        custom_channel_id: 4913,          // "Direct Booking" channel in Hostex
        check_in_date:     checkIn,
        check_out_date:    checkOut,
        // Hostex v3 create-reservation expects FLAT fields named exactly
        // `guest_name`, `email`, and `mobile` — NOT `guest_email`/`guest_phone`.
        // Hostex silently ignores unrecognised keys (returns 200 + a valid
        // reservation_code), so the previous `guest_email`/`guest_phone` keys
        // were accepted and discarded — the name saved but phone/email were
        // dropped. See https://api-doc.hostex.io/reference/create-reservation
        guest_name:        safeName,
        email:             safeEmail,
        mobile:            safePhone,
        number_of_adults:  parseInt(guests, 10) || 1,
        number_of_guests:  parseInt(guests, 10) || 1,
        rate_amount:       rateAmount,
        commission_amount: 0,
        received_amount:   perRoomPrice,
        income_method_id:  1,             // Online/card payment
        total_price:       perRoomPrice,
        currency:          'THB',
        remarks,
        status:            'accepted',
      }),
    });
    const code = result?.data?.reservation?.reservation_code || 'unknown';
    const tag = placeholderUsed ? '⚠️ (placeholder contact)' : '✅';
    console.log(`  ${tag} Hostex reservation: ${matched?.en || rid} — ${code} (${checkIn} → ${checkOut})`);
  }
  // Mark done so a duplicate webhook delivery for the same booking is a no-op.
  if (referenceId) processedReferenceIds.add(referenceId);
  roomListingCache  = null;
  blockedDatesCache = null;
}


// ================================================================
// WEBHOOK: POST /api/stripe-webhook
// Stripe calls this after a successful payment.
// We create the Hostex reservation HERE (not at form submit) so
// rooms are only blocked once money is actually collected.
// ================================================================
async function handleStripeWebhook(req, res) {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  // ── A: Hard-fail in production if the signing secret isn't configured. ──
  // Without the secret, a malicious actor could POST a fake
  // `checkout.session.completed` event to this URL and create unpaid Hostex
  // reservations. The previous behaviour was to silently process unsigned
  // events with just a console warning — which meant a misconfigured
  // production env would be exploitable without anyone noticing. Now an
  // unsigned event in prod returns 503 and refuses to process anything.
  //
  // The unsigned-fallback is preserved ONLY for true localhost dev
  // (where Stripe can't reach us anyway) so the test-payment flow keeps
  // working when running `node server.js` directly.
  const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
  const isLocalhost = (req.hostname === 'localhost' || req.hostname === '127.0.0.1');
  if (!secret && (isProd || !isLocalhost)) {
    console.error('🚨 Stripe webhook BLOCKED — STRIPE_WEBHOOK_SECRET not set in production env');
    console.error('   Set it via: Vercel Dashboard → Settings → Environment Variables');
    return res.status(503).send('Webhook misconfigured: signing secret required');
  }
  if (!secret && !sig) {
    console.warn('⚠️  STRIPE_WEBHOOK_SECRET not set — DEV-ONLY unsigned mode');
  }

  let event;
  try {
    if (secret && sig) {
      // Verified path — requires raw body (Buffer or string)
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
    } else if (!secret && !isProd && isLocalhost) {
      // Dev-only path: parse without verification
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
        event = JSON.parse(req.body.toString());
      } else {
        event = req.body;
      }
    } else if (secret && !sig) {
      console.error('🚨 Stripe webhook BLOCKED — secret configured but request has no stripe-signature header');
      return res.status(400).send('Missing stripe-signature header');
    } else {
      console.error('🚨 Stripe webhook reached an unreachable branch — secret=' + !!secret + ' sig=' + !!sig + ' prod=' + isProd);
      return res.status(500).send('Webhook handler error');
    }
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  console.log(`📨 Webhook received: ${event.type}`);

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const meta     = session.metadata || {};
    const allRoomIds = JSON.parse(meta.roomIds || '[]');

    console.log(`💳 Stripe payment confirmed: ${meta.referenceId} — ฿${meta.total}`);

    try {
      await createHostexReservations({
        allRoomIds,
        checkIn:         meta.checkIn,
        checkOut:        meta.checkOut,
        name:            meta.name,
        email:           meta.email,
        phone:           meta.phone,
        guests:          meta.guests,
        specialRequests: meta.specialRequests,
        perRoomPrice:    calcTotal(meta.checkIn, meta.checkOut),
        referenceId:     meta.referenceId,
        nights:          meta.nights,
      });

      await sendConfirmationEmail({
        name:            meta.name,
        email:           meta.email,
        checkIn:         meta.checkIn,
        checkOut:        meta.checkOut,
        nights:          parseInt(meta.nights, 10),
        total:           parseInt(meta.total,  10),
        guests:          meta.guests,
        referenceId:     meta.referenceId,
        specialRequests: meta.specialRequests,
        lang:            meta.lang || 'en',
        roomName:        meta.roomName,
      });

      console.log(`✅ Booking complete: ${meta.referenceId} for ${meta.name}`);
    } catch (err) {
      console.error('Post-payment processing error:', err.message);
      // Still return 200 to Stripe so it doesn't retry — log for manual follow-up
    }
  }

  // ── B9: Abandoned-booking recovery ───────────────────────────────────
  // Stripe fires `checkout.session.expired` once the session timeout passes
  // (24h by default) without a successful payment. We send a one-shot recovery
  // email with a deep-link back to /booking.html that pre-fills the same
  // dates + guests so the user can resume in two taps.
  // Stripe is the source of truth — no extra "pending bookings" store is
  // needed; the metadata we set at session creation is still in the event.
  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    const meta    = session.metadata || {};
    if (!meta.email) {
      console.log('⏰ Session expired, no email in metadata — skipping recovery');
    } else {
      console.log(`⏰ Stripe session expired: ${meta.referenceId} — emailing ${meta.email}`);
      try {
        await sendRecoveryEmail({
          name:     meta.name || '',
          email:    meta.email,
          checkIn:  meta.checkIn,
          checkOut: meta.checkOut,
          nights:   parseInt(meta.nights, 10),
          guests:   meta.guests,
          roomName: meta.roomName,
          total:    parseInt(meta.total, 10),
          lang:     meta.lang || 'en',
        });
      } catch (err) {
        console.error('Recovery email failed:', err.message);
      }
    }
  }

  res.json({ received: true });
}


// ================================================================
// EMAIL: B9 — Abandoned-booking recovery
// Sent when a Stripe Checkout session expires without payment.
// One-shot email with a deep-link that pre-fills dates + guests so the
// user can resume the booking without re-entering anything.
// ================================================================
async function sendRecoveryEmail({ name, email, checkIn, checkOut,
    nights, guests, roomName, total, lang }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || key === 'YOUR_RESEND_API_KEY_HERE') {
    console.log('⚠️  Resend API key not set — skipping recovery email');
    return;
  }

  const isThai = lang === 'th';
  const isZh   = lang === 'zh';

  const subject = isThai
    ? 'การจองที่ Eco Eyes Village ยังรออยู่ — มาทำให้เสร็จกันต่อนะ'
    : isZh
    ? '您在 Eco Eyes Village 的预订仍在等您 — 来完成它吧'
    : 'Your Eco Eyes stay is still waiting — finish your booking';

  // Deep-link to /booking.html with the same dates/guests pre-filled. The page
  // already reads these query params at init and runs Check Availability for
  // the user automatically — so it's literally one click to resume.
  const params = new URLSearchParams();
  if (checkIn)  params.set('checkIn',  checkIn);
  if (checkOut) params.set('checkOut', checkOut);
  if (guests)   params.set('guests',   String(guests));
  const resumeUrl = `${SITE_URL}/booking.html?${params.toString()}`;

  const html = buildRecoveryEmailHtml({ name, checkIn, checkOut, nights,
    guests, roomName, total, isThai, isZh, resumeUrl });

  const response = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    `Eco Eyes Village <${process.env.FROM_EMAIL || 'bookings@ecoeyesvillage.com'}>`,
      to:      [email],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Recovery Resend error:', err);
  } else {
    console.log(`📧 Recovery email sent to ${email}`);
  }
}

function buildRecoveryEmailHtml({ name, checkIn, checkOut, nights,
    guests, roomName, total, isThai, isZh, resumeUrl }) {
  const fmt = d => d ? new Date(d + 'T12:00:00').toLocaleDateString(
    isThai ? 'th-TH' : isZh ? 'zh-CN' : 'en-GB',
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
  ) : '';

  const T = {
    eyebrow:   isThai ? 'การจองยังไม่เสร็จ' : isZh ? '预订未完成' : 'Booking unfinished',
    title:     isThai ? 'มาทำให้เสร็จกันต่อ' : isZh ? '继续完成预订' : 'Pick up where you left off',
    dear:      isThai ? 'เรียนคุณ' : isZh ? '亲爱的' : 'Hi',
    body:      isThai
      ? 'คุณเริ่มจองที่ Eco Eyes Village ไว้แต่ยังไม่ได้ชำระเงิน เราเก็บโดมและวันที่ของคุณไว้ คลิกด้านล่างเพื่อกลับไปจองต่อ — ใช้เวลาเพียงไม่กี่วินาที'
      : isZh
      ? '您已经开始预订 Eco Eyes Village，但尚未完成付款。我们已为您保留所选球顶屋和日期，点击下方按钮即可继续。'
      : 'You started a booking at Eco Eyes Village but didn\'t complete payment. We\'ve saved your dome and dates — finishing only takes a few seconds.',
    details:   isThai ? 'การจองของคุณ' : isZh ? '您的预订' : 'Your booking',
    room:      isThai ? 'ห้องพัก'      : isZh ? '球顶屋'  : 'Dome',
    checkin:   isThai ? 'เช็คอิน'      : isZh ? '入住'   : 'Check-in',
    checkout:  isThai ? 'เช็คเอาต์'    : isZh ? '退房'   : 'Check-out',
    nightsLbl: isThai ? 'จำนวนคืน'     : isZh ? '晚数'   : 'Nights',
    guestsLbl: isThai ? 'ผู้เข้าพัก'   : isZh ? '客人'   : 'Guests',
    totalLbl:  isThai ? 'ยอดรวม'      : isZh ? '总计'   : 'Total',
    cta:       isThai ? 'จองต่อให้เสร็จ' : isZh ? '继续预订' : 'Finish my booking',
    help:      isThai ? 'คำถาม? ติดต่อเราได้ทุกวัน:' : isZh ? '有问题？我们每日恭候：' : 'Questions? Real humans, every day:',
    bye:       isThai ? 'แล้วพบกันที่ Eco Eyes' : isZh ? '期待在 Eco Eyes 见到您' : 'See you under the trees,',
    team:      isThai ? 'ทีม Eco Eyes Village' : isZh ? 'Eco Eyes Village 团队' : 'The Eco Eyes Village team',
  };

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#EDE8DE;font-family:Georgia,serif">
  <div style="max-width:600px;margin:40px auto;background:#FAF7EF;border:1px solid #D4CEC4">
    <div style="background:#1C1915;padding:44px 40px;text-align:center">
      <p style="color:#C4A36A;font-family:Arial,sans-serif;font-size:9px;letter-spacing:5px;text-transform:uppercase;margin:0 0 14px">${T.eyebrow}</p>
      <h1 style="color:#FAF7EF;font-weight:300;font-size:28px;margin:0;letter-spacing:0.5px">${T.title}</h1>
    </div>
    <div style="padding:40px 40px 28px">
      <p style="color:#555;font-family:Arial,sans-serif;font-size:14px;margin:0 0 8px">${T.dear} ${escapeHtml(name || '')},</p>
      <p style="color:#666;font-family:Arial,sans-serif;font-size:14px;line-height:1.75;margin:0 0 26px">${T.body}</p>
      <div style="background:#F0EBE0;padding:24px 28px;border-left:3px solid #967138;margin-bottom:30px">
        <p style="color:#967138;font-family:Arial,sans-serif;font-size:9px;letter-spacing:4px;text-transform:uppercase;margin:0 0 16px">${T.details}</p>
        <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
          ${roomName ? `<tr><td style="padding:5px 0;color:#888;width:140px">${T.room}</td><td style="color:#333">${escapeHtml(roomName)}</td></tr>` : ''}
          ${checkIn  ? `<tr><td style="padding:5px 0;color:#888">${T.checkin}</td><td style="color:#333">${fmt(checkIn)}</td></tr>` : ''}
          ${checkOut ? `<tr><td style="padding:5px 0;color:#888">${T.checkout}</td><td style="color:#333">${fmt(checkOut)}</td></tr>` : ''}
          ${nights   ? `<tr><td style="padding:5px 0;color:#888">${T.nightsLbl}</td><td style="color:#333">${escapeHtml(nights)}</td></tr>` : ''}
          ${guests   ? `<tr><td style="padding:5px 0;color:#888">${T.guestsLbl}</td><td style="color:#333">${escapeHtml(guests)}</td></tr>` : ''}
          ${total    ? `<tr style="border-top:1px solid #D4CEC4"><td style="padding:10px 0 4px;color:#888">${T.totalLbl}</td><td style="padding:10px 0 4px;color:#967138;font-size:20px;font-weight:700">฿${parseInt(total).toLocaleString()}</td></tr>` : ''}
        </table>
      </div>
      <div style="text-align:center;margin-bottom:30px">
        <a href="${resumeUrl}" style="display:inline-block;background:#967138;color:#FAF7EF;font-family:Arial,sans-serif;font-size:13px;letter-spacing:2px;text-transform:uppercase;padding:16px 38px;text-decoration:none;font-weight:600">${T.cta}</a>
      </div>
      <p style="color:#666;font-family:Arial,sans-serif;font-size:13px;line-height:1.7;margin:0 0 4px">${T.help}</p>
      <p style="color:#555;font-family:Arial,sans-serif;font-size:13px;line-height:1.9;margin:0 0 22px">
        📞 +66 92 610 0560<br>✉️ ecoeyesvillagenaec@gmail.com
      </p>
      <p style="color:#888;font-family:Arial,sans-serif;font-size:13px;margin:18px 0 4px">${T.bye}</p>
      <p style="color:#888;font-family:Arial,sans-serif;font-size:13px;margin:0">${T.team}</p>
    </div>
    <div style="background:#1C1915;padding:20px 40px;text-align:center">
      <p style="color:#555;font-family:Arial,sans-serif;font-size:11px;margin:0">188 Moo 9, Sarika, Nakhon Nayok 26000, Thailand</p>
    </div>
  </div>
</body></html>`;
}


// ================================================================
// API: POST /api/test-payment   ⚠️  SANDBOX ONLY
// Simulates what happens after a successful Stripe payment —
// creates Hostex reservations and sends confirmation email —
// WITHOUT requiring a real payment. Only works when the Stripe key
// is a test key (sk_test_...). Use this to verify the full flow.
//
// Body: same as /api/booking
// Returns: { success, referenceId, hostexCreated, emailSent }
// ================================================================
app.post('/api/test-payment', async (req, res) => {
  if (!_stripeKey.startsWith('sk_test_')) {
    return res.status(403).json({ success: false, error: 'Test endpoint disabled in live mode' });
  }

  let { name, email, phone, guests, checkIn, checkOut, nights,
        specialRequests, lang, roomId, roomIds, roomName } = req.body;

  if (!checkIn || !checkOut) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  // Route through the same validator as /api/booking — no chance for
  // test-payment to fall behind on phone/email rules.
  const v = normalizeGuestContact({ name, email, phone });
  if (!v.ok) {
    return res.status(400).json({ success: false, error: v.error });
  }
  ({ name, email, phone } = v.normalized);

  const allRoomIds    = Array.isArray(roomIds) && roomIds.length > 0 ? roomIds : roomId ? [roomId] : [];
  const referenceId   = 'TEST-' + generateRef();
  const perRoomPrice  = calcTotal(checkIn, checkOut);
  const total         = perRoomPrice * Math.max(allRoomIds.length, 1);
  const nightsNum     = parseInt(nights, 10) || 1;

  console.log(`🧪 TEST PAYMENT: ${referenceId} — ${name} — ฿${total}`);

  let hostexCreated = false;
  let emailSent     = false;

  try {
    await createHostexReservations({ allRoomIds, checkIn, checkOut, name, email, phone,
      guests, specialRequests, perRoomPrice, referenceId });
    hostexCreated = true;
  } catch (err) {
    console.error('Test: Hostex failed:', err.message);
  }

  try {
    await sendConfirmationEmail({ name, email, checkIn, checkOut, nights: nightsNum,
      total, guests, referenceId, specialRequests, lang: lang || 'en', roomName });
    emailSent = true;
  } catch (err) {
    console.error('Test: Email failed:', err.message);
  }

  res.json({ success: true, referenceId, total, hostexCreated, emailSent,
    message: `Simulated payment complete. Hostex: ${hostexCreated ? '✅' : '❌'}  Email: ${emailSent ? '✅' : '❌'}` });
});


// ================================================================
// C: GET /api/audit-contacts  (cron — Vercel hits this daily)
// Scans Hostex reservations across the next 180 days for any direct
// booking with empty/short phone or email. Returns a JSON report and
// emails an alert to FROM_EMAIL if any broken records are found.
//
// Auth: must include `Authorization: Bearer ${CRON_SECRET}` header
// (Vercel cron sends this automatically when CRON_SECRET is set on
// the project's env). Without the secret, public callers get 401.
//
// History: built after Hostex reservations 5-6B95CG5UI and 5-6BBOR0I29
// were created with guest_phone/email = "" and the team didn't notice
// until check-in. This catches the same shape within 24h.
// ================================================================
app.get('/api/audit-contacts', async (req, res) => {
  // Auth — Vercel Cron forwards `Authorization: Bearer ${CRON_SECRET}`.
  // Same secret can be hit manually from a browser via `?secret=…`.
  //
  // FAIL CLOSED in production: an unset CRON_SECRET in a deployed
  // environment means the endpoint is exposed to anyone with the URL —
  // they could enumerate guest contact info from the JSON response.
  // Mirrors the Stripe webhook signature pattern in this same file: only
  // permit the unauthenticated path on true localhost dev.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const supplied = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (req.query.secret || '');
  const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
  const isLocalhost = (req.hostname === 'localhost' || req.hostname === '127.0.0.1');
  if (!cronSecret) {
    if (isProd || !isLocalhost) {
      console.error('🚨 /api/audit-contacts BLOCKED — CRON_SECRET not set in production env');
      console.error('   Set it via: Vercel Dashboard → Settings → Environment Variables');
      return res.status(503).json({ success: false, error: 'CRON_SECRET not configured' });
    }
    console.warn('⚠️  /api/audit-contacts called without CRON_SECRET — DEV-ONLY unauthenticated mode (localhost)');
  } else if (supplied !== cronSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const matched = await matchRoomsToListings();
    const today  = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);

    // Only flag bookings that came through OUR Stripe flow — those have
    // `[Ref: EEV-XXXXXX]` in the remarks. Everything else (manual entries,
    // influencer reviews, OTA channels mis-tagged as direct, tests, old
    // crusty records from before this fix) is noise for the team and would
    // make the daily alert email useless.
    const seenCodes = new Set();
    const broken = [];
    for (const room of matched.filter(r => r.hostexId)) {
      try {
        const data = await hostexFetch(`/reservations?property_id=${room.hostexId}&start_date=${today}&end_date=${future}&limit=100`);
        const list = extractList(data);
        for (const r of list) {
          // Dedupe: Hostex returns the same reservation across multiple
          // property queries when it spans more than one dome.
          if (seenCodes.has(r.reservation_code)) continue;
          // Only Stripe-flow direct bookings — grep the EEV reference.
          const remarks = String(r.remarks || '');
          if (!/\[Ref:\s*EEV-/i.test(remarks)) continue;

          seenCodes.add(r.reservation_code);

          // Hostex returns contact as `mobile`/`email` (same names as the
          // create payload), NOT `guest_phone`/`guest_email`. Fall back to the
          // old names defensively in case a future API version differs.
          const rPhone = r.mobile ?? r.guest_phone ?? '';
          const rEmail = r.email  ?? r.guest_email ?? '';
          const phoneDigits = String(rPhone).replace(/\D+/g, '').length;
          const emailOk     = /\S+@\S+\.\S+/.test(String(rEmail));
          const isPlaceholder = /^MISSING-/.test(String(rPhone)) ||
                                /^MISSING-/.test(String(rEmail));
          if (phoneDigits < 6 || !emailOk || isPlaceholder) {
            broken.push({
              property:        room.en,
              reservation:     r.reservation_code,
              guest_name:      r.guest_name,
              guest_email:     rEmail,
              guest_phone:     rPhone,
              check_in:        r.check_in_date,
              check_out:       r.check_out_date,
              booked_at:       r.booked_at,
              remarks:         r.remarks,
              issue:           isPlaceholder ? 'placeholder contact (recover from Stripe)'
                             : phoneDigits < 6 ? 'phone empty/short'
                             : 'email invalid',
            });
          }
        }
      } catch (e) {
        console.warn(`audit-contacts: property ${room.en} fetch failed:`, e.message);
      }
    }

    const summary = {
      success:       true,
      scanned_range: { from: today, to: future },
      broken_count:  broken.length,
      broken,
    };

    // Email the team if anything broken AND Resend is configured
    if (broken.length > 0 && process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 'YOUR_RESEND_API_KEY_HERE') {
      const to = process.env.AUDIT_ALERT_EMAIL || process.env.FROM_EMAIL || 'bookings@ecoeyesvillage.com';
      // HTML-escape every Hostex-supplied field before interpolation. Guest
      // name/email/phone come from end-user input via the booking form —
      // a malicious guest could put `<script>` or attribute-breaking quotes
      // into their name and trigger an XSS in the audit email rendered in
      // the team's inbox. Reservation code / property / dates come from
      // Hostex's API which we don't fully control either.
      const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
        ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

      const rows = broken.map(b => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee"><strong>${esc(b.reservation)}</strong><br><span style="color:#999;font-size:11px">${esc(b.property)}</span></td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee">${b.guest_name ? esc(b.guest_name) : '<em style="color:#aaa">(none)</em>'}<br><span style="color:#999;font-size:11px">${esc(b.check_in)} → ${esc(b.check_out)}</span></td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee"><code>${esc(b.guest_phone || '(empty)')}</code></td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee"><code>${esc(b.guest_email || '(empty)')}</code></td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#A8473B"><strong>${esc(b.issue)}</strong></td>
        </tr>`).join('');

      const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f6f5f0;padding:24px">
        <div style="max-width:760px;margin:0 auto;background:#fff;border:1px solid #ddd;padding:28px">
          <p style="color:#A8473B;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin:0">🚨 Hostex contact audit</p>
          <h1 style="margin:8px 0 4px;font-size:22px;color:#1C1915">${broken.length} direct booking${broken.length !== 1 ? 's' : ''} need follow-up</h1>
          <p style="color:#666;font-size:13px;margin:0 0 20px">Direct bookings with missing/short phone or email, or with placeholder contact fields. Recover the real values from Stripe and PATCH them into Hostex.</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px"><thead>
            <tr style="background:#f6f5f0;text-align:left">
              <th style="padding:8px 12px">Reservation</th>
              <th style="padding:8px 12px">Guest</th>
              <th style="padding:8px 12px">Phone</th>
              <th style="padding:8px 12px">Email</th>
              <th style="padding:8px 12px">Issue</th>
            </tr></thead><tbody>${rows}</tbody></table>
          <p style="color:#999;font-size:11px;margin:20px 0 0">Scanned ${esc(today)} → ${esc(future)}. This alert auto-fires daily via Vercel Cron.</p>
        </div></body></html>`;

      try {
        const r = await fetch('https://api.resend.com/emails', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:    `Eco Eyes Village <${process.env.FROM_EMAIL || 'bookings@ecoeyesvillage.com'}>`,
            to:      [to],
            subject: `🚨 Hostex contact audit: ${broken.length} booking${broken.length !== 1 ? 's' : ''} need follow-up`,
            html,
          }),
        });
        summary.alert_email_sent = r.ok;
        if (!r.ok) summary.alert_email_error = await r.text();
      } catch (e) {
        summary.alert_email_sent = false;
        summary.alert_email_error = e.message;
      }
    } else {
      summary.alert_email_sent = false;
      summary.alert_email_reason = broken.length === 0 ? 'no broken records' : 'RESEND_API_KEY not configured';
    }

    console.log(`🔍 audit-contacts: scanned ${matched.filter(r => r.hostexId).length} properties → ${broken.length} broken`);
    res.json(summary);
  } catch (err) {
    console.error('audit-contacts error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ================================================================
// API: GET /api/blocked-dates
// Returns all booked date ranges across all 10 rooms for the next
// 6 months. Used by the booking calendar to show unavailable dates.
// Cached for 15 minutes server-side.
// ================================================================
app.get('/api/blocked-dates', async (req, res) => {
  const CACHE_TTL = 15 * 60 * 1000;
  if (blockedDatesCache && Date.now() - blockedDatesCacheTime < CACHE_TTL) {
    return res.json(blockedDatesCache);
  }

  const today  = new Date().toISOString().split('T')[0];
  const future = new Date(Date.now() + 180 * 86400000).toISOString().split('T')[0];

  // Returns a Set of YYYY-MM-DD strings that are blocked for this room.
  // Calendar is AUTHORITATIVE — it catches both reservations and pure
  // calendar blocks (Airbnb/Booking.com sync, manual blocks). Reservations
  // is a fallback only used when the calendar endpoint returns no days.
  async function getBlockedDatesForRoom(room) {
    const blocked = new Set();
    let calendarHadData = false;
    try {
      const calData = await hostexFetch(
        `/availabilities?property_ids=${room.hostexId}&start_date=${today}&end_date=${future}`
      );
      const days = extractAvailabilityDays(calData);
      if (days.length > 0) {
        calendarHadData = true;
        for (const d of days) {
          if (isDayBlocked(d)) {
            const date = d.date || d.day;
            if (date) blocked.add(date);
          }
        }
      }
    } catch (e) {
      console.warn(`blocked-dates calendar failed for ${room.en}:`, e.message);
    }
    if (calendarHadData) return blocked;

    // Fallback: reservations (only reached if calendar returned empty)
    const CANCELLED = ['cancelled','canceled','rejected','declined','expired','no_show','noshow'];
    try {
      const data = await hostexFetch(
        `/reservations?property_id=${room.hostexId}&start_date=${today}&end_date=${future}&limit=100`
      );
      extractList(data)
        .filter(r => !CANCELLED.includes((r.status || '').toLowerCase().replace(/ /g, '_')))
        .forEach(r => {
          const from = r.check_in_date  || r.check_in  || r.start_date;
          const to   = r.check_out_date || r.check_out || r.end_date;
          if (!from || !to) return;
          const cur = new Date(from);
          const end = new Date(to);
          while (cur < end) {
            blocked.add(cur.toISOString().split('T')[0]);
            cur.setDate(cur.getDate() + 1);
          }
        });
    } catch (e) {
      console.warn(`blocked-dates reservations failed for ${room.en}:`, e.message);
    }
    return blocked;
  }

  try {
    const rooms = await matchRoomsToListings();
    const datesPerRoom = await Promise.all(
      rooms.filter(r => r.hostexId).map(getBlockedDatesForRoom)
    );

    // Count how many rooms are blocked per date → identify fully-blocked days
    const dateCounts = {};
    datesPerRoom.forEach(set => set.forEach(d => {
      dateCounts[d] = (dateCounts[d] || 0) + 1;
    }));

    const totalRooms   = rooms.filter(r => r.hostexId).length || ROOMS.length;
    const someBooked   = Object.keys(dateCounts);
    const fullyBlocked = someBooked.filter(d => dateCounts[d] >= totalRooms);

    blockedDatesCache = { success: true, someBooked, fullyBlocked };
    blockedDatesCacheTime = Date.now();
    res.json(blockedDatesCache);
  } catch (err) {
    console.error('blocked-dates error:', err.message);
    // Fail-closed shape: empty arrays so the frontend can't pretend things
    // are available; success:false signals the issue to anything that checks.
    res.json({ success: false, error: err.message, someBooked: [], fullyBlocked: [] });
  }
});

// ================================================================
// DEBUG: GET /api/debug/hostex
// Shows raw Hostex API responses to help diagnose matching issues.
// Open in browser: http://localhost:3000/api/debug/hostex
// ================================================================
app.get('/api/debug/hostex', async (req, res) => {
  // AUTH — this endpoint returns raw Hostex reservation objects, which include
  // guest name/phone/email. Leaving it open would leak guest PII to anyone with
  // the URL. Fail closed in production exactly like /api/audit-contacts: require
  // CRON_SECRET (Bearer header or ?secret=), allow the open path only on true
  // localhost dev.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const supplied = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.secret || '');
  const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
  const isLocalhost = (req.hostname === 'localhost' || req.hostname === '127.0.0.1');
  if (!cronSecret) {
    if (isProd || !isLocalhost) {
      return res.status(503).json({ error: 'debug endpoint disabled: CRON_SECRET not configured' });
    }
  } else if (supplied !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  roomListingCache = null; // always re-fetch on debug
  const out = {};
  try {
    out.properties_raw = await hostexFetch('/properties');
    out.properties_parsed = extractList(out.properties_raw);
    out.room_matching = (await matchRoomsToListings()).map(r => ({
      room: r.en, hostexId: r.hostexId
    }));
  } catch (e) { out.properties_error = e.message; }

  if (req.query.checkIn && req.query.checkOut) {
    try {
      const firstId = out.room_matching?.find(r => r.hostexId)?.hostexId;
      if (firstId) {
        out.sample_reservations_raw = await hostexFetch(
          `/reservations?property_id=${firstId}&start_date=${req.query.checkIn}&end_date=${req.query.checkOut}`
        );
        out.sample_reservations_parsed = extractList(out.sample_reservations_raw);
      }
    } catch (e) { out.reservations_error = e.message; }

    // Sample availabilities + reservations for the chosen listing.
    // ?listingId=… overrides which listing to sample (default: first matched).
    const sampleId = req.query.listingId || out.room_matching?.find(r => r.hostexId)?.hostexId;
    if (sampleId) {
      out.sample_listing_id = sampleId;
      // /availabilities (primary availability source — calendar blocks + reservations)
      try {
        out.sample_availabilities_raw = await hostexFetch(
          `/availabilities?property_ids=${sampleId}&start_date=${req.query.checkIn}&end_date=${req.query.checkOut}`
        );
        out.sample_availabilities_days = extractAvailabilityDays(out.sample_availabilities_raw);
      } catch (e) { out.availabilities_error = e.message; }

      // /reservations (fallback source — gets all bookings with limit=100)
      try {
        const r = await hostexFetch(
          `/reservations?property_id=${sampleId}&start_date=${req.query.checkIn}&end_date=${req.query.checkOut}&limit=100`
        );
        const list = extractList(r);
        out.sample_reservations_count = list.length;
        // Show only reservations that overlap the requested window
        const reqIn = new Date(req.query.checkIn);
        const reqOut = new Date(req.query.checkOut);
        out.sample_reservations_overlapping = list
          .filter(x => x.check_in_date && x.check_out_date)
          .filter(x => new Date(x.check_in_date) < reqOut && new Date(x.check_out_date) > reqIn)
          .map(x => ({ from: x.check_in_date, to: x.check_out_date, status: x.status }));
      } catch (e) { out.reservations_error = e.message; }
    }
  }

  res.json(out);
});

// ================================================================
// WEBHOOK: POST /api/hostex-webhook
//
// Set this URL in Hostex:
//   Settings → Integrations → Webhooks → Add Webhook
//   URL: https://your-domain.com/api/hostex-webhook
//
// Hostex will POST here whenever a booking arrives from Airbnb,
// Booking.com, or any other connected channel. This keeps
// our availability calendar in sync automatically — the next
// call to /api/availability will pick up the new reservation
// because it queries Hostex live.
//
// If you later add a local availability cache, invalidate it here.
// ================================================================
app.post('/api/hostex-webhook', (req, res) => {
  const event = req.body;
  console.log('Hostex webhook received:', JSON.stringify(event, null, 2));

  const eventType = event.event || event.type || 'unknown';

  if (eventType.includes('reservation') || eventType.includes('booking')) {
    // A new reservation came in from another channel.
    // The /api/availability endpoint queries Hostex live, so no
    // local cache invalidation is needed in this basic setup.
    console.log('📅 New external reservation — availability will reflect on next fetch');
  }

  // Always acknowledge immediately (Hostex expects a 200 quickly)
  res.json({ received: true });
});


// ================================================================
// EMAIL: Send booking confirmation via Resend
// https://resend.com — sign up and get a free API key
//
// Add your key to .env:  RESEND_API_KEY=re_xxxxxxxxxxxxx
// ================================================================
async function sendConfirmationEmail({ name, email, checkIn, checkOut,
    nights, total, guests, referenceId, specialRequests, lang, roomName }) {

  const key = process.env.RESEND_API_KEY;

  if (!key || key === 'YOUR_RESEND_API_KEY_HERE') {
    console.log('⚠️  Resend API key not set — skipping email. Add RESEND_API_KEY to .env');
    return;
  }

  const isThai  = lang === 'th';
  const subject = isThai
    ? `ยืนยันการจอง Eco Eyes Village — อ้างอิง: ${referenceId}`
    : `Booking Confirmation — Eco Eyes Village (Ref: ${referenceId})`;

  const html = buildEmailHtml({ name, checkIn, checkOut, nights,
    total, guests, referenceId, specialRequests, isThai, roomName });

  const response = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    `Eco Eyes Village <${process.env.FROM_EMAIL || 'bookings@ecoeyesvillage.com'}>`,
      to:      [email],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Resend error:', err);
    // Don't throw — booking already created, email is non-fatal
  } else {
    console.log(`📧 Confirmation email sent to ${email}`);
  }
}

// ── HTML email template ──────────────────────────────────────
function buildEmailHtml({ name, checkIn, checkOut, nights,
    total, guests, referenceId, specialRequests, isThai, roomName }) {

  const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString(
    isThai ? 'th-TH' : 'en-GB',
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
  );

  const T = {
    confirmed:  isThai ? 'ยืนยันการจองแล้ว' : 'Booking Confirmed',
    dear:       isThai ? 'เรียนคุณ'          : 'Dear',
    body:       isThai
      ? 'ขอบคุณสำหรับการจองที่ Eco Eyes Village เราได้รับคำขอจองของคุณแล้ว และจะติดต่อกลับเพื่อยืนยันเร็วๆ นี้'
      : 'Thank you for booking at Eco Eyes Village. We have received your request and will be in touch to confirm your stay.',
    details:    isThai ? 'รายละเอียดการจอง' : 'Booking Details',
    ref:        isThai ? 'รหัสอ้างอิง'      : 'Reference',
    room:       isThai ? 'ห้องพัก'           : 'Room',
    checkin:    isThai ? 'เช็คอิน'           : 'Check-in',
    checkout:   isThai ? 'เช็คเอาต์'         : 'Check-out',
    nightsLbl:  isThai ? 'จำนวนคืน'          : 'Nights',
    guestsLbl:  isThai ? 'จำนวนผู้เข้าพัก'  : 'Guests',
    totalLbl:   isThai ? 'ยอดรวมทั้งหมด'    : 'Total',
    requests:   isThai ? 'คำขอพิเศษ'        : 'Special Requests',
    questions:  isThai ? 'หากมีคำถาม กรุณาติดต่อเรา:' : 'Questions? Contact us:',
  };

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#EDE8DE;font-family:Georgia,serif">
  <div style="max-width:600px;margin:40px auto;background:#FAF7EF;border:1px solid #D4CEC4">
    <!-- Header -->
    <div style="background:#1C1915;padding:44px 40px;text-align:center">
      <p style="color:#C4A36A;font-family:Arial,sans-serif;font-size:9px;letter-spacing:5px;text-transform:uppercase;margin:0 0 14px">Eco Eyes Village · Nakhon Nayok, Thailand</p>
      <h1 style="color:#FAF7EF;font-weight:300;font-size:30px;margin:0;letter-spacing:1px">${T.confirmed}</h1>
    </div>
    <!-- Body -->
    <div style="padding:44px 40px">
      <p style="color:#555;font-family:Arial,sans-serif;font-size:14px;margin:0 0 8px">${T.dear} ${escapeHtml(name)},</p>
      <p style="color:#666;font-family:Arial,sans-serif;font-size:14px;line-height:1.75;margin:0 0 28px">${T.body}</p>
      <!-- Details box -->
      <div style="background:#F0EBE0;padding:28px 32px;border-left:3px solid #967138;margin-bottom:28px">
        <p style="color:#967138;font-family:Arial,sans-serif;font-size:9px;letter-spacing:4px;text-transform:uppercase;margin:0 0 20px">${T.details}</p>
        <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
          <tr><td style="padding:6px 0;color:#888;width:140px">${T.ref}</td>
              <td style="color:#1C1915;font-weight:700;font-size:15px;letter-spacing:1px">${referenceId}</td></tr>
          ${roomName ? `<tr><td style="padding:6px 0;color:#888">${T.room}</td>
              <td style="color:#333">${escapeHtml(roomName)}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#888">${T.checkin}</td>
              <td style="color:#333">${fmt(checkIn)}</td></tr>
          <tr><td style="padding:6px 0;color:#888">${T.checkout}</td>
              <td style="color:#333">${fmt(checkOut)}</td></tr>
          <tr><td style="padding:6px 0;color:#888">${T.nightsLbl}</td>
              <td style="color:#333">${nights}</td></tr>
          <tr><td style="padding:6px 0;color:#888">${T.guestsLbl}</td>
              <td style="color:#333">${escapeHtml(guests)}</td></tr>
          <tr style="border-top:1px solid #D4CEC4">
              <td style="padding:12px 0 6px;color:#888">${T.totalLbl}</td>
              <td style="padding:12px 0 6px;color:#967138;font-size:22px;font-weight:700">฿${parseInt(total).toLocaleString()}</td></tr>
        </table>
        ${specialRequests ? `<p style="margin:14px 0 0;color:#666;font-family:Arial,sans-serif;font-size:12px;border-top:1px solid #D4CEC4;padding-top:12px"><strong>${T.requests}:</strong> ${escapeHtml(specialRequests)}</p>` : ''}
      </div>
      <p style="color:#666;font-family:Arial,sans-serif;font-size:13px;line-height:1.7">${T.questions}</p>
      <p style="color:#555;font-family:Arial,sans-serif;font-size:13px;line-height:1.9">
        📞 +66 92 610 0560<br>✉️ ecoeyesvillagenaec@gmail.com
      </p>
    </div>
    <!-- Footer -->
    <div style="background:#1C1915;padding:24px 40px;text-align:center">
      <p style="color:#555;font-family:Arial,sans-serif;font-size:11px;margin:0">188 Moo 9, Sarika, Nakhon Nayok 26000, Thailand</p>
      <p style="color:#444;font-family:Arial,sans-serif;font-size:11px;margin:6px 0 0">© 2025 Eco Eyes Village</p>
    </div>
  </div>
</body></html>`;
}


// ================================================================
// Start server (local dev only — Vercel uses the export below)
// ================================================================
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`\n🌿 Eco Eyes Village server running at http://localhost:${PORT}`);
    console.log(`   Booking page: http://localhost:${PORT}/booking.html\n`);
    if (!HOSTEX_API_KEY) console.warn('⚠️  HOSTEX_API_KEY not set in .env');
  });
}

export default app;
