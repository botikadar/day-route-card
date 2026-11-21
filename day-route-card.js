/*
 * day-route-card: shows where a person was on a chosen day.
 * Draws the GPS route from Home Assistant's history, marks stops (stayed 10+ min) with times,
 * shows zones, and has a time slider to scrub through the day.
 *
 * type: custom:day-route-card
 * people:
 *   - name: Boti
 *     entity: device_tracker.botonds_iphone_v2
 *     color: "#3b82f6"
 *     activity: sensor.botonds_iphone_v2_activity   # optional: iOS Activity / Android Detected activity
 * zones: [zone.home, zone.lunii_24]    # optional, default: all zones
 * max_accuracy: 150                     # ignore GPS points less accurate than this (m)
 * stop_minutes: 10                      # min stay to count as a stop
 * stop_radius: 120                      # m
 * place_names: true                     # name stops outside zones (Photon/OpenStreetMap, Esri fallback)
 *                                       # click a name to pick from nearby places; saved per HA user
 */
const LEAFLET_VER = "1.9.4";
const LEAFLET_JS = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VER}/leaflet.js`;
const LEAFLET_CSS = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VER}/leaflet.css`;

let leafletPromise;
function loadLeaflet() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LEAFLET_JS;
      s.onload = () => resolve(window.L);
      s.onerror = () => reject(new Error("Could not load the map library"));
      document.head.appendChild(s);
    });
  }
  return leafletPromise;
}
let cssPromise;
function loadCss() {
  if (!cssPromise) cssPromise = fetch(LEAFLET_CSS).then((r) => r.text()).catch(() => "");
  return cssPromise;
}

function dist(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLa = (b[0] - a[0]) * toR, dLo = (b[1] - a[1]) * toR;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const pad = (n) => String(n).padStart(2, "0");
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function dur(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}


// ---- Place names for stops outside zones: Photon (OpenStreetMap) first, Esri as fallback ----
const PLACE_KEYS = ["shop", "amenity", "leisure", "tourism", "office", "healthcare", "craft", "building"];
const SKIP_VALUES = ["parking", "bicycle_parking", "parking_space", "parking_entrance", "bench", "waste_basket",
  "waste_disposal", "recycling", "vending_machine", "atm", "post_box", "telephone", "drinking_water",
  "charging_station", "motorcycle_parking", "shelter", "toilets", "yes", "house", "residential", "apartments"];
const nice = (v) => (v || "").replace(/_/g, " ");
let placeCache = null;
function cacheGet(k) {
  try { placeCache = placeCache || JSON.parse(localStorage.getItem("day-route-card-places") || "{}"); } catch (e) { placeCache = placeCache || {}; }
  return placeCache[k];
}
function cacheSet(k, v) {
  placeCache = placeCache || {};
  placeCache[k] = v;
  try { localStorage.setItem("day-route-card-places", JSON.stringify(placeCache)); } catch (e) { /* storage unavailable */ }
}
async function lookupPlace(ll) {
  const key = `${ll[0].toFixed(4)},${ll[1].toFixed(4)}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  let label = null;
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${ll[0]}&lon=${ll[1]}&limit=15&radius=0.12`);
    const feats = r.ok ? (await r.json()).features || [] : [];
    const pois = feats.filter((f) => f.properties.name && PLACE_KEYS.includes(f.properties.osm_key)
      && !SKIP_VALUES.includes(f.properties.osm_value))
      .map((f) => ({ f, d: dist(ll, [f.geometry.coordinates[1], f.geometry.coordinates[0]]) }))
      .sort((a, b) => a.d - b.d);
    if (pois.length && pois[0].d <= 120) {
      const pr = pois[0].f.properties;
      label = `${pr.name}${pr.osm_value && pr.osm_key !== "building" ? ` (${nice(pr.osm_value)})` : ""}`;
    } else {
      const addr = feats.find((f) => f.properties.street);
      if (addr) label = `${addr.properties.street}${addr.properties.housenumber ? " " + addr.properties.housenumber : ""}`;
    }
  } catch (e) { /* try Esri */ }
  if (!label) {
    try {
      const r = await fetch(`https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode?location=${ll[1]},${ll[0]}&f=json&langCode=en`);
      const a = r.ok ? (await r.json()).address : null;
      if (a) label = a.Addr_type === "POI" ? `${a.PlaceName}${a.Type ? ` (${a.Type.toLowerCase()})` : ""}` : (a.Address || a.Match_addr || null);
    } catch (e) { /* offline */ }
  }
  if (label) cacheSet(key, label);
  return label;
}

// Up to 5 named places near a point, nearest first, plus the street address (for the "correct it" menu).
async function lookupCandidates(ll) {
  const out = [];
  const add = (label, d) => { if (label && !out.some((o) => o.label === label)) out.push({ label, d }); };
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${ll[0]}&lon=${ll[1]}&limit=30&radius=0.2`);
    const feats = r.ok ? (await r.json()).features || [] : [];
    feats.filter((f) => f.properties.name && PLACE_KEYS.includes(f.properties.osm_key) && !SKIP_VALUES.includes(f.properties.osm_value))
      .map((f) => ({ f, d: dist(ll, [f.geometry.coordinates[1], f.geometry.coordinates[0]]) }))
      .sort((a, b) => a.d - b.d)
      .forEach(({ f, d }) => add(`${f.properties.name}${f.properties.osm_key !== "building" ? ` (${nice(f.properties.osm_value)})` : ""}`, d));
    const addr = feats.find((f) => f.properties.street);
    if (addr) add(`${addr.properties.street}${addr.properties.housenumber ? " " + addr.properties.housenumber : ""}`, null);
  } catch (e) { /* offline */ }
  try {
    // Esri nearby places (no key): a second source, merged with Photon's by distance.
    const dLat = 0.0014, dLon = 0.002;  // ~150 m box
    const ext = [ll[1] - dLon, ll[0] - dLat, ll[1] + dLon, ll[0] + dLat].join(",");
    const r = await fetch(`https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?category=POI&location=${ll[1]},${ll[0]}&searchExtent=${ext}&maxLocations=10&outFields=PlaceName,Type&langCode=en&f=json`);
    const cands = r.ok ? (await r.json()).candidates || [] : [];
    for (const c of cands) {
      const name = (c.attributes && c.attributes.PlaceName) || c.address;
      const type = c.attributes && c.attributes.Type;
      add(`${name}${type ? ` (${type.toLowerCase()})` : ""}`, dist(ll, [c.location.y, c.location.x]));
    }
  } catch (e) { /* ignore */ }
  const pois = out.filter((o) => o.d !== null).sort((a, b) => a.d - b.d).slice(0, 5);
  return [...pois, ...out.filter((o) => o.d === null)].slice(0, 6);
}
// ---- How someone moved: phone activity sensor first, speed as fallback ----
const MODES = {
  car: { icon: "🚗", label: "Vehicle", color: "#2563eb" },
  foot: { icon: "🚶", label: "On foot", color: "#16a34a" },
  bike: { icon: "🚲", label: "Bike", color: "#f59e0b" },
  move: { icon: "➡️", label: "Moving", color: "#9ca3af" },
};
const ACTIVITY = {  // iOS "Activity" and Android "Detected activity" states
  automotive: "car", in_vehicle: "car", walking: "foot", running: "foot", on_foot: "foot",
  cycling: "bike", on_bicycle: "bike",
};
function speedMode(m, ms) {
  if (ms <= 0) return null;
  const kmh = (m / 1000) / (ms / 3600000);
  if (kmh < 7) return "foot";
  if (kmh >= 25) return "car";
  return "move";
}

const USER_KEY = "day_route_card_places";
const MATCH_M = 75;

class DayRouteCard extends HTMLElement {
  setConfig(config) {
    if (!config.people || !config.people.length) throw new Error("Add at least one person under people:");
    this._config = { max_accuracy: 150, stop_minutes: 10, stop_radius: 120, place_names: true, ...config };
    this._person = 0;
    this._gen = 0;
    this._corr = null;
    this._day = isoDay(new Date());
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._built = false;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._built) this._build();
    if (first) {
      hass.callWS({ type: "frontend/get_user_data", key: USER_KEY })
        .then((r) => { this._corr = (r && r.value) || []; })
        .catch(() => { this._corr = []; })
        .finally(() => this._load());
    }
  }

  getCardSize() { return 10; }
  getGridOptions() { return { columns: "full", rows: 10, min_rows: 6 }; }

  async _build() {
    this._built = true;
    const css = await loadCss();
    const people = this._config.people.map((p, i) => `<option value="${i}">${p.name}</option>`).join("");
    this.shadowRoot.innerHTML = `
      <style>${css}
        ha-card { overflow: hidden; }
        .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 16px 8px; }
        .bar select, .bar input[type=date] { font: inherit; padding: 6px 8px; border-radius: 8px;
          border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .bar button { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--divider-color);
          background: var(--secondary-background-color); color: var(--primary-text-color); cursor: pointer; }
        .bar button:disabled { opacity: .4; cursor: default; }
        .sum { padding: 0 16px 8px; color: var(--secondary-text-color); font-size: 14px; }
        #map { height: 420px; }
        .slider { display: flex; align-items: center; gap: 10px; padding: 8px 16px; }
        .slider input { flex: 1; }
        .slider span { min-width: 3.2em; font-variant-numeric: tabular-nums; }
        ol { margin: 4px 0 12px; padding: 0 16px 0 40px; }
        li { padding: 3px 0; }
        li .t { font-variant-numeric: tabular-nums; color: var(--secondary-text-color); }
        li[data-i] { cursor: pointer; border-radius: 6px; padding: 4px 6px; margin-left: -6px; }
        li[data-i]:hover { background: var(--secondary-background-color); }
        li.sel { background: var(--secondary-background-color); outline: 2px solid var(--primary-color); }
        .trip { margin: 2px 0 6px -16px; padding: 4px 8px; font-size: 13px; border-left: 3px dotted var(--divider-color); color: var(--primary-text-color); list-style: none; }
        .g { color: var(--secondary-text-color); font-size: 12px; }
        .legend { display: flex; flex-wrap: wrap; gap: 12px; padding: 4px 16px 0; font-size: 12px; color: var(--secondary-text-color); }
        .legend i { display: inline-block; width: 14px; height: 4px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
        b.pick { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
        .menu { display: none; margin: 6px 0 4px; padding: 8px; border-radius: 10px;
          background: var(--card-background-color); border: 1px solid var(--divider-color); }
        .menu.open { display: flex; flex-direction: column; gap: 4px; }
        .menu .hint { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 2px; }
        .menu button { text-align: left; font: inherit; padding: 7px 10px; border-radius: 8px; cursor: pointer;
          border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); }
        .menu button span { float: right; color: var(--secondary-text-color); font-size: 12px; }
        .msg { padding: 24px 16px; color: var(--secondary-text-color); }
        .leaflet-container { background: var(--secondary-background-color); font: inherit; }
        .stopicon { background: var(--card-background-color); border: 2px solid; border-radius: 12px;
          font-size: 11px; font-weight: 600; text-align: center; line-height: 18px; color: var(--primary-text-color); }
      </style>
      <ha-card>
        <div class="bar">
          <select id="person">${people}</select>
          <button id="prev" title="Previous day">◀</button>
          <input type="date" id="day">
          <button id="next" title="Next day">▶</button>
          <button id="today">Today</button>
        </div>
        <div class="sum" id="sum"></div>
        <div id="map"></div>
        <div class="slider"><input type="range" id="slide" min="0" max="0" value="0" disabled><span id="slidet">–</span></div>
        <div id="list"></div>
      </ha-card>`;
    const $ = (id) => this.shadowRoot.getElementById(id);
    this.$ = $;
    $("person").addEventListener("change", (e) => { this._person = +e.target.value; this._load(); });
    $("day").value = this._day;
    $("day").max = isoDay(new Date());
    $("day").addEventListener("change", (e) => { if (e.target.value) { this._day = e.target.value; this._load(); } });
    $("prev").addEventListener("click", () => this._shift(-1));
    $("next").addEventListener("click", () => this._shift(1));
    $("today").addEventListener("click", () => { this._day = isoDay(new Date()); this._load(); });
    $("slide").addEventListener("input", (e) => this._scrub(+e.target.value));
    const L = await loadLeaflet();
    this._map = L.map($("map"), { zoomControl: true, attributionControl: true }).setView([46.77, 23.59], 12);
    // Esri World Street Map: no API key and no Referer needed. (CARTO now wants an API key, and
    // OpenStreetMap answers 403 because Home Assistant pages send no Referer.) Override with tile_url.
    L.tileLayer(this._config.tile_url || "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, maxNativeZoom: 18, referrerPolicy: "strict-origin-when-cross-origin",
      attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    }).addTo(this._map);
    this._layer = L.layerGroup().addTo(this._map);
    new ResizeObserver(() => this._map && this._map.invalidateSize()).observe($("map"));
    if (this._hass) this._load();
  }

  _shift(days) {
    const d = new Date(this._day + "T12:00:00");
    d.setDate(d.getDate() + days);
    if (isoDay(d) > isoDay(new Date())) return;
    this._day = isoDay(d);
    this._load();
  }

  async _load() {
    if (!this._hass || !this.$ || !this._map) return;
    const $ = this.$;
    $("day").value = this._day;
    $("next").disabled = this._day >= isoDay(new Date());
    const p = this._config.people[this._person];
    const start = new Date(this._day + "T00:00:00");
    const end = new Date(start); end.setDate(end.getDate() + 1);
    $("sum").textContent = "Loading…";
    let rows = [];
    try {
      const res = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: [p.entity, ...(p.activity ? [p.activity] : [])], minimal_response: false, no_attributes: false,
        significant_changes_only: false,
      });
      rows = res[p.entity] || [];
      this._act = (p.activity && res[p.activity] || [])
        .map((r) => ({ t: new Date((r.lu || r.lc) * 1000), mode: ACTIVITY[String(r.s).toLowerCase()] || null }))
        .sort((a, b) => a.t - b.t);
    } catch (e) {
      $("sum").textContent = `Could not read history: ${e.message || e}`;
      return;
    }
    let lastAttr = {};
    const pts = [];
    for (const r of rows) {
      const a = r.a || lastAttr; lastAttr = a;
      const t = new Date(((r.lu || r.lc) * 1000));
      if (typeof a.latitude !== "number" || typeof a.longitude !== "number") continue;
      if (a.gps_accuracy && a.gps_accuracy > this._config.max_accuracy) continue;
      if (t < start || t >= end) continue;
      pts.push({ t, ll: [a.latitude, a.longitude], zone: r.s });
    }
    this._render(p, pts, start);
  }

  _actAt(t) {
    let m = null;
    for (const a of this._act || []) { if (a.t <= t) m = a.mode; else break; }
    return m;
  }

  // One mode per GPS segment; source is "phone" (activity sensor) or "speed".
  _segments(pts) {
    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], m = dist(a.ll, b.ll), ms = b.t - a.t;
      if (m < 40) { segs.push({ a, b, m, mode: null }); continue; }
      const act = this._actAt(new Date((+a.t + +b.t) / 2)) || this._actAt(b.t);
      segs.push({ a, b, m, mode: act || speedMode(m, ms), src: act ? "phone" : "speed" });
    }
    return segs;
  }

  _trip(segs, from, to) {
    const part = segs.filter((g) => g.a.t >= from && g.b.t <= to && g.mode);
    if (!part.length) return null;
    const byMode = {};
    let m = 0, phone = 0;
    for (const g of part) { byMode[g.mode] = (byMode[g.mode] || 0) + g.m; m += g.m; if (g.src === "phone") phone += g.m; }
    if (m < 150) return null;
    const ranked = Object.entries(byMode).sort((x, y) => y[1] - x[1]);
    const main = ranked[0][0];
    const mixed = ranked.length > 1 && ranked[1][1] > 0.25 * m ? ranked[1][0] : null;
    return { mode: main, mixed, m, from: part[0].a.t, to: part[part.length - 1].b.t, guessed: phone < m / 2 };
  }

  _zones() {
    const want = this._config.zones;
    return Object.values(this._hass.states).filter((s) => s.entity_id.startsWith("zone.") &&
      (!want || want.includes(s.entity_id)) && !s.attributes.passive && s.attributes.latitude != null);
  }

  _stops(pts) {
    const out = [];
    let i = 0;
    while (i < pts.length) {
      let j = i;
      while (j + 1 < pts.length && dist(pts[i].ll, pts[j + 1].ll) <= this._config.stop_radius) j++;
      const ms = pts[j].t - pts[i].t;
      if (ms >= this._config.stop_minutes * 60000 || (i === 0 && j > i) || (j === pts.length - 1 && j > i)) {
        const lat = pts.slice(i, j + 1).reduce((s, p) => s + p.ll[0], 0) / (j - i + 1);
        const lon = pts.slice(i, j + 1).reduce((s, p) => s + p.ll[1], 0) / (j - i + 1);
        out.push({ from: pts[i].t, to: pts[j].t, ll: [lat, lon], zone: pts[j].zone });
        i = j + 1;
      } else i++;
    }
    return out;
  }

  _zoneName(state, ll) {
    if (state === "home") return "Home";
    const z = this._hass.states[`zone.${state}`];
    if (z) return z.attributes.friendly_name;
    for (const zz of this._zones()) {
      if (dist(ll, [zz.attributes.latitude, zz.attributes.longitude]) <= (zz.attributes.radius || 100) + 50)
        return zz.attributes.friendly_name;
    }
    return null;
  }

  _render(p, pts, dayStart) {
    const L = window.L, $ = this.$, color = p.color || "#3b82f6";
    this._layer.clearLayers();
    for (const z of this._zones()) {
      L.circle([z.attributes.latitude, z.attributes.longitude], {
        radius: z.attributes.radius || 100, color: "#ff9800", weight: 1, fillOpacity: 0.12,
      }).bindTooltip(z.attributes.friendly_name).addTo(this._layer);
    }
    this._pts = pts;
    const slide = $("slide");
    if (!pts.length) {
      $("sum").textContent = `No location history for ${p.name} on this day.`;
      $("list").innerHTML = `<div class="msg">Home Assistant keeps location history for the last 7 days. Days before that, or days when the phone sent no location, show nothing.</div>`;
      slide.disabled = true; $("slidet").textContent = "–";
      return;
    }
    let km = 0;
    for (let i = 1; i < pts.length; i++) km += dist(pts[i - 1].ll, pts[i].ll);
    const segs = this._segments(pts);
    let run = null;
    const flush = () => {
      if (!run) return;
      const st = run.mode ? { color: MODES[run.mode].color, weight: 5, opacity: 0.85 } : { color, weight: 2, opacity: 0.5, dashArray: "4 6" };
      L.polyline(run.lls, st).bindTooltip(run.mode ? MODES[run.mode].label : "Short move / GPS jitter").addTo(this._layer);
      run = null;
    };
    for (const g of segs) {
      if (!run || run.mode !== g.mode) { flush(); run = { mode: g.mode, lls: [g.a.ll] }; }
      run.lls.push(g.b.ll);
    }
    flush();
    for (const x of pts) L.circleMarker(x.ll, { radius: 3, color, weight: 1, fillOpacity: 1 })
      .bindTooltip(hm(x.t)).addTo(this._layer);
    const stops = this._stops(pts);
    stops.forEach((s, i) => {
      const name = this._zoneName(s.zone, s.ll);
      const icon = L.divIcon({ className: "", html: `<div class="stopicon" style="border-color:${color};width:22px;height:18px">${i + 1}</div>`, iconSize: [26, 22], iconAnchor: [13, 11] });
      s.name = name;
      s.marker = L.marker(s.ll, { icon }).bindTooltip(`${i + 1}. ${name || "Stop"} · ${hm(s.from)}–${hm(s.to)}`).addTo(this._layer);
    });
    this._cursor = L.circleMarker(pts[pts.length - 1].ll, { radius: 8, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 }).addTo(this._layer);
    this._map.fitBounds(L.latLngBounds(pts.map((x) => x.ll)).pad(0.15), { maxZoom: 16 });
    slide.min = 0; slide.max = pts.length - 1; slide.value = pts.length - 1; slide.disabled = false;
    this._scrub(pts.length - 1);
    $("sum").textContent = `${p.name} · ${pts.length} location points · ${(km / 1000).toFixed(1)} km travelled · ${hm(pts[0].t)}–${hm(pts[pts.length - 1].t)}`;
    const tripHtml = (t) => t ? `<div class="trip"><span style="color:${MODES[t.mode].color}">${MODES[t.mode].icon}</span> ${MODES[t.mode].label}${t.mixed ? ` + ${MODES[t.mixed].label.toLowerCase()}` : ""} · <span class="t">${hm(t.from)}–${hm(t.to)}</span> · ${(t.m / 1000).toFixed(1)} km · ${dur(t.to - t.from)}${t.guessed ? ` <span class="g">(from speed)</span>` : ""}</div>` : "";
    const trips = stops.map((st, i) => i + 1 < stops.length ? this._trip(segs, st.to, stops[i + 1].from) : null);
    const legend = `<div class="legend">${["car", "foot", "bike", "move"].map((k) => `<span><i style="background:${MODES[k].color}"></i>${MODES[k].label}</span>`).join("")}${p.activity ? "" : `<span class="g">no activity sensor: guessed from speed</span>`}</div>`;
    $("list").innerHTML = legend + (stops.length
      ? `<ol>${stops.map((s, i) => `<li data-i="${i}" title="Show on map"><span class="t">${hm(s.from)}–${hm(s.to)}</span> · <b id="pl${i}" class="${s.name ? "" : "pick"}">${s.name || (this._config.place_names ? "Stop (looking up…)" : "Stop")}</b><div class="menu" id="menu${i}"></div> · ${dur(s.to - s.from)}</li>${tripHtml(trips[i])}`).join("")}</ol>`
      : `<div class="msg">No stops of ${this._config.stop_minutes}+ minutes.</div>${tripHtml(this._trip(segs, pts[0].t, pts[pts.length - 1].t))}`);
    this._stopsShown = stops;
    this.$("list").querySelectorAll("li[data-i]").forEach((li) =>
      li.addEventListener("click", () => this._focusStop(+li.dataset.i)));
    this.$("list").querySelectorAll("b.pick").forEach((b) =>
      b.addEventListener("click", (e) => { e.stopPropagation(); this._openMenu(+b.id.slice(2)); }));
    if (this._config.place_names) this._names(stops, ++this._gen);
  }

  async _names(stops, gen) {
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (s.name) continue;
      const mine = this._myPlace(s.ll);
      const label = mine ? null : await lookupPlace(s.ll);
      if (gen !== this._gen) return;  // a different day/person was chosen meanwhile
      const text = mine ? `✓ ${mine}` : label ? `≈ ${label}` : "Stop";
      s.label = text;
      const el = this.$(`pl${i}`);
      if (el) el.textContent = text;
      s.marker.setTooltipContent(`${i + 1}. ${text} · ${hm(s.from)}–${hm(s.to)}`);
    }
  }

  _myPlace(ll) {
    let best = null;
    for (const c of this._corr || []) {
      const d = dist(ll, [c.lat, c.lon]);
      if (d <= MATCH_M && (!best || d < best.d)) best = { d, name: c.name };
    }
    return best && best.name;
  }

  async _saveCorr(ll, name) {
    let list = (this._corr || []).filter((c) => dist(ll, [c.lat, c.lon]) > MATCH_M);
    if (name) list = [...list, { lat: +ll[0].toFixed(5), lon: +ll[1].toFixed(5), name }];
    this._corr = list;
    try {
      await this._hass.callWS({ type: "frontend/set_user_data", key: USER_KEY, value: list });
    } catch (e) { /* kept for this session only */ }
  }

  async _openMenu(i) {
    const s = this._stopsShown && this._stopsShown[i];
    const menu = this.$(`menu${i}`);
    if (!s || !menu) return;
    if (menu.classList.contains("open")) { menu.classList.remove("open"); return; }
    this.shadowRoot.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
    menu.classList.add("open");
    menu.innerHTML = `<div class="hint">Looking for places nearby…</div>`;
    const cands = await lookupCandidates(s.ll);
    const mine = this._myPlace(s.ll);
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    menu.innerHTML = `<div class="hint">Which place was it? Your choice is remembered for this spot.</div>`
      + cands.map((c, k) => `<button data-k="${k}">${esc(c.label)}${c.d !== null ? ` <span>${Math.round(c.d)} m</span>` : ""}</button>`).join("")
      + `<button data-k="custom">✏️ Type a name…</button>`
      + (mine ? `<button data-k="clear">↺ Forget my name for this spot</button>` : "");
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", async () => {
      const k = btn.dataset.k;
      let name = null;
      if (k === "custom") {
        name = (window.prompt("Name for this place", (mine || "").trim()) || "").trim();
        if (!name) return;
      } else if (k !== "clear") name = cands[+k].label;
      await this._saveCorr(s.ll, name);
      menu.classList.remove("open");
      this._load();  // re-label every stop near this spot
    }));
  }

  _focusStop(i) {
    const s = this._stopsShown && this._stopsShown[i];
    if (!s) return;
    this.$("list").querySelectorAll("li").forEach((li) => li.classList.toggle("sel", +li.dataset.i === i));
    this._map.flyTo(s.ll, Math.max(this._map.getZoom(), 17), { duration: 0.6 });
    s.marker.openTooltip();
    // move the time slider to the start of this stop
    const k = this._pts.findIndex((p) => p.t >= s.from);
    if (k >= 0) { this.$("slide").value = k; this._scrub(k); }
    this.$("map").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  _scrub(i) {
    const x = this._pts && this._pts[i];
    if (!x || !this._cursor) return;
    this._cursor.setLatLng(x.ll);
    this.$("slidet").textContent = hm(x.t);
  }
}

customElements.define("day-route-card", DayRouteCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: "day-route-card", name: "Day route", description: "Where a person was on a chosen day (route, stops, times)." });
