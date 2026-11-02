# Live Location Tracking App — Implementation Plan

A device shares its location (with the user's permission), the location streams
continuously to a server, and an admin watches every device live on a map in a
web dashboard.

This document covers **all the realistic ways to build it**, the **tech stacks
that work in production**, the **trade-offs**, and a **phased roadmap** with code
sketches you can start from.

---

## 0. Read this first — consent, legality, scope

This system tracks where real people are. Build it as **transparent, consent-based
tracking**, because that is both the law and the only version that survives an app
store review.

Non-negotiable rules this plan assumes:

1. **The tracked person knows and has agreed.** They tap "Allow location," they can
   see tracking is on, and they can turn it off and delete their data.
2. **No covert/stealth tracking.** Hiding the app, disabling the OS location
   indicator, or tracking someone without their knowledge is **illegal** in most
   countries (stalking / wiretap / privacy statutes) and is explicitly banned by
   Apple and Google. This plan does not do that and you should not build it.
3. **Legitimate uses this fits:** delivery/fleet driver tracking, field-service
   workforce, logistics, event staff, lone-worker safety, family-safety apps where
   everyone opted in, "find my device."
4. **Compliance:** you need a privacy policy, a lawful basis (GDPR), disclosure and
   opt-out (CCPA/CPRA), data-retention limits, and — if these are employees — labor
   law notice requirements. See the checklist in §12.

If you keep consent and visibility front and center, everything below is standard,
legal engineering.

---

## 1. The architecture (every approach shares this shape)

```
┌──────────────┐   location    ┌──────────────┐   live push   ┌──────────────┐
│  TRACKED     │  ──────────▶  │   BACKEND    │  ──────────▶  │    ADMIN     │
│  DEVICE      │   (HTTP/WS/   │  (ingest +   │   (WS/SSE/    │  DASHBOARD   │
│  (client)    │    MQTT)      │   store +    │   realtime)   │  (web map)   │
│              │               │   relay)     │               │              │
└──────────────┘               └──────┬───────┘               └──────────────┘
                                       │
                                 ┌─────▼─────┐
                                 │ DATABASE  │  last-known + history
                                 └───────────┘
```

Four decisions to make, each with several options:

| Layer | Question |
|-------|----------|
| **Client** | Web link, or installed native app? (This is the big one — see §2.) |
| **Transport** | How does the device send points? HTTP / WebSocket / MQTT / managed realtime |
| **Backend + DB** | Where do points land and how are they relayed + stored? |
| **Dashboard** | What map and what live-update mechanism? |

---

## 2. The one hard truth: "24/7 always" decides web vs native

You said "whoever opens this on their device" and "track 24/7." Those two pull in
**opposite** directions, and you must choose:

- **A web page / link cannot track in the background.** The W3C Geolocation API
  stops the moment the tab is backgrounded, the screen locks, or the browser is
  closed. This is a deliberate privacy protection in every browser; there is no flag
  that removes it. A web link can only track **while the page is open and in the
  foreground.**
- **Only an installed native app can track 24/7 in the background**, and even then
  the OS shows an indicator and can throttle it.

So pick your reality:

| You want… | You must build… |
|-----------|-----------------|
| "Send a link, person opens it, I see them **while the page is open**" | **Web / PWA** (§3A) — easiest, no install, but foreground-only |
| "Person installs once, I see them **continuously, even backgrounded**" | **Native / cross-platform app** (§3B/3C) — real 24/7, needs install + permissions |

There is no option that is both "just a link" **and** true 24/7 background. Anyone
who tells you otherwise is wrong about how mobile browsers work.

---

## 3. Client options (the tracked device)

### A. Web app / PWA  — *link-based, foreground-only*

- **API:** `navigator.geolocation.watchPosition()` (W3C Geolocation).
- **Install:** none. Open a URL, grant permission. Matches "whoever opens this."
- **Background:** ❌ not real. Tricks that *extend* foreground life only:
  - **Screen Wake Lock API** (`navigator.wakeLock`) keeps the screen on so the tab
    stays active.
  - **PWA "installed" mode** (add to home screen) is a little more resilient but
    **still** suspends when backgrounded.
  - A **Service Worker** can keep a cached shell and retry uploads, but it **cannot**
    read GPS on its own in the background.
- **Best for:** live-sharing a ride/trip while the app is open, "share my location
  for the next hour," a quick MVP, or when you genuinely can't ask people to install.
- **Stack:** plain HTML/JS or React/Vue/Svelte + the Geolocation API.

Minimal client:

```html
<script>
let watchId;
function startSharing(deviceId) {
  if (!('geolocation' in navigator)) return alert('No geolocation support');
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const body = {
        deviceId,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        speed: pos.coords.speed,
        heading: pos.coords.heading,
        ts: pos.timestamp,
      };
      // Transport choice goes here (fetch / WebSocket / Firebase). HTTP shown:
      fetch('/api/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,           // lets the last beacon survive a tab close
      });
    },
    (err) => console.warn('geo error', err),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
}
// Keep the screen awake while sharing (best-effort):
async function keepAwake() {
  try { await navigator.wakeLock.request('screen'); } catch (e) {}
}
</script>
```

### B. Native mobile apps — *true 24/7 background*

This is the only path to real continuous tracking.

- **iOS (Swift + Core Location):**
  - `CLLocationManager` with `requestAlwaysAuthorization()`.
  - Background modes: *standard background updates*, *significant-location-change*
    (low battery, cell-tower based), *region monitoring / visit monitoring*.
  - App Store review **requires** you to justify "Always" access and disclose it.
- **Android (Kotlin + Fused Location Provider):**
  - `FusedLocationProviderClient` from Google Play Services.
  - A **foreground service** with a persistent notification is **mandatory** for
    continuous background location (Android 8+); `ACCESS_BACKGROUND_LOCATION`
    permission (Android 10+), requested *after* foreground permission.
  - Fight OEM battery killers (Doze, manufacturer task-killers) with a foreground
    service + user guidance to disable battery optimization for the app.

### C. Cross-platform — *one codebase, real background (recommended for most)*

| Framework | Background-location library | Notes |
|-----------|----------------------------|-------|
| **React Native** | `react-native-background-geolocation` (transistorsoft) | The gold standard. Handles iOS+Android background, motion detection, geofencing, offline buffering, battery logic. Paid license for some features. Free alt: `@react-native-community/geolocation` (weaker background). |
| **Flutter** | `flutter_background_geolocation` (same vendor) or `geolocator` + `flutter_background_service` | Same excellent engine as RN; `geolocator` is the free/simple option. |
| **Expo** | `expo-location` + `expo-task-manager` | `startLocationUpdatesAsync` runs a background task. Easiest DX; fine for moderate needs. |

### D. Hybrid wrapper — *reuse a web UI, gain background*

- **Capacitor** (modern) or Cordova (legacy) wraps your web app in a native shell.
- Plugin: `@capacitor-community/background-geolocation`.
- Good if you already have a web client and want to graduate it to real background
  tracking without a full native rewrite.

**Client recommendation:** MVP/throwaway → **PWA (A)**. Anything real and continuous
→ **React Native or Flutter with `*-background-geolocation` (C)**.

---

## 4. Transport (device → server)

| Option | When to use | Pros | Cons |
|--------|-------------|------|------|
| **HTTP POST (batched)** | Default for mobile | Simple, cache/retry easy, battery-friendly if you batch every N sec / M meters | Not instant; you poll or push separately to the dashboard |
| **WebSocket** | Need low-latency two-way | Real-time, server can push commands back | Persistent connection drains battery; needs reconnect logic |
| **MQTT** | Fleets / many devices | Very lightweight, pub/sub, QoS levels, built for telemetry | Needs a broker (EMQX, Mosquitto, HiveMQ); more moving parts |
| **Server-Sent Events (SSE)** | Server→dashboard push | Dead simple one-way streaming to the browser | One-directional (fine for the dashboard side) |
| **Managed realtime** (Firebase, Supabase Realtime, Ably, Pusher) | Want to skip infra | Device writes, dashboard subscribes, sync handled for you | Vendor lock-in, cost at scale |

**Common production pattern:** device **batches** points and sends over **HTTP or
MQTT** (battery-friendly); the **dashboard** receives via **WebSocket/SSE** or a
**managed realtime** subscription. Don't hold a hot WebSocket open on the phone just
to save a few seconds of latency — it wrecks battery.

---

## 5. Backend (ingest + relay + store)

| Stack | Why pick it |
|-------|-------------|
| **Node.js** (Express/Fastify/NestJS) + **Socket.IO** | Fastest to build, huge ecosystem, great for WebSocket fan-out |
| **Python** (FastAPI + `websockets`, or Django Channels) | Clean, great if you'll do analytics/ML on tracks later |
| **Go** (Fiber/Gin + gorilla/websocket) | Best raw throughput for lots of devices and connections |
| **Managed, write little backend** | **Firebase** (Firestore + functions) or **Supabase** (Postgres + Realtime + Edge Functions) |

Backend responsibilities regardless of language:
- **Auth** every device (JWT / API key / device identity) and every admin.
- **Validate + clean** incoming points (drop impossible jumps, clamp accuracy).
- **Write** last-known position (hot) + append to history (cold).
- **Fan out** live updates to connected dashboards (only to admins allowed to see
  that device).

---

## 6. Database & storage

- **Last-known position (hot path):** **Redis** (a hash per device) or a single
  "latest" row — fast reads for the live map, plus Redis pub/sub for fan-out.
- **History / breadcrumbs (cold path):**
  - **PostgreSQL + PostGIS** — the best general choice. Real geospatial types,
    "within radius," "distance along route," geofence polygons. Add **TimescaleDB**
    if you want time-series compression for millions of points.
  - **MongoDB** with a `2dsphere` geospatial index — fine, document-friendly.
  - **Firebase/Firestore or Supabase** — if you went managed in §5.
- **Retention:** set a TTL / scheduled purge (e.g., keep raw points 30–90 days,
  keep aggregated trips longer). This is both a cost and a **compliance** control.

---

## 7. Admin dashboard (the webpage)

- **Map library:**
  | Library | Notes |
  |---------|-------|
  | **Leaflet** + OpenStreetMap tiles | Free, light, easy. Great default. |
  | **MapLibre GL JS** | Open-source vector maps (Mapbox GL fork), no per-load fee. |
  | **Mapbox GL JS** | Beautiful vector maps, rich features; paid above free tier. |
  | **Google Maps JS API** | Familiar, strong geocoding/places; paid, keyed. |
- **Frontend:** React/Next.js, Vue, or Svelte. Next.js is a comfortable default
  (dashboard + API routes in one app).
- **Live updates:** subscribe via WebSocket/SSE or your managed-realtime SDK; move
  each device's marker as points arrive.
- **Features to plan for:** live markers with heading/speed, breadcrumb trails,
  history playback with a time slider, geofences + enter/exit alerts, device list
  with online/offline + battery, search/filter, and an **audit log** of who viewed
  what (good practice for a tracking tool).

Marker update sketch (Leaflet + Socket.IO):

```js
import L from 'leaflet';
const map = L.map('map').setView([20.59, 78.96], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

const markers = {};
socket.on('location', ({ deviceId, lat, lng }) => {
  if (!markers[deviceId]) markers[deviceId] = L.marker([lat, lng]).addTo(map);
  else markers[deviceId].setLatLng([lat, lng]);
});
```

---

## 8. Three end-to-end stacks that work

### Stack 1 — Fastest MVP (web link, foreground-only)
```
PWA (Geolocation API + Wake Lock)
   → Firebase Firestore (device writes points)
   → React/Next.js + Leaflet dashboard (Firestore onSnapshot live updates)
```
- **Ship in days.** No backend to run, no app install.
- **Limit:** tracks only while the page is open. Good for "share my trip" style use.

### Stack 2 — Production, real 24/7 (recommended)
```
React Native + react-native-background-geolocation
   → HTTP/MQTT ingest → Node.js (Fastify) or FastAPI
   → Redis (last-known + pub/sub) + PostgreSQL/PostGIS (history)
   → dashboard pushed via WebSocket (Socket.IO)
   → Next.js + Mapbox/MapLibre dashboard
```
- True background tracking, offline buffering, battery logic, scales to many devices.

### Stack 3 — Managed / low-ops (real background, little infra)
```
Flutter + flutter_background_geolocation
   → Supabase (Postgres + PostGIS + Realtime)
   → Next.js + MapLibre dashboard (Supabase Realtime subscription)
```
- Real background tracking with almost no server code to maintain.

---

## 9. Cross-cutting engineering concerns

- **Battery (the #1 field problem):** don't stream every GPS fix. Use a **distance
  filter** (e.g., every 25–50 m) + **time cap**, drop to significant-change /
  stationary mode when still (motion detection), and **batch** uploads. The
  transistorsoft libraries do most of this for you.
- **Offline buffering:** queue points in local storage/SQLite when there's no
  network and flush when it returns. Non-negotiable for real-world mobile.
- **Accuracy & noise:** keep `accuracy`, discard fixes with huge radius, and smooth
  jitter (a simple Kalman filter or distance/speed sanity checks) before drawing.
- **Security:** TLS everywhere, authenticate devices and admins, scope each admin to
  only the devices they may see, encrypt at rest, rotate tokens, rate-limit ingest.
- **Scale:** for thousands of devices, put ingest behind a queue (MQTT/Kafka/SQS),
  shard by region, and keep the live map reading from Redis, not the history table.
- **Reliability:** reconnect/backoff on the socket, idempotent ingest (dedupe by
  `deviceId + ts`), health checks, and metrics on points/sec and connected devices.

---

## 10. Permissions & UX flow (do it in this order)

1. **Explain before you ask.** A screen stating *what* is tracked, *why*, *who sees
   it*, and *how to stop*. This raises grant rates and is required for store review.
2. **Request foreground location first.** Get "While Using."
3. **Then escalate to background/Always**, with an in-app rationale right before the
   OS prompt (iOS "Always"; Android `ACCESS_BACKGROUND_LOCATION`).
4. **Show a persistent, honest indicator** that tracking is on, plus an easy
   pause/stop and a "delete my data" action.
5. **Handle denial gracefully** — degrade to foreground-only or explain what breaks.

---

## 11. Phased roadmap

| Phase | Goal | Deliverable |
|-------|------|-------------|
| **0** | Decide web vs native (§2), write the privacy policy + consent copy | Scope doc |
| **1** | MVP: one device → server → one live marker on a map | Stack 1 working end-to-end |
| **2** | Real client: background tracking (native/cross-platform), batching, offline queue | Stack 2/3 client |
| **3** | Dashboard: multi-device, trails, history playback, device online/offline | Full admin UI |
| **4** | Auth, per-admin device scoping, audit log, retention/purge job | Security + compliance |
| **5** | Geofences + alerts, battery tuning, scale testing, monitoring | Production hardening |

---

## 12. Compliance checklist

- [ ] Written, specific **consent** captured in-app (not buried in an EULA).
- [ ] **Privacy policy** published: what's collected, why, who sees it, retention, deletion.
- [ ] **Lawful basis** documented (GDPR) / disclosure + opt-out (CCPA/CPRA).
- [ ] If **employees**: notice/consent per local labor law; limit to work hours where required.
- [ ] **Data minimization**: collect only what you need; set a **retention/purge** policy.
- [ ] **Right to access/delete** honored; easy in-app off switch.
- [ ] **Store compliance**: Apple "Always" justification + Google background-location
      disclosure; prominent in-app indicator. No stealth/hidden tracking.
- [ ] **Security**: TLS, authn/authz, encryption at rest, access logging.

---

### TL;DR
- A **link alone can't do 24/7** — mobile browsers stop location in the background.
  Real continuous tracking means an **installed native/cross-platform app**.
- **Fastest:** PWA + Firebase + Leaflet (foreground-only).
- **Real & recommended:** React Native (or Flutter) `background-geolocation` →
  Node/FastAPI + Redis + PostgreSQL/PostGIS → Next.js + Mapbox/MapLibre dashboard,
  live over WebSocket.
- Build it **consent-first and visible** — that's the legal, store-approvable, and
  ethical version, and the only one worth building.
