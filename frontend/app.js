// app.js - SafeRoute frontend application

const DEFAULT_LAT = 12.9716;
const DEFAULT_LON = 77.5946;
const map = L.map('map').setView([DEFAULT_LAT, DEFAULT_LON], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const LS_LAST_SEARCH = 'sr_last_search';
const LS_SAVED_ROUTES = 'sr_saved_routes';
const LS_TRACKING_ENABLED = 'sr_tracking_enabled';
const LS_SEARCH_MEMORY = 'sr_search_memory';
const SEARCH_RECENT_LIMIT = 6;
const SEARCH_COMMON_LIMIT = 6;
const LIVE_NAV_ARRIVAL_M = 30;

let issueMode = false;
let routeLayer = null;
let markerLayer = null;
let issueClusterLayer = null; // route-specific issue markers only
let heatmapLayer = null;
let currentUser = null;
let originCoords = null;
let destCoords = null;
let lastRoutePayload = null;
let trackingEnabled = localStorage.getItem(LS_TRACKING_ENABLED) === '1';
const shownValidationSet = new Set();
let _watchId = null;
let _navWatchId = null;
let _liveMarker = null;
let _liveAccuracyCircle = null;
let _liveTrail = null;
let _liveRouteType = null;
let _liveRouteCoords = [];
let _liveRouteSteps = [];
let _liveRouteTotalM = 0;
let _liveRouteMode = 'walk';

function showLoading(msg) {
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  const text = el.querySelector('#loading-text');
  if (text) text.textContent = msg || 'Please wait...';
  el.style.display = 'flex';
}

function hideLoading() {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = 'none';
}

function showToast(msg, duration = 3500) {
  const toast = document.createElement('div');
  toast.textContent = msg;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '88px',
    right: '24px',
    background: '#2c3e50',
    color: '#fff',
    padding: '10px 18px',
    borderRadius: '8px',
    zIndex: '9999',
    fontSize: '14px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    maxWidth: '380px',
    lineHeight: '1.4',
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function scoreColor(score) {
  if (score >= 70) return '#27ae60';
  if (score >= 50) return '#e67e22';
  return '#e74c3c';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateNavbar(user) {
  const userInfo = document.getElementById('user-info');
  if (!userInfo) return;
  if (user) {
    userInfo.innerHTML = `
      <a class="nav-link" href="profile.html">Profile</a>
      <span class="nav-username">Hi, ${escHtml(user.username)}</span>
      <button class="nav-btn" onclick="logout()">Logout</button>
    `;
  } else {
    userInfo.innerHTML = '<a class="nav-link" href="login.html">Login</a>';
  }
}

function metersBetween(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const p1 = aLat * Math.PI / 180;
  const p2 = bLat * Math.PI / 180;
  const dp = (bLat - aLat) * Math.PI / 180;
  const dl = (bLon - aLon) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function _emptySearchMemory() {
  return {
    origin: { recent: [], counts: {} },
    destination: { recent: [], counts: {} },
    lastMode: 'walk',
  };
}

function _normalizePlaceKey(text) {
  return String(text || '').trim().toLowerCase();
}

function getSearchMemory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_SEARCH_MEMORY) || '{}');
    const base = _emptySearchMemory();
    return {
      origin: parsed.origin || base.origin,
      destination: parsed.destination || base.destination,
      lastMode: parsed.lastMode || base.lastMode,
    };
  } catch {
    return _emptySearchMemory();
  }
}

function setSearchMemory(memory) {
  localStorage.setItem(LS_SEARCH_MEMORY, JSON.stringify(memory));
}

function rememberPlace(kind, label, coords = null) {
  const clean = String(label || '').trim();
  const key = _normalizePlaceKey(clean);
  if (!clean || !key || (kind !== 'origin' && kind !== 'destination')) return;

  const now = Date.now();
  const mem = getSearchMemory();
  const bucket = mem[kind];

  bucket.recent = (bucket.recent || []).filter((e) => _normalizePlaceKey(e?.label) !== key);
  bucket.recent.unshift({
    label: clean,
    lat: Number.isFinite(coords?.lat) ? Number(coords.lat) : null,
    lon: Number.isFinite(coords?.lon) ? Number(coords.lon) : null,
    last_used: now,
  });
  if (bucket.recent.length > 20) bucket.recent.length = 20;

  const prev = bucket.counts?.[key] || { label: clean, count: 0, last_used: 0, lat: null, lon: null };
  bucket.counts[key] = {
    label: clean,
    count: (prev.count || 0) + 1,
    last_used: now,
    lat: Number.isFinite(coords?.lat) ? Number(coords.lat) : prev.lat,
    lon: Number.isFinite(coords?.lon) ? Number(coords.lon) : prev.lon,
  };

  mem[kind] = bucket;
  setSearchMemory(mem);
}

function getPlaceSuggestions(kind, query = '') {
  if (kind !== 'origin' && kind !== 'destination') return [];

  const q = _normalizePlaceKey(query);
  const mem = getSearchMemory();
  const bucket = mem[kind] || { recent: [], counts: {} };
  const out = [];
  const seen = new Set();

  for (const item of bucket.recent || []) {
    const key = _normalizePlaceKey(item?.label);
    if (!key || seen.has(key)) continue;
    if (q && !key.includes(q)) continue;
    seen.add(key);
    out.push({
      name: item.label,
      lat: Number.isFinite(item.lat) ? Number(item.lat) : null,
      lon: Number.isFinite(item.lon) ? Number(item.lon) : null,
    });
    if (out.length >= SEARCH_RECENT_LIMIT) break;
  }

  const common = Object.values(bucket.counts || {})
    .filter((item) => {
      const key = _normalizePlaceKey(item?.label);
      return key && (!q || key.includes(q));
    })
    .sort((a, b) => (b.count || 0) - (a.count || 0) || (b.last_used || 0) - (a.last_used || 0));

  for (const item of common) {
    const key = _normalizePlaceKey(item?.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: item.label,
      lat: Number.isFinite(item.lat) ? Number(item.lat) : null,
      lon: Number.isFinite(item.lon) ? Number(item.lon) : null,
    });
    if (out.length >= SEARCH_RECENT_LIMIT + SEARCH_COMMON_LIMIT) break;
  }

  return out;
}

function resolveRememberedPlace(kind, text) {
  const key = _normalizePlaceKey(text);
  if (!key || (kind !== 'origin' && kind !== 'destination')) return null;

  const mem = getSearchMemory();
  const bucket = mem[kind] || { recent: [], counts: {} };
  const recentExact = (bucket.recent || []).find((e) => _normalizePlaceKey(e?.label) === key);
  if (Number.isFinite(recentExact?.lat) && Number.isFinite(recentExact?.lon)) {
    return { lat: Number(recentExact.lat), lon: Number(recentExact.lon) };
  }
  const commonExact = bucket.counts?.[key];
  if (Number.isFinite(commonExact?.lat) && Number.isFinite(commonExact?.lon)) {
    return { lat: Number(commonExact.lat), lon: Number(commonExact.lon) };
  }
  return null;
}

function saveLastSearch(originText, destText, mode, originResolved = null, destResolved = null) {
  localStorage.setItem(LS_LAST_SEARCH, JSON.stringify({ mode }));
  const mem = getSearchMemory();
  mem.lastMode = mode || 'walk';
  setSearchMemory(mem);
  rememberPlace('origin', originText, originResolved);
  rememberPlace('destination', destText, destResolved);
}

function restoreLastSearch() {
  try {
    const raw = localStorage.getItem(LS_LAST_SEARCH);
    const mem = getSearchMemory();
    const obj = raw ? JSON.parse(raw) : {};
    document.getElementById('originInput').value = '';
    document.getElementById('destInput').value = '';
    originCoords = null;
    destCoords = null;
    selectMode(obj.mode || mem.lastMode || 'walk');
  } catch {}
}

function setShareParams(originLat, originLon, destLat, destLon, mode, originText, destText) {
  const qs = new URLSearchParams(window.location.search);
  qs.set('from', `${originLat.toFixed(6)},${originLon.toFixed(6)}`);
  qs.set('to', `${destLat.toFixed(6)},${destLon.toFixed(6)}`);
  qs.set('mode', mode || 'walk');
  if (originText) qs.set('from_label', originText);
  if (destText) qs.set('to_label', destText);
  history.replaceState({}, '', `${window.location.pathname}?${qs.toString()}`);
}

function parseCoords(text) {
  const parts = String(text || '').split(',').map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  return { lat: parts[0], lon: parts[1] };
}

function applyShareParamsIfAny() {
  const qs = new URLSearchParams(window.location.search);
  const from = parseCoords(qs.get('from'));
  const to = parseCoords(qs.get('to'));
  const mode = qs.get('mode');

  if (!from || !to) return false;

  originCoords = from;
  destCoords = to;
  document.getElementById('originInput').value = qs.get('from_label') || `${from.lat.toFixed(5)}, ${from.lon.toFixed(5)}`;
  document.getElementById('destInput').value = qs.get('to_label') || `${to.lat.toFixed(5)}, ${to.lon.toFixed(5)}`;
  if (mode && ['walk', 'cycle', 'drive'].includes(mode)) {
    selectMode(mode);
  }
  return true;
}

const _acTimers = {};
function setupAutocomplete(inputId, onCoordSelect) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(inputId + '-list');
  if (!input || !list) return;
  const kind = inputId === 'originInput' ? 'origin' : 'destination';

  const showLocalSuggestions = (query = '') => {
    const local = getPlaceSuggestions(kind, query);
    renderSuggestions(list, local, (s) => {
      input.value = s.name;
      list.innerHTML = '';
      list.style.display = 'none';
      if (Number.isFinite(s?.lat) && Number.isFinite(s?.lon)) {
        onCoordSelect({ lat: Number(s.lat), lon: Number(s.lon) });
      } else {
        onCoordSelect(null);
      }
    });
  };

  input.addEventListener('input', () => {
    onCoordSelect(null);
    clearTimeout(_acTimers[inputId]);
    const q = input.value.trim();

    if (q.length === 0) {
      showLocalSuggestions('');
      return;
    }

    if (q.length < 2) {
      showLocalSuggestions(q);
      return;
    }

    _acTimers[inputId] = setTimeout(async () => {
      try {
        const c = map.getCenter();
        const url = `${API_BASE}/geocode/autocomplete?query=${encodeURIComponent(q)}&lat=${c.lat}&lon=${c.lng}`;
        const res = await fetch(url);
        const data = await res.json();
        const remote = data.suggestions || [];
        const local = getPlaceSuggestions(kind, q).slice(0, 3);
        const merged = [];
        const seen = new Set();
        [...local, ...remote].forEach((s) => {
          const key = _normalizePlaceKey(s?.name);
          if (!key || seen.has(key)) return;
          seen.add(key);
          merged.push(s);
        });

        renderSuggestions(list, merged, (s) => {
          input.value = s.name;
          list.innerHTML = '';
          list.style.display = 'none';
          if (Number.isFinite(s?.lat) && Number.isFinite(s?.lon)) {
            onCoordSelect({ lat: Number(s.lat), lon: Number(s.lon) });
          } else {
            onCoordSelect(null);
          }
        });
      } catch (err) {
        console.error('Autocomplete error:', err);
      }
    }, 300);
  });

  input.addEventListener('focus', () => {
    if (!input.value.trim()) showLocalSuggestions('');
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !list.contains(e.target)) {
      list.innerHTML = '';
      list.style.display = 'none';
    }
  });
}

function renderSuggestions(container, suggestions, onClickFn) {
  container.innerHTML = '';
  if (!suggestions.length) {
    container.style.display = 'none';
    return;
  }
  suggestions.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.textContent = s.name;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      onClickFn(s);
    });
    container.appendChild(item);
  });
  container.style.display = 'block';
}

function summarizeRouteIssues(routeIssues) {
  if (!Array.isArray(routeIssues) || !routeIssues.length) return 'No reported issues on this route.';
  const items = routeIssues.slice(0, 6).map((i) => {
    const conf = Math.round(i.effective_confidence || 0);
    const desc = i.description ? ` - ${escHtml(i.description).slice(0, 80)}` : '';
    return `<li>${escHtml(i.category)} (${conf}/100)${desc}</li>`;
  });
  const more = routeIssues.length > 6 ? `<li>+${routeIssues.length - 6} more...</li>` : '';
  return `<ul style="margin:4px 0 0 16px;padding:0;">${items.join('')}${more}</ul>`;
}

function drawRouteIssueMarkers(routeData) {
  if (issueClusterLayer) {
    map.removeLayer(issueClusterLayer);
    issueClusterLayer = null;
  }

  const features = routeData?.features || [];
  const routeFeatures = features.filter((f) => f.properties?.route_type);
  const byId = new Map();

  routeFeatures.forEach((f) => {
    const routeType = f.properties?.route_type;
    (f.properties?.route_issues || []).forEach((issue) => {
      if (!issue?.id || byId.has(issue.id)) return;
      byId.set(issue.id, { ...issue, _routeType: routeType });
    });
  });

  issueClusterLayer = L.layerGroup();
  for (const issue of byId.values()) {
    const stale = (issue.effective_confidence || 0) <= 55;
    const marker = L.circleMarker([issue.lat, issue.lon], {
      radius: 8,
      color: stale ? '#e67e22' : '#e74c3c',
      fillColor: stale ? '#f39c12' : '#e74c3c',
      fillOpacity: 0.8,
      weight: 2,
    });

    const validationHtml = currentUser
      ? `
        <br><br>
        <button onclick="validateIssue('${issue.id}','confirm')" style="margin-right:6px;padding:4px 10px;background:#27ae60;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:12px;">Still there</button>
        <button onclick="validateIssue('${issue.id}','dismiss')" style="padding:4px 10px;background:#e74c3c;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:12px;">Fixed/Gone</button>
      `
      : '<br><small style="color:#888">Login to validate</small>';

    marker.bindPopup(`
      <b>${escHtml(issue.category)}</b><br>
      ${issue.description ? escHtml(issue.description) + '<br>' : ''}
      Confidence: <b>${Math.round(issue.effective_confidence || 0)}</b><br>
      Reports: ${issue.num_reports || 0}, Confirm: ${issue.num_confirmations || 0}, Dismiss: ${issue.num_dismissals || 0}
      ${validationHtml}
    `);

    marker._issueId = issue.id;
    marker._issueMeta = issue;
    issueClusterLayer.addLayer(marker);
  }

  issueClusterLayer.addTo(map);
}

async function getRoutesFromInput() {
  const originText = document.getElementById('originInput').value.trim();
  const destText = document.getElementById('destInput').value.trim();
  const mode = document.getElementById('mode').value;

  if (!originText || !destText) {
    showToast('Please enter both origin and destination.');
    return;
  }

  showLoading('Resolving locations...');

  try {
    const center = map.getCenter();
    let origin_lat, origin_lon, dest_lat, dest_lon;

    if (originCoords) {
      origin_lat = originCoords.lat;
      origin_lon = originCoords.lon;
    } else {
      const remembered = resolveRememberedPlace('origin', originText);
      if (remembered) {
        origin_lat = remembered.lat;
        origin_lon = remembered.lon;
      } else {
        const res = await fetch(`${API_BASE}/geocode?query=${encodeURIComponent(originText)}&lat=${center.lat}&lon=${center.lng}`);
        const data = await res.json();
        if (data.error) {
          hideLoading();
          showToast('Origin not found. Try a more specific name.');
          return;
        }
        origin_lat = data.lat;
        origin_lon = data.lon;
      }
    }

    if (destCoords) {
      dest_lat = destCoords.lat;
      dest_lon = destCoords.lon;
    } else {
      const remembered = resolveRememberedPlace('destination', destText);
      if (remembered) {
        dest_lat = remembered.lat;
        dest_lon = remembered.lon;
      } else {
        const res = await fetch(`${API_BASE}/geocode?query=${encodeURIComponent(destText)}&lat=${center.lat}&lon=${center.lng}`);
        const data = await res.json();
        if (data.error) {
          hideLoading();
          showToast('Destination not found. Try a more specific name.');
          return;
        }
        dest_lat = data.lat;
        dest_lon = data.lon;
      }
    }

    // Clear ALL stale layers before new request — prevents old data showing on error
    if (routeLayer)        { map.removeLayer(routeLayer);        routeLayer        = null; }
    if (markerLayer)       { map.removeLayer(markerLayer);       markerLayer       = null; }
    if (issueClusterLayer) { map.removeLayer(issueClusterLayer); issueClusterLayer = null; }
    const summaryEl = document.getElementById('route-summary');
    if (summaryEl) summaryEl.style.display = 'none';

    markerLayer = L.layerGroup([
      L.marker([origin_lat, origin_lon]).bindPopup('<b>Origin</b>'),
      L.marker([dest_lat, dest_lon]).bindPopup('<b>Destination</b>'),
    ]).addTo(map);

    showLoading('Building street graph and computing routes...');
    const res = await fetch(`${API_BASE}/route`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ origin_lat, origin_lon, dest_lat, dest_lon, mode }),
    });
    const data = await res.json();
    hideLoading();

    if (!data || data.error || data.type !== 'FeatureCollection') {
      showToast(data?.error || 'No route found. Try nearby locations.');
      return;
    }

    saveLastSearch(
      originText,
      destText,
      mode,
      { lat: origin_lat, lon: origin_lon },
      { lat: dest_lat, lon: dest_lon }
    );
    setShareParams(origin_lat, origin_lon, dest_lat, dest_lon, mode, originText, destText);

    lastRoutePayload = {
      data,
      origin: { lat: origin_lat, lon: origin_lon, label: originText },
      destination: { lat: dest_lat, lon: dest_lon, label: destText },
      mode,
    };

    drawRoutes(data);
  } catch (err) {
    hideLoading();
    console.error('Route error:', err);
    showToast('Something went wrong. Is the backend running?');
  }
}

function routeCard(p, type) {
  const label = type === 'safe' ? 'Safe' : 'Fast';
  const border = type === 'safe' ? '#27ae60' : '#e67e22';
  const color = scoreColor(p.safety_score);
  const issues = p.issues_on_path ?? 0;
  return `
    <div class="route-card" style="border-left:4px solid ${border}">
      <div class="rc-label">${label}</div>
      <div class="rc-row">Safety <span style="color:${color};font-weight:700">${p.safety_score}/100</span></div>
      <div class="rc-row">Distance <span>${p.distance_km} km</span></div>
      <div class="rc-row">Time <span>~${formatMinutes(p.duration_min)} min</span></div>
      <div class="rc-row">Issues <span>${issues}</span></div>
      <div style="margin-top:6px;display:flex;gap:6px;">
        <button class="small-btn" onclick="saveCurrentRoute('${type}')">Save</button>
        <button class="small-btn" onclick="showSteps('${type}')">Steps</button>
        <button class="small-btn" onclick="startLiveNavigation('${type}')">Live</button>
      </div>
    </div>
  `;
}

function formatMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '--';
  return n.toFixed(1);
}

function drawRoutes(data) {
  stopLiveNavigation(true);

  if (routeLayer) map.removeLayer(routeLayer);

  routeLayer = L.geoJSON(data, {
    style: (feature) => {
      if (feature.geometry.type !== 'LineString') return {};
      if (feature.properties.route_type === 'safe') {
        return { color: '#27ae60', weight: 6, opacity: 0.9 };
      }
      if (feature.properties.route_type === 'fast') {
        return { color: '#e67e22', weight: 5, opacity: 0.85, dashArray: '10, 8' };
      }
      return {};
    },
    pointToLayer: (_feature, latlng) => L.marker(latlng),
    onEachFeature: (feature, layer) => {
      if (feature.geometry.type === 'Point') {
        layer.bindPopup(`<b>${feature.properties.label}</b>`);
      }
      if (feature.properties?.route_type) {
        const p = feature.properties;
        layer.bindPopup(`
          <b>${p.route_type === 'safe' ? 'Safe Route' : 'Fast Route'}</b><br>
          Safety: <span style="color:${scoreColor(p.safety_score)};font-weight:bold">${p.safety_score}/100</span><br>
          Distance: ${p.distance_km} km<br>
          Time: ~${formatMinutes(p.duration_min)} min<br>
          Issues on path: ${p.issues_on_path ?? 0}<br>
          <b>Reported issues on this route:</b>
          ${summarizeRouteIssues(p.route_issues || [])}
        `);
      }
    },
  }).addTo(map);

  const bounds = routeLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50] });

  drawRouteIssueMarkers(data);

  const features = data.features || [];
  const safeProps = features.find((f) => f.properties?.route_type === 'safe')?.properties;
  const fastProps = features.find((f) => f.properties?.route_type === 'fast')?.properties;
  const sameRoute = Boolean(data?.metadata?.same_route);

  const summaryEl = document.getElementById('route-summary');
  if (!summaryEl || !safeProps) return;

  if (sameRoute || !fastProps) {
    summaryEl.style.display = 'block';
    if (window.innerWidth <= 768) summaryEl.classList.add('sheet-open');
    summaryEl.innerHTML = `
      <h4 style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;">Route Result</h4>
      <div style="margin-bottom:8px;padding:8px;border-radius:8px;background:#ecfdf3;color:#0f5132;font-size:12px;">
        The safest route is also the fastest here.
      </div>
      <div class="route-cards">${routeCard(safeProps, 'safe')}</div>
      <div id="live-nav-panel" style="margin-top:10px;"></div>
      <div id="steps-panel" style="margin-top:10px;"></div>
    `;
  } else {
    summaryEl.style.display = 'block';
    if (window.innerWidth <= 768) summaryEl.classList.add('sheet-open');
    summaryEl.innerHTML = `
      <h4 style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;">Route Comparison</h4>
      <div class="route-cards">
        ${routeCard(safeProps, 'safe')}
        ${routeCard(fastProps, 'fast')}
      </div>
      <div id="live-nav-panel" style="margin-top:10px;"></div>
      <div id="steps-panel" style="margin-top:10px;"></div>
    `;
  }

  showSteps('safe');
}

function showSteps(type) {
  const panel = document.getElementById('steps-panel');
  if (!panel || !lastRoutePayload?.data) return;

  const feature = (lastRoutePayload.data.features || []).find((f) => f.properties?.route_type === type);
  const steps = feature?.properties?.steps || [];
  const title = type === 'safe' ? 'Safe Route Steps' : 'Fast Route Steps';

  if (!steps.length) {
    panel.innerHTML = '';
    return;
  }

  panel.innerHTML = `
    <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">${title}</div>
    <ol style="margin:0;padding-left:16px;font-size:12px;color:#1f2937;line-height:1.5;max-height:180px;overflow:auto;">
      ${steps.map((s) => `<li style="margin-bottom:4px;">${escHtml(s.instruction || '')}</li>`).join('')}
    </ol>
  `;
}

function getRouteFeature(type) {
  if (!lastRoutePayload?.data?.features) return null;
  return lastRoutePayload.data.features.find((f) => f.properties?.route_type === type) || null;
}

function distanceMetersBetweenCoords(a, b) {
  return metersBetween(a[1], a[0], b[1], b[0]);
}

function routeLengthMeters(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < coords.length - 1; i += 1) {
    total += distanceMetersBetweenCoords(coords[i], coords[i + 1]);
  }
  return total;
}

function nearestPointOnRoute(userLat, userLon, coords) {
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coords.length; i += 1) {
    const p = coords[i];
    const d = metersBetween(userLat, userLon, p[1], p[0]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return { index: bestIdx, dist_m: bestDist };
}

function remainingDistanceMeters(userLat, userLon, coords, nearestIdx) {
  if (!coords.length) return 0;
  let remaining = metersBetween(userLat, userLon, coords[nearestIdx][1], coords[nearestIdx][0]);
  for (let i = nearestIdx; i < coords.length - 1; i += 1) {
    remaining += distanceMetersBetweenCoords(coords[i], coords[i + 1]);
  }
  return remaining;
}

function stepFromProgress(traveledM, steps) {
  if (!Array.isArray(steps) || !steps.length) return '';
  let cumulative = 0;
  for (let i = 0; i < steps.length; i += 1) {
    cumulative += Number(steps[i].distance_m || 0);
    if (traveledM <= cumulative + 20) return steps[i].instruction || '';
  }
  return steps[steps.length - 1].instruction || '';
}

function ensureLivePanel() {
  const summary = document.getElementById('route-summary');
  if (!summary) return null;
  let panel = document.getElementById('live-nav-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'live-nav-panel';
    panel.style.marginTop = '10px';
    summary.appendChild(panel);
  }
  return panel;
}

function renderLivePanel(html) {
  const panel = ensureLivePanel();
  if (!panel) return;
  panel.innerHTML = html || '';
}

function stopLiveNavigation(silent = false) {
  if (_navWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(_navWatchId);
    _navWatchId = null;
  }
  if (_liveMarker) {
    map.removeLayer(_liveMarker);
    _liveMarker = null;
  }
  if (_liveAccuracyCircle) {
    map.removeLayer(_liveAccuracyCircle);
    _liveAccuracyCircle = null;
  }
  if (_liveTrail) {
    map.removeLayer(_liveTrail);
    _liveTrail = null;
  }
  _liveRouteType = null;
  _liveRouteCoords = [];
  _liveRouteSteps = [];
  _liveRouteTotalM = 0;
  if (silent) {
    renderLivePanel('');
    return;
  }
  renderLivePanel('');
  showToast('Live navigation stopped.');
}

function updateLiveNavigation(position) {
  if (!_liveRouteCoords.length) return;

  const userLat = position.coords.latitude;
  const userLon = position.coords.longitude;
  const accuracy = Number(position.coords.accuracy || 0);
  const ll = [userLat, userLon];

  if (!_liveMarker) {
    _liveMarker = L.circleMarker(ll, {
      radius: 8,
      color: '#1d4ed8',
      fillColor: '#3b82f6',
      fillOpacity: 0.95,
      weight: 2,
    }).addTo(map);
    _liveMarker.bindPopup('<b>Your live location</b>');
  } else {
    _liveMarker.setLatLng(ll);
  }

  if (!_liveAccuracyCircle) {
    _liveAccuracyCircle = L.circle(ll, {
      radius: Math.max(5, accuracy),
      color: '#60a5fa',
      fillColor: '#93c5fd',
      fillOpacity: 0.15,
      weight: 1,
    }).addTo(map);
  } else {
    _liveAccuracyCircle.setLatLng(ll);
    _liveAccuracyCircle.setRadius(Math.max(5, accuracy));
  }

  if (!_liveTrail) {
    _liveTrail = L.polyline([ll], { color: '#1d4ed8', weight: 3, opacity: 0.7 }).addTo(map);
  } else {
    _liveTrail.addLatLng(ll);
  }

  const nearest = nearestPointOnRoute(userLat, userLon, _liveRouteCoords);
  const remainingM = remainingDistanceMeters(userLat, userLon, _liveRouteCoords, nearest.index);
  const traveledM = Math.max(0, _liveRouteTotalM - remainingM);
  const speed = _liveRouteMode === 'drive' ? 24 : _liveRouteMode === 'cycle' ? 14 : 4.8;
  const etaMin = (remainingM / 1000) / speed * 60;
  const nextStep = stepFromProgress(traveledM, _liveRouteSteps);

  renderLivePanel(`
    <div style="padding:10px;border:1px solid #dbeafe;border-radius:8px;background:#eff6ff;">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#1e3a8a;margin-bottom:4px;">Live Navigation (${_liveRouteType})</div>
      <div style="font-size:12px;color:#1f2937;line-height:1.5;">
        Remaining: <b>${(remainingM / 1000).toFixed(2)} km</b><br>
        ETA: <b>~${formatMinutes(etaMin)} min</b><br>
        Accuracy: <b>${Math.round(accuracy)} m</b><br>
        Next: ${escHtml(nextStep || 'Follow the highlighted route')}
      </div>
      <div style="margin-top:8px;">
        <button class="small-btn" onclick="stopLiveNavigation()">Stop live</button>
      </div>
    </div>
  `);

  if (remainingM <= LIVE_NAV_ARRIVAL_M) {
    showToast('You have arrived at your destination.');
    stopLiveNavigation(true);
    renderLivePanel(`
      <div style="padding:10px;border:1px solid #d1fae5;border-radius:8px;background:#ecfdf5;color:#065f46;font-size:12px;">
        Arrival detected. Live navigation finished.
      </div>
    `);
  }
}

function startLiveNavigation(type = 'safe') {
  const feature = getRouteFeature(type);
  if (!feature?.geometry?.coordinates?.length) {
    showToast('No route available for live navigation.');
    return;
  }
  if (!navigator.geolocation) {
    showToast('Geolocation is not supported on this browser/device.');
    return;
  }

  const coords = feature.geometry.coordinates;
  _liveRouteType = type;
  _liveRouteCoords = coords;
  _liveRouteSteps = feature.properties?.steps || [];
  _liveRouteMode = feature.properties?.travel_mode || lastRoutePayload?.mode || 'walk';
  _liveRouteTotalM = routeLengthMeters(coords);

  if (_navWatchId !== null) stopLiveNavigation(true);

  showToast('Requesting location permission for live navigation...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      updateLiveNavigation(pos);
      _navWatchId = navigator.geolocation.watchPosition(
        updateLiveNavigation,
        () => {
          showToast('Could not read live location updates.');
          stopLiveNavigation(true);
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
      );
      showToast(`Live navigation started for ${type} route.`);
    },
    () => {
      showToast('Location permission denied. Enable it to use live navigation.');
      stopLiveNavigation(true);
    },
    { enableHighAccuracy: true, timeout: 12000 }
  );
}

function getSavedRoutes() {
  try {
    return JSON.parse(localStorage.getItem(LS_SAVED_ROUTES) || '[]');
  } catch {
    return [];
  }
}

function setSavedRoutes(routes) {
  localStorage.setItem(LS_SAVED_ROUTES, JSON.stringify(routes));
}

function saveCurrentRoute(type) {
  if (!lastRoutePayload?.data) return;
  const feature = (lastRoutePayload.data.features || []).find((f) => f.properties?.route_type === type);
  if (!feature?.geometry?.coordinates?.length) {
    showToast('No route to save yet.');
    return;
  }

  const routes = getSavedRoutes();
  routes.unshift({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    created_at: new Date().toISOString(),
    type,
    mode: lastRoutePayload.mode,
    origin: lastRoutePayload.origin,
    destination: lastRoutePayload.destination,
    coordinates: feature.geometry.coordinates,
    seen_issue_ids: [],
  });
  if (routes.length > 10) routes.length = 10;
  setSavedRoutes(routes);
  showToast(`Saved ${type} route for quick alerts.`);
}

async function checkSavedRouteAlerts() {
  const routes = getSavedRoutes();
  if (!routes.length) return;

  try {
    const res = await fetch(`${API_BASE}/issues`);
    const issues = await res.json();
    if (!Array.isArray(issues)) return;

    let changed = false;
    for (const route of routes) {
      const seen = new Set(route.seen_issue_ids || []);
      const nearNew = [];
      for (const issue of issues) {
        const coords = route.coordinates || [];
        let isNear = false;
        for (const p of coords) {
          const d = metersBetween(issue.lat, issue.lon, p[1], p[0]);
          if (d <= 50) {
            isNear = true;
            break;
          }
        }
        if (isNear && !seen.has(issue.id)) nearNew.push(issue.id);
      }

      if (nearNew.length) {
        nearNew.forEach((id) => seen.add(id));
        route.seen_issue_ids = Array.from(seen);
        changed = true;
        showToast(`New issue(s) near saved ${route.type} route: ${nearNew.length}`);
      }
    }

    if (changed) setSavedRoutes(routes);
  } catch {}
}

function heatColor(intensity) {
  if (intensity >= 0.75) return '#d73027';
  if (intensity >= 0.5) return '#fc8d59';
  if (intensity >= 0.25) return '#fee08b';
  return '#91cf60';
}

async function loadHeatmap() {
  const bounds = map.getBounds();
  const url = `${API_BASE}/issues/heatmap?lat_min=${bounds.getSouth()}&lat_max=${bounds.getNorth()}&lon_min=${bounds.getWest()}&lon_max=${bounds.getEast()}&cell_size=0.005`;
  const res = await fetch(url);
  const data = await res.json();

  if (heatmapLayer) map.removeLayer(heatmapLayer);
  heatmapLayer = L.geoJSON(data, {
    style: (feature) => {
      const i = feature?.properties?.intensity ?? 0;
      return {
        color: '#555',
        weight: 0.5,
        fillColor: heatColor(i),
        fillOpacity: Math.max(0.18, i * 0.55),
      };
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties || {};
      layer.bindPopup(`
        <b>Area Safety Density</b><br>
        Active issues: ${p.issue_count ?? 0}<br>
        Avg confidence: ${p.avg_effective_confidence ?? 0}
      `);
    },
  }).addTo(map);
}

async function toggleHeatmap(on) {
  if (!on) {
    if (heatmapLayer) {
      map.removeLayer(heatmapLayer);
      heatmapLayer = null;
    }
    return;
  }
  try {
    await loadHeatmap();
  } catch {
    showToast('Unable to load heatmap right now.');
  }
}

function isAmbiguousIssue(issue) {
  if (!issue) return false;
  return (issue.effective_confidence ?? 0) <= 55;
}

function enableIssueMode() {
  if (!currentUser) {
    showToast('Please login to report issues.');
    setTimeout(() => (window.location.href = 'login.html'), 1200);
    return;
  }
  issueMode = true;
  showToast('Click on the map to place the issue marker.');
  map.getContainer().style.cursor = 'crosshair';
}

map.on('click', function (e) {
  if (!issueMode) return;
  issueMode = false;
  map.getContainer().style.cursor = '';

  const { lat, lng } = e.latlng;
  L.popup()
    .setLatLng(e.latlng)
    .setContent(`
      <div style="min-width:200px">
        <b style="font-size:14px">Report Issue</b><br><br>
        <label style="font-size:12px;color:#555">Category</label><br>
        <select id="issue-category" style="width:100%;padding:5px;margin-bottom:8px;border-radius:5px;border:1px solid #ddd">
          <option>Broken Streetlight</option>
          <option>Pothole</option>
          <option>Narrow Lane</option>
          <option>Unsafe Area</option>
          <option>Other</option>
        </select><br>
        <label style="font-size:12px;color:#555">Description (optional)</label><br>
        <input id="issue-desc" placeholder="Brief description..." style="width:100%;padding:5px;margin-bottom:10px;border-radius:5px;border:1px solid #ddd;font-size:13px"/><br>
        <button onclick="submitIssue(${lat}, ${lng})" style="width:100%;padding:8px;background:#e74c3c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px">Submit Report</button>
      </div>
    `)
    .openOn(map);
});

async function submitIssue(lat, lon) {
  const category = document.getElementById('issue-category')?.value || 'Other';
  const description = document.getElementById('issue-desc')?.value || '';

  try {
    const res = await fetch(`${API_BASE}/issues`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ lat, lon, category, description }),
    });

    if (res.status === 401) {
      showToast('Session expired. Please login again.');
      setTimeout(() => (window.location.href = 'login.html'), 1200);
      return;
    }

    if (!res.ok) {
      const err = await res.json();
      showToast(err.detail || 'Failed to submit issue.');
      return;
    }

    map.closePopup();
    showToast('Issue reported successfully!');

    if (lastRoutePayload) {
      // refresh current route so route-specific issues update
      getRoutesFromInput();
    }
    if (document.getElementById('toggle-heatmap')?.checked) loadHeatmap();
  } catch {
    showToast('Failed to submit. Is the backend running?');
  }
}

async function validateIssue(issueId, response) {
  try {
    const res = await fetch(`${API_BASE}/issues/${issueId}/validate`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ response }),
    });

    if (res.status === 401) {
      showToast('Session expired. Please login again.');
      setTimeout(() => (window.location.href = 'login.html'), 1200);
      return;
    }

    const data = await res.json();
    if (!res.ok) {
      showToast(data.detail || 'Validation failed.');
      return;
    }

    map.closePopup();
    const label = response === 'confirm' ? 'Confirmed' : 'Dismissed';
    showToast(`${label}. New confidence: ${Math.round(data.confidence_score)}`);

    if (lastRoutePayload) getRoutesFromInput();
    if (document.getElementById('toggle-heatmap')?.checked) loadHeatmap();
  } catch {
    showToast('Validation failed. Please try again.');
  }
}

function showValidationPopup(issueId, latlng) {
  if (!currentUser) return;
  L.popup()
    .setLatLng(latlng)
    .setContent(`
      <div style="min-width:190px">
        <b>Nearby Issue</b><br>Can you verify this issue?<br><br>
        <button onclick="validateIssue('${issueId}','confirm')" style="margin-right:8px;padding:6px 12px;background:#27ae60;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px">Still there</button>
        <button onclick="validateIssue('${issueId}','dismiss')" style="padding:6px 12px;background:#e74c3c;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:13px">Fixed / gone</button>
      </div>
    `)
    .openOn(map);
}

function stopPositionWatch() {
  if (_watchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(_watchId);
    _watchId = null;
  }
  stopLiveNavigation(true);
}

function startPositionWatch() {
  if (!navigator.geolocation || !trackingEnabled || !currentUser) return;

  stopPositionWatch();
  _watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!currentUser || !trackingEnabled || !issueClusterLayer) return;
      const userLatLng = L.latLng(pos.coords.latitude, pos.coords.longitude);

      issueClusterLayer.eachLayer((layer) => {
        if (!layer?.getLatLng) return;
        const issueId = layer._issueId;
        const meta = layer._issueMeta;
        if (!issueId || !isAmbiguousIssue(meta)) return;

        const dist = userLatLng.distanceTo(layer.getLatLng());
        if (dist < 70 && !shownValidationSet.has(issueId)) {
          shownValidationSet.add(issueId);
          showValidationPopup(issueId, layer.getLatLng());
        }
      });
    },
    null,
    { enableHighAccuracy: true, maximumAge: 10000 }
  );
}

function syncTrackingUI() {
  const toggle = document.getElementById('toggle-tracking');
  if (!toggle) return;
  toggle.checked = trackingEnabled;
  toggle.addEventListener('change', () => {
    trackingEnabled = !!toggle.checked;
    localStorage.setItem(LS_TRACKING_ENABLED, trackingEnabled ? '1' : '0');
    if (trackingEnabled) {
      showToast('Nearby issue prompts enabled.');
      startPositionWatch();
    } else {
      showToast('Nearby issue prompts disabled.');
      stopPositionWatch();
    }
  });
}

setInterval(async () => {
  if (!currentUser || !trackingEnabled || !navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const userLatLng = L.latLng(pos.coords.latitude, pos.coords.longitude);
    if (!issueClusterLayer) return;

    issueClusterLayer.eachLayer((layer) => {
      if (!layer?.getLatLng) return;
      const issueId = layer._issueId;
      const meta = layer._issueMeta;
      if (!issueId || !isAmbiguousIssue(meta)) return;
      const dist = userLatLng.distanceTo(layer.getLatLng());
      if (dist < 200 && !shownValidationSet.has(issueId)) {
        shownValidationSet.add(issueId);
        showValidationPopup(issueId, layer.getLatLng());
      }
    });
  });
}, 5 * 60 * 1000);

function selectMode(mode) {
  document.getElementById('mode').value = mode;
  document.querySelectorAll('.mode-pill').forEach((p) =>
    p.classList.toggle('active', p.dataset.mode === mode)
  );
}

function closeBottomSheet() {
  const el = document.getElementById('route-summary');
  if (el) el.classList.remove('sheet-open');
}

function wireControls() {
  const routeBtn = document.getElementById('btn-get-route');
  if (routeBtn) routeBtn.onclick = getRoutesFromInput;

  const heatToggle = document.getElementById('toggle-heatmap');
  if (heatToggle) {
    heatToggle.addEventListener('change', () => toggleHeatmap(heatToggle.checked));
  }

  map.on('moveend', () => {
    if (document.getElementById('toggle-heatmap')?.checked) loadHeatmap().catch(() => {});
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js?v=5');
  } catch {}
}

async function init() {
  currentUser = await verifyToken();
  updateNavbar(currentUser);

  wireControls();
  syncTrackingUI();

  restoreLastSearch();
  const fromShare = applyShareParamsIfAny();

  setupAutocomplete('originInput', (coords) => {
    originCoords = coords;
  });
  setupAutocomplete('destInput', (coords) => {
    destCoords = coords;
  });

  if (currentUser && trackingEnabled) startPositionWatch();

  await checkSavedRouteAlerts();
  registerServiceWorker();

  if (fromShare) getRoutesFromInput();
}

init();

