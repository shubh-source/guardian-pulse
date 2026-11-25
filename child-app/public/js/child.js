const DEVICE_TOKEN_KEY = 'gp_child_device_token';
const CHILD_META_KEY = 'gp_child_meta';
const API_BASE_KEY = 'gp_child_api_base';
const QUEUE_KEY = 'gp_offline_queue';
const MAX_QUEUE_SIZE = 5000;

const state = {
  deviceToken: localStorage.getItem(DEVICE_TOKEN_KEY) || '',
  apiBase: localStorage.getItem(API_BASE_KEY) || '',
  child: null,
  trackingActive: true,
  watchId: null,
  heartbeatTimer: null,
  flushTimer: null,
  simTimer: null,
  simStep: 0,
  wakeLock: null,
  wakeLockWanted: false,
  lastCoords: null,
  lastSyncedAt: null,
};

const els = {
  headerDot: document.getElementById('headerDot'),
  headerStateText: document.getElementById('headerStateText'),
  pairCard: document.getElementById('pairCard'),
  pairForm: document.getElementById('pairForm'),
  pairError: document.getElementById('pairError'),
  pairingCodeInput: document.getElementById('pairingCodeInput'),
  deviceNameInput: document.getElementById('deviceNameInput'),
  apiServerInput: document.getElementById('apiServerInput'),
  trackerCard: document.getElementById('trackerCard'),
  statusBanner: document.getElementById('statusBanner'),
  trackerDot: document.getElementById('trackerDot'),
  trackerStateLabel: document.getElementById('trackerStateLabel'),
  networkBadge: document.getElementById('networkBadge'),
  sharedWithText: document.getElementById('sharedWithText'),
  toggleTrackingBtn: document.getElementById('toggleTrackingBtn'),
  telCoords: document.getElementById('telCoords'),
  telLastSync: document.getElementById('telLastSync'),
  telAccuracy: document.getElementById('telAccuracy'),
  telQueue: document.getElementById('telQueue'),
  sendNowBtn: document.getElementById('sendNowBtn'),
  wakeLockBtn: document.getElementById('wakeLockBtn'),
  simulateBtn: document.getElementById('simulateBtn'),
  trackerError: document.getElementById('trackerError'),
  unpairBtn: document.getElementById('unpairBtn'),
};

function apiUrl(endpoint) {
  const base = state.apiBase ? state.apiBase.replace(/\/+$/, '') : '';
  return `${base}${endpoint}`;
}

function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(items) {
  const trimmed = items.slice(-MAX_QUEUE_SIZE);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(trimmed));
  els.telQueue.textContent = `${trimmed.length} pts`;
}

function enqueuePoints(newPoints) {
  const queue = readQueue();
  for (const pt of newPoints) {
    queue.push(pt);
  }
  writeQueue(queue);
}

async function getBatteryStatus() {
  try {
    if (typeof navigator.getBattery === 'function') {
      const bat = await navigator.getBattery();
      return {
        batteryLevel: Math.round(bat.level * 100),
        isCharging: Boolean(bat.charging),
      };
    }
  } catch {
    // Battery API unavailable
  }
  return { batteryLevel: null, isCharging: null };
}

function showTrackerError(msg) {
  if (!msg) {
    els.trackerError.classList.add('hidden');
    return;
  }
  els.trackerError.textContent = msg;
  els.trackerError.classList.remove('hidden');
}

function updateNetworkBadge() {
  els.networkBadge.textContent = navigator.onLine ? 'Online' : 'Offline (Queuing)';
}

function updateStatusBanner() {
  if (state.trackingActive) {
    els.statusBanner.classList.remove('paused');
    els.trackerDot.className = 'dot live';
    els.headerDot.className = 'dot live';
    els.headerStateText.textContent = 'Sharing Live';
    els.trackerStateLabel.textContent = '24/7 Location Sharing Active';
    els.toggleTrackingBtn.textContent = 'Pause Sharing';
  } else {
    els.statusBanner.classList.add('paused');
    els.trackerDot.className = 'dot idle';
    els.headerDot.className = 'dot idle';
    els.headerStateText.textContent = 'Paused';
    els.trackerStateLabel.textContent = 'Location Sharing Paused';
    els.toggleTrackingBtn.textContent = 'Resume Sharing';
  }
}

function updateTelemetryDisplay(point) {
  if (point) {
    els.telCoords.textContent = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    const acc = point.accuracy ? `±${Math.round(point.accuracy)}m` : '--';
    const kmh = point.speed ? `${(point.speed * 3.6).toFixed(1)} km/h` : '0 km/h';
    els.telAccuracy.textContent = `${acc} · ${kmh}`;
  }
  if (state.lastSyncedAt) {
    els.telLastSync.textContent = new Date(state.lastSyncedAt).toLocaleTimeString();
  }
  els.telQueue.textContent = `${readQueue().length} pts`;
}

async function flushQueue() {
  if (!state.deviceToken || !navigator.onLine) return;
  const queue = readQueue();
  if (queue.length === 0) return;

  const batch = queue.slice(0, 200);
  try {
    const res = await fetch(apiUrl('/api/locations'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': state.deviceToken,
      },
      body: JSON.stringify({ points: batch }),
    });
    if (res.status === 401) {
      handleUnpair(false);
      return;
    }
    if (!res.ok) return;

    const remaining = readQueue().slice(batch.length);
    writeQueue(remaining);
    state.lastSyncedAt = new Date().toISOString();
    updateTelemetryDisplay(null);
    showTrackerError('');

    if (remaining.length > 0) {
      flushQueue();
    }
  } catch {
    // Stay queued for next retry
  }
}

async function pushLocationPoint(point) {
  state.lastCoords = point;
  updateTelemetryDisplay(point);

  if (!navigator.onLine) {
    enqueuePoints([point]);
    return;
  }

  try {
    const res = await fetch(apiUrl('/api/locations'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': state.deviceToken,
      },
      body: JSON.stringify(point),
    });
    if (res.status === 401) {
      handleUnpair(false);
      return;
    }
    if (!res.ok) {
      enqueuePoints([point]);
      return;
    }
    state.lastSyncedAt = new Date().toISOString();
    updateTelemetryDisplay(point);
    showTrackerError('');
    flushQueue();
  } catch {
    enqueuePoints([point]);
  }
}

async function handlePosition(pos, source = 'gps') {
  if (!state.trackingActive) return;
  const bat = await getBatteryStatus();
  const point = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: pos.coords.accuracy ?? null,
    speed: pos.coords.speed ?? null,
    heading: pos.coords.heading ?? null,
    altitude: pos.coords.altitude ?? null,
    batteryLevel: bat.batteryLevel,
    isCharging: bat.isCharging,
    source,
    recordedAt: new Date(pos.timestamp || Date.now()).toISOString(),
  };
  await pushLocationPoint(point);
}

function startGeolocation() {
  stopGeolocation();
  if (!('geolocation' in navigator)) {
    showTrackerError(
      'Geolocation is not supported in this browser. Use "Simulate Walk (Test)" to test.'
    );
    return;
  }

  state.watchId = navigator.geolocation.watchPosition(
    (pos) => handlePosition(pos, 'gps'),
    (err) => {
      showTrackerError(`GPS warning: ${err.message}. You can still test with "Simulate Walk".`);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 10000,
      timeout: 20000,
    }
  );

  state.heartbeatTimer = setInterval(() => {
    if (!state.trackingActive) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => handlePosition(pos, 'heartbeat'),
      () => {},
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 15000 }
    );
  }, 30000);
}

function stopGeolocation() {
  if (state.watchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

async function syncTrackingStateToServer(active) {
  if (!state.deviceToken) return;
  try {
    await fetch(apiUrl('/api/device/tracking-state'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': state.deviceToken,
      },
      body: JSON.stringify({ active }),
    });
  } catch {
    // Ignore offline error
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    showTrackerError('Screen Wake Lock API is not supported in this browser.');
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLockWanted = true;
    els.wakeLockBtn.textContent = 'Keep Screen Awake: ON';
    state.wakeLock.addEventListener('release', () => {
      els.wakeLockBtn.textContent = 'Keep Screen Awake: OFF';
    });
  } catch (err) {
    showTrackerError(`Wake Lock declined: ${err.message}`);
  }
}

async function releaseWakeLock() {
  state.wakeLockWanted = false;
  if (state.wakeLock) {
    await state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }
  els.wakeLockBtn.textContent = 'Keep Screen Awake: OFF';
}

function toggleSimulator() {
  if (state.simTimer) {
    clearInterval(state.simTimer);
    state.simTimer = null;
    els.simulateBtn.textContent = 'Simulate Walk (Test)';
    return;
  }

  const baseLat = state.lastCoords?.lat ?? 37.7749;
  const baseLng = state.lastCoords?.lng ?? -122.4194;
  els.simulateBtn.textContent = 'Stop Simulator';

  const emitStep = async () => {
    if (!state.trackingActive) return;
    state.simStep += 1;
    const angle = state.simStep * 0.28;
    const radius = 0.0018;
    const lat = baseLat + Math.sin(angle) * radius + state.simStep * 0.00012;
    const lng = baseLng + Math.cos(angle) * radius + state.simStep * 0.0001;
    const bat = await getBatteryStatus();

    await pushLocationPoint({
      lat,
      lng,
      accuracy: 8 + (state.simStep % 5),
      speed: 1.4,
      heading: ((angle * 180) / Math.PI) % 360,
      batteryLevel: bat.batteryLevel ?? 86,
      isCharging: bat.isCharging ?? false,
      source: 'simulator',
      recordedAt: new Date().toISOString(),
    });
  };

  emitStep();
  state.simTimer = setInterval(emitStep, 2500);
}

function showPairedView(child) {
  state.child = child;
  els.pairCard.classList.add('hidden');
  els.trackerCard.classList.remove('hidden');
  els.sharedWithText.textContent = `Child: ${child.name} · Parent: ${child.parentName} (${child.deviceName})`;
  updateStatusBanner();
  updateNetworkBadge();
  updateTelemetryDisplay(null);

  if (!state.flushTimer) {
    state.flushTimer = setInterval(flushQueue, 15000);
  }
  if (state.trackingActive) {
    startGeolocation();
  }
  flushQueue();
}

function handleUnpair(notifyServer = true) {
  if (notifyServer) {
    syncTrackingStateToServer(false);
  }
  stopGeolocation();
  if (state.simTimer) {
    clearInterval(state.simTimer);
    state.simTimer = null;
  }
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
  releaseWakeLock();
  localStorage.removeItem(DEVICE_TOKEN_KEY);
  localStorage.removeItem(CHILD_META_KEY);
  state.deviceToken = '';
  state.child = null;
  els.headerDot.className = 'dot';
  els.headerStateText.textContent = 'Not Paired';
  els.trackerCard.classList.add('hidden');
  els.pairCard.classList.remove('hidden');
}

els.pairForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.pairError.classList.add('hidden');
  const pairingCode = els.pairingCodeInput.value.trim().toUpperCase();
  const deviceName = els.deviceNameInput.value.trim() || navigator.platform || 'Child Browser';
  const customApi = els.apiServerInput.value.trim().replace(/\/+$/, '');

  state.apiBase = customApi;
  if (customApi) {
    localStorage.setItem(API_BASE_KEY, customApi);
  } else {
    localStorage.removeItem(API_BASE_KEY);
  }

  try {
    const res = await fetch(apiUrl('/api/pair'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode, deviceName }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Pairing failed');
    }

    state.deviceToken = data.deviceToken;
    localStorage.setItem(DEVICE_TOKEN_KEY, data.deviceToken);
    localStorage.setItem(CHILD_META_KEY, JSON.stringify(data.child));
    state.trackingActive = true;
    showPairedView(data.child);
  } catch (err) {
    els.pairError.textContent = err.message;
    els.pairError.classList.remove('hidden');
  }
});

els.toggleTrackingBtn.addEventListener('click', () => {
  state.trackingActive = !state.trackingActive;
  updateStatusBanner();
  syncTrackingStateToServer(state.trackingActive);
  if (state.trackingActive) {
    startGeolocation();
  } else {
    stopGeolocation();
  }
});

els.sendNowBtn.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    showTrackerError('Geolocation unavailable; use "Simulate Walk (Test)".');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => handlePosition(pos, 'manual'),
    (err) => showTrackerError(`GPS error: ${err.message}`),
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

els.wakeLockBtn.addEventListener('click', () => {
  if (state.wakeLock) {
    releaseWakeLock();
  } else {
    requestWakeLock();
  }
});

els.simulateBtn.addEventListener('click', toggleSimulator);
els.unpairBtn.addEventListener('click', () => handleUnpair(true));

window.addEventListener('online', () => {
  updateNetworkBadge();
  flushQueue();
});
window.addEventListener('offline', updateNetworkBadge);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.wakeLockWanted && !state.wakeLock) {
    requestWakeLock();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

(async function init() {
  const params = new URLSearchParams(window.location.search);
  const codeFromUrl = params.get('code');
  const apiFromUrl = params.get('server');
  if (codeFromUrl) {
    els.pairingCodeInput.value = codeFromUrl.toUpperCase();
  }
  if (apiFromUrl) {
    els.apiServerInput.value = apiFromUrl;
    state.apiBase = apiFromUrl.replace(/\/+$/, '');
  } else if (state.apiBase) {
    els.apiServerInput.value = state.apiBase;
  }

  if (!state.deviceToken) return;

  try {
    const res = await fetch(apiUrl('/api/device/status'), {
      headers: { 'X-Device-Token': state.deviceToken },
    });
    if (res.status === 401) {
      handleUnpair(false);
      return;
    }
    const data = await res.json();
    state.trackingActive = Boolean(data.child?.trackingActive ?? true);
    showPairedView(data.child);
  } catch {
    const cached = localStorage.getItem(CHILD_META_KEY);
    if (cached) {
      showPairedView(JSON.parse(cached));
    }
  }
})();
