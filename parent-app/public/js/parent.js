import { GuardianMap } from './map.js';

const TOKEN_KEY = 'gp_parent_token';

const state = {
  mode: 'login',
  token: localStorage.getItem(TOKEN_KEY) || '',
  parent: null,
  children: [],
  selectedChildId: null,
  rangeHours: 24,
  historyPoints: [],
  historyStats: null,
  staySpots: [],
  followLive: true,
  playbackIndex: -1,
  playbackTimer: null,
  eventSource: null,
};

const els = {
  authView: document.getElementById('authView'),
  dashboardView: document.getElementById('dashboardView'),
  tabLogin: document.getElementById('tabLogin'),
  tabRegister: document.getElementById('tabRegister'),
  nameField: document.getElementById('nameField'),
  authForm: document.getElementById('authForm'),
  authName: document.getElementById('authName'),
  authEmail: document.getElementById('authEmail'),
  authPassword: document.getElementById('authPassword'),
  authSubmitBtn: document.getElementById('authSubmitBtn'),
  authError: document.getElementById('authError'),
  logoutBtn: document.getElementById('logoutBtn'),
  sseStatusPill: document.getElementById('sseStatusPill'),
  sseDot: document.getElementById('sseDot'),
  sseLabel: document.getElementById('sseLabel'),
  childList: document.getElementById('childList'),
  staySpotsCount: document.getElementById('staySpotsCount'),
  staySpotsList: document.getElementById('staySpotsList'),
  addChildBtn: document.getElementById('addChildBtn'),
  addChildModal: document.getElementById('addChildModal'),
  closeModalBtn: document.getElementById('closeModalBtn'),
  createChildForm: document.getElementById('createChildForm'),
  childNameInput: document.getElementById('childNameInput'),
  pairingResult: document.getElementById('pairingResult'),
  modalPairingCode: document.getElementById('modalPairingCode'),
  childAppOriginLabel: document.getElementById('childAppOriginLabel'),
  copyPairCodeBtn: document.getElementById('copyPairCodeBtn'),
  copyPairLinkBtn: document.getElementById('copyPairLinkBtn'),
  rangePills: document.getElementById('rangePills'),
  refreshHistoryBtn: document.getElementById('refreshHistoryBtn'),
  statDistance: document.getElementById('statDistance'),
  statPoints: document.getElementById('statPoints'),
  statSpeed: document.getElementById('statSpeed'),
  timelineList: document.getElementById('timelineList'),
  mapContainer: document.getElementById('mapContainer'),
  hudDot: document.getElementById('hudDot'),
  hudName: document.getElementById('hudName'),
  hudDetails: document.getElementById('hudDetails'),
  zoomInBtn: document.getElementById('zoomInBtn'),
  zoomOutBtn: document.getElementById('zoomOutBtn'),
  fitRouteBtn: document.getElementById('fitRouteBtn'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  playbackSpeed: document.getElementById('playbackSpeed'),
  playbackSlider: document.getElementById('playbackSlider'),
  snapLiveBtn: document.getElementById('snapLiveBtn'),
  playbackTime: document.getElementById('playbackTime'),
};

const map = new GuardianMap(els.mapContainer);
let configuredChildAppUrl = '';

function getChildAppOrigin() {
  if (configuredChildAppUrl) return configuredChildAppUrl;
  const host = window.location.hostname || 'localhost';
  if (host === 'localhost' || host === '127.0.0.1') {
    return `${window.location.protocol}//${host}:3002`;
  }
  return window.location.origin;
}

function formatRelativeTime(iso) {
  if (!iso) return 'Never';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatDateTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function setAuthMode(mode) {
  state.mode = mode;
  els.authError.classList.add('hidden');
  if (mode === 'register') {
    els.tabRegister.classList.add('active');
    els.tabLogin.classList.remove('active');
    els.nameField.classList.remove('hidden');
    els.authSubmitBtn.textContent = 'Create Parent Account';
  } else {
    els.tabLogin.classList.add('active');
    els.tabRegister.classList.remove('active');
    els.nameField.classList.add('hidden');
    els.authSubmitBtn.textContent = 'Sign In';
  }
}

function showDashboard() {
  els.authView.classList.add('hidden');
  els.dashboardView.classList.remove('hidden');
  els.logoutBtn.classList.remove('hidden');
  els.sseStatusPill.classList.remove('hidden');
  map.resize();
}

function showAuth() {
  stopPlayback();
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  els.dashboardView.classList.add('hidden');
  els.authView.classList.remove('hidden');
  els.logoutBtn.classList.add('hidden');
  els.sseStatusPill.classList.add('hidden');
}

function connectEventStream() {
  if (!state.token) return;
  if (state.eventSource) state.eventSource.close();

  const es = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
  state.eventSource = es;

  es.addEventListener('connected', () => {
    els.sseDot.className = 'dot live';
    els.sseLabel.textContent = '24/7 Live Stream';
  });

  es.onerror = () => {
    els.sseDot.className = 'dot idle';
    els.sseLabel.textContent = 'Reconnecting...';
  };

  es.addEventListener('child_paired', () => {
    loadChildren();
  });

  es.addEventListener('child_status', (evt) => {
    const msg = JSON.parse(evt.data);
    const child = state.children.find((c) => c.id === msg.childId);
    if (child) {
      child.trackingActive = msg.trackingActive;
      child.lastSeenAt = msg.lastSeenAt;
      child.status = msg.status;
      renderChildren();
      renderHud();
    }
  });

  es.addEventListener('location_update', (evt) => {
    const msg = JSON.parse(evt.data);
    const child = state.children.find((c) => c.id === msg.childId);
    if (child) {
      child.latestLocation = msg.location;
      child.lastSeenAt = msg.childStatus.lastSeenAt;
      child.batteryLevel = msg.childStatus.batteryLevel;
      child.isCharging = msg.childStatus.isCharging;
      child.trackingActive = msg.childStatus.trackingActive;
      child.status = msg.childStatus.status;
      renderChildren();
    }

    if (msg.childId === state.selectedChildId && msg.location) {
      const exists = state.historyPoints.some((p) => p.id === msg.location.id);
      if (!exists) {
        state.historyPoints.push(msg.location);
      }
      state.staySpots = computeStaySpots(state.historyPoints, 50, 10);
      if (state.followLive) {
        state.playbackIndex = state.historyPoints.length - 1;
        syncMapAndControls(true);
      } else {
        syncPlaybackSliderBounds();
      }
      renderStaySpots();
      renderTimeline();
      updateStatsFromPoints();
    }
  });
}

function updateStatsFromPoints() {
  if (!state.historyPoints.length) {
    els.statDistance.textContent = '0 km';
    els.statPoints.textContent = '0';
    els.statSpeed.textContent = '0 km/h';
    return;
  }
  if (state.historyStats) {
    els.statDistance.textContent = `${state.historyStats.totalDistanceKm} km`;
    els.statSpeed.textContent = `${state.historyStats.maxSpeedKmh} km/h`;
  }
  els.statPoints.textContent = String(state.historyPoints.length);
}

function renderChildren() {
  if (state.children.length === 0) {
    els.childList.innerHTML =
      '<div class="empty-state">No child profiles yet. Click "+ Add Child" to pair a device.</div>';
    return;
  }

  els.childList.innerHTML = state.children
    .map((c) => {
      const selected = c.id === state.selectedChildId ? 'selected' : '';
      const initial = escapeHtml(c.name.slice(0, 1).toUpperCase());
      const battery = c.batteryLevel !== null ? `${c.batteryLevel}%` : '--';
      const statusText =
        c.status === 'unpaired'
          ? `Code: ${escapeHtml(c.pairingCode || '------')}`
          : `${c.status.toUpperCase()} · ${formatRelativeTime(c.lastSeenAt)}`;

      return `
        <div class="child-card ${selected}" data-child-id="${escapeHtml(c.id)}">
          <div class="child-card-top">
            <div class="child-identity">
              <div class="avatar" style="background:${escapeHtml(c.avatarColor)}">${initial}</div>
              <div>
                <div class="child-name">${escapeHtml(c.name)}</div>
                <div class="child-meta">
                  <span><span class="dot ${escapeHtml(c.status)}"></span> ${statusText}</span>
                </div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <span class="pill" style="padding:3px 7px;font-size:0.7rem">${battery}</span>
              <button class="btn btn-danger btn-sm" data-delete-id="${escapeHtml(c.id)}" title="Remove child" type="button">×</button>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  for (const card of els.childList.querySelectorAll('.child-card')) {
    card.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-delete-id]');
      if (delBtn) {
        e.stopPropagation();
        deleteChild(delBtn.dataset.deleteId);
        return;
      }
      selectChild(card.dataset.childId);
    });
  }
}

function renderHud() {
  const child = state.children.find((c) => c.id === state.selectedChildId);
  if (!child) {
    els.hudDot.className = 'dot';
    els.hudName.textContent = 'Select a child';
    els.hudDetails.innerHTML =
      '<span>Add and pair a child device using the Child App to begin 24/7 tracking.</span>';
    return;
  }

  els.hudDot.className = `dot ${child.status}`;
  els.hudName.textContent = child.name;

  const activePoint =
    state.playbackIndex >= 0 && state.historyPoints[state.playbackIndex]
      ? state.historyPoints[state.playbackIndex]
      : child.latestLocation;

  if (!activePoint) {
    const pairHint = child.pairingCode
      ? `Pairing code: <strong>${escapeHtml(child.pairingCode)}</strong> — enter in the Child App (${escapeHtml(getChildAppOrigin())})`
      : 'Waiting for first GPS coordinate from paired Child App...';
    els.hudDetails.innerHTML = `<span>${pairHint}</span>`;
    return;
  }

  const speedKmh =
    activePoint.speed !== null && activePoint.speed !== undefined
      ? `${(activePoint.speed * 3.6).toFixed(1)} km/h`
      : '0.0 km/h';
  const acc = activePoint.accuracy ? `±${Math.round(activePoint.accuracy)}m` : '--';
  const bat =
    activePoint.batteryLevel !== null && activePoint.batteryLevel !== undefined
      ? `${activePoint.batteryLevel}%${activePoint.isCharging ? ' (charging)' : ''}`
      : child.batteryLevel !== null
        ? `${child.batteryLevel}%`
        : '--';

  els.hudDetails.innerHTML = `
    <span>Coords: ${activePoint.lat.toFixed(5)}, ${activePoint.lng.toFixed(5)} (${acc})</span>
    <span>Speed: ${speedKmh} · Battery: ${bat}</span>
    <span>Recorded: ${formatDateTime(activePoint.recordedAt)}</span>
  `;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeStaySpots(points, radiusMeters = 50, minDurationMinutes = 10) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const minMs = minDurationMinutes * 60 * 1000;
  const nowMs = Date.now();
  const spots = [];
  let cluster = [];
  let sumLat = 0;
  let sumLng = 0;

  const finalize = (isLast) => {
    if (cluster.length < 2) return;
    const first = cluster[0];
    const last = cluster[cluster.length - 1];
    const startMs = new Date(first.recordedAt).getTime();
    const endMs = new Date(last.recordedAt).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs - startMs < minMs) return;

    const avgLat = sumLat / cluster.length;
    const avgLng = sumLng / cluster.length;
    let maxDist = 0;
    for (const p of cluster) {
      const d = haversineMeters(avgLat, avgLng, p.lat, p.lng);
      if (d > maxDist) maxDist = d;
    }

    spots.push({
      id: `stay-${spots.length + 1}-${startMs}`,
      lat: Number(avgLat.toFixed(6)),
      lng: Number(avgLng.toFixed(6)),
      radiusMeters: Math.round(maxDist),
      startedAt: first.recordedAt,
      endedAt: last.recordedAt,
      durationMinutes: Math.round((endMs - startMs) / 60000),
      pointCount: cluster.length,
      isOngoing: isLast && nowMs - endMs <= 5 * 60 * 1000,
    });
  };

  for (const pt of points) {
    if (cluster.length === 0) {
      cluster = [pt];
      sumLat = pt.lat;
      sumLng = pt.lng;
      continue;
    }
    const cLat = sumLat / cluster.length;
    const cLng = sumLng / cluster.length;
    if (haversineMeters(cLat, cLng, pt.lat, pt.lng) <= radiusMeters) {
      cluster.push(pt);
      sumLat += pt.lat;
      sumLng += pt.lng;
    } else {
      finalize(false);
      cluster = [pt];
      sumLat = pt.lat;
      sumLng = pt.lng;
    }
  }
  finalize(true);
  return spots;
}

function renderStaySpots() {
  const spots = state.staySpots || [];
  els.staySpotsCount.textContent = String(spots.length);

  if (spots.length === 0) {
    els.staySpotsList.innerHTML =
      '<div class="empty-state" style="padding:10px 6px">No 10+ min stops within 50m in this time range.</div>';
    return;
  }

  const cards = [];
  for (let i = spots.length - 1; i >= 0; i--) {
    const s = spots[i];
    const latStr = Number(s.lat).toFixed(6);
    const lngStr = Number(s.lng).toFixed(6);
    const badge = s.isOngoing
      ? '<span class="pill" style="padding:2px 6px;font-size:0.68rem;color:#34d399;border-color:rgba(16,185,129,0.45)">ACTIVE NOW</span>'
      : `<span>${s.durationMinutes} min</span>`;
    const timeRange = `${new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(s.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const mapsUrl = `https://www.google.com/maps?q=${encodeURIComponent(`${latStr},${lngStr}`)}`;

    cards.push(`
      <div class="stay-spot-card" data-spot-idx="${i}">
        <div class="stay-spot-top">
          <span>Spot S${i + 1} (${timeRange})</span>
          ${badge}
        </div>
        <div class="stay-coords">Lat: ${latStr} &nbsp;|&nbsp; Lng: ${lngStr}</div>
        <div class="stay-actions">
          <span>±${s.radiusMeters}m radius · ${s.pointCount} pts</span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" style="padding:2px 7px;font-size:0.7rem" data-copy-coords="${latStr}, ${lngStr}" type="button">Copy</button>
            <a class="btn btn-secondary btn-sm" style="padding:2px 7px;font-size:0.7rem" href="${mapsUrl}" target="_blank" rel="noopener">Google Maps</a>
          </div>
        </div>
      </div>
    `);
  }

  els.staySpotsList.innerHTML = cards.join('');

  for (const card of els.staySpotsList.querySelectorAll('.stay-spot-card')) {
    card.addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('[data-copy-coords]');
      if (copyBtn) {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(copyBtn.dataset.copyCoords);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 1200);
        } catch {
          copyBtn.textContent = 'Select text';
        }
        return;
      }
      if (e.target.closest('a')) return;

      const idx = Number(card.dataset.spotIdx);
      const spot = state.staySpots[idx];
      if (spot) {
        stopPlayback();
        state.followLive = false;
        map.panTo(spot.lat, spot.lng, 17);
      }
    });
  }
}

function renderTimeline() {
  if (state.historyPoints.length === 0) {
    els.timelineList.innerHTML =
      '<div class="empty-state">No location points recorded in this time window.</div>';
    return;
  }

  const items = [];
  for (let i = state.historyPoints.length - 1; i >= 0; i--) {
    const pt = state.historyPoints[i];
    const activeClass = i === state.playbackIndex ? 'active' : '';
    const speedKmh =
      pt.speed !== null && pt.speed !== undefined ? `${(pt.speed * 3.6).toFixed(1)} km/h` : '0 km/h';
    items.push(`
      <div class="timeline-item ${activeClass}" data-point-idx="${i}">
        <div>
          <div style="font-weight:600">${formatDateTime(pt.recordedAt)}</div>
          <div style="color:var(--text-muted);font-size:0.72rem">${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}</div>
        </div>
        <div style="text-align:right;color:var(--text-muted);font-size:0.72rem">
          <div>${speedKmh}</div>
          <div>${escapeHtml(pt.source || 'gps')}</div>
        </div>
      </div>
    `);
  }

  els.timelineList.innerHTML = items.join('');
  for (const el of els.timelineList.querySelectorAll('.timeline-item')) {
    el.addEventListener('click', () => {
      stopPlayback();
      state.followLive = false;
      state.playbackIndex = Number(el.dataset.pointIdx);
      syncMapAndControls(true);
      renderTimeline();
    });
  }
}

function syncPlaybackSliderBounds() {
  const count = state.historyPoints.length;
  els.playbackSlider.min = '0';
  els.playbackSlider.max = String(Math.max(0, count - 1));
  els.playbackSlider.disabled = count === 0;
  els.playPauseBtn.disabled = count < 2;
  els.snapLiveBtn.disabled = count === 0;
}

function syncMapAndControls(panToActive = false) {
  const child = state.children.find((c) => c.id === state.selectedChildId);
  syncPlaybackSliderBounds();

  const idx =
    state.playbackIndex >= 0 && state.playbackIndex < state.historyPoints.length
      ? state.playbackIndex
      : state.historyPoints.length - 1;

  els.playbackSlider.value = String(Math.max(0, idx));
  const pt = state.historyPoints[idx];
  els.playbackTime.textContent = pt ? formatDateTime(pt.recordedAt) : '--';

  map.setData({
    points: state.historyPoints,
    staySpots: state.staySpots,
    activeIndex: idx,
    childMeta: child ? { name: child.name, color: child.avatarColor } : undefined,
  });

  if (panToActive && pt) {
    map.panTo(pt.lat, pt.lng);
  }
  renderHud();
}

function stopPlayback() {
  if (state.playbackTimer) {
    clearInterval(state.playbackTimer);
    state.playbackTimer = null;
  }
  els.playPauseBtn.textContent = 'Play Route';
}

function togglePlayback() {
  if (state.playbackTimer) {
    stopPlayback();
    return;
  }
  if (state.historyPoints.length < 2) return;

  state.followLive = false;
  if (state.playbackIndex >= state.historyPoints.length - 1 || state.playbackIndex < 0) {
    state.playbackIndex = 0;
  }

  els.playPauseBtn.textContent = 'Pause';
  const speed = Number(els.playbackSpeed.value) || 1;
  const intervalMs = Math.max(120, Math.floor(800 / speed));

  state.playbackTimer = setInterval(() => {
    if (state.playbackIndex >= state.historyPoints.length - 1) {
      stopPlayback();
      return;
    }
    state.playbackIndex += 1;
    syncMapAndControls(true);
    renderTimeline();
  }, intervalMs);
}

async function loadChildren() {
  const data = await apiFetch('/api/children');
  state.children = data.children || [];
  if (!state.selectedChildId && state.children.length > 0) {
    state.selectedChildId = state.children[0].id;
  } else if (
    state.selectedChildId &&
    !state.children.some((c) => c.id === state.selectedChildId)
  ) {
    state.selectedChildId = state.children[0]?.id || null;
  }
  renderChildren();
  await loadHistory(true);
}

async function selectChild(childId) {
  stopPlayback();
  state.selectedChildId = childId;
  state.followLive = true;
  renderChildren();
  await loadHistory(true);
}

async function deleteChild(childId) {
  await apiFetch(`/api/children/${encodeURIComponent(childId)}`, { method: 'DELETE' });
  if (state.selectedChildId === childId) {
    state.selectedChildId = null;
    state.historyPoints = [];
  }
  await loadChildren();
}

async function loadHistory(fitMap = false) {
  if (!state.selectedChildId) {
    state.historyPoints = [];
    state.historyStats = null;
    state.staySpots = [];
    state.playbackIndex = -1;
    updateStatsFromPoints();
    renderStaySpots();
    renderTimeline();
    syncMapAndControls(false);
    return;
  }

  const to = new Date();
  const from = new Date(to.getTime() - state.rangeHours * 60 * 60 * 1000);
  const query = `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&limit=2000`;
  const data = await apiFetch(
    `/api/children/${encodeURIComponent(state.selectedChildId)}/history${query}`
  );

  state.historyPoints = data.points || [];
  state.historyStats = data.stats || null;
  state.staySpots = data.staySpots || computeStaySpots(state.historyPoints, 50, 10);
  state.playbackIndex = state.historyPoints.length - 1;

  updateStatsFromPoints();
  renderStaySpots();
  renderTimeline();
  syncMapAndControls(false);
  if (fitMap && state.historyPoints.length > 0) {
    map.fitPoints(state.historyPoints);
  }
}

function showPairingModal(child) {
  const childOrigin = getChildAppOrigin();
  const link = `${childOrigin}/?code=${encodeURIComponent(child.pairingCode)}`;
  els.modalPairingCode.textContent = child.pairingCode;
  els.childAppOriginLabel.textContent = childOrigin;
  els.pairingResult.classList.remove('hidden');

  els.copyPairCodeBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(child.pairingCode);
      els.copyPairCodeBtn.textContent = 'Code Copied!';
      setTimeout(() => {
        els.copyPairCodeBtn.textContent = 'Copy Pairing Code';
      }, 1500);
    } catch {
      els.copyPairCodeBtn.textContent = 'Copy manually';
    }
  };

  els.copyPairLinkBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      els.copyPairLinkBtn.textContent = 'Link Copied!';
      setTimeout(() => {
        els.copyPairLinkBtn.textContent = 'Copy Child App Link';
      }, 1500);
    } catch {
      els.copyPairLinkBtn.textContent = 'Copy manually';
    }
  };
}

els.tabLogin.addEventListener('click', () => setAuthMode('login'));
els.tabRegister.addEventListener('click', () => setAuthMode('register'));

els.authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.authError.classList.add('hidden');
  try {
    const endpoint = state.mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const payload = {
      email: els.authEmail.value.trim(),
      password: els.authPassword.value,
    };
    if (state.mode === 'register') {
      payload.name = els.authName.value.trim();
    }
    const res = await apiFetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    state.token = res.token;
    state.parent = res.parent;
    localStorage.setItem(TOKEN_KEY, res.token);
    showDashboard();
    connectEventStream();
    await loadChildren();
  } catch (err) {
    els.authError.textContent = err.message;
    els.authError.classList.remove('hidden');
  }
});

els.logoutBtn.addEventListener('click', () => {
  state.token = '';
  state.parent = null;
  state.children = [];
  state.selectedChildId = null;
  localStorage.removeItem(TOKEN_KEY);
  showAuth();
});

els.addChildBtn.addEventListener('click', () => {
  els.pairingResult.classList.add('hidden');
  els.childNameInput.value = '';
  els.addChildModal.classList.remove('hidden');
});

els.closeModalBtn.addEventListener('click', () => {
  els.addChildModal.classList.add('hidden');
});

els.createChildForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.childNameInput.value.trim();
  if (!name) return;
  const data = await apiFetch('/api/children', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  showPairingModal(data.child);
  state.selectedChildId = data.child.id;
  await loadChildren();
});

for (const btn of els.rangePills.querySelectorAll('.range-btn')) {
  btn.addEventListener('click', () => {
    for (const b of els.rangePills.querySelectorAll('.range-btn')) {
      b.classList.remove('active');
    }
    btn.classList.add('active');
    state.rangeHours = Number(btn.dataset.hours);
    stopPlayback();
    loadHistory(true);
  });
}

els.refreshHistoryBtn.addEventListener('click', () => loadHistory(false));
els.zoomInBtn.addEventListener('click', () => map.setZoom(map.zoom + 1));
els.zoomOutBtn.addEventListener('click', () => map.setZoom(map.zoom - 1));
els.fitRouteBtn.addEventListener('click', () => map.fitPoints(state.historyPoints));

els.playPauseBtn.addEventListener('click', togglePlayback);
els.playbackSpeed.addEventListener('change', () => {
  if (state.playbackTimer) {
    stopPlayback();
    togglePlayback();
  }
});

els.playbackSlider.addEventListener('input', () => {
  stopPlayback();
  state.followLive = false;
  state.playbackIndex = Number(els.playbackSlider.value);
  syncMapAndControls(true);
  renderTimeline();
});

els.snapLiveBtn.addEventListener('click', () => {
  stopPlayback();
  state.followLive = true;
  state.playbackIndex = state.historyPoints.length - 1;
  syncMapAndControls(true);
  renderTimeline();
});

setInterval(() => {
  if (state.token && state.children.length > 0) {
    renderChildren();
    renderHud();
  }
}, 15000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

(async function init() {
  try {
    const cfg = await fetch('/api/config').then((r) => (r.ok ? r.json() : {}));
    if (cfg && cfg.childAppUrl) {
      configuredChildAppUrl = cfg.childAppUrl;
    }
  } catch {
    // Fallback to default origin detection
  }

  if (!state.token) {
    showAuth();
    return;
  }
  try {
    const me = await apiFetch('/api/auth/me');
    state.parent = me.parent;
    showDashboard();
    connectEventStream();
    await loadChildren();
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    state.token = '';
    showAuth();
  }
})();
