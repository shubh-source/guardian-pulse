const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { createChildApp } = require('../child-app/server');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('../server/auth');
const {
  haversineKm,
  computeHistoryStats,
  normalizeLocationPoint,
  detectStaySpots,
} = require('../server/geo');

async function startTwoApps() {
  const parentApp = createApp({
    dbPath: ':memory:',
    sessionSecret: 'test-secret-key-1234567890',
    publicDir: path.join(__dirname, '..', 'parent-app', 'public'),
  });
  await new Promise((resolve) => parentApp.server.listen(0, '127.0.0.1', resolve));
  const parentPort = parentApp.server.address().port;
  const parentUrl = `http://127.0.0.1:${parentPort}`;

  const childApp = createChildApp({
    apiBaseUrl: parentUrl,
    publicDir: path.join(__dirname, '..', 'child-app', 'public'),
  });
  await new Promise((resolve) => childApp.server.listen(0, '127.0.0.1', resolve));
  const childPort = childApp.server.address().port;
  const childUrl = `http://127.0.0.1:${childPort}`;

  return {
    parentUrl,
    childUrl,
    close() {
      childApp.close();
      parentApp.close();
    },
  };
}

test('auth helpers hash passwords and verify signed tokens', () => {
  const hash = hashPassword('supersecret');
  assert.equal(verifyPassword('supersecret', hash), true);
  assert.equal(verifyPassword('wrongpass', hash), false);

  const token = signToken({ parentId: 'p1' }, 'secret-key', 60);
  const claims = verifyToken(token, 'secret-key');
  assert.equal(claims.parentId, 'p1');
  assert.equal(verifyToken(`${token}tamper`, 'secret-key'), null);
});

test('geo helpers validate coordinates and compute distance stats', () => {
  const invalid = normalizeLocationPoint({ lat: 95, lng: 10 });
  assert.ok(invalid.error);

  const d = haversineKm(37.7749, -122.4194, 37.7849, -122.4094);
  assert.ok(d > 1.0 && d < 2.0);

  const stats = computeHistoryStats([
    { lat: 37.7749, lng: -122.4194, accuracy: 10, speed: 1.5, recorded_at: '2026-11-25T08:00:00.000Z' },
    { lat: 37.7849, lng: -122.4094, accuracy: 20, speed: 2.5, recorded_at: '2026-11-25T08:10:00.000Z' },
  ]);
  assert.equal(stats.totalPoints, 2);
  assert.ok(stats.totalDistanceKm > 1.0);
  assert.equal(stats.maxSpeedKmh, 9.0);
  assert.equal(stats.avgAccuracyM, 15);
});

test('two separate apps: Parent App + Child App communicate cleanly end-to-end', async () => {
  const apps = await startTwoApps();
  const abortController = new AbortController();

  try {
    // Verify Parent App serves only Parent UI and Child App serves only Child UI
    const parentHtmlRes = await fetch(`${apps.parentUrl}/`);
    assert.equal(parentHtmlRes.status, 200);
    const parentHtml = await parentHtmlRes.text();
    assert.match(parentHtml, /GuardianPulse · Parent App/);

    const removedCombinedRoute = await fetch(`${apps.parentUrl}/child`);
    assert.equal(removedCombinedRoute.status, 404);

    const childHtmlRes = await fetch(`${apps.childUrl}/`);
    assert.equal(childHtmlRes.status, 200);
    const childHtml = await childHtmlRes.text();
    assert.match(childHtml, /GuardianPulse · Child App/);
    assert.doesNotMatch(childHtml, /Parent Dashboard/);

    // 1. Register parent on Parent App
    const regRes = await fetch(`${apps.parentUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Sarah Patel',
        email: 'sarah@example.com',
        password: 'password123',
      }),
    });
    assert.equal(regRes.status, 201);
    const { token: parentToken } = await regRes.json();

    // 2. Create child profile on Parent App
    const childRes = await fetch(`${apps.parentUrl}/api/children`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${parentToken}`,
      },
      body: JSON.stringify({ name: 'Leo' }),
    });
    assert.equal(childRes.status, 201);
    const { child } = await childRes.json();
    assert.equal(child.pairingCode.length, 6);

    // 3. Pair via the separate Child App origin (proxied to Parent App)
    const pairRes = await fetch(`${apps.childUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: child.pairingCode, deviceName: "Leo's Phone" }),
    });
    assert.equal(pairRes.status, 200);
    const pairData = await pairRes.json();
    assert.ok(pairData.deviceToken);

    // Verify Child App status endpoint
    const statusRes = await fetch(`${apps.childUrl}/api/device/status`, {
      headers: { 'X-Device-Token': pairData.deviceToken },
    });
    assert.equal(statusRes.status, 200);

    // 4. Connect Parent App SSE stream
    const sseRes = await fetch(`${apps.parentUrl}/api/events?token=${encodeURIComponent(parentToken)}`, {
      signal: abortController.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const firstChunk = await reader.read();
    assert.match(decoder.decode(firstChunk.value), /event: connected/);

    // 5. Child App sends batch GPS points (earlier travel)
    const t1 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const locRes = await fetch(`${apps.childUrl}/api/locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': pairData.deviceToken,
      },
      body: JSON.stringify({
        points: [
          { lat: 37.7749, lng: -122.4194, accuracy: 12, speed: 1.2, batteryLevel: 88, recordedAt: t1 },
          { lat: 37.7789, lng: -122.4154, accuracy: 9, speed: 1.8, batteryLevel: 87, recordedAt: t2 },
        ],
      }),
    });
    assert.equal(locRes.status, 201);
    const locData = await locRes.json();
    assert.equal(locData.accepted, 2);

    // 6. Parent App SSE receives live update immediately
    const sseUpdateChunk = await reader.read();
    const sseUpdateText = decoder.decode(sseUpdateChunk.value);
    assert.match(sseUpdateText, /event: location_update/);
    assert.match(sseUpdateText, /37\.7789/);

    // 7. Parent App queries 24h location history
    const histRes = await fetch(`${apps.parentUrl}/api/children/${child.id}/history`, {
      headers: { Authorization: `Bearer ${parentToken}` },
    });
    assert.equal(histRes.status, 200);
    const histData = await histRes.json();
    assert.equal(histData.points.length, 2);
    assert.equal(histData.stats.totalPoints, 2);
    assert.deepEqual(histData.staySpots, []);

    // 8. Child stays within 50m radius for 12 minutes -> detected as a Stay Spot
    const stayStart = Date.now() - 12 * 60 * 1000;
    const stayMid = Date.now() - 6 * 60 * 1000;
    const stayEnd = Date.now() - 10 * 1000;
    const stayRes = await fetch(`${apps.childUrl}/api/locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Token': pairData.deviceToken,
      },
      body: JSON.stringify({
        points: [
          { lat: 28.6139, lng: 77.209, accuracy: 8, recordedAt: new Date(stayStart).toISOString() },
          { lat: 28.61398, lng: 77.20905, accuracy: 7, recordedAt: new Date(stayMid).toISOString() },
          { lat: 28.61393, lng: 77.20902, accuracy: 6, recordedAt: new Date(stayEnd).toISOString() },
        ],
      }),
    });
    assert.equal(stayRes.status, 201);

    const histWithStayRes = await fetch(`${apps.parentUrl}/api/children/${child.id}/history`, {
      headers: { Authorization: `Bearer ${parentToken}` },
    });
    assert.equal(histWithStayRes.status, 200);
    const histWithStay = await histWithStayRes.json();
    assert.equal(histWithStay.staySpots.length, 1);
    assert.ok(histWithStay.staySpots[0].durationMinutes >= 11);
    assert.ok(histWithStay.staySpots[0].radiusMeters <= 50);
    assert.equal(histWithStay.staySpots[0].isOngoing, true);
    assert.ok(Math.abs(histWithStay.staySpots[0].lat - 28.613937) < 0.001);
    assert.ok(Math.abs(histWithStay.staySpots[0].lng - 77.209023) < 0.001);
  } finally {
    abortController.abort();
    apps.close();
  }
});

test('detectStaySpots ignores <10m stops and splits clusters >50m apart', () => {
  const base = Date.UTC(2026, 10, 25, 9, 0, 0);
  const pts = [
    // Short 5-minute stop (ignored)
    { lat: 28.6, lng: 77.2, recordedAt: new Date(base).toISOString() },
    { lat: 28.60005, lng: 77.20005, recordedAt: new Date(base + 5 * 60 * 1000).toISOString() },
    // Moved ~220m away and stayed 15 minutes (detected)
    { lat: 28.602, lng: 77.2, recordedAt: new Date(base + 10 * 60 * 1000).toISOString() },
    { lat: 28.6021, lng: 77.20005, recordedAt: new Date(base + 18 * 60 * 1000).toISOString() },
    { lat: 28.60205, lng: 77.20002, recordedAt: new Date(base + 25 * 60 * 1000).toISOString() },
  ];

  const spots = detectStaySpots(pts, {
    radiusMeters: 50,
    minDurationMinutes: 10,
    nowMs: base + 60 * 60 * 1000,
  });

  assert.equal(spots.length, 1);
  assert.equal(spots[0].durationMinutes, 15);
  assert.equal(spots[0].pointCount, 3);
  assert.equal(spots[0].isOngoing, false);
  assert.ok(spots[0].radiusMeters <= 50);
});

test('incoming & outgoing call recordings upload, broadcast via SSE, stream with Range, and delete cleanly', async () => {
  const tempRecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-calls-test-'));
  const parentApp = createApp({
    dbPath: ':memory:',
    sessionSecret: 'test-secret-key-1234567890',
    publicDir: path.join(__dirname, '..', 'parent-app', 'public'),
    recordingsDir: tempRecDir,
  });
  await new Promise((resolve) => parentApp.server.listen(0, '127.0.0.1', resolve));
  const parentUrl = `http://127.0.0.1:${parentApp.server.address().port}`;
  const abortController = new AbortController();

  try {
    // Parent Console HTML includes Call Recordings tab
    const html = await (await fetch(`${parentUrl}/`)).text();
    assert.match(html, /Call Recordings/);

    // Register parent & create child profile
    const regRes = await fetch(`${parentUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alex Guardian',
        email: 'alex@example.com',
        password: 'password123',
      }),
    });
    const { token: parentToken } = await regRes.json();

    const childRes = await fetch(`${parentUrl}/api/children`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${parentToken}`,
      },
      body: JSON.stringify({ name: 'Maya' }),
    });
    const { child } = await childRes.json();

    const pairRes = await fetch(`${parentUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: child.pairingCode, deviceName: 'Call Recorder Phone' }),
    });
    const { deviceToken } = await pairRes.json();

    // Connect SSE stream
    const sseRes = await fetch(`${parentUrl}/api/events?token=${encodeURIComponent(parentToken)}`, {
      signal: abortController.signal,
    });
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // connected event

    // Validation check: reject invalid direction
    const badRes = await fetch(`${parentUrl}/api/calls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/mp4',
        'X-Device-Token': deviceToken,
        'X-Call-Direction': 'missed',
      },
      body: Buffer.from('FAKE_AUDIO'),
    });
    assert.equal(badRes.status, 400);

    // 1. Upload incoming call binary recording
    const incomingAudio = Buffer.from('M4A_INCOMING_SAMPLE_BYTES_123456');
    const inRes = await fetch(`${parentUrl}/api/calls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/mp4',
        'X-Device-Token': deviceToken,
        'X-Call-Direction': 'incoming',
        'X-Call-Number': encodeURIComponent('+1 555-0101'),
        'X-Call-Started-At': '2026-11-25T10:00:00.000Z',
        'X-Call-Ended-At': '2026-11-25T10:01:30.000Z',
        'X-Call-Duration-Sec': '90',
        'X-Call-Audio-Source': 'voice_recognition',
      },
      body: incomingAudio,
    });
    assert.equal(inRes.status, 201);
    const { call: inCall } = await inRes.json();
    assert.equal(inCall.direction, 'incoming');
    assert.equal(inCall.phoneNumber, '+1 555-0101');
    assert.equal(inCall.durationSec, 90);
    assert.equal(inCall.fileSize, incomingAudio.length);

    // SSE receives call_recorded immediately
    const sseChunk = decoder.decode((await reader.read()).value);
    assert.match(sseChunk, /event: call_recorded/);
    assert.match(sseChunk, /\+1 555-0101/);

    // 2. Upload outgoing call binary recording
    const outgoingAudio = Buffer.from('M4A_OUTGOING_SAMPLE_BYTES_ABCDEF');
    const outRes = await fetch(`${parentUrl}/api/calls`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/mp4',
        'X-Device-Token': deviceToken,
        'X-Call-Direction': 'outgoing',
        'X-Call-Number': encodeURIComponent('+1 555-0202'),
        'X-Call-Started-At': '2026-11-25T10:15:00.000Z',
        'X-Call-Ended-At': '2026-11-25T10:15:45.000Z',
        'X-Call-Duration-Sec': '45',
        'X-Call-Audio-Source': 'mic',
      },
      body: outgoingAudio,
    });
    assert.equal(outRes.status, 201);
    const { call: outCall } = await outRes.json();
    assert.equal(outCall.direction, 'outgoing');

    // 3. List & filter calls
    const allCalls = await (
      await fetch(`${parentUrl}/api/children/${child.id}/calls`, {
        headers: { Authorization: `Bearer ${parentToken}` },
      })
    ).json();
    assert.equal(allCalls.calls.length, 2);

    const incomingOnly = await (
      await fetch(`${parentUrl}/api/children/${child.id}/calls?direction=incoming`, {
        headers: { Authorization: `Bearer ${parentToken}` },
      })
    ).json();
    assert.equal(incomingOnly.calls.length, 1);
    assert.equal(incomingOnly.calls[0].id, inCall.id);

    const outgoingOnly = await (
      await fetch(`${parentUrl}/api/children/${child.id}/calls?direction=outgoing`, {
        headers: { Authorization: `Bearer ${parentToken}` },
      })
    ).json();
    assert.equal(outgoingOnly.calls.length, 1);
    assert.equal(outgoingOnly.calls[0].id, outCall.id);

    // 4. Stream audio (full + Range request)
    const audioFullRes = await fetch(
      `${parentUrl}/api/calls/${inCall.id}/audio?token=${encodeURIComponent(parentToken)}`
    );
    assert.equal(audioFullRes.status, 200);
    assert.equal(audioFullRes.headers.get('content-type'), 'audio/mp4');
    const fetchedBuf = Buffer.from(await audioFullRes.arrayBuffer());
    assert.deepEqual(fetchedBuf, incomingAudio);

    const audioRangeRes = await fetch(
      `${parentUrl}/api/calls/${inCall.id}/audio?token=${encodeURIComponent(parentToken)}`,
      { headers: { Range: 'bytes=0-3' } }
    );
    assert.equal(audioRangeRes.status, 206);
    assert.equal(audioRangeRes.headers.get('content-range'), `bytes 0-3/${incomingAudio.length}`);
    const rangeText = await audioRangeRes.text();
    assert.equal(rangeText, 'M4A_');

    // 5. Delete recording and verify file removed from disk
    const storedFilesBefore = fs.readdirSync(path.join(tempRecDir, child.id));
    assert.equal(storedFilesBefore.length, 2);

    const delRes = await fetch(`${parentUrl}/api/calls/${inCall.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${parentToken}` },
    });
    assert.equal(delRes.status, 200);

    const storedFilesAfter = fs.readdirSync(path.join(tempRecDir, child.id));
    assert.equal(storedFilesAfter.length, 1);
  } finally {
    abortController.abort();
    parentApp.close();
    fs.rmSync(tempRecDir, { recursive: true, force: true });
  }
});

test('screen recordings upload, broadcast via SSE, stream MP4 with Range, and delete cleanly', async () => {
  const tempRecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-screen-test-'));
  const parentApp = createApp({
    dbPath: ':memory:',
    sessionSecret: 'test-secret-key-1234567890',
    publicDir: path.join(__dirname, '..', 'parent-app', 'public'),
    recordingsDir: tempRecDir,
  });
  await new Promise((resolve) => parentApp.server.listen(0, '127.0.0.1', resolve));
  const parentUrl = `http://127.0.0.1:${parentApp.server.address().port}`;
  const abortController = new AbortController();

  try {
    const html = await (await fetch(`${parentUrl}/`)).text();
    assert.match(html, /Screen Recordings/);

    const regRes = await fetch(`${parentUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Jordan Parent',
        email: 'jordan@example.com',
        password: 'password123',
      }),
    });
    const { token: parentToken } = await regRes.json();

    const childRes = await fetch(`${parentUrl}/api/children`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${parentToken}`,
      },
      body: JSON.stringify({ name: 'Sam' }),
    });
    const { child } = await childRes.json();

    const pairRes = await fetch(`${parentUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: child.pairingCode, deviceName: 'Sam Android' }),
    });
    const { deviceToken } = await pairRes.json();

    const sseRes = await fetch(`${parentUrl}/api/events?token=${encodeURIComponent(parentToken)}`, {
      signal: abortController.signal,
    });
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // connected event

    // Reject empty body
    const emptyRes = await fetch(`${parentUrl}/api/screen-recordings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'X-Device-Token': deviceToken,
      },
      body: Buffer.alloc(0),
    });
    assert.equal(emptyRes.status, 400);

    // Upload MP4 screen clip
    const sampleVideo = Buffer.from('FTYPMP4_SCREEN_CLIP_SAMPLE_BYTES_987654');
    const upRes = await fetch(`${parentUrl}/api/screen-recordings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'X-Device-Token': deviceToken,
        'X-Screen-Started-At': '2026-11-25T11:00:00.000Z',
        'X-Screen-Ended-At': '2026-11-25T11:01:00.000Z',
        'X-Screen-Duration-Sec': '60',
        'X-Screen-Width': '720',
        'X-Screen-Height': '1600',
        'X-Screen-Fps': '10',
      },
      body: sampleVideo,
    });
    assert.equal(upRes.status, 201);
    const { recording } = await upRes.json();
    assert.equal(recording.durationSec, 60);
    assert.equal(recording.width, 720);
    assert.equal(recording.height, 1600);
    assert.equal(recording.fps, 10);
    assert.equal(recording.fileSize, sampleVideo.length);

    // SSE receives screen_recorded event
    const sseChunk = decoder.decode((await reader.read()).value);
    assert.match(sseChunk, /event: screen_recorded/);
    assert.match(sseChunk, /"width":720/);

    // List screen recordings
    const listData = await (
      await fetch(`${parentUrl}/api/children/${child.id}/screen-recordings`, {
        headers: { Authorization: `Bearer ${parentToken}` },
      })
    ).json();
    assert.equal(listData.recordings.length, 1);
    assert.equal(listData.recordings[0].id, recording.id);

    // Stream video (full + Range)
    const fullVideoRes = await fetch(
      `${parentUrl}/api/screen-recordings/${recording.id}/video?token=${encodeURIComponent(parentToken)}`
    );
    assert.equal(fullVideoRes.status, 200);
    assert.equal(fullVideoRes.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await fullVideoRes.arrayBuffer()), sampleVideo);

    const rangeRes = await fetch(
      `${parentUrl}/api/screen-recordings/${recording.id}/video?token=${encodeURIComponent(parentToken)}`,
      { headers: { Range: 'bytes=0-6' } }
    );
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), `bytes 0-6/${sampleVideo.length}`);
    assert.equal(await rangeRes.text(), 'FTYPMP4');

    // Delete screen recording and verify disk cleanup
    const delRes = await fetch(`${parentUrl}/api/screen-recordings/${recording.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${parentToken}` },
    });
    assert.equal(delRes.status, 200);
    const remaining = fs.readdirSync(path.join(tempRecDir, child.id));
    assert.equal(remaining.length, 0);
  } finally {
    abortController.abort();
    parentApp.close();
    fs.rmSync(tempRecDir, { recursive: true, force: true });
  }
});
