/* ---------- Land map -----------------------------------------------------
   A pan/zoom map of Decentraland on the genesis.city rendered tiles (MIT,
   github.com/genesis-city/genesis.city) using their pixel-projection tile
   grid, plus:
     - jump to coordinates + click-to-identify with an in-world link,
     - a live "Deployed today" layer built from the catalyst deployment feed,
       with real thumbnails from genesis.city's per-parcel image API.
   Tiles/images are served by genesis.city; the deploy feed is the catalyst.   */
(function () {
  if (document.body.dataset.page !== 'map') return;
  var target = document.getElementById('map');
  if (!target) return;
  if (typeof ol === 'undefined') {
    target.innerHTML = '<div class="map-fallback">Couldn\u2019t load the map library. Check your connection and reload.</div>';
    return;
  }

  var cfg = (typeof DCL_CONFIG !== 'undefined' && DCL_CONFIG.assetBundles) || {};
  var CONTENT = cfg.contentServer || 'https://peer.decentraland.org/content';

  // --- genesis.city tile pyramid geometry (verbatim constants) ---
  var side = 200, tiles = 61, zoom = 6;
  var extent = [0, 0, side * tiles, side * tiles];   // [0,0,12200,12200]
  var origin = [0, side * tiles];
  var SCALE = (side * tiles) / 305, OFF = 152.5;      // 40px per parcel

  var resolutions = [];
  for (var i = 0; i <= zoom; i++) resolutions.push(Math.pow(2, zoom - i));
  var viewResolutions = [];
  for (var j = 1; j <= 9; j++) viewResolutions.push(side / Math.pow(2, 1 + j));

  var projection = new ol.proj.Projection({ code: 'dcl-images', units: 'pixels', extent: extent });

  var source = new ol.source.TileImage({
    url: 'https://genesis.city/map/latest/{z}/{x},{y}.jpg',
    wrapX: false,
    attributions:
      'Tiles \u00A9 <a href="https://genesis.city" target="_blank" rel="noopener">genesis.city</a> \u00B7 Land \u00A9 Decentraland',
    tileGrid: new ol.tilegrid.TileGrid({
      extent: extent, origin: origin, tileSize: [side, side],
      resolutions: resolutions, minZoom: 1, maxZoom: 10,
    }),
  });

  // Live "deployed today" markers
  var deploySource = new ol.source.Vector();
  var deployLayer = new ol.layer.Vector({
    source: deploySource,
    style: new ol.style.Style({
      image: new ol.style.Circle({
        radius: 5,
        fill: new ol.style.Fill({ color: 'rgba(255,45,85,0.85)' }),
        stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.95)', width: 1.5 }),
      }),
    }),
  });

  // Changed-parcel overlay (range control / "Changes" mode) — one polygon per
  // touched parcel, backed by Supabase deployment history rather than the
  // live today-only feed above.
  var heatmapOn = false;
  function changeFillColor(count) {
    if (!heatmapOn) return 'rgba(255,110,78,0.28)';
    var t = Math.min(1, (count - 1) / 4); // 1 deploy -> low heat, 5+ -> hottest
    var g = Math.round(160 - 120 * t), b = Math.round(90 - 60 * t);
    return 'rgba(255,' + g + ',' + b + ',' + (0.30 + 0.4 * t) + ')';
  }
  function baseChangeStyle(feature) {
    var d = feature.get('data') || {};
    return new ol.style.Style({
      fill: new ol.style.Fill({ color: changeFillColor(d.count || 1) }),
      stroke: new ol.style.Stroke({ color: 'rgba(255,188,91,0.55)', width: 1 }),
    });
  }
  var selectStyle = new ol.style.Style({
    fill: new ol.style.Fill({ color: 'rgba(255,188,91,0.35)' }),
    stroke: new ol.style.Stroke({ color: 'rgba(255,188,91,0.95)', width: 2 }),
  });
  var hoverStyle = new ol.style.Style({
    fill: new ol.style.Fill({ color: 'rgba(255,188,91,0.30)' }),
    stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.85)', width: 1.5 }),
  });
  var changesSource = new ol.source.Vector();
  var changesLayer = new ol.layer.Vector({ source: changesSource, style: baseChangeStyle });

  var popEl = document.getElementById('mapPopup');
  var overlay = new ol.Overlay({ element: popEl, positioning: 'bottom-center', stopEvent: true, offset: [0, -6] });

  // Our own base layer: rendered server-side from Decentraland's official LAND
  // parcel data (ownership/type/estates), not genesis.city — always available
  // regardless of genesis.city's uptime. See docs/DECENTRALAND_MAP.md.
  var landSource = new ol.source.TileImage({
    url: '/api/map/land-tile?z={z}&x={x}&y={y}',
    wrapX: false,
    tileGrid: new ol.tilegrid.TileGrid({
      extent: extent, origin: origin, tileSize: [side, side],
      resolutions: resolutions, minZoom: 1, maxZoom: 10,
    }),
  });
  var landLayer = new ol.layer.Tile({ source: landSource });

  // genesis.city's photographic renders — optional "Photo view" overlay, off
  // by default so a genesis.city outage never breaks the map (see the 2026-09
  // TLS-misconfiguration incident noted in docs/DECENTRALAND_MAP.md).
  var tileLayer = new ol.layer.Tile({ source: source, visible: false });

  // Named places (the actual "scenes" — Decentraland's official Places
  // directory: title/description/image/categories), clustered so a busy
  // district reads as one badge instead of an unreadable pile of pins.
  var placesSource = new ol.source.Vector();
  var placesCluster = new ol.source.Cluster({ source: placesSource, distance: 44 });
  var starStyleCache = {};
  function starStyle(count) {
    var key = count > 1 ? 'n' + Math.min(count, 99) : '1';
    if (starStyleCache[key]) return starStyleCache[key];
    var style;
    if (count > 1) {
      style = new ol.style.Style({
        image: new ol.style.Circle({
          radius: 12,
          fill: new ol.style.Fill({ color: 'rgba(255,140,40,0.92)' }),
          stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.9)', width: 1.5 }),
        }),
        text: new ol.style.Text({
          text: String(count),
          font: '700 11px sans-serif',
          fill: new ol.style.Fill({ color: '#1a1017' }),
        }),
      });
    } else {
      style = new ol.style.Style({
        image: new ol.style.RegularShape({
          points: 5, radius: 8, radius2: 3.4, angle: 0,
          fill: new ol.style.Fill({ color: 'rgba(255,163,26,0.95)' }),
          stroke: new ol.style.Stroke({ color: 'rgba(90,50,0,0.9)', width: 1 }),
        }),
      });
    }
    starStyleCache[key] = style;
    return style;
  }
  var placesLayer = new ol.layer.Vector({
    source: placesCluster,
    style: function (feature) { return starStyle(feature.get('features').length); },
  });

  var map = new ol.Map({
    target: target,
    layers: [landLayer, tileLayer, changesLayer, deployLayer, placesLayer],
    overlays: [overlay],
    view: new ol.View({
      projection: projection,
      center: ol.extent.getCenter(extent),
      resolutions: viewResolutions,
      zoom: 3, minZoom: 1, maxZoom: 8, extent: extent,
    }),
  });

  // --- helpers ---
  function toPx(x, y) { return [(x + OFF) * SCALE + SCALE / 2, (y + OFF) * SCALE + SCALE / 2]; }
  function toCoord(px, py) { return [Math.floor(px / SCALE - OFF), Math.floor(py / SCALE - OFF)]; }
  function inRange(x, y) { return x >= -152 && x <= 152 && y >= -152 && y <= 152; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function relTime(ms) {
    if (!ms) return '';
    var s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }
  function wireClose() { var b = popEl.querySelector('.map-pop-x'); if (b) b.onclick = function () { overlay.setPosition(undefined); }; }

  function wireHistoryLink(x, y) {
    var btn = popEl.querySelector('.map-pop-link');
    if (btn) btn.onclick = function () { selectParcel(x, y); openDetailPanel(x, y); };
  }

  function showParcel(x, y) {
    if (!inRange(x, y)) { overlay.setPosition(undefined); return; }
    var play = 'https://play.decentraland.org/?position=' + x + '%2C' + y;
    var gen = 'https://genesis.city/#' + x + ',' + y + ',4z';
    popEl.innerHTML =
      '<button class="map-pop-x" aria-label="Close">\u00D7</button>' +
      '<div class="mp-coord">' + x + ', ' + y + '</div>' +
      '<a href="' + play + '" target="_blank" rel="noopener">Jump in-world \u2197</a>' +
      '<a href="' + gen + '" target="_blank" rel="noopener">Open on genesis.city \u2197</a>' +
      '<button type="button" class="map-pop-link" data-x="' + x + '" data-y="' + y + '">View deployment history</button>';
    overlay.setPosition(toPx(x, y)); wireClose(); wireHistoryLink(x, y);
  }

  function showDeploy(d) {
    var thumb = 'https://genesis.city/api/v1/land/' + d.x + ',' + d.y + '.jpg';
    var play = 'https://play.decentraland.org/?position=' + d.x + '%2C' + d.y;
    var recent = d.ts && (Date.now() - d.ts < 2 * 3600 * 1000);
    popEl.innerHTML =
      '<button class="map-pop-x" aria-label="Close">\u00D7</button>' +
      '<img class="mp-thumb" src="' + thumb + '" alt="" loading="lazy" onerror="this.remove()">' +
      '<div class="mp-coord">' + (d.name ? esc(d.name) : (d.x + ', ' + d.y)) + '</div>' +
      '<div class="mp-sub">' + d.x + ',' + d.y + (d.n > 1 ? ' \u00B7 ' + d.n + ' parcels' : '') + (d.ts ? ' \u00B7 ' + relTime(d.ts) : '') + '</div>' +
      (recent ? '<div class="mp-note">Thumbnail may still be rendering</div>' : '') +
      '<a href="' + play + '" target="_blank" rel="noopener">Jump in-world \u2197</a>' +
      '<button type="button" class="map-pop-link" data-x="' + d.x + '" data-y="' + d.y + '">View deployment history</button>';
    overlay.setPosition(toPx(d.x, d.y)); wireClose(); wireHistoryLink(d.x, d.y);
  }

  map.on('singleclick', function (evt) {
    var placeHit = map.forEachFeatureAtPixel(evt.pixel, function (f) { return f; },
      { hitTolerance: 6, layerFilter: function (l) { return l === placesLayer; } });
    if (placeHit) {
      var clustered = placeHit.get('features');
      if (clustered.length > 1) {
        var ext = ol.extent.createEmpty();
        clustered.forEach(function (f) { ol.extent.extend(ext, f.getGeometry().getExtent()); });
        map.getView().fit(ext, { duration: 400, padding: [60, 60, 60, 60], maxZoom: 8 });
      } else {
        showPlace(clustered[0].get('place'));
      }
      return;
    }
    var hit = map.forEachFeatureAtPixel(evt.pixel, function (f) { return f; },
      { hitTolerance: 5, layerFilter: function (l) { return l === deployLayer; } });
    if (hit && hit.get('data')) { showDeploy(hit.get('data')); return; }
    var c = toCoord(evt.coordinate[0], evt.coordinate[1]);
    showParcel(c[0], c[1]);
  });
  map.on('pointermove', function (e) { target.style.cursor = e.dragging ? 'grabbing' : 'pointer'; });

  // --- jump to coordinates ---
  var input = document.getElementById('mapCoord');
  var go = document.getElementById('mapGo');
  function jump() {
    if (!input) return;
    var m = (input.value || '').match(/(-?\d+)\s*[, ]\s*(-?\d+)/);
    if (!m) { input.focus(); return; }
    var x = +m[1], y = +m[2];
    if (!inRange(x, y)) { input.focus(); return; }
    map.getView().animate({ center: toPx(x, y), zoom: 6, duration: 450 });
    showParcel(x, y);
  }
  if (go) go.onclick = jump;
  if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') jump(); });

  // --- live "deployed today" layer ---
  var toggle = document.getElementById('deployToggle');
  var countEl = document.getElementById('deployCount');
  if (toggle) toggle.addEventListener('change', function () { deployLayer.setVisible(toggle.checked); });

  function baseParcel(d) {
    var p = null;
    if (d.metadata && d.metadata.scene && d.metadata.scene.base) p = d.metadata.scene.base;
    else if (d.pointers && d.pointers.length) p = d.pointers[0];
    if (!p) return null;
    var m = String(p).match(/(-?\d+)\s*,\s*(-?\d+)/);
    return m ? [+m[1], +m[2]] : null;
  }

  async function loadDeployedToday() {
    var start = new Date(); start.setHours(0, 0, 0, 0);
    var from = start.getTime();
    var raw = [];
    // Primary: pointer-changes (light — pointers + localTimestamp)
    try {
      var res = await fetch(CONTENT + '/pointer-changes?entityType=scene&from=' + from, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        var j = await res.json();
        raw = (j.deltas || []).map(function (d) { return { pointers: d.pointers, metadata: null, ts: d.localTimestamp || d.entityTimestamp, id: d.entityId }; });
      }
    } catch (e) { /* ignore */ }
    // Fallback: deployments (carries metadata names)
    if (!raw.length) {
      try {
        var r2 = await fetch(CONTENT + '/deployments?entityType=scene&from=' + from + '&sortingField=local_timestamp&sortingOrder=DESC', { headers: { Accept: 'application/json' } });
        if (r2.ok) {
          var j2 = await r2.json();
          raw = (j2.deployments || []).map(function (d) { return { pointers: d.pointers, metadata: d.metadata, ts: d.entityTimestamp || d.localTimestamp, id: d.entityId }; });
        }
      } catch (e) { /* ignore */ }
    }

    var seen = {}, feats = [];
    raw.forEach(function (d) {
      var bp = baseParcel(d); if (!bp) return;               // skip worlds (no coords)
      if (!inRange(bp[0], bp[1])) return;
      var key = bp[0] + ',' + bp[1];
      if (seen[key]) return; seen[key] = true;               // one marker per parcel (latest)
      var name = d.metadata && ((d.metadata.display && d.metadata.display.title) || (d.metadata.scene && d.metadata.scene.name)) || null;
      var f = new ol.Feature({ geometry: new ol.geom.Point(toPx(bp[0], bp[1])) });
      f.set('data', { x: bp[0], y: bp[1], name: name, ts: d.ts, n: (d.pointers ? d.pointers.length : 1) });
      feats.push(f);
    });
    deploySource.clear();
    deploySource.addFeatures(feats);
    if (countEl) countEl.textContent = '(' + feats.length + ')';
  }

  loadDeployedToday();
  setInterval(loadDeployedToday, 5 * 60 * 1000);   // keep the layer fresh during a session

  /* ---------- Change history: range control, overlay, sidebar, parcel panel ----------
     Reads our own synced history from Supabase (see supabase/functions/sync-map-changes
     and docs/DECENTRALAND_MAP.md) via the same anon-key + RPC pattern assets/dcl.js
     already uses for get_site_content(). Nothing here talks to the Catalyst directly —
     that only happens server-side. */
  var sb = (typeof DCL_CONFIG !== 'undefined' && DCL_CONFIG.supabase) || {};
  async function callRpc(name, params) {
    if (!sb.url || !sb.anonKey) return null;
    try {
      var res = await fetch(sb.url + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: { apikey: sb.anonKey, Authorization: 'Bearer ' + sb.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; }
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) + ' — ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function parcelPolygon(x, y) {
    var c = toPx(x, y), h = SCALE / 2;
    return [[c[0] - h, c[1] - h], [c[0] + h, c[1] - h], [c[0] + h, c[1] + h], [c[0] - h, c[1] + h], [c[0] - h, c[1] - h]];
  }

  var RANGE_MS = { '24h': 24 * 3600 * 1000, '7d': 7 * 24 * 3600 * 1000, '30d': 30 * 24 * 3600 * 1000 };
  var currentRangeKey = '30d';
  var lastChanges = [];
  var listShown = 0;
  var LIST_PAGE = 20;
  var changesFeatureByKey = {};
  var selectedFeature = null, hoveredFeature = null;

  var summaryEl = document.getElementById('mapSummary');
  var listEl = document.getElementById('mapChangesList');
  var moreWrap = document.getElementById('mapMoreWrap');
  var moreBtn = document.getElementById('mapMoreBtn');
  var rangeBtns = document.querySelectorAll('.map-range-btn');
  var customRangeEl = document.getElementById('mapCustomRange');
  var fromInput = document.getElementById('mapRangeFrom');
  var toInput = document.getElementById('mapRangeTo');
  var changesToggle = document.getElementById('changesToggle');
  var heatmapToggle = document.getElementById('heatmapToggle');
  var heatmapWrap = document.getElementById('mapHeatmapToggleWrap');
  var detailPanel = document.getElementById('mapDetailPanel');
  var detailBody = document.getElementById('mapDetailBody');
  var detailClose = document.getElementById('mapDetailClose');

  function currentWindow() {
    if (currentRangeKey === 'custom') {
      var f = fromInput && fromInput.value ? new Date(fromInput.value + 'T00:00:00Z').getTime() : (Date.now() - RANGE_MS['30d']);
      var t = toInput && toInput.value ? new Date(toInput.value + 'T23:59:59Z').getTime() : Date.now();
      return { from: f, to: t };
    }
    return { from: Date.now() - RANGE_MS[currentRangeKey], to: Date.now() };
  }

  function clearChangesOverlay() {
    changesSource.clear();
    changesFeatureByKey = {};
    selectedFeature = null;
  }

  function renderSummary(items) {
    if (!summaryEl) return;
    if (!items.length) { summaryEl.innerHTML = ''; return; }
    var scenes = {}, parcels = {};
    items.forEach(function (d) {
      if (d.base_parcel_x != null) scenes[d.base_parcel_x + ',' + d.base_parcel_y] = true;
      (d.parcels || []).forEach(function (p) { parcels[p.x + ',' + p.y] = true; });
    });
    var cap = items.length >= 500 ? '+' : '';
    summaryEl.innerHTML =
      '<div class="stat"><div class="map-stat-n">' + items.length + cap + '</div><div class="map-stat-l">Deployments</div></div>' +
      '<div class="stat"><div class="map-stat-n">' + Object.keys(scenes).length + cap + '</div><div class="map-stat-l">Scenes updated</div></div>' +
      '<div class="stat"><div class="map-stat-n">' + Object.keys(parcels).length + cap + '</div><div class="map-stat-l">Parcels affected</div></div>';
  }

  function renderChangesOverlay(items) {
    clearChangesOverlay();
    var byParcel = {};
    items.forEach(function (d) {
      (d.parcels || []).forEach(function (p) {
        if (!inRange(p.x, p.y)) return;
        var key = p.x + ',' + p.y;
        if (!byParcel[key]) byParcel[key] = { x: p.x, y: p.y, count: 0 };
        byParcel[key].count++;
      });
    });
    Object.keys(byParcel).forEach(function (key) {
      var info = byParcel[key];
      var f = new ol.Feature({ geometry: new ol.geom.Polygon([parcelPolygon(info.x, info.y)]) });
      f.set('data', info);
      changesSource.addFeature(f);
      changesFeatureByKey[key] = f;
    });
  }

  function selectParcel(x, y) {
    if (selectedFeature) selectedFeature.setStyle(undefined);
    selectedFeature = changesFeatureByKey[x + ',' + y] || null;
    if (selectedFeature) selectedFeature.setStyle(selectStyle);
  }

  function renderList(reset) {
    if (!listEl) return;
    if (reset) listShown = 0;
    var slice = lastChanges.slice(0, listShown + LIST_PAGE);
    listShown = slice.length;
    if (!slice.length) {
      listEl.innerHTML = '<div class="empty">No scene deployments detected during this period.</div>';
    } else {
      listEl.innerHTML = slice.map(function (d) {
        var name = d.scene_name ? esc(d.scene_name) : (d.base_parcel_x != null ? 'Parcel (' + d.base_parcel_x + ', ' + d.base_parcel_y + ')' : 'Unknown scene');
        var n = d.parcel_count || (d.parcels || []).length;
        return '<button type="button" class="map-change-item" data-x="' + d.base_parcel_x + '" data-y="' + d.base_parcel_y + '">' +
          '<div class="map-change-time">' + fmtDateTime(d.deployed_at) + '</div>' +
          '<div class="map-change-name">' + name + '</div>' +
          '<div class="map-change-coord">' + d.base_parcel_x + ', ' + d.base_parcel_y +
            (n > 1 ? ' <span class="map-change-n">· ' + n + ' parcels</span>' : '') + '</div>' +
        '</button>';
      }).join('');
      Array.prototype.forEach.call(listEl.querySelectorAll('.map-change-item'), function (btn) {
        btn.onclick = function () {
          var x = parseInt(btn.getAttribute('data-x'), 10), y = parseInt(btn.getAttribute('data-y'), 10);
          if (isNaN(x) || isNaN(y)) return;
          map.getView().animate({ center: toPx(x, y), zoom: 6, duration: 450 });
          selectParcel(x, y);
          openDetailPanel(x, y);
        };
      });
    }
    if (moreWrap) moreWrap.hidden = listShown >= lastChanges.length;
  }

  async function loadChangesForRange() {
    if (!sb.url || !sb.anonKey) {
      if (listEl) listEl.innerHTML = '<div class="empty">Change history isn’t configured yet.</div>';
      renderSummary([]);
      clearChangesOverlay();
      return;
    }
    var win = currentWindow();
    if (listEl) listEl.innerHTML = '<div class="loading">Loading changes…</div>';
    var rows = await callRpc('get_map_changes', {
      p_from: new Date(win.from).toISOString(), p_to: new Date(win.to).toISOString(), p_limit: 500, p_offset: 0,
    });
    if (rows === null) {
      if (listEl) listEl.innerHTML = '<div class="error-box">Unable to load change history right now.</div>';
      renderSummary([]);
      clearChangesOverlay();
      return;
    }
    lastChanges = rows;
    renderSummary(rows);
    renderChangesOverlay(rows);
    renderList(true);
  }

  Array.prototype.forEach.call(rangeBtns, function (btn) {
    btn.onclick = function () {
      Array.prototype.forEach.call(rangeBtns, function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      currentRangeKey = btn.getAttribute('data-range');
      if (customRangeEl) customRangeEl.hidden = currentRangeKey !== 'custom';
      loadChangesForRange();
    };
  });
  if (fromInput) fromInput.addEventListener('change', function () { if (currentRangeKey === 'custom') loadChangesForRange(); });
  if (toInput) toInput.addEventListener('change', function () { if (currentRangeKey === 'custom') loadChangesForRange(); });
  if (moreBtn) moreBtn.onclick = function () { renderList(false); };

  if (changesToggle) changesToggle.addEventListener('change', function () {
    var on = changesToggle.checked;
    tileLayer.setOpacity(on ? 0.35 : 1);       // de-emphasize the base map; the overlay itself
    if (heatmapWrap) heatmapWrap.hidden = !on; // is always shown for the selected range regardless
  });
  if (heatmapToggle) heatmapToggle.addEventListener('change', function () {
    heatmapOn = heatmapToggle.checked;
    changesSource.changed();
  });

  // "Photo view" — opt-in genesis.city photographic tiles layered over our
  // own always-on official-data map. Off by default (see notes above).
  var photoToggle = document.getElementById('photoToggle');
  if (photoToggle) photoToggle.addEventListener('change', function () {
    tileLayer.setVisible(photoToggle.checked);
  });

  // Hover highlight for the changed-parcel overlay (separate listener from the
  // existing cursor-style one above, so neither has to know about the other).
  map.on('pointermove', function (e) {
    if (e.dragging) return;
    var hit = map.forEachFeatureAtPixel(e.pixel, function (f) { return f; },
      { hitTolerance: 2, layerFilter: function (l) { return l === changesLayer; } });
    if (hit === hoveredFeature) return;
    if (hoveredFeature && hoveredFeature !== selectedFeature) hoveredFeature.setStyle(undefined);
    hoveredFeature = hit || null;
    if (hoveredFeature && hoveredFeature !== selectedFeature) hoveredFeature.setStyle(hoverStyle);
  });

  /* ---------- Parcel deployment-history panel ---------- */
  if (detailClose) detailClose.onclick = function () { if (detailPanel) detailPanel.hidden = true; };

  function shortAddr(a) { return a ? (a.slice(0, 6) + '…' + a.slice(-4)) : ''; }
  var LAND_TYPE_LABEL = { district: 'District', road: 'Road', plaza: 'Plaza', owned: 'Private LAND' };

  async function renderOwnershipInfo(x, y) {
    // get_parcel_info returns a single jsonb object (or SQL null), not an array.
    var row = await callRpc('get_parcel_info', { p_x: x, p_y: y });
    if (!row || !row.type) return '';
    var typeLabel = LAND_TYPE_LABEL[row.type] || row.type;
    var bits = ['<span>' + esc(typeLabel) + '</span>'];
    if (row.name) bits.push('<span>' + esc(row.name) + '</span>');
    if (row.owner) bits.push('<span title="' + esc(row.owner) + '">' + esc(shortAddr(row.owner)) + '</span>');
    var html = '<div class="map-detail-ownership">' + bits.join(' · ') + '</div>';
    // has_scene reflects the Catalyst content server's current state (any
    // active deployed scene, not just recent changes) — distinct from, and a
    // superset of, the deployment-history list below.
    html += row.has_scene
      ? '<div class="map-detail-scene has-scene">Has a scene' + (row.scene_name ? ': ' + esc(row.scene_name) : '') + '</div>'
      : '<div class="map-detail-scene">No scene currently deployed here</div>';
    return html;
  }

  async function openDetailPanel(x, y) {
    if (!detailPanel || !detailBody) return;
    var play = 'https://play.decentraland.org/?position=' + x + '%2C' + y;
    var header = '<div class="map-detail-coord">' + x + ', ' + y + '</div>' +
      '<a class="map-history-link" href="' + play + '" target="_blank" rel="noopener">Jump into Decentraland ↗</a>';
    detailPanel.hidden = false;
    detailBody.innerHTML = header + '<div class="loading" style="margin-top:16px">Loading history…</div>';

    var ownershipHtml = '';
    if (sb.url && sb.anonKey) {
      try { ownershipHtml = await renderOwnershipInfo(x, y); } catch (e) { /* non-critical, skip */ }
    }
    header += ownershipHtml;

    if (!sb.url || !sb.anonKey) {
      detailBody.innerHTML = header + '<div class="empty" style="margin-top:16px">Deployment history isn’t configured yet.</div>';
      return;
    }
    var rows = await callRpc('get_parcel_history', { p_x: x, p_y: y });
    if (rows === null) {
      detailBody.innerHTML = header + '<div class="error-box" style="margin-top:16px">Couldn’t load deployment history right now.</div>';
      return;
    }
    if (!rows.length) {
      detailBody.innerHTML = header + '<div class="empty" style="margin-top:16px">No scene deployments recorded for this parcel yet.</div>';
      return;
    }
    var html = header + rows.map(function (r) {
      var parcels = (r.parcels || []).map(function (p) { return p.x + ',' + p.y; }).join(' · ');
      var n = r.parcel_count || (r.parcels || []).length;
      return '<div class="map-history-item">' +
        '<div class="map-history-name">' + esc(r.scene_name || 'Unnamed scene') + '</div>' +
        '<div class="map-history-meta"><span>' + fmtDateTime(r.deployed_at) + '</span><span>' + n + ' parcel' + (n === 1 ? '' : 's') + '</span></div>' +
        '<div class="map-history-ids">' +
          '<div class="map-history-id-row"><span class="map-history-id" title="' + esc(r.entity_id) + '">' + esc(r.entity_id) + '</span>' +
            '<button type="button" class="map-copy-btn" data-copy="' + esc(r.entity_id) + '">Copy</button></div>' +
          (r.previous_entity_id ? '<div class="map-history-id-row"><span class="map-history-id" title="' + esc(r.previous_entity_id) + '">prev ' + esc(r.previous_entity_id) + '</span>' +
            '<button type="button" class="map-copy-btn" data-copy="' + esc(r.previous_entity_id) + '">Copy</button></div>' : '') +
        '</div>' +
        (parcels ? '<div class="map-history-parcels">' + esc(parcels) + '</div>' : '') +
      '</div>';
    }).join('');
    detailBody.innerHTML = html;
    Array.prototype.forEach.call(detailBody.querySelectorAll('.map-copy-btn'), function (btn) {
      btn.onclick = function () {
        var v = btn.getAttribute('data-copy');
        if (!v) return;
        var reset = function () { btn.textContent = 'Copy'; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(v).then(function () { btn.textContent = 'Copied'; setTimeout(reset, 1200); });
        }
      };
    });
  }

  /* ---------- Before/after historical imagery ----------
     genesis.city's own Time Machine uses a small hardcoded list of snapshot
     dates (there is no API for arbitrary dates) served from the parcels repo's
     Git LFS host. Mirrored here rather than guessed — see docs/DECENTRALAND_MAP.md. */
  var HIST_BASE = 'https://media.githubusercontent.com/media/genesis-city/parcels/master';
  var HISTORICAL_SNAPSHOTS = [
    { path: '2023-06-11', label: '11 Jun 2023' },
    { path: '2023-07-02', label: '02 Jul 2023' },
    { path: '2023-08-07', label: '07 Aug 2023' },
    { path: '2023-09-03', label: '03 Sep 2023' },
    { path: '2024-08-20', label: '20 Aug 2024' },
  ];

  var imageryBtn = document.getElementById('mapImageryBtn');
  var imageryPanel = document.getElementById('mapImageryPanel');
  var imageryDateSel = document.getElementById('mapImageryDate');
  var imagerySliderRow = document.getElementById('mapImagerySliderRow');
  var imagerySlider = document.getElementById('mapImagerySlider');
  var imageryNote = document.getElementById('mapImageryNote');
  var historicalLayer = null;

  if (imageryDateSel) {
    HISTORICAL_SNAPSHOTS.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.path; opt.textContent = s.label;
      imageryDateSel.appendChild(opt);
    });
  }
  if (imageryBtn) imageryBtn.onclick = function () { if (imageryPanel) imageryPanel.hidden = !imageryPanel.hidden; };

  function removeHistoricalLayer() {
    if (historicalLayer) { map.removeLayer(historicalLayer); historicalLayer = null; }
    if (imagerySliderRow) imagerySliderRow.hidden = true;
  }

  if (imageryDateSel) imageryDateSel.addEventListener('change', function () {
    removeHistoricalLayer();
    if (imageryNote) imageryNote.textContent = '';
    var path = imageryDateSel.value;
    if (!path) return;
    var histSource = new ol.source.TileImage({
      url: HIST_BASE + '/maps/' + path + '/{z}/{x},{y}.jpg',
      wrapX: false,
      tileGrid: new ol.tilegrid.TileGrid({ extent: extent, origin: origin, tileSize: [side, side], resolutions: resolutions, minZoom: 1, maxZoom: 10 }),
    });
    var loaded = 0, errored = 0;
    histSource.on('tileloadend', function () { loaded++; });
    histSource.on('tileloaderror', function () { errored++; });
    historicalLayer = new ol.layer.Tile({ source: histSource, opacity: (imagerySlider ? +imagerySlider.value : 50) / 100 });
    map.getLayers().insertAt(1, historicalLayer); // just above the base "latest" tile layer
    if (imagerySliderRow) imagerySliderRow.hidden = false;
    setTimeout(function () {
      if (loaded === 0 && errored > 0) {
        if (imageryNote) imageryNote.textContent = 'Historical rendered imagery unavailable for this date.';
        removeHistoricalLayer();
        imageryDateSel.value = '';
      }
    }, 1500);
  });
  if (imagerySlider) imagerySlider.addEventListener('input', function () {
    if (historicalLayer) historicalLayer.setOpacity(+imagerySlider.value / 100);
  });

  /* ---------- Named places — the actual "scenes" on the map ----------
     Decentraland's official Places directory (title/description/image/
     categories) — distinct from land_parcels (raw ownership). Loaded for the
     current viewport only (re-fetched, debounced, on pan/zoom), same pattern
     as the changed-parcel overlay above. */
  function showPlace(place) {
    if (!place) return;
    var x = place.base_x, y = place.base_y;
    var play = 'https://play.decentraland.org/?position=' + x + '%2C' + y;
    var cats = (place.categories || []).join(' · ');
    popEl.innerHTML =
      '<button class="map-pop-x" aria-label="Close">×</button>' +
      (place.image ? '<img class="mp-thumb" src="' + esc(place.image) + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
      '<div class="mp-coord">' + esc(place.title || (x + ', ' + y)) + '</div>' +
      (cats ? '<div class="mp-sub">' + esc(cats) + '</div>' : '') +
      '<a href="' + play + '" target="_blank" rel="noopener">Jump in-world ↗</a>' +
      '<button type="button" class="map-pop-link" data-x="' + x + '" data-y="' + y + '">View deployment history</button>';
    overlay.setPosition(toPx(x, y)); wireClose(); wireHistoryLink(x, y);
  }

  var placesLoadTimer = null;
  function loadPlacesForView() {
    if (!sb.url || !sb.anonKey) return;
    var ext = map.getView().calculateExtent(map.getSize());
    var c1 = toCoord(ext[0], ext[1]), c2 = toCoord(ext[2], ext[3]);
    var minX = Math.max(-152, Math.min(c1[0], c2[0])), maxX = Math.min(152, Math.max(c1[0], c2[0]));
    var minY = Math.max(-152, Math.min(c1[1], c2[1])), maxY = Math.min(152, Math.max(c1[1], c2[1]));
    callRpc('get_places_in_bbox', { p_min_x: minX, p_max_x: maxX, p_min_y: minY, p_max_y: maxY, p_limit: 800 })
      .then(function (rows) {
        if (!rows) return;
        var feats = rows.filter(function (p) { return inRange(p.base_x, p.base_y); }).map(function (p) {
          var f = new ol.Feature({ geometry: new ol.geom.Point(toPx(p.base_x, p.base_y)) });
          f.set('place', p);
          return f;
        });
        placesSource.clear();
        placesSource.addFeatures(feats);
      });
  }
  map.on('moveend', function () {
    clearTimeout(placesLoadTimer);
    placesLoadTimer = setTimeout(loadPlacesForView, 300);
  });

  loadChangesForRange();
  loadPlacesForView();
})();
