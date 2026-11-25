/**
 * GuardianMap: Zero-dependency Web Mercator slippy map with OpenStreetMap tiles,
 * offline graticule fallback, accuracy circle, route polyline, and playback cursor.
 */
export class GuardianMap {
  constructor(containerEl, options = {}) {
    this.container = containerEl;
    this.center = options.center || { lat: 37.7749, lng: -122.4194 };
    this.zoom = options.zoom || 14;
    this.minZoom = 2;
    this.maxZoom = 18;
    this.tileSize = 256;

    this.points = [];
    this.staySpots = [];
    this.activeIndex = -1;
    this.childMeta = { name: 'Child', color: '#3b82f6' };
    this.tileCache = new Map();
    this.tilesFailed = false;

    this.tilesCanvas = document.createElement('canvas');
    this.tilesCanvas.className = 'map-tiles-layer';
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.className = 'map-overlay-canvas';

    this.container.appendChild(this.tilesCanvas);
    this.container.appendChild(this.overlayCanvas);

    this.tilesCtx = this.tilesCanvas.getContext('2d');
    this.overlayCtx = this.overlayCanvas.getContext('2d');

    this._dragging = false;
    this._lastPointer = null;
    this._bindEvents();
    this.resize();
  }

  _bindEvents() {
    window.addEventListener('resize', () => this.resize());

    this.container.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.map-controls') || e.target.closest('.map-hud')) return;
      this._dragging = true;
      this._lastPointer = { x: e.clientX, y: e.clientY };
      this.container.setPointerCapture(e.pointerId);
    });

    this.container.addEventListener('pointermove', (e) => {
      if (!this._dragging || !this._lastPointer) return;
      const dx = e.clientX - this._lastPointer.x;
      const dy = e.clientY - this._lastPointer.y;
      this._lastPointer = { x: e.clientX, y: e.clientY };

      const world = this.latLngToWorld(this.center.lat, this.center.lng, this.zoom);
      const next = this.worldToLatLng(world.x - dx, world.y - dy, this.zoom);
      this.center = next;
      this.render();
    });

    const endDrag = () => {
      this._dragging = false;
      this._lastPointer = null;
    };
    this.container.addEventListener('pointerup', endDrag);
    this.container.addEventListener('pointercancel', endDrag);

    this.container.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1 : -1;
        this.setZoom(this.zoom + delta);
      },
      { passive: false }
    );
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    this.width = width;
    this.height = height;
    this.dpr = dpr;

    for (const canvas of [this.tilesCanvas, this.overlayCanvas]) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    this.render();
  }

  latLngToWorld(lat, lng, zoom) {
    const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
    const scale = this.tileSize * Math.pow(2, zoom);
    const x = ((lng + 180) / 360) * scale;
    const sinLat = Math.sin((clampedLat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    return { x, y };
  }

  worldToLatLng(x, y, zoom) {
    const scale = this.tileSize * Math.pow(2, zoom);
    const lng = (x / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return {
      lat: Math.max(-85.0511, Math.min(85.0511, lat)),
      lng: Math.max(-180, Math.min(180, lng)),
    };
  }

  latLngToScreen(lat, lng) {
    const centerW = this.latLngToWorld(this.center.lat, this.center.lng, this.zoom);
    const ptW = this.latLngToWorld(lat, lng, this.zoom);
    return {
      x: this.width / 2 + (ptW.x - centerW.x),
      y: this.height / 2 + (ptW.y - centerW.y),
    };
  }

  metersPerPixel(lat, zoom) {
    return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  }

  setZoom(nextZoom) {
    const clamped = Math.max(this.minZoom, Math.min(this.maxZoom, nextZoom));
    if (clamped !== this.zoom) {
      this.zoom = clamped;
      this.render();
    }
  }

  panTo(lat, lng, zoom = null) {
    this.center = { lat, lng };
    if (zoom !== null) {
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    }
    this.render();
  }

  fitPoints(points) {
    if (!points || points.length === 0) return;
    if (points.length === 1) {
      this.panTo(points[0].lat, points[0].lng, Math.max(this.zoom, 15));
      return;
    }

    let minLat = 90;
    let maxLat = -90;
    let minLng = 180;
    let maxLng = -180;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }

    const centerLat = (minLat + maxLat) / 2;
    const centerLng = (minLng + maxLng) / 2;

    let chosenZoom = 16;
    for (let z = 17; z >= this.minZoom; z--) {
      const nw = this.latLngToWorld(maxLat, minLng, z);
      const se = this.latLngToWorld(minLat, maxLng, z);
      const spanX = Math.abs(se.x - nw.x);
      const spanY = Math.abs(se.y - nw.y);
      if (spanX < this.width * 0.72 && spanY < this.height * 0.72) {
        chosenZoom = z;
        break;
      }
      chosenZoom = z;
    }

    this.center = { lat: centerLat, lng: centerLng };
    this.zoom = chosenZoom;
    this.render();
  }

  setData({ points, staySpots = null, activeIndex = -1, childMeta = null }) {
    this.points = Array.isArray(points) ? points : [];
    if (Array.isArray(staySpots)) {
      this.staySpots = staySpots;
    }
    this.activeIndex =
      activeIndex >= 0 && activeIndex < this.points.length
        ? activeIndex
        : this.points.length - 1;
    if (childMeta) this.childMeta = childMeta;
    this.render();
  }

  setActiveIndex(idx) {
    if (this.points.length === 0) return;
    this.activeIndex = Math.max(0, Math.min(this.points.length - 1, idx));
    const pt = this.points[this.activeIndex];
    if (pt) {
      this.center = { lat: pt.lat, lng: pt.lng };
    }
    this.render();
  }

  _getTile(z, x, y) {
    const maxTile = Math.pow(2, z);
    const wrappedX = ((x % maxTile) + maxTile) % maxTile;
    if (y < 0 || y >= maxTile) return null;

    const key = `${z}/${wrappedX}/${y}`;
    const cached = this.tileCache.get(key);
    if (cached) return cached;

    const entry = { status: 'loading', img: new Image() };
    entry.img.crossOrigin = 'anonymous';
    entry.img.onload = () => {
      entry.status = 'loaded';
      this.tilesFailed = false;
      this._renderTiles();
    };
    entry.img.onerror = () => {
      entry.status = 'error';
      this.tilesFailed = true;
    };
    entry.img.src = `https://tile.openstreetmap.org/${z}/${wrappedX}/${y}.png`;

    if (this.tileCache.size > 240) {
      const oldestKey = this.tileCache.keys().next().value;
      this.tileCache.delete(oldestKey);
    }
    this.tileCache.set(key, entry);
    return entry;
  }

  _renderTiles() {
    const ctx = this.tilesCtx;
    if (!ctx || !this.width || !this.height) return;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // Base dark slate background + subtle coordinate grid fallback
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, this.width, this.height);

    const centerW = this.latLngToWorld(this.center.lat, this.center.lng, this.zoom);
    const topLeftX = centerW.x - this.width / 2;
    const topLeftY = centerW.y - this.height / 2;

    const startTileX = Math.floor(topLeftX / this.tileSize);
    const endTileX = Math.floor((topLeftX + this.width) / this.tileSize);
    const startTileY = Math.floor(topLeftY / this.tileSize);
    const endTileY = Math.floor((topLeftY + this.height) / this.tileSize);

    // Draw subtle grid lines first so fallback mode always looks intentional
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
    ctx.lineWidth = 1;
    for (let tx = startTileX; tx <= endTileX + 1; tx++) {
      const sx = tx * this.tileSize - topLeftX;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this.height);
      ctx.stroke();
    }
    for (let ty = startTileY; ty <= endTileY + 1; ty++) {
      const sy = ty * this.tileSize - topLeftY;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(this.width, sy);
      ctx.stroke();
    }

    let drewAnyTile = false;
    for (let tx = startTileX; tx <= endTileX; tx++) {
      for (let ty = startTileY; ty <= endTileY; ty++) {
        const entry = this._getTile(this.zoom, tx, ty);
        if (entry && entry.status === 'loaded') {
          const dx = Math.round(tx * this.tileSize - topLeftX);
          const dy = Math.round(ty * this.tileSize - topLeftY);
          ctx.drawImage(entry.img, dx, dy, this.tileSize, this.tileSize);
          drewAnyTile = true;
        }
      }
    }

    if (drewAnyTile) {
      // Subtle dark tint for crisp contrast with bright GPS trail
      ctx.fillStyle = 'rgba(11, 17, 32, 0.16)';
      ctx.fillRect(0, 0, this.width, this.height);
    }

    ctx.restore();
  }

  _renderOverlay() {
    const ctx = this.overlayCtx;
    if (!ctx || !this.width || !this.height) return;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    if (this.points.length === 0) {
      ctx.restore();
      return;
    }

    const screenPts = this.points.map((pt) => ({
      ...pt,
      ...this.latLngToScreen(pt.lat, pt.lng),
    }));

    // 1. Route polyline
    if (screenPts.length > 1) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.strokeStyle = 'rgba(59, 130, 246, 0.35)';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(screenPts[0].x, screenPts[0].y);
      for (let i = 1; i < screenPts.length; i++) {
        ctx.lineTo(screenPts[i].x, screenPts[i].y);
      }
      ctx.stroke();

      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(screenPts[0].x, screenPts[0].y);
      for (let i = 1; i < screenPts.length; i++) {
        ctx.lineTo(screenPts[i].x, screenPts[i].y);
      }
      ctx.stroke();

      // Breadcrumb dots
      for (let i = 0; i < screenPts.length; i++) {
        const sp = screenPts[i];
        ctx.fillStyle = i === 0 ? '#10b981' : '#93c5fd';
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, i === 0 ? 4.5 : 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 1.5 Stay Spots (50m radius for 10+ min)
    for (let i = 0; i < this.staySpots.length; i++) {
      const spot = this.staySpots[i];
      const sp = this.latLngToScreen(spot.lat, spot.lng);
      const mpp = this.metersPerPixel(spot.lat, this.zoom);
      const zoneRadiusPx = Math.max(14, Math.min(220, 50 / mpp));

      ctx.fillStyle = 'rgba(245, 158, 11, 0.14)';
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, zoneRadiusPx, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f59e0b';
      ctx.strokeStyle = '#0b1120';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#0b1120';
      ctx.font = '800 9px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`S${i + 1}`, sp.x, sp.y + 0.5);
    }

    // 2. Active / playback point marker + accuracy radius
    const focusIdx =
      this.activeIndex >= 0 && this.activeIndex < screenPts.length
        ? this.activeIndex
        : screenPts.length - 1;
    const focus = screenPts[focusIdx];

    if (focus.accuracy && focus.accuracy > 0) {
      const mpp = this.metersPerPixel(focus.lat, this.zoom);
      const radiusPx = Math.max(12, Math.min(240, focus.accuracy / mpp));
      ctx.fillStyle = 'rgba(59, 130, 246, 0.14)';
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(focus.x, focus.y, radiusPx, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Outer halo
    ctx.fillStyle = 'rgba(16, 185, 129, 0.28)';
    ctx.beginPath();
    ctx.arc(focus.x, focus.y, 20, 0, Math.PI * 2);
    ctx.fill();

    // Inner beacon
    ctx.fillStyle = this.childMeta.color || '#2563eb';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(focus.x, focus.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Initials inside marker
    const initials = (this.childMeta.name || 'C').slice(0, 2).toUpperCase();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 10px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, focus.x, focus.y + 0.5);

    ctx.restore();
  }

  render() {
    this._renderTiles();
    this._renderOverlay();
  }
}
