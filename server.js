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
const stripe = /^sk_(test|live)_\w{20,}/.test(_stripeKey) ? new Stripe(_stripeKey) : null;
if (stripe) console.log('✅ Stripe initialized');
else        console.warn('⚠️  Stripe NOT active — STRIPE_SECRET_KEY missing or placeholder');

// ── Stripe webhook — must be registered BEFORE express.json() ─
// Stripe requires the raw (unparsed) body to verify the signature.
// express.json() would consume it first, breaking verification.
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

// ── JSON + static middleware ──────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));   // serves index.html, booking.html etc.

// ── Config ───────────────────────────────────────────────────
const HOSTEX_API_KEY  = process.env.HOSTEX_API_KEY;
const HOSTEX_BASE     = 'https://api.hostex.io/v3';
const BASE_RATE       = parseInt(process.env.NIGHTLY_RATE  || '2700', 10);
const WEEKEND_RATE    = parseInt(process.env.WEEKEND_RATE  || '3500', 10);
const SITE_URL        = process.env.SITE_URL || 'http://localhost:3000';
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

// ── Universal Hostex list extractor ──────────────────────────
// Hostex v3 wraps responses as { error_code:200, data: { properties:[...] } }
// but endpoint shape varies (list, reservations, properties, etc.)
function extractList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  // data.data.* — nested object with named array
  if (data.data?.properties   && Array.isArray(data.data.properties))   return data.data.properties;
  if (data.data?.reservations && Array.isArray(data.data.reservations)) return data.data.reservations;
  if (data.data?.list         && Array.isArray(data.data.list))         return data.data.list;
  if (data.data?.orders       && Array.isArray(data.data.orders))       return data.data.orders;
  // data.data itself is array
  if (data.data               && Array.isArray(data.data))               return data.data;
  // top-level named arrays
  if (data.properties         && Array.isArray(data.properties))         return data.properties;
  if (data.reservations       && Array.isArray(data.reservations))       return data.reservations;
  if (data.list               && Array.isArray(data.list))               return data.list;
  return [];
}

// ── Room definitions ──────────────────────────────────────────
// These are the 10 rooms at Eco Eyes Village.
// hostexName should match the listing name in your Hostex dashboard.
// Once Hostex listings are confirmed, set hostexId via HOSTEX_ROOM_xx env vars.
const ROOMS = [
  { id: 'sun',     num: '01', en: 'The Sun',     th: 'เดอะ ซัน',       zh: '太阳房',  hostexName: 'The Sun'     },
  { id: 'moon',    num: '02', en: 'The Moon',    th: 'เดอะ มูน',       zh: '月亮房',  hostexName: 'The Moon'    },
  { id: 'mercury', num: '03', en: 'The Mercury', th: 'เดอะ เมอร์คิวรี่', zh: '水星房', hostexName: 'The Mercury' },
  { id: 'earth',   num: '04', en: 'The Earth',   th: 'เดอะ เอิร์ธ',    zh: '地球房',  hostexName: 'The Earth'   },
  { id: 'mars',    num: '05', en: 'The Mars',    th: 'เดอะ มาร์ส',     zh: '火星房',  hostexName: 'The Mars'    },
  { id: 'jupiter', num: '06', en: 'The Jupiter', th: 'เดอะ จูปิเตอร์', zh: '木星房',  hostexName: 'The Jupiter' },
  { id: 'saturn',  num: '07', en: 'The Saturn',  th: 'เดอะ แซทเทิร์น', zh: '土星房',  hostexName: 'The Saturn'  },
  { id: 'uranus',  num: '08', en: 'The Uranus',  th: 'เดอะ ยูเรนัส',  zh: '天王星房', hostexName: 'The Uranus'  },
  { id: 'neptune', num: '09', en: 'The Neptune', th: 'เดอะ เนปจูน',   zh: '海王星房', hostexName: 'The Neptune' },
  { id: 'pluto',   num: '10', en: 'The Pluto',   th: 'เดอะ พลูโต',    zh: '冥王星房', hostexName: 'The Pluto'   },
];

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

    roomListingCache = ROOMS.map((room, idx) => {
      const match = list.find(l => {
        const n = (l.name || l.title || '').toLowerCase();
        return n.includes(room.hostexName.toLowerCase()) ||
               n.includes(room.en.toLowerCase().replace('the ', ''));
      }) || list[idx] || null;

      const hostexId = match ? (match.id || match.property_id || match.listing_id) : null;
      return { ...room, hostexId };
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

  // Try calendar endpoint first — day-by-day is the most reliable
  try {
    const calData = await hostexFetch(
      `/calendar?listing_id=${listingId}&start_date=${checkIn}&end_date=${checkOut}`
    );
    const days = extractList(calData);
    if (days.length > 0) {
      const blocked = days.some(d =>
        d.available === false || d.status === 'blocked' || d.status === 'unavailable'
      );
      console.log(`  Calendar check listing ${listingId}: ${blocked ? '❌ BLOCKED' : '✅ available'}`);
      return !blocked;
    }
  } catch (e) {
    console.warn(`  Calendar endpoint failed for ${listingId}:`, e.message);
  }

  // Fall back: query reservations with a wide window (90 days before check-in)
  // to catch reservations that started earlier but overlap our dates.
  try {
    const wideStart = new Date(reqIn.getTime() - 90 * 86400000).toISOString().split('T')[0];
    const data = await hostexFetch(
      `/reservations?property_id=${listingId}&start_date=${wideStart}&end_date=${checkOut}`
    );
    const list = extractList(data);
    console.log(`  Reservations for listing ${listingId}: ${list.length} found`);

    // Use an exclusion list — only skip statuses that definitely free the room.
    // This catches 'pending check-in', 'checked in', 'checked_in', etc.
    const CANCELLED = ['cancelled', 'canceled', 'rejected', 'declined', 'expired', 'no_show', 'noshow'];
    const conflict = list
      .filter(r => !CANCELLED.includes((r.status || '').toLowerCase().replace(/ /g, '_')))
      .some(r => {
        // Hostex v3 uses check_in_date / check_out_date
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
    return true;
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
      } else if (!room.hostexId) {
        console.warn(`No hostexId matched for ${room.en} — showing as available`);
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
    // Fall back: return all rooms as available
    res.json({
      success: true,
      rooms: ROOMS.map(r => ({ ...r, available: true, blocked: [], nightlyRate: BASE_RATE })),
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
        `/reservations?property_id=${propertyId}&start_date=${start}&end_date=${end}`
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
        `/calendar?property_id=${propertyId}&start_date=${start}&end_date=${end}`
      );
      const days = extractList(calData);
      blockedDates = days
        .filter(d => d.available === false || d.status === 'blocked' || d.status === 'unavailable')
        .map(d => d.date);
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
  const { name, email, phone, guests, checkIn, checkOut,
          nights, total, specialRequests, lang,
          roomId, roomIds, roomName } = req.body;

  // ── Validation ───────────────────────────────────────────
  if (!name || !email || !phone || !checkIn || !checkOut || !guests) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  if (!/\S+@\S+\.\S+/.test(email)) {
    return res.status(400).json({ success: false, error: 'Invalid email address' });
  }

  // Support both single roomId and multi-room roomIds array
  const allRoomIds = Array.isArray(roomIds) && roomIds.length > 0
    ? roomIds
    : roomId ? [roomId] : [];

  const referenceId = generateRef();
  const perRoomPrice = calcTotal(checkIn, checkOut);
  const serverTotal  = perRoomPrice * Math.max(allRoomIds.length, 1);

  try {
    // ── Stripe Checkout Session ──────────────────────────
    if (stripe) {
      const roomLabel = roomName || `${allRoomIds.length} room${allRoomIds.length !== 1 ? 's' : ''}`;
      const nightsNum = parseInt(nights, 10) || 1;
      const session = await stripe.checkout.sessions.create({
        mode:                 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency:     'thb',
            unit_amount:  serverTotal * 100,  // satang (smallest THB unit)
            product_data: {
              name:        `Eco Eyes Village — ${roomLabel}`,
              description: `${checkIn} → ${checkOut} · ${nightsNum} night${nightsNum !== 1 ? 's' : ''} · ${guests} guest${guests > 1 ? 's' : ''}`,
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
          nights: String(nightsNum),
          roomIds: JSON.stringify(allRoomIds),
          roomName: roomName || '',
          specialRequests: specialRequests || '',
          lang: lang || 'en',
          total: String(serverTotal),
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
    guests, specialRequests, perRoomPrice, referenceId }) {
  const allRooms  = await matchRoomsToListings();
  const targetIds = allRoomIds.length > 0 ? allRoomIds : [null];

  for (const rid of targetIds) {
    const matched    = allRooms.find(r => r.id === rid);
    const propertyId = matched?.hostexId || await getPropertyId();
    await hostexFetch('/reservations', {
      method: 'POST',
      body: JSON.stringify({
        property_id:      propertyId,
        check_in_date:    checkIn,
        check_out_date:   checkOut,
        guest_name:       name,
        guest_email:      email,
        guest_phone:      phone,
        number_of_adults: parseInt(guests, 10) || 1,
        number_of_guests: parseInt(guests, 10) || 1,
        total_price:      perRoomPrice,
        currency:         'THB',
        remarks:          `${specialRequests || ''}${referenceId ? ` [Ref: ${referenceId}]` : ''}`.trim(),
        channel_type:     'hostex_direct',
        status:           'accepted',
        creator:          'Eco Eyes Village',
      }),
    });
    console.log(`  ✅ Hostex reservation: ${matched?.en || rid} (${checkIn} → ${checkOut})`);
  }
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

  let event;
  try {
    if (secret) {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } else {
      // No webhook secret set — parse body directly (dev/testing only)
      event = JSON.parse(req.body.toString());
      console.warn('⚠️  STRIPE_WEBHOOK_SECRET not set — skipping signature check');
    }
  } catch (err) {
    console.error('Stripe webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

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

  res.json({ received: true });
}


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

  try {
    const rooms = await matchRoomsToListings();
    const CANCELLED = ['cancelled','canceled','rejected','declined','expired','no_show','noshow'];

    // Fetch reservations for all rooms in parallel
    const allRoomRanges = await Promise.all(
      rooms.filter(r => r.hostexId).map(async (room) => {
        try {
          const data = await hostexFetch(
            `/reservations?property_id=${room.hostexId}&start_date=${today}&end_date=${future}`
          );
          return extractList(data)
            .filter(r => !CANCELLED.includes((r.status || '').toLowerCase().replace(/ /g, '_')))
            .map(r => ({
              roomId: room.id,
              from: r.check_in_date  || r.check_in  || r.start_date,
              to:   r.check_out_date || r.check_out || r.end_date,
            }))
            .filter(r => r.from && r.to);
        } catch { return []; }
      })
    );

    const flat = allRoomRanges.flat();

    // Count rooms booked per date to identify fully-blocked days
    const dateCounts = {};
    flat.forEach(({ from, to }) => {
      const cur = new Date(from);
      const end = new Date(to);
      while (cur < end) {
        const d = cur.toISOString().split('T')[0];
        dateCounts[d] = (dateCounts[d] || 0) + 1;
        cur.setDate(cur.getDate() + 1);
      }
    });

    const totalRooms = rooms.filter(r => r.hostexId).length || ROOMS.length;
    const someBooked = Object.keys(dateCounts);
    const fullyBlocked = someBooked.filter(d => dateCounts[d] >= totalRooms);

    blockedDatesCache = { success: true, someBooked, fullyBlocked, ranges: flat };
    blockedDatesCacheTime = Date.now();
    res.json(blockedDatesCache);
  } catch (err) {
    console.error('blocked-dates error:', err.message);
    res.json({ success: false, someBooked: [], fullyBlocked: [], ranges: [] });
  }
});

// ================================================================
// DEBUG: GET /api/debug/hostex
// Shows raw Hostex API responses to help diagnose matching issues.
// Open in browser: http://localhost:3000/api/debug/hostex
// ================================================================
app.get('/api/debug/hostex', async (req, res) => {
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
      <p style="color:#555;font-family:Arial,sans-serif;font-size:14px;margin:0 0 8px">${T.dear} ${name},</p>
      <p style="color:#666;font-family:Arial,sans-serif;font-size:14px;line-height:1.75;margin:0 0 28px">${T.body}</p>
      <!-- Details box -->
      <div style="background:#F0EBE0;padding:28px 32px;border-left:3px solid #967138;margin-bottom:28px">
        <p style="color:#967138;font-family:Arial,sans-serif;font-size:9px;letter-spacing:4px;text-transform:uppercase;margin:0 0 20px">${T.details}</p>
        <table style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
          <tr><td style="padding:6px 0;color:#888;width:140px">${T.ref}</td>
              <td style="color:#1C1915;font-weight:700;font-size:15px;letter-spacing:1px">${referenceId}</td></tr>
          ${roomName ? `<tr><td style="padding:6px 0;color:#888">${T.room}</td>
              <td style="color:#333">${roomName}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#888">${T.checkin}</td>
              <td style="color:#333">${fmt(checkIn)}</td></tr>
          <tr><td style="padding:6px 0;color:#888">${T.checkout}</td>
              <td style="color:#333">${fmt(checkOut)}</td></tr>
          <tr><td style="padding:6px 0;color:#888">${T.nightsLbl}</td>
              <td style="color:#333">${nights}</td></tr>
          <tr><td style="padding:6px 0;color:#888">${T.guestsLbl}</td>
              <td style="color:#333">${guests}</td></tr>
          <tr style="border-top:1px solid #D4CEC4">
              <td style="padding:12px 0 6px;color:#888">${T.totalLbl}</td>
              <td style="padding:12px 0 6px;color:#967138;font-size:22px;font-weight:700">฿${parseInt(total).toLocaleString()}</td></tr>
        </table>
        ${specialRequests ? `<p style="margin:14px 0 0;color:#666;font-family:Arial,sans-serif;font-size:12px;border-top:1px solid #D4CEC4;padding-top:12px"><strong>${T.requests}:</strong> ${specialRequests}</p>` : ''}
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
