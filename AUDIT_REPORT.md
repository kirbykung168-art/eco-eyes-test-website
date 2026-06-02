# AUDIT_REPORT.md — Section C Full-Site Audit

**Run:** 2026-06-02 · against `main` @ `f7ab114` (post-Section B rebuild) + 1 audit-fix commit pending.
**Method:** Local server on port 3838 → curl probes, JS parsing, static analysis. Browser-required checks (real iOS/Android render, Stripe TEST card walk-through, screen-reader passes) are flagged where they apply.
**Verdict:** PASS, with 5 minor notes and 1 fix applied during the audit.

---

## C1 — Crawl & links

| Page | HTTP | Notes |
|---|---|---|
| `/` (index) | 200 | — |
| `/index.html` | 301 → `/` | Intentional (server.js redirect) |
| `booking.html` | 200 | — |
| `booking-confirm.html` | 200 | — |
| `cafe.html` | 200 | — |
| `checkout-preview.html` | 200 | — |
| `contact.html` | 200 | — |
| `csr.html` | 200 | `#eyes` anchor exists at line 380 ✓ |
| `explore.html` | 200 | — |
| `life.html` | 200 | — |
| `resort.html` | 200 | — |

- **No `cdn.tailwindcss.com` references anywhere in `*.html`** — Tailwind is self-hosted from `/tailwind.css` (200, 18 KB).
- **Internal `.html` links** all resolve to files that exist.
- **Anchor links** (`#eyes`, `#activities`, `#why-choose`, etc.) all have matching `id=` targets in their destination pages.
- **External hosts** referenced: `fonts.googleapis.com`, `fonts.gstatic.com`, `eco-eyes-bucket.s3.ap-southeast-1.amazonaws.com` (icon + OG image), `agoda.com`, `booking.com`, `tripadvisor.co.uk`, `trip.com`, `line.me`, `m.me`, `maps.google.com`, `facebook.com`, `instagram.com`. All look intentional.
- **Contact links** (`tel:+66926100560`, `mailto:ecoeyesvillagenaec@gmail.com`) — both well-formed, single canonical pair across the site.

**Fix applied during audit:** `/favicon.ico` returned **404** (browsers auto-request this regardless of `<link rel="icon">`). Added a 302 redirect to the S3 icon in `server.js` so the network panel is clean.

---

## C2 — Console & network

- **Inline JS parses cleanly** on every page (parsed with `new Function(...)` against every `<script>` block):
  - `booking.html`, `booking-confirm.html`, `checkout-preview.html`: 1 block each, OK.
  - `index.html`, `resort.html`, `life.html`, `cafe.html`, `csr.html`, `contact.html`, `explore.html`: 2 blocks each, OK.
- **External script tags:** every page references `/_vercel/insights/script.js` (defer). This 404s in **local dev only** — Vercel injects it in production. Browser network panel will show one 404 locally; not a real issue.
- **No `console.error`/`console.warn` calls in HTML** frontend code. (Server.js has them by design for diagnostics.)
- **No `eval`, no inline `onload="…"` attributes** doing risky things.

**Browser-required to fully clear:** open DevTools on a real device and confirm a 200 across the network panel. The static scan can't simulate the Stripe redirect chain or the Resend POST.

---

## C3 — Booking flow end-to-end (CRITICAL)

Walked the full pipeline programmatically:

1. **Calendar / blocked dates** — `GET /api/blocked-dates` → `200 OK`, returns real Hostex data (23 `someBooked` days, 2 `fullyBlocked` days for the next 180 days).
2. **Availability check** — `GET /api/rooms?checkIn=2026-08-10&checkOut=2026-08-12` → `200 OK`, returns 10 rooms with `available: true|false` per dome, every room matched to a real Hostex listing ID (`11809073…11963608`).
3. **Booking POST** — `POST /api/booking` with a representative payload returned:
   ```json
   {
     "success": true,
     "requiresPayment": true,
     "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_…",
     "ref": "EEV-VE6QKE"
   }
   ```
   `cs_test_` prefix confirms Stripe is in **TEST mode** (the configured key is `sk_test_…`).
4. **Confirmation page** — `booking-confirm.html` reads `ref`, `name`, `room`, `checkIn`, `checkOut`, `nights`, `total` from URL query (line 365-372). When the Stripe success URL fires, the page populates dome name + booking reference. ✓
5. **Hostex reservation** — created server-side by `createHostexReservations()` inside the `checkout.session.completed` webhook handler, after Stripe confirms payment. Uses `custom_channel_id: 4913` ("Direct Booking"). Code path unchanged by Section B.
6. **Booked-date probe** — `GET /api/rooms?checkIn=2026-07-04&checkOut=2026-07-05` (a `fullyBlocked` day) → all 10 domes return `available: false`. ✓
7. **Partly-booked probe** — `GET /api/rooms?checkIn=2026-06-15&checkOut=2026-06-16` (a `someBooked` day) → 9 available, "The Sun" unavailable. ✓

**Browser-required to fully clear:** walking the page with a Stripe TEST card (`4242 4242 4242 4242`) and verifying the `checkout.session.completed` webhook actually creates a Hostex reservation + sends the confirmation email. The local server doesn't receive Stripe webhooks unless the user is running `stripe listen --forward-to`.

---

## C4 — Integrations intact

| API | Shape | Status |
|---|---|---|
| `GET /api/blocked-dates` | `{ success, someBooked: [...], fullyBlocked: [...] }` | unchanged |
| `GET /api/rooms?checkIn=&checkOut=` | `{ success, nightlyRate, rooms: [{ id, en, th, zh, num, hostexId, available, nightlyRate }] }` | unchanged |
| `GET /api/availability` (legacy) | `{ … }` | still 200, kept for compat |
| `POST /api/booking` | `{ success, requiresPayment, checkoutUrl, ref }` | unchanged |
| `POST /api/stripe-webhook` | Handles `checkout.session.completed` + new `checkout.session.expired` (B9) | additive only |
| `GET /api/debug/hostex` | Diagnostic dump | 200 |

- The booking page's `submitBooking()` POSTs **the same payload shape** it did before the rebuild (`roomIds`, `roomId`, `roomName`, `extraBeds`, `petCount`, `nights`, `total`, etc.). No contract drift.
- Stripe key: `sk_test_…` (TEST mode confirmed).
- Hostex API key configured; all 10 dome names matched to live listings (`Found 10 Hostex listing(s)` in startup log).

**Note (production deploy):** `STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET` in `.env` are still `REPLACE_ME` placeholders. The webhook will accept events without signature verification in this state — fine for dev, but **must be set in production** before going live, or the `checkout.session.completed` and `checkout.session.expired` handlers won't fire correctly and bookings won't auto-create Hostex reservations / recovery emails.

**Language switching (EN/TH/ZH)** — `setLang()` exists in every page, persists to `localStorage`, and updates `document.documentElement.lang`. All Section B additions (legend, perk, trust block, dome map states, scarcity pill) have TH/ZH translations in the `T` map.

---

## C5 — Responsive & cross-browser

- **Viewport meta** present on every page (`width=device-width, initial-scale=1.0`).
- **Media queries** in `booking.html` cover `640px`, `880px`, `1024px` breakpoints.
- **Tap targets ≥44×44 px** on the critical mobile controls:
  - `.cal-nav-btn` (B1 fix): `min-width: 44px; min-height: 44px;` ✓
  - `#back-to-top`: `width: 44px; height: 44px;` ✓
  - `.dome` SVG groups: `hit` circle has `r: R+6` (~28 px radius = 56 px diameter) ✓
- **No CSS `width: > 100vw`** values that would force horizontal scroll.
- **Homepage availability bar** (B2 fix in `index.html`) — collapses to `max-height: 64px` on `< 768px` with Guests + Rooms selectors hidden so the hero photo leads on mobile.

**Browser-required to fully clear:** rendering on real iOS Safari + Android Chrome at 375 / 390 / 768 / 1280 / 1440 px. Static rules look correct but pixel-perfect verification is a browser job.

---

## C6 — Performance

**Booking page first-view weight:**

| Resource | Bytes | KB |
|---|---|---|
| `booking.html` (raw) | 129,577 | 126 |
| `tailwind.css` | 18,152 | 18 |
| Hero/main image `Room%20picture%201.webp` (reused 3× → cached) | 133,998 | 131 |
| Fonts (Google Fonts CSS subset) | ~varies | ~30 (typical) |
| **First-view total** | **~310 KB** | well **under the 1 MB target** ✓ |

**Image deduplication:**
- **Pre-rebuild:** 10 cards × ~15 photos = ~150 image requests, ~3.3 MB total. (See Section B brief.)
- **Post-rebuild:** 1 hero (eager) + 5 thumbs (lazy via `loading="lazy"`). Hero image is the same file as the section background, so it's a single network request reused everywhere.
- **`buildGallery()` ([booking.html:990](booking.html#L990))** sets `loading="eager"` only on index 0; thumbs 1-5 get `loading="lazy"` so they download only when scrolled into view.

**Full gallery weight (if every thumb forced visible):**

| Photo | Bytes |
|---|---|
| `Room%20picture%201.webp` | 133,998 |
| `Scenic%20room%20picture%20.webp` | 111,266 |
| `Outdoor%20patio%20picture.webp` | 80,828 |
| `view%20from%20inside%20the%20room.jpg` | **751,894** ⚠️ |
| `Bathroom%20picture%201.webp` | 55,514 |
| `picture%20of%20lights.webp` | 39,942 |
| **Total** | 1,173,442 (~1.1 MB) |

**Note (not a bug):** the gallery includes one large JPG (`view from inside the room.jpg`, 752 KB) that drags the lazy-loaded total up. It's not first-view (lazy) so it doesn't fail the brief, but converting it to WebP would knock ~80% off (≈ 150 KB) and improve the scroll-into-view experience. Future optimization.

**No `cdn.tailwindcss.com` references** — Tailwind is self-hosted.

---

## C7 — Accessibility sanity

- **Alt text:** every `<img>` across all 10 HTML pages has `alt=` (0 missing of 53 total).
- **`aria-label`** used 9 times in `booking.html` (calendar fully-booked days, dome SVG groups, back-to-top, photo-nav buttons, etc.).
- **`tabindex`** on the interactive dome map elements + text-fallback list items. Dome SVG groups have `tabindex="0"`, `role="button"`, `aria-pressed` reflecting selection state, and `keydown` handlers binding Enter/Space to toggle selection.
- **Non-color cue for calendar booked days:** `text-decoration: line-through` on `.cal-day.cal-fully-blocked .cal-day-num`. Calendar legend below the grid names each color with text. ✓ (B2)
- **Non-color cue for booked domes:** dashed-red ✕ on the SVG, plus `.dome-litem.booked` adds `text-decoration: line-through` to the dome name in the text fallback. ✓ (B6b)
- **Saffron `#C4A36A` as text on bone `#FAF7EF`** — used only in the page-label/eyebrow micro-copy where it's small but not body-text-sized. Spot-check: where saffron is body-text, it's on a dark background (`#1C1915`) and contrast is comfortably above WCAG AA. No body-size saffron on bone.

**Minor miss:** no "Skip to content" link. Not a blocker for a brochure site, but worth adding if compliance is a target.

**Browser-required to fully clear:** real screen-reader pass (VoiceOver on iOS, TalkBack on Android, NVDA on Windows).

---

## Issues found vs. fixed

| # | Severity | Item | Status |
|---|---|---|---|
| 1 | low | `/favicon.ico` → 404 (browsers auto-request) | **Fixed** — `server.js` now 302-redirects to the S3 icon. |
| 2 | info | `/_vercel/insights/script.js` 404 in local dev (Vercel-injected in prod) | No action — production-only resource. |
| 3 | info | `view from inside the room.jpg` is 752 KB; would benefit from WebP conversion | No action this audit — lazy-loaded, not first-view. Future optimization. |
| 4 | **production-blocker** | `STRIPE_WEBHOOK_SECRET` and `STRIPE_PUBLISHABLE_KEY` are `REPLACE_ME` in `.env` | **User action** — must be set in production environment before going live. |
| 5 | low | No "Skip to main content" link | No action this audit — discretionary a11y polish. |

---

## What this audit did NOT cover (requires a browser)

- Real iOS Safari + Android Chrome rendering at the responsive breakpoints.
- Stripe TEST card walk-through with the real `4242 4242 4242 4242` card. The local server can't receive Stripe's `checkout.session.completed` webhook without `stripe listen --forward-to`.
- Manual screen-reader pass.
- Visual regression on the dome map, gallery, and calendar legend across browsers.

Each of these is straightforward to do manually now that the static + integration layers are clean.

---

## Bottom line

**Section C passes.** Every page returns 200. All inline JS parses. Stripe is in TEST mode and the checkout URL returns successfully. Hostex availability flows correctly into both the calendar (`/api/blocked-dates`) and the dome map (`/api/rooms`). Integration contracts are unchanged from before the Section B rebuild. The booking page's first-view weight is roughly **310 KB**, well under the 1 MB target the brief called for (down from ~3.3 MB pre-rebuild).

One trivial 404 was found and fixed (favicon). Three notes are informational. One production-deploy blocker (Stripe webhook + publishable key placeholders in `.env`) needs to be addressed before going live — not a code change, a config change.
