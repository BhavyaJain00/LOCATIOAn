const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 10000,
  pingTimeout: 8000
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'devices.json');
const MAX_TRAIL_POINTS = 500;
const MIN_TRAIL_DISTANCE_METERS = 3; // Minimum movement to append a new breadcrumb point

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory store of devices: Map<deviceId, DeviceObject>
const devices = new Map();
// Map of socket.id -> deviceId
const socketToDevice = new Map();
// Pending offline timers for grace period during mobile network handoffs (Wi-Fi <-> 5G)
const disconnectTimers = new Map();

// Load persisted devices on startup
function loadPersistedDevices() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((dev) => {
          // On fresh server start, mark all loaded devices offline until they reconnect
          dev.status = 'offline';
          dev.socketId = null;
          devices.set(dev.deviceId, dev);
        });
        console.log(`[Storage] Loaded ${devices.size} persisted device(s) from disk.`);
      }
    }
  } catch (err) {
    console.error('[Storage] Failed to load devices.json:', err.message);
  }
}

let saveTimeout = null;
function scheduleSaveDevices() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    try {
      const serialized = Array.from(devices.values());
      fs.writeFileSync(DATA_FILE, JSON.stringify(serialized, null, 2), 'utf8');
    } catch (err) {
      console.error('[Storage] Failed to save devices.json:', err.message);
    }
  }, 2000);
}

// Haversine formula to compute distance in meters between two GPS coordinates
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Get local LAN IPv4 addresses so Admin can share QR codes on local Wi-Fi
function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ name, address: iface.address });
      }
    }
  }
  return addresses;
}

// Core helper to process incoming location telemetry (used by both WebSocket & HTTP Background POST)
function processLocationUpdate(payload, socketId = null) {
  if (!payload || !payload.deviceId) return null;
  const lat = Number(payload.latitude);
  const lng = Number(payload.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const now = Date.now();
  const timestamp = Number(payload.timestamp) || now;
  const deviceId = String(payload.deviceId).trim();

  let device = devices.get(deviceId);
  if (!device) {
    device = {
      deviceId,
      userName: payload.userName || `Device-${deviceId.slice(-4)}`,
      status: 'online',
      socketId: socketId,
      platform: payload.platform || 'Web / Mobile Browser',
      trackingMode: payload.trackingMode || 'Continuous 24/7',
      latitude: lat,
      longitude: lng,
      accuracy: Number(payload.accuracy) || 0,
      speed: Number(payload.speed) || 0,
      heading: Number(payload.heading) || 0,
      altitude: payload.altitude != null ? Number(payload.altitude) : null,
      batteryLevel: payload.batteryLevel != null ? Number(payload.batteryLevel) : null,
      isCharging: Boolean(payload.isCharging),
      wakeLockActive: Boolean(payload.wakeLockActive),
      totalDistanceMeters: 0,
      updateCount: 0,
      firstSeen: now,
      lastSeen: now,
      lastLocationTimestamp: timestamp,
      trail: []
    };
    devices.set(deviceId, device);
  }

  // Clear any pending offline timer
  if (disconnectTimers.has(deviceId)) {
    clearTimeout(disconnectTimers.get(deviceId));
    disconnectTimers.delete(deviceId);
  }

  // Calculate distance from previous valid coordinate
  const prevTrailPoint = device.trail.length > 0 ? device.trail[device.trail.length - 1] : null;
  let movedMeters = 0;
  if (prevTrailPoint) {
    movedMeters = calculateDistanceMeters(
      prevTrailPoint.lat,
      prevTrailPoint.lng,
      lat,
      lng
    );
    // Ignore impossible GPS jumps (> 50km in a few seconds unless first lock)
    if (movedMeters >= MIN_TRAIL_DISTANCE_METERS && movedMeters < 50000) {
      device.totalDistanceMeters = Math.round((device.totalDistanceMeters || 0) + movedMeters);
    }
  }

  // Update live properties
  if (payload.userName && !device.customNameLocked) {
    device.userName = String(payload.userName).trim();
  }
  if (socketId) {
    device.socketId = socketId;
  }
  device.status = 'online';
  device.latitude = lat;
  device.longitude = lng;
  device.accuracy = Number.isFinite(Number(payload.accuracy)) ? Number(payload.accuracy) : device.accuracy;

  // Estimate speed if device GPS didn't supply speed
  let speedMps = Number(payload.speed);
  if ((!Number.isFinite(speedMps) || speedMps < 0) && prevTrailPoint) {
    const dtSec = (timestamp - prevTrailPoint.ts) / 1000;
    if (dtSec > 0.5 && movedMeters >= MIN_TRAIL_DISTANCE_METERS && movedMeters < 5000) {
      speedMps = movedMeters / dtSec;
    } else {
      speedMps = 0;
    }
  }
  device.speed = Number.isFinite(speedMps) && speedMps >= 0 ? speedMps : 0;

  if (Number.isFinite(Number(payload.heading)) && Number(payload.heading) >= 0) {
    device.heading = Number(payload.heading);
  }
  if (payload.altitude != null && Number.isFinite(Number(payload.altitude))) {
    device.altitude = Number(payload.altitude);
  }
  if (payload.batteryLevel != null && Number.isFinite(Number(payload.batteryLevel))) {
    device.batteryLevel = Math.round(Number(payload.batteryLevel));
  }
  if (payload.isCharging !== undefined) {
    device.isCharging = Boolean(payload.isCharging);
  }
  if (payload.wakeLockActive !== undefined) {
    device.wakeLockActive = Boolean(payload.wakeLockActive);
  }
  if (payload.platform) {
    device.platform = payload.platform;
  }
  if (payload.trackingMode) {
    device.trackingMode = payload.trackingMode;
  }

  device.updateCount = (device.updateCount || 0) + 1;
  device.lastSeen = now;
  device.lastLocationTimestamp = timestamp;

  // Append to trail if first point or moved at least MIN_TRAIL_DISTANCE_METERS
  if (!prevTrailPoint || movedMeters >= MIN_TRAIL_DISTANCE_METERS) {
    device.trail.push({
      lat,
      lng,
      acc: Math.round(device.accuracy || 0),
      spd: Number((device.speed || 0).toFixed(1)),
      ts: timestamp
    });
    if (device.trail.length > MAX_TRAIL_POINTS) {
      device.trail.shift();
    }
  }

  scheduleSaveDevices();
  return device;
}

loadPersistedDevices();

// ==================== ROUTES ====================

// User Tracker Application (Default root & /track)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/track', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin Live Dashboard Webpage
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// REST API: Server & Network Info (for QR code & shareable links)
app.get('/api/server-info', (req, res) => {
  const lanAddresses = getLocalIPv4Addresses();
  const hostHeader = req.headers.host || `localhost:${PORT}`;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';

  const allDevices = Array.from(devices.values());
  const onlineCount = allDevices.filter((d) => d.status === 'online').length;

  res.json({
    port: PORT,
    protocol,
    host: hostHeader,
    lanAddresses,
    recommendedLanUrl:
      lanAddresses.length > 0
        ? `http://${lanAddresses[0].address}:${PORT}/track`
        : `${protocol}://${hostHeader}/track`,
    totalDevices: allDevices.length,
    onlineDevices: onlineCount,
    serverTime: Date.now()
  });
});

// REST API: Get all devices & trails
app.get('/api/devices', (req, res) => {
  res.json({
    devices: Array.from(devices.values()),
    serverTime: Date.now()
  });
});

// REST API: Background HTTP POST endpoint for Native Android/iOS Background Services & Offline Batch Sync
app.post('/api/location', (req, res) => {
  const body = req.body;

  // Support both single location object and batch array
  if (Array.isArray(body.locations)) {
    let lastUpdated = null;
    body.locations.forEach((loc) => {
      const updated = processLocationUpdate({
        ...loc,
        deviceId: loc.deviceId || body.deviceId,
        userName: loc.userName || body.userName
      });
      if (updated) lastUpdated = updated;
    });
    if (lastUpdated) {
      io.to('admins').emit('device:updated', lastUpdated);
    }
    return res.json({ ok: true, count: body.locations.length });
  }

  // Also support @capacitor-community/background-geolocation or native POST formats
  const normalized = {
    deviceId: body.deviceId || req.headers['x-device-id'] || 'native-device',
    userName: body.userName || req.headers['x-user-name'],
    latitude: body.latitude ?? body.lat ?? (body.location && body.location.latitude),
    longitude: body.longitude ?? body.lng ?? body.lon ?? (body.location && body.location.longitude),
    accuracy: body.accuracy ?? (body.location && body.location.accuracy),
    speed: body.speed ?? (body.location && body.location.speed),
    heading: body.heading ?? body.bearing ?? (body.location && body.location.bearing),
    altitude: body.altitude ?? (body.location && body.location.altitude),
    batteryLevel: body.batteryLevel ?? (body.battery && body.battery.level),
    isCharging: body.isCharging ?? (body.battery && body.battery.is_charging),
    timestamp: body.timestamp ?? body.time ?? Date.now(),
    platform: body.platform || 'Native Background Service',
    trackingMode: body.trackingMode || 'Native 24/7 Background'
  };

  const updated = processLocationUpdate(normalized);
  if (!updated) {
    return res.status(400).json({ ok: false, error: 'Invalid deviceId or coordinates' });
  }

  io.to('admins').emit('device:updated', updated);
  res.json({ ok: true, deviceId: updated.deviceId, timestamp: Date.now() });
});

// ==================== SOCKET.IO REAL-TIME ENGINE ====================

io.on('connection', (socket) => {
  // 1. Admin Webpage joins 'admins' room
  socket.on('admin:join', () => {
    socket.join('admins');
    socket.emit('devices:snapshot', {
      devices: Array.from(devices.values()),
      serverTime: Date.now()
    });
  });

  // 2. User Device registers as a tracker
  socket.on('tracker:register', (payload, ack) => {
    if (!payload || !payload.deviceId) return;
    const deviceId = String(payload.deviceId).trim();

    socket.join('trackers');
    socket.join(`device:${deviceId}`);
    socketToDevice.set(socket.id, deviceId);

    if (disconnectTimers.has(deviceId)) {
      clearTimeout(disconnectTimers.get(deviceId));
      disconnectTimers.delete(deviceId);
    }

    const now = Date.now();
    let device = devices.get(deviceId);
    if (!device) {
      device = {
        deviceId,
        userName: payload.userName || `User-${deviceId.slice(-4)}`,
        status: 'online',
        socketId: socket.id,
        platform: payload.platform || 'Mobile Web',
        trackingMode: payload.trackingMode || 'Live 24/7',
        latitude: payload.latitude ?? null,
        longitude: payload.longitude ?? null,
        accuracy: payload.accuracy ?? null,
        speed: 0,
        heading: 0,
        altitude: null,
        batteryLevel: payload.batteryLevel ?? null,
        isCharging: Boolean(payload.isCharging),
        wakeLockActive: Boolean(payload.wakeLockActive),
        totalDistanceMeters: 0,
        updateCount: 0,
        firstSeen: now,
        lastSeen: now,
        lastLocationTimestamp: null,
        trail: []
      };
      devices.set(deviceId, device);
    } else {
      device.status = 'online';
      device.socketId = socket.id;
      device.lastSeen = now;
      if (payload.userName && !device.customNameLocked) {
        device.userName = String(payload.userName).trim();
      }
      if (payload.platform) device.platform = payload.platform;
      if (payload.trackingMode) device.trackingMode = payload.trackingMode;
      if (payload.batteryLevel != null) device.batteryLevel = Math.round(Number(payload.batteryLevel));
      if (payload.isCharging !== undefined) device.isCharging = Boolean(payload.isCharging);
      if (payload.wakeLockActive !== undefined) device.wakeLockActive = Boolean(payload.wakeLockActive);
    }

    scheduleSaveDevices();
    io.to('admins').emit('device:updated', device);
    if (typeof ack === 'function') {
      ack({ ok: true, deviceId, serverTime: now });
    }
  });

  // 3. Live Location Stream from Device
  socket.on('location:update', (payload, ack) => {
    const updated = processLocationUpdate(payload, socket.id);
    if (updated) {
      socketToDevice.set(socket.id, updated.deviceId);
      io.to('admins').emit('device:updated', updated);
      if (typeof ack === 'function') {
        ack({ ok: true, ts: Date.now() });
      }
    }
  });

  // 4. Batch Offline Sync (when device regains internet after dead zone)
  socket.on('location:batch', (payload, ack) => {
    if (!payload || !Array.isArray(payload.locations)) return;
    let lastUpdated = null;
    payload.locations.forEach((loc) => {
      const updated = processLocationUpdate(
        {
          ...loc,
          deviceId: loc.deviceId || payload.deviceId,
          userName: loc.userName || payload.userName
        },
        socket.id
      );
      if (updated) lastUpdated = updated;
    });
    if (lastUpdated) {
      io.to('admins').emit('device:updated', lastUpdated);
    }
    if (typeof ack === 'function') {
      ack({ ok: true, syncedCount: payload.locations.length });
    }
  });

  // 5. Device 24/7 Heartbeat (keeps device status green even when stationary indoors)
  socket.on('tracker:heartbeat', (payload, ack) => {
    if (!payload || !payload.deviceId) return;
    const device = devices.get(String(payload.deviceId).trim());
    if (device) {
      device.status = 'online';
      device.lastSeen = Date.now();
      device.socketId = socket.id;
      if (payload.batteryLevel != null) device.batteryLevel = Math.round(Number(payload.batteryLevel));
      if (payload.isCharging !== undefined) device.isCharging = Boolean(payload.isCharging);
      if (payload.wakeLockActive !== undefined) device.wakeLockActive = Boolean(payload.wakeLockActive);
      if (payload.permissionState) device.permissionState = payload.permissionState;
      io.to('admins').emit('device:updated', device);
    }
    if (typeof ack === 'function') {
      ack({ ok: true, serverTime: Date.now() });
    }
  });

  // 6. Admin Actions: Force-ping a device to refresh its GPS immediately
  socket.on('admin:ping-device', ({ deviceId }) => {
    if (deviceId) {
      io.to(`device:${deviceId}`).emit('server:request-location', { requestedAt: Date.now() });
    } else {
      io.to('trackers').emit('server:request-location', { requestedAt: Date.now() });
    }
  });

  // 7. Admin Action: Rename a device
  socket.on('admin:rename-device', ({ deviceId, userName }) => {
    const device = devices.get(deviceId);
    if (device && userName) {
      device.userName = String(userName).trim();
      device.customNameLocked = true;
      scheduleSaveDevices();
      io.to('admins').emit('device:updated', device);
    }
  });

  // 8. Admin Action: Clear a device's breadcrumb trail
  socket.on('admin:clear-trail', ({ deviceId }) => {
    const device = devices.get(deviceId);
    if (device) {
      device.trail =
        device.latitude != null && device.longitude != null
          ? [
              {
                lat: device.latitude,
                lng: device.longitude,
                acc: Math.round(device.accuracy || 0),
                spd: Number((device.speed || 0).toFixed(1)),
                ts: Date.now()
              }
            ]
          : [];
      device.totalDistanceMeters = 0;
      scheduleSaveDevices();
      io.to('admins').emit('device:updated', device);
    }
  });

  // 9. Admin Action: Delete a device
  socket.on('admin:delete-device', ({ deviceId }) => {
    if (devices.has(deviceId)) {
      devices.delete(deviceId);
      scheduleSaveDevices();
      io.to('admins').emit('device:deleted', { deviceId });
    }
  });

  // 10. Handle Disconnect with a 4-second grace period for mobile network switching
  socket.on('disconnect', () => {
    const deviceId = socketToDevice.get(socket.id);
    socketToDevice.delete(socket.id);
    if (!deviceId) return;

    const timer = setTimeout(() => {
      disconnectTimers.delete(deviceId);
      const device = devices.get(deviceId);
      if (device && device.socketId === socket.id) {
        device.status = 'offline';
        device.lastSeen = Date.now();
        scheduleSaveDevices();
        io.to('admins').emit('device:updated', device);
      }
    }, 4000);

    disconnectTimers.set(deviceId, timer);
  });
});

// Periodic stale check (if an HTTP-only background device hasn't sent a ping in 60s, mark offline)
setInterval(() => {
  const now = Date.now();
  devices.forEach((device) => {
    if (device.status === 'online' && !device.socketId && now - device.lastSeen > 60000) {
      device.status = 'offline';
      io.to('admins').emit('device:updated', device);
    }
  });
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
  const lanIps = getLocalIPv4Addresses();
  console.log('\n============================================================');
  console.log('  24/7 LIVE LOCATION TRACKER & ADMIN SERVER RUNNING');
  console.log('============================================================');
  console.log(`  Local Tracker App : http://localhost:${PORT}/track`);
  console.log(`  Local Admin Map   : http://localhost:${PORT}/admin`);
  if (lanIps.length > 0) {
    lanIps.forEach((ip) => {
      console.log(`  LAN Tracker URL   : http://${ip.address}:${PORT}/track  (${ip.name})`);
      console.log(`  LAN Admin URL     : http://${ip.address}:${PORT}/admin  (${ip.name})`);
    });
  }
  console.log('============================================================\n');
});
