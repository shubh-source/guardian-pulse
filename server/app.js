const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createDatabase } = require('./db');
const {
  loadOrCreateSecret,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  generatePairingCode,
  generateDeviceToken,
  hashDeviceToken,
} = require('./auth');
const {
  normalizeLocationPoint,
  computeHistoryStats,
  deriveConnectionStatus,
  detectStaySpots,
} = require('./geo');

const AVATAR_COLORS = ['#2563eb', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed'];
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

const ALLOWED_AUDIO_MIME_EXT = {
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/3gpp': '.3gp',
  'audio/3gpp2': '.3g2',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
};

const ALLOWED_VIDEO_MIME_EXT = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function extractBearerToken(req, queryToken = null) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const deviceHeader = req.headers['x-device-token'];
  if (typeof deviceHeader === 'string' && deviceHeader.trim()) {
    return deviceHeader.trim();
  }
  if (typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken.trim();
  }
  return null;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Device-Token, X-Call-Direction, X-Call-Number, X-Call-Started-At, X-Call-Ended-At, X-Call-Duration-Sec, X-Call-Audio-Source, X-Screen-Started-At, X-Screen-Ended-At, X-Screen-Duration-Sec, X-Screen-Width, X-Screen-Height, X-Screen-Fps',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON payload'), { statusCode: 400 }));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

function readBinaryBody(req, maxBytes = MAX_AUDIO_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('Audio upload exceeds maximum allowed size'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => reject(err));
  });
}

function safeDecodeHeader(val) {
  if (typeof val !== 'string') return '';
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function parseTimeWindow(raw, nowIso) {
  let endedAt = nowIso;
  if (raw.endedAt) {
    const d = new Date(raw.endedAt);
    if (Number.isNaN(d.getTime())) {
      return { error: 'Invalid endedAt timestamp' };
    }
    endedAt = d.toISOString();
  }

  let durationSec = Number(raw.durationSec);
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    durationSec = 0;
  } else {
    durationSec = Math.round(durationSec);
  }

  let startedAt;
  if (raw.startedAt) {
    const d = new Date(raw.startedAt);
    if (Number.isNaN(d.getTime())) {
      return { error: 'Invalid startedAt timestamp' };
    }
    startedAt = d.toISOString();
    if (!raw.durationSec && Date.parse(endedAt) >= Date.parse(startedAt)) {
      durationSec = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
    }
  } else {
    startedAt = new Date(Date.parse(endedAt) - durationSec * 1000).toISOString();
  }

  return { startedAt, endedAt, durationSec };
}

function normalizeCallMetadata(raw, nowIso) {
  const direction = typeof raw.direction === 'string' ? raw.direction.trim().toLowerCase() : '';
  if (direction !== 'incoming' && direction !== 'outgoing') {
    return { error: 'direction must be "incoming" or "outgoing"' };
  }

  const rawNumber = typeof raw.phoneNumber === 'string' ? raw.phoneNumber.trim() : '';
  const phoneNumber = rawNumber ? rawNumber.slice(0, 40) : 'Unknown';

  const rawMime = typeof raw.mimeType === 'string' ? raw.mimeType.split(';')[0].trim().toLowerCase() : '';
  const mimeType = ALLOWED_AUDIO_MIME_EXT[rawMime] ? rawMime : 'audio/mp4';
  const ext = ALLOWED_AUDIO_MIME_EXT[mimeType] || '.m4a';

  const windowResult = parseTimeWindow(raw, nowIso);
  if (windowResult.error) return windowResult;

  const audioSource =
    typeof raw.audioSource === 'string' && raw.audioSource.trim()
      ? raw.audioSource.trim().slice(0, 40)
      : 'microphone';

  return {
    value: {
      direction,
      phoneNumber,
      startedAt: windowResult.startedAt,
      endedAt: windowResult.endedAt,
      durationSec: windowResult.durationSec,
      mimeType,
      ext,
      audioSource,
    },
  };
}

function normalizePositiveInt(val, fallback = 0, max = 10000) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.round(n), max);
}

function normalizeScreenMetadata(raw, nowIso) {
  const rawMime = typeof raw.mimeType === 'string' ? raw.mimeType.split(';')[0].trim().toLowerCase() : '';
  const mimeType = ALLOWED_VIDEO_MIME_EXT[rawMime] ? rawMime : 'video/mp4';
  const ext = ALLOWED_VIDEO_MIME_EXT[mimeType] || '.mp4';

  const windowResult = parseTimeWindow(raw, nowIso);
  if (windowResult.error) return windowResult;

  return {
    value: {
      startedAt: windowResult.startedAt,
      endedAt: windowResult.endedAt,
      durationSec: windowResult.durationSec,
      width: normalizePositiveInt(raw.width, 0, 8192),
      height: normalizePositiveInt(raw.height, 0, 8192),
      fps: normalizePositiveInt(raw.fps, 0, 120),
      mimeType,
      ext,
    },
  };
}

function serializeCallRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    childId: row.child_id,
    direction: row.direction,
    phoneNumber: row.phone_number || 'Unknown',
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSec: row.duration_sec,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    audioSource: row.audio_source || 'microphone',
    createdAt: row.created_at,
    audioUrl: `/api/calls/${encodeURIComponent(row.id)}/audio`,
  };
}

function serializeScreenRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    childId: row.child_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSec: row.duration_sec,
    width: row.width || 0,
    height: row.height || 0,
    fps: row.fps || 0,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    createdAt: row.created_at,
    videoUrl: `/api/screen-recordings/${encodeURIComponent(row.id)}/video`,
  };
}

function serializeLocationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    childId: row.child_id,
    lat: row.lat,
    lng: row.lng,
    accuracy: row.accuracy,
    speed: row.speed,
    heading: row.heading,
    altitude: row.altitude,
    batteryLevel: row.battery_level,
    isCharging: row.is_charging === null ? null : Boolean(row.is_charging),
    source: row.source,
    recordedAt: row.recorded_at,
    receivedAt: row.received_at,
  };
}

function serializeChildRow(row, latestLocation) {
  const isPaired = Boolean(row.is_paired ?? row.paired_at);
  const trackingActive = Boolean(row.tracking_active);
  return {
    id: row.id,
    name: row.name,
    avatarColor: row.avatar_color,
    isPaired,
    pairingCode: row.pairing_code || null,
    pairingExpiresAt: row.pairing_expires_at || null,
    deviceName: row.device_name || null,
    pairedAt: row.paired_at || null,
    lastSeenAt: row.last_seen_at || null,
    batteryLevel: row.battery_level ?? null,
    isCharging:
      row.is_charging === null || row.is_charging === undefined ? null : Boolean(row.is_charging),
    trackingActive,
    status: isPaired ? deriveConnectionStatus(row.last_seen_at, trackingActive) : 'unpaired',
    latestLocation: serializeLocationRow(latestLocation),
    createdAt: row.created_at,
  };
}

/**
 * Create the zero-dependency Node.js HTTP + SSE + SQLite application instance.
 */
function createApp(options = {}) {
  const dbPath = options.dbPath || path.join(__dirname, '..', 'data', 'guardian.db');
  const secretPath =
    options.secretPath || (dbPath === ':memory:' ? null : path.join(path.dirname(dbPath), '.secret'));
  const sessionSecret = options.sessionSecret || loadOrCreateSecret(secretPath);
  const publicDir =
    options.publicDir === null
      ? null
      : path.resolve(options.publicDir || path.join(__dirname, '..', 'parent-app', 'public'));
  const recordingsDir =
    options.recordingsDir !== undefined
      ? options.recordingsDir
      : dbPath === ':memory:'
        ? null
        : path.join(path.dirname(dbPath), 'recordings');
  const memoryRecordings = new Map();

  if (recordingsDir) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  function storeMediaFile(fileName, buffer) {
    if (!recordingsDir) {
      memoryRecordings.set(fileName, buffer);
      return;
    }
    const baseDir = path.resolve(recordingsDir);
    const targetPath = path.resolve(baseDir, fileName);
    if (!targetPath.startsWith(baseDir + path.sep)) {
      throw new Error('Invalid recording path');
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, buffer);
  }

  function deleteMediaFile(fileName) {
    if (!fileName) return;
    if (!recordingsDir) {
      memoryRecordings.delete(fileName);
      return;
    }
    const baseDir = path.resolve(recordingsDir);
    const targetPath = path.resolve(baseDir, fileName);
    if (targetPath.startsWith(baseDir + path.sep)) {
      try {
        fs.unlinkSync(targetPath);
      } catch {
        // Ignore missing file
      }
    }
  }

  function serveMediaFile(req, res, row, downloadName, defaultMime, defaultExt) {
    const ext = path.extname(row.file_name) || defaultExt;
    const contentType = row.mime_type || defaultMime;
    const rangeHeader = req.headers.range;

    if (!recordingsDir) {
      const buf = memoryRecordings.get(row.file_name);
      if (!buf) {
        return sendJson(res, 404, { error: 'Recording not found' });
      }
      const total = buf.length;
      if (rangeHeader && rangeHeader.startsWith('bytes=')) {
        const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
        const start = startStr ? parseInt(startStr, 10) : 0;
        const end = endStr ? Math.min(parseInt(endStr, 10), total - 1) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || end >= total) {
          res.writeHead(416, { ...CORS_HEADERS, 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }
        const slice = buf.subarray(start, end + 1);
        res.writeHead(206, {
          ...CORS_HEADERS,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': slice.length,
          'Cache-Control': 'no-store',
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        ...CORS_HEADERS,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': total,
        'Content-Disposition': `inline; filename="${downloadName}${ext}"`,
        'Cache-Control': 'no-store',
      });
      res.end(buf);
      return;
    }

    const baseDir = path.resolve(recordingsDir);
    const targetPath = path.resolve(baseDir, row.file_name);
    if (!targetPath.startsWith(baseDir + path.sep)) {
      return sendJson(res, 403, { error: 'Forbidden' });
    }

    fs.stat(targetPath, (err, stat) => {
      if (err || !stat.isFile()) {
        return sendJson(res, 404, { error: 'Recording file not found' });
      }
      const total = stat.size;
      if (rangeHeader && rangeHeader.startsWith('bytes=')) {
        const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
        const start = startStr ? parseInt(startStr, 10) : 0;
        const end = endStr ? Math.min(parseInt(endStr, 10), total - 1) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || end >= total) {
          res.writeHead(416, { ...CORS_HEADERS, 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          ...CORS_HEADERS,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(targetPath, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        ...CORS_HEADERS,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': total,
        'Content-Disposition': `inline; filename="${downloadName}${ext}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(targetPath).pipe(res);
    });
  }

  const { db, statements, close: closeDb } = createDatabase(dbPath);

  // SSE parent subscriber registry: Map<parentId, Set<http.ServerResponse>>
  const parentSubscribers = new Map();

  function addParentSubscriber(parentId, res) {
    if (!parentSubscribers.has(parentId)) {
      parentSubscribers.set(parentId, new Set());
    }
    parentSubscribers.get(parentId).add(res);
  }

  function removeParentSubscriber(parentId, res) {
    const set = parentSubscribers.get(parentId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
      parentSubscribers.delete(parentId);
    }
  }

  function broadcastToParent(parentId, eventName, data) {
    const set = parentSubscribers.get(parentId);
    if (!set || set.size === 0) return;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      if (!res.writableEnded) {
        res.write(frame);
      }
    }
  }

  function authenticateParent(req, res, queryToken = null) {
    const token = extractBearerToken(req, queryToken);
    const claims = verifyToken(token, sessionSecret);
    if (!claims || !claims.parentId) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return null;
    }
    const parent = statements.findParentById.get(claims.parentId);
    if (!parent) {
      sendJson(res, 401, { error: 'Account not found' });
      return null;
    }
    return parent;
  }

  function authenticateDevice(req, res) {
    const rawToken = extractBearerToken(req);
    if (!rawToken) {
      sendJson(res, 401, { error: 'Missing device token' });
      return null;
    }
    const child = statements.findChildByDeviceTokenHash.get(hashDeviceToken(rawToken));
    if (!child) {
      sendJson(res, 401, { error: 'Invalid or revoked device token' });
      return null;
    }
    return child;
  }

  function recordChildLocations(child, rawPoints) {
    const pointsArray = Array.isArray(rawPoints) ? rawPoints : [rawPoints];
    if (pointsArray.length === 0) {
      return { error: 'No location points provided' };
    }
    if (pointsArray.length > 500) {
      return { error: 'Batch size exceeds 500 points limit' };
    }

    const nowIso = new Date().toISOString();
    const normalized = [];
    for (const raw of pointsArray) {
      const result = normalizeLocationPoint(raw, nowIso);
      if (result.error) {
        return { error: result.error };
      }
      normalized.push(result.value);
    }

    normalized.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));

    db.exec('BEGIN');
    try {
      for (const pt of normalized) {
        statements.insertLocation.run(
          child.id,
          pt.lat,
          pt.lng,
          pt.accuracy,
          pt.speed,
          pt.heading,
          pt.altitude,
          pt.batteryLevel,
          pt.isCharging,
          pt.source,
          pt.recordedAt,
          nowIso
        );
      }

      const newest = normalized[normalized.length - 1];
      statements.updateChildTelemetry.run(
        nowIso,
        newest.batteryLevel,
        newest.isCharging,
        1,
        child.id
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const latestRow = statements.getLatestLocationForChild.get(child.id);
    const serializedLatest = serializeLocationRow(latestRow);

    broadcastToParent(child.parent_id, 'location_update', {
      type: 'location_update',
      childId: child.id,
      location: serializedLatest,
      childStatus: {
        lastSeenAt: nowIso,
        batteryLevel: serializedLatest ? serializedLatest.batteryLevel : child.battery_level,
        isCharging: serializedLatest ? serializedLatest.isCharging : null,
        trackingActive: true,
        status: 'live',
      },
    });

    return { accepted: normalized.length, latestLocation: serializedLatest };
  }

  function serveStaticFile(res, relativePath) {
    const safeRel = relativePath.replace(/^\/+/, '');
    const targetPath = path.resolve(publicDir, safeRel);
    if (!targetPath.startsWith(publicDir + path.sep) && targetPath !== publicDir) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }

    fs.stat(targetPath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const ext = path.extname(targetPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const cacheControl =
        ext === '.html' || safeRel === 'sw.js' ? 'no-cache' : 'public, max-age=300';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': cacheControl,
      });
      fs.createReadStream(targetPath).pipe(res);
    });
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    try {
      // Health check & public runtime config
      if (method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
      }
      if (method === 'GET' && pathname === '/api/config') {
        return sendJson(res, 200, {
          childAppUrl: (process.env.CHILD_APP_URL || '').replace(/\/+$/, ''),
        });
      }

      // SSE real-time stream for parent dashboard
      if (method === 'GET' && pathname === '/api/events') {
        const parent = authenticateParent(req, res, url.searchParams.get('token'));
        if (!parent) return;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ role: 'parent', parentId: parent.id })}\n\n`);
        addParentSubscriber(parent.id, res);

        req.on('close', () => {
          removeParentSubscriber(parent.id, res);
        });
        return;
      }

      // Parent auth
      if (method === 'POST' && pathname === '/api/auth/register') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';

        if (!name || name.length < 2) {
          return sendJson(res, 400, { error: 'Name must be at least 2 characters' });
        }
        if (!email || !email.includes('@')) {
          return sendJson(res, 400, { error: 'Valid email is required' });
        }
        if (password.length < 6) {
          return sendJson(res, 400, { error: 'Password must be at least 6 characters' });
        }

        if (statements.findParentByEmail.get(email)) {
          return sendJson(res, 409, { error: 'An account with this email already exists' });
        }

        const parent = {
          id: crypto.randomUUID(),
          name: name.slice(0, 80),
          email,
          createdAt: new Date().toISOString(),
        };

        statements.insertParent.run(
          parent.id,
          parent.name,
          parent.email,
          hashPassword(password),
          parent.createdAt
        );

        const token = signToken({ parentId: parent.id, email: parent.email }, sessionSecret);
        return sendJson(res, 201, { token, parent });
      }

      if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJsonBody(req);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body.password === 'string' ? body.password : '';

        const row = statements.findParentByEmail.get(email);
        if (!row || !verifyPassword(password, row.password_hash)) {
          return sendJson(res, 401, { error: 'Invalid email or password' });
        }

        const parent = {
          id: row.id,
          name: row.name,
          email: row.email,
          createdAt: row.created_at,
        };
        const token = signToken({ parentId: parent.id, email: parent.email }, sessionSecret);
        return sendJson(res, 200, { token, parent });
      }

      if (method === 'GET' && pathname === '/api/auth/me') {
        const parent = authenticateParent(req, res);
        if (!parent) return;
        return sendJson(res, 200, {
          parent: {
            id: parent.id,
            name: parent.name,
            email: parent.email,
            createdAt: parent.created_at,
          },
        });
      }

      // Parent child-profile endpoints
      if (method === 'GET' && pathname === '/api/children') {
        const parent = authenticateParent(req, res);
        if (!parent) return;
        const rows = statements.listChildrenByParent.all(parent.id);
        const children = rows.map((row) => {
          const latest = statements.getLatestLocationForChild.get(row.id);
          return serializeChildRow(row, latest);
        });
        return sendJson(res, 200, { children });
      }

      if (method === 'POST' && pathname === '/api/children') {
        const parent = authenticateParent(req, res);
        if (!parent) return;
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          return sendJson(res, 400, { error: 'Child name is required' });
        }

        const avatarColor = AVATAR_COLORS.includes(body.avatarColor)
          ? body.avatarColor
          : AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
        const id = crypto.randomUUID();
        const pairingCode = generatePairingCode(6);
        const createdAt = new Date().toISOString();
        const pairingExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        statements.insertChild.run(
          id,
          parent.id,
          name.slice(0, 60),
          avatarColor,
          pairingCode,
          pairingExpiresAt,
          createdAt
        );

        const created = statements.findChildByIdAndParent.get(id, parent.id);
        return sendJson(res, 201, { child: serializeChildRow(created, null) });
      }

      const rotateMatch = pathname.match(/^\/api\/children\/([^/]+)\/rotate-code$/);
      if (method === 'POST' && rotateMatch) {
        const parent = authenticateParent(req, res);
        if (!parent) return;
        const childId = decodeURIComponent(rotateMatch[1]);
        const existing = statements.findChildByIdAndParent.get(childId, parent.id);
        if (!existing) {
          return sendJson(res, 404, { error: 'Child profile not found' });
        }
        const pairingCode = generatePairingCode(6);
        const pairingExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        statements.updateChildPairingCode.run(pairingCode, pairingExpiresAt, existing.id, parent.id);
        const updated = statements.findChildByIdAndParent.get(existing.id, parent.id);
        const latest = statements.getLatestLocationForChild.get(existing.id);
        return sendJson(res, 200, { child: serializeChildRow(updated, latest) });
      }

      const historyMatch = pathname.match(/^\/api\/children\/([^/]+)\/history$/);
      if (method === 'GET' && historyMatch) {
        const parent = authenticateParent(req, res);
        if (!parent) return;
        const childId = decodeURIComponent(historyMatch[1]);
        const child = statements.findChildByIdAndParent.get(childId, parent.id);
        if (!child) {
          return sendJson(res, 404, { error: 'Child profile not found' });
        }

        const now = new Date();
        const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const fromParam = url.searchParams.get('from');
        const toParam = url.searchParams.get('to');
        const fromParsed = fromParam ? new Date(fromParam) : defaultFrom;
        const toParsed = toParam ? new Date(toParam) : now;

        if (Number.isNaN(fromParsed.getTime()) || Number.isNaN(toParsed.getTime())) {
          return sendJson(res, 400, { error: 'Invalid from/to ISO timestamps' });
        }

        const rawLimit = Number(url.searchParams.get('limit') || 2000);
        const limit = Number.isFinite(rawLimit)
          ? Math.min(Math.max(1, Math.floor(rawLimit)), 10000)
          : 2000;

        const rows = statements.getLocationsInRange.all(
          child.id,
          fromParsed.toISOString(),
          toParsed.toISOString(),
          limit
        );
        const points = rows.map(serializeLocationRow);
        const stats = computeHistoryStats(rows);
        const staySpots = detectStaySpots(rows, { radiusMeters: 50, minDurationMinutes: 10 });

        return sendJson(res, 200, {
          childId: child.id,
          from: fromParsed.toISOString(),
          to: toParsed.toISOString(),
          points,
          stats,
          staySpots,
        });
      }

      const childDeleteMatch = pathname.match(/^\/api\/children\/([^/]+)$/);
      if (method === 'DELETE' && childDeleteMatch) {
        const parent = authenticateParent(req, res);
        if (!parent) return;
        const childId = decodeURIComponent(childDeleteMatch[1]);
        const callFiles = statements.listCallFilesForChild.all(childId);
        const screenFiles = statements.listScreenRecordingFilesForChild.all(childId);
        const result = statements.deleteChild.run(childId, parent.id);
        if (result.changes === 0) {
          return sendJson(res, 404, { error: 'Child profile not found' });
        }
        for (const f of callFiles) {
          deleteMediaFile(f.file_name);
        }
        for (const f of screenFiles) {
          deleteMediaFile(f.file_name);
        }
        return sendJson(res, 200, { deleted: true });
      }

      // Parent call-recording endpoints
      const callsListMatch = pathname.match(/^\/api\/children\/([^/]+)\/calls$/);
      if (method === 'GET' && callsListMatch) {
        const parent = authenticateParent(req, res);
        if (!parent) return;
        const childId = decodeURIComponent(callsListMatch[1]);
        const child = statements.findChildByIdAndParent.get(childId, parent.id);
        if (!child) {
          return sendJson(res, 404, { error: 'Child profile not found' });
        }

        const directionParam = (url.searchParams.get('direction') || 'all').toLowerCase();
        const rawLimit = Number(url.searchParams.get('limit') || 100);
        const limit = Number.isFinite(rawLimit)
          ? Math.min(Math.max(1, Math.floor(rawLimit)), 500)
          : 100;

        const rows =
          directionParam === 'incoming' || directionParam === 'outgoing'
            ? statements.listCallsByChildAndDirection.all(child.id, directionParam, limit)
            : statements.listCallsByChild.all(child.id, limit);

        return sendJson(res, 200, {
          childId: child.id,
          calls: rows.map(serializeCallRow),
        });
      }

      const callAudioMatch = pathname.match(/^\/api\/calls\/([^/]+)\/audio$/);
      if (method === 'GET' && callAudioMatch) {
        const parent = authenticateParent(req, res, url.searchParams.get('token'));
        if (!parent) return;
        const callId = decodeURIComponent(callAudioMatch[1]);
        const row = statements.findCallByIdAndParent.get(callId, parent.id);
        if (!row) {
          return sendJson(res, 404, { error: 'Call recording not found' });
        }
        return serveMediaFile(req, res, row, `call-${row.direction}-${row.id}`, 'audio/mp4', '.m4a');
      }

      const callDeleteMatch = pathname.match(/^\/api\/calls\/([^/]+)$/);
      if (method === 'DELETE' && callDeleteMatch) {
        const parent = authenticateParent(req, res);
        if (!parent) return;
        const callId = decodeURIComponent(callDeleteMatch[1]);
        const existing = statements.findCallByIdAndParent.get(callId, parent.id);
        if (!existing) {
          return sendJson(res, 404, { error: 'Call recording not found' });
        }
        statements.deleteCallByIdAndParent.run(callId, parent.id);
        deleteMediaFile(existing.file_name);
        return sendJson(res, 200, { deleted: true });
      }

      // Parent screen-recording endpoints
      const screenListMatch = pathname.match(/^\/api\/children\/([^/]+)\/screen-recordings$/);
      if (method === 'GET' && screenListMatch) {
        const parent = authenticateParent(req, res);
        if (!parent) return;
        const childId = decodeURIComponent(screenListMatch[1]);
        const child = statements.findChildByIdAndParent.get(childId, parent.id);
        if (!child) {
          return sendJson(res, 404, { error: 'Child profile not found' });
        }

        const rawLimit = Number(url.searchParams.get('limit') || 100);
        const limit = Number.isFinite(rawLimit)
          ? Math.min(Math.max(1, Math.floor(rawLimit)), 500)
          : 100;

        const rows = statements.listScreenRecordingsByChild.all(child.id, limit);
        return sendJson(res, 200, {
          childId: child.id,
          recordings: rows.map(serializeScreenRow),
        });
      }

      const screenVideoMatch = pathname.match(/^\/api\/screen-recordings\/([^/]+)\/video$/);
      if (method === 'GET' && screenVideoMatch) {
        const parent = authenticateParent(req, res, url.searchParams.get('token'));
        if (!parent) return;
        const recordingId = decodeURIComponent(screenVideoMatch[1]);
        const row = statements.findScreenRecordingByIdAndParent.get(recordingId, parent.id);
        if (!row) {
          return sendJson(res, 404, { error: 'Screen recording not found' });
        }
        return serveMediaFile(req, res, row, `screen-${row.id}`, 'video/mp4', '.mp4');
      }

      const screenDeleteMatch = pathname.match(/^\/api\/screen-recordings\/([^/]+)$/);
      if (method === 'DELETE' && screenDeleteMatch) {
        const parent = authenticateParent(req, res);
        if (!parent) return;
        const recordingId = decodeURIComponent(screenDeleteMatch[1]);
        const existing = statements.findScreenRecordingByIdAndParent.get(recordingId, parent.id);
        if (!existing) {
          return sendJson(res, 404, { error: 'Screen recording not found' });
        }
        statements.deleteScreenRecordingByIdAndParent.run(recordingId, parent.id);
        deleteMediaFile(existing.file_name);
        return sendJson(res, 200, { deleted: true });
      }

      // Child pairing & location telemetry routes
      if (method === 'POST' && pathname === '/api/pair') {
        const body = await readJsonBody(req);
        const pairingCode =
          typeof body.pairingCode === 'string' ? body.pairingCode.trim().toUpperCase() : '';
        const deviceName =
          typeof body.deviceName === 'string' && body.deviceName.trim()
            ? body.deviceName.trim().slice(0, 80)
            : 'Child Mobile Browser';

        if (!pairingCode || pairingCode.length < 4) {
          return sendJson(res, 400, { error: 'Pairing code is required' });
        }

        const child = statements.findChildByPairingCode.get(pairingCode);
        if (!child) {
          return sendJson(res, 404, { error: 'Invalid or already used pairing code' });
        }

        if (child.pairing_expires_at && new Date(child.pairing_expires_at).getTime() < Date.now()) {
          return sendJson(res, 410, {
            error: 'Pairing code has expired; ask parent for a new code',
          });
        }

        const deviceToken = generateDeviceToken();
        const tokenHash = hashDeviceToken(deviceToken);
        const pairedAt = new Date().toISOString();

        statements.completeChildPairing.run(tokenHash, deviceName, pairedAt, child.id);

        broadcastToParent(child.parent_id, 'child_paired', {
          type: 'child_paired',
          childId: child.id,
          deviceName,
          pairedAt,
        });

        return sendJson(res, 200, {
          deviceToken,
          child: {
            id: child.id,
            name: child.name,
            avatarColor: child.avatar_color,
            parentName: child.parent_name,
            deviceName,
            pairedAt,
          },
        });
      }

      if (method === 'GET' && pathname === '/api/device/status') {
        const child = authenticateDevice(req, res);
        if (!child) return;
        return sendJson(res, 200, {
          paired: true,
          child: {
            id: child.id,
            name: child.name,
            avatarColor: child.avatar_color,
            parentName: child.parent_name,
            deviceName: child.device_name,
            pairedAt: child.paired_at,
            lastSeenAt: child.last_seen_at,
            trackingActive: Boolean(child.tracking_active),
          },
        });
      }

      if (method === 'POST' && pathname === '/api/device/tracking-state') {
        const child = authenticateDevice(req, res);
        if (!child) return;
        const body = await readJsonBody(req);
        const active = Boolean(body.active);
        const nowIso = new Date().toISOString();
        statements.updateChildTrackingState.run(active ? 1 : 0, nowIso, child.id);

        broadcastToParent(child.parent_id, 'child_status', {
          type: 'child_status',
          childId: child.id,
          trackingActive: active,
          lastSeenAt: nowIso,
          status: deriveConnectionStatus(nowIso, active),
        });

        return sendJson(res, 200, { trackingActive: active, lastSeenAt: nowIso });
      }

      if (method === 'POST' && pathname === '/api/locations') {
        const child = authenticateDevice(req, res);
        if (!child) return;
        const body = await readJsonBody(req);
        const payload = Array.isArray(body.points) ? body.points : body;
        const result = recordChildLocations(child, payload);
        if (result.error) {
          return sendJson(res, 400, { error: result.error });
        }
        return sendJson(res, 201, result);
      }

      if (method === 'POST' && pathname === '/api/calls') {
        const child = authenticateDevice(req, res);
        if (!child) return;

        const nowIso = new Date().toISOString();
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        let metaInput;
        let audioBuffer;

        if (contentType.includes('application/json')) {
          const body = await readJsonBody(req);
          if (typeof body.audioBase64 !== 'string' || !body.audioBase64.trim()) {
            return sendJson(res, 400, { error: 'audioBase64 is required' });
          }
          audioBuffer = Buffer.from(body.audioBase64, 'base64');
          if (audioBuffer.length > MAX_AUDIO_BYTES) {
            return sendJson(res, 413, { error: 'Audio upload exceeds maximum allowed size' });
          }
          metaInput = {
            direction: body.direction,
            phoneNumber: body.phoneNumber,
            startedAt: body.startedAt,
            endedAt: body.endedAt,
            durationSec: body.durationSec,
            mimeType: body.mimeType,
            audioSource: body.audioSource,
          };
        } else {
          audioBuffer = await readBinaryBody(req, MAX_AUDIO_BYTES);
          metaInput = {
            direction: req.headers['x-call-direction'],
            phoneNumber: safeDecodeHeader(req.headers['x-call-number']),
            startedAt: req.headers['x-call-started-at'],
            endedAt: req.headers['x-call-ended-at'],
            durationSec: req.headers['x-call-duration-sec'],
            mimeType: contentType,
            audioSource: req.headers['x-call-audio-source'],
          };
        }

        if (!audioBuffer || audioBuffer.length === 0) {
          return sendJson(res, 400, { error: 'Empty audio recording payload' });
        }

        const normalized = normalizeCallMetadata(metaInput, nowIso);
        if (normalized.error) {
          return sendJson(res, 400, { error: normalized.error });
        }

        const meta = normalized.value;
        const callId = crypto.randomUUID();
        const fileName = `${child.id}/${callId}${meta.ext}`;

        storeMediaFile(fileName, audioBuffer);

        statements.insertCallRecording.run(
          callId,
          child.id,
          meta.direction,
          meta.phoneNumber,
          meta.startedAt,
          meta.endedAt,
          meta.durationSec,
          meta.mimeType,
          fileName,
          audioBuffer.length,
          meta.audioSource,
          nowIso
        );

        statements.updateChildTelemetry.run(nowIso, null, null, 1, child.id);

        const row = statements.findCallByIdAndParent.get(callId, child.parent_id);
        const serialized = serializeCallRow(row);

        broadcastToParent(child.parent_id, 'call_recorded', {
          type: 'call_recorded',
          childId: child.id,
          call: serialized,
        });

        return sendJson(res, 201, { call: serialized });
      }

      if (method === 'POST' && pathname === '/api/screen-recordings') {
        const child = authenticateDevice(req, res);
        if (!child) return;

        const nowIso = new Date().toISOString();
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        let metaInput;
        let videoBuffer;

        if (contentType.includes('application/json')) {
          const body = await readJsonBody(req, MAX_VIDEO_BYTES);
          if (typeof body.videoBase64 !== 'string' || !body.videoBase64.trim()) {
            return sendJson(res, 400, { error: 'videoBase64 is required' });
          }
          videoBuffer = Buffer.from(body.videoBase64, 'base64');
          if (videoBuffer.length > MAX_VIDEO_BYTES) {
            return sendJson(res, 413, { error: 'Video upload exceeds maximum allowed size' });
          }
          metaInput = {
            startedAt: body.startedAt,
            endedAt: body.endedAt,
            durationSec: body.durationSec,
            width: body.width,
            height: body.height,
            fps: body.fps,
            mimeType: body.mimeType,
          };
        } else {
          videoBuffer = await readBinaryBody(req, MAX_VIDEO_BYTES);
          metaInput = {
            startedAt: req.headers['x-screen-started-at'],
            endedAt: req.headers['x-screen-ended-at'],
            durationSec: req.headers['x-screen-duration-sec'],
            width: req.headers['x-screen-width'],
            height: req.headers['x-screen-height'],
            fps: req.headers['x-screen-fps'],
            mimeType: contentType,
          };
        }

        if (!videoBuffer || videoBuffer.length === 0) {
          return sendJson(res, 400, { error: 'Empty screen recording payload' });
        }

        const normalized = normalizeScreenMetadata(metaInput, nowIso);
        if (normalized.error) {
          return sendJson(res, 400, { error: normalized.error });
        }

        const meta = normalized.value;
        const recordingId = crypto.randomUUID();
        const fileName = `${child.id}/screen-${recordingId}${meta.ext}`;

        storeMediaFile(fileName, videoBuffer);

        statements.insertScreenRecording.run(
          recordingId,
          child.id,
          meta.startedAt,
          meta.endedAt,
          meta.durationSec,
          meta.width,
          meta.height,
          meta.fps,
          meta.mimeType,
          fileName,
          videoBuffer.length,
          nowIso
        );

        statements.updateChildTelemetry.run(nowIso, null, null, 1, child.id);

        const row = statements.findScreenRecordingByIdAndParent.get(recordingId, child.parent_id);
        const serialized = serializeScreenRow(row);

        broadcastToParent(child.parent_id, 'screen_recorded', {
          type: 'screen_recorded',
          childId: child.id,
          recording: serialized,
        });

        return sendJson(res, 201, { recording: serialized });
      }

      // Frontend routes (Parent Console only when publicDir is configured)
      if (publicDir) {
        if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
          return serveStaticFile(res, 'index.html');
        }
        if (method === 'GET' && !pathname.startsWith('/api/')) {
          return serveStaticFile(res, pathname);
        }
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err.statusCode || 500;
      return sendJson(res, status, { error: err.message || 'Internal server error' });
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });

  // Periodic SSE keepalive comments so proxies/browsers keep 24/7 stream alive
  const keepaliveTimer = setInterval(() => {
    for (const set of parentSubscribers.values()) {
      for (const res of set) {
        if (!res.writableEnded) {
          res.write(': keepalive\n\n');
        }
      }
    }
  }, 20000);
  keepaliveTimer.unref();

  return {
    server,
    db,
    close() {
      clearInterval(keepaliveTimer);
      for (const set of parentSubscribers.values()) {
        for (const res of set) {
          if (!res.writableEnded) res.end();
        }
      }
      parentSubscribers.clear();
      if (server.listening) {
        server.close();
      }
      closeDb();
    },
  };
}

module.exports = { createApp };
