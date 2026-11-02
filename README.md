# LiveTrack 24/7 — Real-Time Device Location Tracker & Admin Map Dashboard

A complete, real-time 24/7 live location tracking system where any user who opens the tracker application and grants location permission streams their live GPS coordinates, speed, heading, accuracy, and battery status to the Admin Webpage Dashboard.

---

## 1. Quick Start

```bash
npm install
npm start
```

Once running, open:
- **User Device Tracker App:** `http://localhost:3000/track`
- **Live Admin Webpage Dashboard:** `http://localhost:3000/admin`

---

## 2. How to Track Real Mobile Phones Over Wi-Fi / 4G / 5G

Because mobile browsers (Chrome on Android, Safari on iOS) require **HTTPS** (secure context) to allow `navigator.geolocation` on non-localhost URLs, use a free 1-command HTTPS tunnel to get a public `https://` link you can open on any phone anywhere in the world:

```bash
npx localtunnel --port 3000
```
*(Or use `ngrok http 3000` / Cloudflare Tunnel `npx cloudflared tunnel --url http://localhost:3000`)*

Then:
1. Open `https://<your-tunnel-url>/admin` on your laptop/PC.
2. Send `https://<your-tunnel-url>/track?name=Rider-01` to any mobile phone.
3. As soon as they open it and tap **Allow Location**, their live position moves in real time on your Admin Map!

---

## 3. How to Package as a Native Android APK for True Screen-Off 24/7 Tracking

The frontend in `public/index.html` already includes the native bridge for `@capacitor-community/background-geolocation` and the backend `server.js` includes the `POST /api/location` background webhook.

To build an installable Android `.apk` that tracks 24/7 even when the phone is locked:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor-community/background-geolocation
npx cap add android
npx cap sync
npx cap open android
```

Ensure `android/app/src/main/AndroidManifest.xml` includes:
```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```
