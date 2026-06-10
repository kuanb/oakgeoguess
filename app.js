/* ============================================================
   Oakland Geospy — Game Logic
   ============================================================

   SETUP:
   You need a Mapillary access token to fetch street-level images.
     1. Sign up at https://www.mapillary.com
     2. Go to https://www.mapillary.com/dashboard/developers
     3. Register a new application
     4. Copy the "Client Token" (starts with MLY| or similar)
     5. Paste it below as MAPILLARY_TOKEN

   The MapBox token is pre-configured.
   ============================================================ */

const CONFIG = {
  MAPILLARY_TOKEN: 'YOUR_MAPILLARY_ACCESS_TOKEN',

  MAPBOX_TOKEN: 'YOUR_MAPBOX_TOKEN',

  // Oakland city boundary box [west, south, east, north]
  OAKLAND_BBOX: [-122.355, 37.632, -122.114, 37.885],

  // Mapillary's bbox search limit is 0.01 degrees; we use a 0.009° box
  SEARCH_BOX_DEG: 0.009,

  MAX_TRIES: 8,

  // ~1 block in Oakland (meters)
  SUCCESS_DISTANCE_M: 160,

  // Max fetch attempts before giving up
  MAX_FETCH_ATTEMPTS: 20,
};

/* ============================================================
   STATE
   ============================================================ */
const S = {
  map: null,          // MapBox GL map (game)
  resultMap: null,    // MapBox GL map (result modal)
  viewer: null,       // MapillaryJS viewer
  image: null,        // { id, lat, lng }
  guessMarker: null,  // MapBox marker for current pin
  wrongMarkers: [],   // past wrong-guess markers kept on map
  guessLat: null,
  guessLng: null,
  triesLeft: CONFIG.MAX_TRIES,
  guesses: [],        // [{ lat, lng, distanceM }]
  wrongTryDots: 0,    // how many red dots to show
  gameOver: false,
};

/* ============================================================
   LOCAL STORAGE
   ============================================================ */
const STORAGE_KEY = 'oakland_geospy_v1';

function loadData() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { games: [] };
  } catch {
    return { games: [] };
  }
}

function persistGame(entry) {
  const data = loadData();
  data.games.unshift(entry);
  if (data.games.length > 300) data.games.length = 300;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/* ============================================================
   MAPILLARY API
   ============================================================ */
async function fetchRandomOaklandImage() {
  const [W, Sth, E, N] = CONFIG.OAKLAND_BBOX;
  const half = CONFIG.SEARCH_BOX_DEG / 2;

  for (let i = 0; i < CONFIG.MAX_FETCH_ATTEMPTS; i++) {
    // Random center point inside Oakland, with margin so bbox stays within city
    const cLon = W + half + Math.random() * (E - W - CONFIG.SEARCH_BOX_DEG);
    const cLat = Sth + half + Math.random() * (N - Sth - CONFIG.SEARCH_BOX_DEG);

    const bbox = [
      (cLon - half).toFixed(7),
      (cLat - half).toFixed(7),
      (cLon + half).toFixed(7),
      (cLat + half).toFixed(7),
    ].join(',');

    const url =
      `https://graph.mapillary.com/images` +
      `?access_token=${CONFIG.MAPILLARY_TOKEN}` +
      `&fields=id,geometry` +
      `&bbox=${bbox}` +
      `&limit=200`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // If token is bad, bail out immediately — no point retrying
        if (res.status === 401 || res.status === 403) {
          throw new Error('Invalid Mapillary token. Check CONFIG.MAPILLARY_TOKEN in app.js.');
        }
        continue;
      }
      const json = await res.json();
      const imgs = json.data || [];
      if (imgs.length > 0) {
        const img = imgs[Math.floor(Math.random() * imgs.length)];
        return {
          id: img.id,
          lng: img.geometry.coordinates[0],
          lat: img.geometry.coordinates[1],
        };
      }
    } catch (e) {
      if (e.message.startsWith('Invalid Mapillary')) throw e;
      console.warn(`Attempt ${i + 1} failed:`, e.message);
    }
  }
  throw new Error('Could not find an image in Oakland after multiple attempts. Try again.');
}

/* ============================================================
   DISTANCE & DIRECTION
   ============================================================ */
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

function directionHint(fromLat, fromLng, toLat, toLng) {
  const dLat = toLat - fromLat;
  const dLng = toLng - fromLng;
  const parts = [];
  if (Math.abs(dLat) > 0.0003) parts.push(dLat > 0 ? 'north' : 'south');
  if (Math.abs(dLng) > 0.0003) parts.push(dLng > 0 ? 'east' : 'west');
  return parts.length ? parts.join('-') : 'nearby';
}

/* ============================================================
   MAP INIT
   ============================================================ */
function initGameMap() {
  mapboxgl.accessToken = CONFIG.MAPBOX_TOKEN;

  S.map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [-122.226, 37.774],
    zoom: 11.5,
    maxBounds: [
      [CONFIG.OAKLAND_BBOX[0] - 0.08, CONFIG.OAKLAND_BBOX[1] - 0.08],
      [CONFIG.OAKLAND_BBOX[2] + 0.08, CONFIG.OAKLAND_BBOX[3] + 0.08],
    ],
  });

  // Remove Mapbox logo attribution for cleaner look (optional)
  S.map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

  S.map.on('click', onMapClick);
}

function onMapClick(e) {
  if (S.gameOver) return;

  S.guessLat = e.lngLat.lat;
  S.guessLng = e.lngLat.lng;

  if (S.guessMarker) {
    S.guessMarker.setLngLat([S.guessLng, S.guessLat]);
  } else {
    const el = document.createElement('div');
    el.className = 'guess-pin';
    S.guessMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom-left' })
      .setLngLat([S.guessLng, S.guessLat])
      .addTo(S.map);
  }

  document.getElementById('submit-btn').disabled = false;
  document.getElementById('map-hint').innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    Pin placed — click Submit or reposition
  `;
}

/* ============================================================
   VIEWER INIT
   ============================================================ */
function initOrMoveViewer(imageId) {
  if (S.viewer) {
    S.viewer.moveTo(imageId).catch(err => {
      console.warn('Viewer moveTo failed:', err);
      showViewerError();
    });
    return;
  }

  S.viewer = new mapillary.Viewer({
    accessToken: CONFIG.MAPILLARY_TOKEN,
    container: 'viewer',
    imageId,
    component: { cover: false, zoom: false },
  });

  S.viewer.on('error', (evt) => {
    console.warn('Viewer error:', evt);
    showViewerError();
  });
}

function showViewerError() {
  document.getElementById('viewer-error').classList.remove('hidden');
}

/* ============================================================
   GAME FLOW
   ============================================================ */
async function startRound() {
  showLoading(true, 'Finding a location in Oakland...');
  resetRoundUI();

  try {
    S.image = await fetchRandomOaklandImage();
    S.triesLeft = CONFIG.MAX_TRIES;
    S.wrongTryDots = 0;
    S.guesses = [];
    S.gameOver = false;

    updateTriesDots();
    document.getElementById('viewer-error').classList.add('hidden');
    initOrMoveViewer(S.image.id);
  } catch (err) {
    console.error(err);
    showLoading(false);
    showViewerError();
    document.getElementById('loading-screen').classList.add('hidden');
    return;
  }

  showLoading(false);
}

function resetRoundUI() {
  // Remove active guess pin
  if (S.guessMarker) { S.guessMarker.remove(); S.guessMarker = null; }
  // Remove all lingering wrong-guess pins
  S.wrongMarkers.forEach(m => m.remove());
  S.wrongMarkers = [];
  S.guessLat = null;
  S.guessLng = null;

  document.getElementById('submit-btn').disabled = true;
  document.getElementById('map-hint').innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
    Click anywhere in Oakland to drop a pin
  `;

  hideFeedback();
  clearResultLayers();

  if (S.map) {
    S.map.flyTo({ center: [-122.226, 37.774], zoom: 11.5, duration: 600 });
  }
}

function clearResultLayers() {
  if (!S.map) return;
  ['reveal-line', 'reveal-actual'].forEach(id => {
    if (S.map.getLayer(id)) S.map.removeLayer(id);
    if (S.map.getSource(id)) S.map.removeSource(id);
  });
}

/* ---- Tries dots ---- */
function updateTriesDots() {
  const container = document.getElementById('tries-dots');
  container.innerHTML = '';
  for (let i = 0; i < CONFIG.MAX_TRIES; i++) {
    const dot = document.createElement('div');
    if (i >= CONFIG.MAX_TRIES - S.wrongTryDots) {
      dot.className = 'try-dot wrong';
    } else if (i >= S.triesLeft) {
      dot.className = 'try-dot used';
    } else {
      dot.className = 'try-dot active';
    }
    container.appendChild(dot);
  }
}

/* ---- Feedback bar ---- */
function showFeedback(text, icon, type) {
  const el = document.getElementById('guess-feedback');
  const iconEl = document.getElementById('feedback-icon');
  const textEl = document.getElementById('feedback-text');
  el.className = `fb-${type}`;
  iconEl.textContent = icon;
  textEl.textContent = text;
}

function hideFeedback() {
  const el = document.getElementById('guess-feedback');
  el.className = 'hidden';
  document.getElementById('feedback-icon').textContent = '';
  document.getElementById('feedback-text').textContent = '';
}

/* ============================================================
   GUESS SUBMISSION
   ============================================================ */
function submitGuess() {
  if (S.guessLat === null || S.gameOver) return;

  const dist = haversineM(S.guessLat, S.guessLng, S.image.lat, S.image.lng);
  const triesUsed = CONFIG.MAX_TRIES - S.triesLeft + 1;

  S.guesses.push({ lat: S.guessLat, lng: S.guessLng, distanceM: dist });
  S.triesLeft--;
  S.wrongTryDots++;
  updateTriesDots();

  if (dist <= CONFIG.SUCCESS_DISTANCE_M) {
    // ---- WIN ----
    S.gameOver = true;
    S.wrongTryDots--; // last dot stays gold on win
    updateTriesDots();
    showFeedback(`You got it! Within ${fmtDist(dist)}.`, '🎯', 'success');

    persistGame({
      date: new Date().toISOString(),
      imageId: S.image.id,
      lat: S.image.lat,
      lng: S.image.lng,
      tries: triesUsed,
      success: true,
      skipped: false,
      bestDistanceM: dist,
    });

    setTimeout(() => showResultModal(true, dist, triesUsed), 900);

  } else if (S.triesLeft <= 0) {
    // ---- GAME OVER ----
    S.gameOver = true;
    showFeedback(`Out of tries! It was ${fmtDist(dist)} from your last guess.`, '😔', 'error');

    persistGame({
      date: new Date().toISOString(),
      imageId: S.image.id,
      lat: S.image.lat,
      lng: S.image.lng,
      tries: CONFIG.MAX_TRIES,
      success: false,
      skipped: false,
      bestDistanceM: Math.min(...S.guesses.map(g => g.distanceM)),
    });

    setTimeout(() => showResultModal(false, dist, CONFIG.MAX_TRIES), 900);

  } else {
    // ---- WRONG GUESS ----
    const dir = directionHint(S.guessLat, S.guessLng, S.image.lat, S.image.lng);
    const feedbackText = `${fmtDist(dist)} away — try heading ${dir}. (${S.triesLeft} tries left)`;
    showFeedback(feedbackText, '📍', 'error');

    // Convert active pin to a persistent wrong-guess marker with hover popup
    if (S.guessMarker) {
      const el = S.guessMarker.getElement();
      el.className = 'wrong-pin';

      const tryNum = triesUsed;
      const popupHTML = `
        <div class="gp-try">Try ${tryNum}</div>
        <div class="gp-dist">${fmtDist(dist)}</div>
        <div class="gp-dir">Head ${dir}</div>`;

      const popup = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: [0, -10],
        className: 'guess-popup',
      }).setHTML(popupHTML);

      const marker = S.guessMarker;
      el.addEventListener('mouseenter', () => popup.setLngLat(marker.getLngLat()).addTo(S.map));
      el.addEventListener('mouseleave', () => popup.remove());

      S.wrongMarkers.push(marker);
      S.guessMarker = null;
    }

    S.guessLat = null;
    S.guessLng = null;
    document.getElementById('submit-btn').disabled = true;
    document.getElementById('map-hint').innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
        <circle cx="12" cy="10" r="3"/>
      </svg>
      Try again — click to place a new pin
    `;
  }
}

function skipRound() {
  if (S.image) {
    persistGame({
      date: new Date().toISOString(),
      imageId: S.image.id,
      lat: S.image.lat,
      lng: S.image.lng,
      tries: 0,
      success: false,
      skipped: true,
      bestDistanceM: null,
    });
  }
  startRound();
}

/* ============================================================
   RESULT MODAL
   ============================================================ */
function showResultModal(win, lastDistM, triesUsed) {
  const modal = document.getElementById('result-modal');

  const iconWrap = document.getElementById('result-icon-wrap');
  const iconEl = document.getElementById('result-icon');
  const title = document.getElementById('result-title');
  const subtitle = document.getElementById('result-subtitle');

  iconWrap.className = win ? 'win' : 'loss';
  iconEl.textContent = win ? '🎯' : '😔';
  title.textContent = win ? 'You found it!' : 'Not quite…';
  title.className = win ? 'win' : 'loss';

  if (win) {
    subtitle.textContent = `Nailed it in ${triesUsed} ${triesUsed === 1 ? 'try' : 'tries'}!`;
  } else {
    const best = Math.min(...S.guesses.map(g => g.distanceM));
    subtitle.textContent = `Your closest guess was ${fmtDist(best)} away.`;
  }

  document.getElementById('result-distance').textContent = fmtDist(lastDistM);
  document.getElementById('result-tries').textContent = `${triesUsed} / ${CONFIG.MAX_TRIES}`;

  modal.classList.remove('hidden');

  // Build result map after modal is painted
  requestAnimationFrame(() => buildResultMap());
}

function buildResultMap() {
  if (S.resultMap) { S.resultMap.remove(); S.resultMap = null; }

  mapboxgl.accessToken = CONFIG.MAPBOX_TOKEN;

  const actual = S.image;
  const lastGuess = S.guesses[S.guesses.length - 1];

  S.resultMap = new mapboxgl.Map({
    container: 'result-map',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    center: [actual.lng, actual.lat],
    zoom: 14,
    interactive: false,
    attributionControl: false,
  });

  S.resultMap.on('load', () => {
    // Actual location — green pin
    new mapboxgl.Marker({ color: '#22c55e' })
      .setLngLat([actual.lng, actual.lat])
      .addTo(S.resultMap);

    if (lastGuess) {
      // Last guess — red pin
      new mapboxgl.Marker({ color: '#ef4444' })
        .setLngLat([lastGuess.lng, lastGuess.lat])
        .addTo(S.resultMap);

      // Dashed line guess → actual
      S.resultMap.addSource('result-line', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [lastGuess.lng, lastGuess.lat],
              [actual.lng, actual.lat],
            ],
          },
        },
      });
      S.resultMap.addLayer({
        id: 'result-line',
        type: 'line',
        source: 'result-line',
        paint: {
          'line-color': '#f59e0b',
          'line-width': 2,
          'line-dasharray': [2, 3],
        },
      });

      const bounds = new mapboxgl.LngLatBounds()
        .extend([lastGuess.lng, lastGuess.lat])
        .extend([actual.lng, actual.lat]);
      S.resultMap.fitBounds(bounds, { padding: 50, maxZoom: 16 });
    }
  });
}

/* ============================================================
   STATS MODAL
   ============================================================ */
function showStatsModal() {
  const { games } = loadData();

  const played = games.filter(g => !g.skipped);
  const wins   = played.filter(g => g.success);
  const total  = played.length;
  const rate   = total > 0 ? Math.round((wins.length / total) * 100) : 0;

  const avgTries = wins.length > 0
    ? (wins.reduce((s, g) => s + g.tries, 0) / wins.length).toFixed(1)
    : '—';

  // Current win streak (most recent non-skip games)
  let streak = 0;
  for (const g of games) {
    if (g.skipped) continue;
    if (g.success) streak++;
    else break;
  }

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-success-rate').textContent = `${rate}%`;
  document.getElementById('stat-avg-tries').textContent = avgTries;
  document.getElementById('stat-streak').textContent = streak;

  // Tries distribution bar chart
  const dist = document.getElementById('tries-distribution');
  if (wins.length > 0) {
    dist.classList.remove('hidden');
    const counts = Array(CONFIG.MAX_TRIES + 1).fill(0);
    wins.forEach(g => { if (g.tries <= CONFIG.MAX_TRIES) counts[g.tries]++; });
    const maxCount = Math.max(...counts);
    const barsEl = document.getElementById('tries-bars');
    barsEl.innerHTML = '';
    for (let t = 1; t <= CONFIG.MAX_TRIES; t++) {
      const c = counts[t];
      const pct = maxCount > 0 ? Math.round((c / maxCount) * 100) : 0;
      barsEl.innerHTML += `
        <div class="tries-bar-row">
          <span class="tries-bar-label">${t}</span>
          <div class="tries-bar-track">
            <div class="tries-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="tries-bar-count">${c}</span>
        </div>`;
    }
  } else {
    dist.classList.add('hidden');
  }

  // Recent games list
  const list = document.getElementById('games-list');
  const recent = games.slice(0, 30);

  if (recent.length === 0) {
    list.innerHTML = '<div class="no-games">No games yet — start playing!</div>';
  } else {
    list.innerHTML = recent.map(g => {
      const d = new Date(g.date);
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const dotCls = g.skipped ? 'skip' : (g.success ? 'win' : 'loss');
      const label = g.skipped
        ? 'Skipped'
        : g.success
          ? `Found in ${g.tries} ${g.tries === 1 ? 'try' : 'tries'}`
          : 'Not found';
      const meta = g.bestDistanceM != null ? fmtDist(g.bestDistanceM) : '';
      return `
        <div class="game-row">
          <div class="game-dot ${dotCls}"></div>
          <span class="game-date">${dateStr}</span>
          <span class="game-label">${label}</span>
          <span class="game-meta">${meta}</span>
        </div>`;
    }).join('');
  }

  document.getElementById('stats-modal').classList.remove('hidden');
}

/* ============================================================
   LOADING SCREEN
   ============================================================ */
function showLoading(visible, msg) {
  const el = document.getElementById('loading-screen');
  if (visible) {
    el.classList.remove('hidden', 'fade-out');
    if (msg) document.getElementById('loading-status').textContent = msg;
  } else {
    el.classList.add('fade-out');
    setTimeout(() => el.classList.add('hidden'), 500);
  }
}

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // Guard: token not configured
  if (!CONFIG.MAPILLARY_TOKEN) {
    console.error('Mapillary token not set');
    document.getElementById('loading-screen').innerHTML = `
      <div class="loading-content">
        <div class="loading-logo">
          <span class="logo-oak">OAK</span><span class="logo-land">LAND</span>
        </div>
        <p class="loading-tagline">GEOSPY</p>
        <p id="loading-status" style="color:#ef4444;margin-top:1rem">
          ⚠ Mapillary token not set
        </p>
        <p style="color:var(--text-1);font-size:0.78rem;margin-top:0.5rem;max-width:280px;line-height:1.5">
          Open <code style="color:var(--accent)">app.js</code> and set
          <code style="color:var(--accent)">CONFIG.MAPILLARY_TOKEN</code> to
          your Mapillary client access token.
        </p>
        <p style="color:var(--text-2);font-size:0.72rem;margin-top:0.75rem">
          Get one free at mapillary.com/dashboard/developers
        </p>
      </div>`;
    return;
  }

  // Initialize map
  initGameMap();

  // Wire buttons
  document.getElementById('submit-btn').addEventListener('click', submitGuess);
  document.getElementById('skip-btn').addEventListener('click', skipRound);
  document.getElementById('stats-btn').addEventListener('click', showStatsModal);
  document.getElementById('retry-load-btn').addEventListener('click', startRound);

  document.getElementById('next-round-btn').addEventListener('click', () => {
    document.getElementById('result-modal').classList.add('hidden');
    if (S.resultMap) { S.resultMap.remove(); S.resultMap = null; }
    startRound();
  });

  document.getElementById('close-stats-btn').addEventListener('click', () => {
    document.getElementById('stats-modal').classList.add('hidden');
  });

  // Close stats modal on backdrop click
  document.getElementById('stats-modal').addEventListener('click', e => {
    if (e.target.classList.contains('modal-backdrop')) {
      document.getElementById('stats-modal').classList.add('hidden');
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !document.getElementById('submit-btn').disabled) submitGuess();
    if (e.key === 'Escape') {
      document.getElementById('stats-modal').classList.add('hidden');
    }
  });

  // Start!
  startRound();
});
