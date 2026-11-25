const EARTH_RADIUS_KM = 6371;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Compute great-circle distance in kilometers between two lat/lng coordinates.
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Validate and normalize an incoming GPS location point.
 */
function normalizeLocationPoint(raw, fallbackIso = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Location payload must be an object' };
  }
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return { error: 'Invalid latitude; must be between -90 and 90' };
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { error: 'Invalid longitude; must be between -180 and 180' };
  }

  const accuracy = raw.accuracy !== undefined && raw.accuracy !== null ? Number(raw.accuracy) : null;
  const speed = raw.speed !== undefined && raw.speed !== null ? Number(raw.speed) : null;
  const heading = raw.heading !== undefined && raw.heading !== null ? Number(raw.heading) : null;
  const altitude = raw.altitude !== undefined && raw.altitude !== null ? Number(raw.altitude) : null;
  const batteryLevel =
    raw.batteryLevel !== undefined && raw.batteryLevel !== null ? Number(raw.batteryLevel) : null;
  const isCharging =
    raw.isCharging === true || raw.isCharging === 1
      ? 1
      : raw.isCharging === false || raw.isCharging === 0
        ? 0
        : null;

  let recordedAt = fallbackIso;
  if (raw.recordedAt) {
    const parsed = new Date(raw.recordedAt);
    if (!Number.isNaN(parsed.getTime())) {
      recordedAt = parsed.toISOString();
    }
  }

  const source = typeof raw.source === 'string' && raw.source.slice(0, 24) ? raw.source.slice(0, 24) : 'gps';

  return {
    value: {
      lat,
      lng,
      accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
      speed: Number.isFinite(speed) && speed >= 0 ? speed : null,
      heading: Number.isFinite(heading) ? heading : null,
      altitude: Number.isFinite(altitude) ? altitude : null,
      batteryLevel:
        Number.isFinite(batteryLevel) && batteryLevel >= 0 && batteryLevel <= 100
          ? Math.round(batteryLevel)
          : null,
      isCharging,
      source,
      recordedAt,
    },
  };
}

/**
 * Compute summary statistics over an ascending array of location points.
 */
function computeHistoryStats(points) {
  if (!points || points.length === 0) {
    return {
      totalPoints: 0,
      totalDistanceKm: 0,
      maxSpeedKmh: 0,
      avgAccuracyM: null,
      firstRecordedAt: null,
      lastRecordedAt: null,
    };
  }

  let totalDistanceKm = 0;
  let maxSpeedMps = 0;
  let accuracySum = 0;
  let accuracyCount = 0;

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (pt.accuracy !== null && pt.accuracy !== undefined) {
      accuracySum += pt.accuracy;
      accuracyCount += 1;
    }
    if (pt.speed !== null && pt.speed !== undefined && pt.speed > maxSpeedMps) {
      maxSpeedMps = pt.speed;
    }
    if (i > 0) {
      const prev = points[i - 1];
      const segKm = haversineKm(prev.lat, prev.lng, pt.lat, pt.lng);
      // Filter unrealistic GPS jumps if accuracy is very poor (> 500m) and jump is huge
      if (segKm < 200) {
        totalDistanceKm += segKm;
      }
    }
  }

  return {
    totalPoints: points.length,
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    maxSpeedKmh: Number((maxSpeedMps * 3.6).toFixed(1)),
    avgAccuracyM: accuracyCount > 0 ? Math.round(accuracySum / accuracyCount) : null,
    firstRecordedAt: points[0].recorded_at || points[0].recordedAt,
    lastRecordedAt: points[points.length - 1].recorded_at || points[points.length - 1].recordedAt,
  };
}

/**
 * Derive online/idle/offline status from lastSeenAt and trackingActive.
 */
function deriveConnectionStatus(lastSeenAt, trackingActive, nowMs = Date.now()) {
  if (!lastSeenAt) return 'unpaired';
  const lastMs = new Date(lastSeenAt).getTime();
  if (Number.isNaN(lastMs)) return 'offline';
  const ageSec = (nowMs - lastMs) / 1000;
  if (trackingActive && ageSec <= 90) return 'live';
  if (ageSec <= 600) return 'idle';
  return 'offline';
}

/**
 * Detect stay spots where a child remained within `radiusMeters` (default 50m)
 * for at least `minDurationMinutes` (default 10 minutes).
 * Expects `points` sorted in ascending chronological order.
 */
function detectStaySpots(points, options = {}) {
  const radiusMeters = Number.isFinite(options.radiusMeters) ? options.radiusMeters : 50;
  const minDurationMs = (Number.isFinite(options.minDurationMinutes) ? options.minDurationMinutes : 10) * 60 * 1000;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

  if (!Array.isArray(points) || points.length < 2) {
    return [];
  }

  const getTs = (pt) => pt.recorded_at || pt.recordedAt;
  const spots = [];

  let cluster = [];
  let sumLat = 0;
  let sumLng = 0;

  const finalizeCluster = (isLastCluster) => {
    if (cluster.length < 2) return;
    const first = cluster[0];
    const last = cluster[cluster.length - 1];
    const startMs = new Date(getTs(first)).getTime();
    const endMs = new Date(getTs(last)).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return;

    const durationMs = endMs - startMs;
    if (durationMs < minDurationMs) return;

    const avgLat = sumLat / cluster.length;
    const avgLng = sumLng / cluster.length;
    let maxDistM = 0;
    for (const p of cluster) {
      const distM = haversineKm(avgLat, avgLng, p.lat, p.lng) * 1000;
      if (distM > maxDistM) maxDistM = distM;
    }

    spots.push({
      id: `stay-${spots.length + 1}-${startMs}`,
      lat: Number(avgLat.toFixed(6)),
      lng: Number(avgLng.toFixed(6)),
      radiusMeters: Math.round(maxDistM),
      startedAt: getTs(first),
      endedAt: getTs(last),
      durationMinutes: Math.round(durationMs / 60000),
      pointCount: cluster.length,
      isOngoing: isLastCluster && nowMs - endMs <= 5 * 60 * 1000,
    });
  };

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (cluster.length === 0) {
      cluster = [pt];
      sumLat = pt.lat;
      sumLng = pt.lng;
      continue;
    }

    const centroidLat = sumLat / cluster.length;
    const centroidLng = sumLng / cluster.length;
    const distFromCentroidM = haversineKm(centroidLat, centroidLng, pt.lat, pt.lng) * 1000;

    if (distFromCentroidM <= radiusMeters) {
      cluster.push(pt);
      sumLat += pt.lat;
      sumLng += pt.lng;
    } else {
      finalizeCluster(false);
      cluster = [pt];
      sumLat = pt.lat;
      sumLng = pt.lng;
    }
  }

  finalizeCluster(true);
  return spots;
}

module.exports = {
  haversineKm,
  normalizeLocationPoint,
  computeHistoryStats,
  deriveConnectionStatus,
  detectStaySpots,
};
