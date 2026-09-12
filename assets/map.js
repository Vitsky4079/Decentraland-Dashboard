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

  var popEl = document.getElementById('mapPopup');
  var overlay = new ol.Overlay({ element: popEl, positioning: 'bottom-center', stopEvent: true, offset: [0, -6] });

  var map = new ol.Map({
    target: target,
    layers: [new ol.layer.Tile({ source: source }), deployLayer],
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

  function showParcel(x, y) {
    if (!inRange(x, y)) { overlay.setPosition(undefined); return; }
    var play = 'https://play.decentraland.org/?position=' + x + '%2C' + y;
    var gen = 'https://genesis.city/#' + x + ',' + y + ',4z';
    popEl.innerHTML =
      '<button class="map-pop-x" aria-label="Close">\u00D7</button>' +
      '<div class="mp-coord">' + x + ', ' + y + '</div>' +
      '<a href="' + play + '" target="_blank" rel="noopener">Jump in-world \u2197</a>' +
      '<a href="' + gen + '" target="_blank" rel="noopener">Open on genesis.city \u2197</a>';
    overlay.setPosition(toPx(x, y)); wireClose();
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
      '<a href="' + play + '" target="_blank" rel="noopener">Jump in-world \u2197</a>';
    overlay.setPosition(toPx(d.x, d.y)); wireClose();
  }

  map.on('singleclick', function (evt) {
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
})();
