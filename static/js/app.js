/* =========  App Logic - what to pull from the XLSX sheets to populate and name buttons =========
    - imagery CSV header: collection_location, ui_group, ui_label, service_type, url, default_on
    - archive CSV header: collection_location, collection_name, ui_group, ui_label_1, ui_label_2, filename, type
    - Uses sessionStorage for tab + layer state (survives refresh; cleared when browser tab closed)
 =================================*/

// ---------- Base path (works on GitHub Pages project sites) ----------
/**
 * When hosted at:
 *   - localhost:8000/ (dev)             -> base = "/"
 *   - https://<user>.github.io/<repo>/  -> base = "/<repo>/"
 *
 * We build all local asset URLs (static/, pdfjs/, etc.) relative to this base.
 */
const AIM_BASE_PATH = (() => {
  try {
    // Prefer an explicit <base href="..."> if present
    const baseEl = document.querySelector('base[href]');
    if (baseEl) {
      const href = baseEl.getAttribute('href') || './';
      const u = new URL(href, window.location.href);
      return u.pathname.endsWith('/') ? u.pathname : (u.pathname + '/');
    }

    // Otherwise, derive from current URL
    const u = new URL(window.location.href);
    const path = u.pathname;
    const base = path.endsWith('/') ? path : path.replace(/[^/]*$/, '');
    return base.endsWith('/') ? base : (base + '/');
  } catch (_) {
    return '/';
  }
})();

function aimJoinPath(basePath, relPath) {
  const b = String(basePath || '/');
  const r = String(relPath || '');
  return b.replace(/\/+$/, '/') + r.replace(/^\/+/, '');
}

function aimStaticUrl(relPath) {
  return aimJoinPath(AIM_BASE_PATH, aimJoinPath('static/', relPath));
}

// ---------- Map initiate ----------
const map = L.map('map', {zoomControl: true}).setView([45.9636, -66.6431], 12);
map.zoomControl.setPosition('topright'); // + / - buttons top-left

// overlay store: id -> layerObject
const overlays = {};      // created from CSV rows and some built-ins
const overlayMeta = {};   // metadata by ui_label

// z-order constants (best-effort for tile layers)
const Z = {OSM: 1, MOSAIC: 100, IMAGERY: 200, LABELS: 300, STREETS: 400};

// Add OSM as a layer
overlays['OSM'] = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {maxZoom: 22, attribution: '© OpenStreetMap contributors'}
);

// Always-on default basemap (will prevent gray/blank map if the overlays timeout)
overlays['OSM'].addTo(map);

L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
});


function cssSafeId(s) {
    return String(s || '').replace(/[^a-z0-9_\-]/gi, '_');
}

// Polyfill for CSS.escape (prevents script crash in some browsers)
if (typeof CSS === 'undefined' || typeof CSS.escape !== 'function') {
    window.CSS = window.CSS || {};
    CSS.escape = function (value) {
        return String(value).replace(/[^a-zA-Z0-9_\-]/g, function (ch) {
            return '\\' + ch;
        });
    };
}

// PDF opening view: default zoom + fit-to-width (reduces horizontal scrolling)
function withPdfView(url, zoomPct = 100) {
    const [base, frag] = String(url).split('#');

    // Try to make it behave like Acrobat "readable" default:
    // - FitH = fit horizontally (fit-to-width)
    // - zoom = fallback / some viewers use it
    // - navpanes=0 / pagemode=none try to reduce thumbnail sidebar where supported
    const add = `view=FitH&zoom=${zoomPct}&navpanes=0&pagemode=none`;

    return frag ? `${base}#${frag}&${add}` : `${base}#${add}`;
}

/**
 * Safe URL segment encoding:
 * - If segment is already encoded (contains %xx), decode then re-encode (prevents %2520 double-encoding)
 * - Otherwise encode normally
 */
function deepDecode(value, maxRounds = 3) {
    let out = String(value ?? '');
    for (let i = 0; i < maxRounds; i++) {
        try {
            const dec = decodeURIComponent(out);
            if (dec === out) break;
            out = dec;
        } catch (_) {
            break;
        }
    }
    return out;
}

function encSeg(seg) {
    // Normalize any pre-encoded (or double-encoded) strings coming from JSON or hard-coded paths.
    // Example: "Annual%2520Report.pdf" -> "Annual Report.pdf" -> encoded once as "Annual%20Report.pdf"
    const s = deepDecode(seg);
    return encodeURIComponent(s);
}


/**
 * Build a URL under /static/pdfs using safe segment encoding.
 * Example: pdfUrl(['1920s','Annual Report 1927.pdf'])
 */
function pdfUrl(pathSegments) {
  // IMPORTANT: return an UN-encoded path.
  // pdf.js will encode the URL when passing it as ?file=...
  const clean = (pathSegments || [])
    .map(s => deepDecode(String(s || '')))
    .join('/');
  return aimStaticUrl(`pdfs/${clean}`);
}



/* ================= Map address/place search (Esri geocoder) =================
   Requires: esri-leaflet-geocoder include within HTML
=============================================================== */
try {
    // Localize results to the Fredericton area as much as possible.
    // - useMapBounds at zoom >= 12 keeps the geocoder focused on what the user is looking at.
    // - searchBounds ensures results stay within a reasonable bounding box around Fredericton.
    const frederictonBounds = L.latLngBounds(
        [45.85, -66.78],
        [46.05, -66.48]
    );

    const searchControl = L.esri.Geocoding.geosearch({
        position: 'topleft',
        placeholder: 'Search address / place (Fredericton, NB)',
        useMapBounds: 12,
        searchBounds: frederictonBounds
    }).addTo(map);

    const resultsLayer = L.layerGroup().addTo(map);
    searchControl.on('results', (data) => {
        resultsLayer.clearLayers();
        if (data.results && data.results[0]) {
            const r = data.results[0];
            resultsLayer.addLayer(L.marker(r.latlng));
            map.setView(r.latlng, Math.max(map.getZoom(), 15));
        }
    });
} catch (e) {
    console.warn('Geocoder not available (missing esri-leaflet-geocoder include?)', e);
}

/* ================= Zoom-to-extent helpers ================= */

const _extentCache = new Map();

async function getServiceExtentLatLngBounds(mapServerUrl) {
    if (_extentCache.has(mapServerUrl)) return _extentCache.get(mapServerUrl);

    const url = mapServerUrl.replace(/\/+$/, '') + '?f=pjson';
    const r = await fetch(url);
    if (!r.ok) throw new Error(`extent fetch failed ${r.status}`);
    const j = await r.json();

    const ex = j.fullExtent || j.extent || j.initialExtent;
    if (!ex) throw new Error('no extent in service metadata');

    const wkid = ex.spatialReference && (ex.spatialReference.latestWkid || ex.spatialReference.wkid);

    let b;
    if (wkid === 4326) {
        b = L.latLngBounds([ex.ymin, ex.xmin], [ex.ymax, ex.xmax]);
    } else {
        // assume Web Mercator meters
        const sw = L.CRS.EPSG3857.unproject(L.point(ex.xmin, ex.ymin));
        const ne = L.CRS.EPSG3857.unproject(L.point(ex.xmax, ex.ymax));
        b = L.latLngBounds(sw, ne);
    }

    _extentCache.set(mapServerUrl, b);
    return b;
}

async function zoomToMosaicExtent(entry) {
    try {
        const bounds = await getServiceExtentLatLngBounds(entry.url);
        map.fitBounds(bounds, {padding: [20, 20]});
    } catch (e) {
        console.warn('Zoom-to-extent failed', e);
    }
}

/* ================= Floating Window Manager ================= */

function bringToFront(winEl) {
    const base = 10000;
    const wins = document.querySelectorAll('.floating-window');
    let maxZ = base;
    wins.forEach(w => {
        const z = parseInt(getComputedStyle(w).zIndex || base, 10);
        if (z > maxZ) maxZ = z;
    });
    winEl.style.zIndex = String(maxZ + 1);
}

function makeDraggable(winEl, handleEl, boundsEl) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;

    const onDown = (e) => {
        dragging = true;
        bringToFront(winEl);
        const rect = winEl.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
    };

    const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        const bounds = boundsEl.getBoundingClientRect();
        const w = winEl.getBoundingClientRect();

        let newLeft = startLeft + dx - bounds.left;
        let newTop = startTop + dy - bounds.top;

        const maxLeft = bounds.width - w.width;
        const maxTop = bounds.height - w.height - 30;
        newLeft = Math.max(0, Math.min(maxLeft, newLeft));
        newTop = Math.max(0, Math.min(maxTop, newTop));

        winEl.style.left = newLeft + 'px';
        winEl.style.top = newTop + 'px';
    };

    const onUp = () => {
        dragging = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };

    handleEl.addEventListener('mousedown', onDown);
}

function ensureDockVisible(dockEl) {
    dockEl.style.display = 'flex';
}

function maybeHideDock(dockEl) {
    if (dockEl.querySelectorAll('button').length === 0) {
        dockEl.style.display = 'none';
    }
}

function openFloatingWindow(opts) {
    // opts: { key, title, paneEl, dockEl, type: 'pdf'|'html', src, html }
    const {key, title, paneEl, dockEl, type} = opts;

    const existing = paneEl.querySelector(`.floating-window[data-key="${CSS.escape(key)}"]`);
    if (existing) {
        existing.style.display = 'flex';
        bringToFront(existing);
        const b = dockEl.querySelector(`button[data-key="${CSS.escape(key)}"]`);
        if (b) {
            b.remove();
            maybeHideDock(dockEl);
        }
        return existing;
    }

    const winEl = document.createElement('div');
    winEl.className = 'floating-window';
    winEl.dataset.key = key;

    const header = document.createElement('div');
    header.className = 'floating-header';

    const t = document.createElement('div');
    t.className = 'floating-title';
    t.textContent = title;

    const actions = document.createElement('div');
    actions.className = 'floating-actions';

    const minimizeBtn = document.createElement('button');
    minimizeBtn.textContent = '—';
    minimizeBtn.title = 'Minimize';

    const popBtn = document.createElement('button');
    popBtn.textContent = '↗';
    popBtn.title = 'Open in new tab';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';

    actions.appendChild(minimizeBtn);
    actions.appendChild(popBtn);
    actions.appendChild(closeBtn);

    header.appendChild(t);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'floating-body';

    if (type === 'pdf') {
        const iframe = document.createElement('iframe');
        iframe.src = opts.src;
        body.appendChild(iframe);
        popBtn.onclick = () => window.open(opts.src, '_blank');
    } else {
        body.innerHTML = opts.html || '<div class="sheet-wrap">No content.</div>';
        popBtn.onclick = () => {
            const blob = new Blob([`<!doctype html><meta charset="utf-8"><title>${title}</title>${body.innerHTML}`], {type: 'text/html'});
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        };
    }

    winEl.addEventListener('mousedown', () => bringToFront(winEl));
    makeDraggable(winEl, header, paneEl);

    closeBtn.onclick = () => {
        const b = dockEl.querySelector(`button[data-key="${CSS.escape(key)}"]`);
        if (b) b.remove();
        winEl.remove();
        maybeHideDock(dockEl);
    };

    minimizeBtn.onclick = () => {
        winEl.style.display = 'none';
        ensureDockVisible(dockEl);

        if (!dockEl.querySelector(`button[data-key="${CSS.escape(key)}"]`)) {
            const dockBtn = document.createElement('button');
            dockBtn.dataset.key = key;
            dockBtn.textContent = title;
            dockBtn.onclick = () => {
                winEl.style.display = 'flex';
                bringToFront(winEl);
                dockBtn.remove();
                maybeHideDock(dockEl);
            };
            dockEl.appendChild(dockBtn);
        }
    };

    winEl.appendChild(header);
    winEl.appendChild(body);

    const count = paneEl.querySelectorAll('.floating-window').length;
    winEl.style.left = (20 + (count * 18)) + 'px';
    winEl.style.top = (80 + (count * 18)) + 'px';

    paneEl.appendChild(winEl);
    bringToFront(winEl);
    return winEl;
}

/* ================= Mosaic: provenance + metadata ================= */

// XLSX (one file, metadata within tabs by year)
const MOSAIC_METADATA_XLSX_URL = aimStaticUrl('data/AIMFredericton_HAPMosaic_Metadata.xlsx');

// Provenance PDFs: AIMFredericton_HAPMosaic_Provenance_19XX.pdf
function mosaicProvenanceUrl(year) {
    return pdfUrl(['Provenance', 'Historical Mosaics', `AIMFredericton_HAPMosaic_Provenance_${year}.pdf`]);
  }

// Extract a 4-digit year from entry label/group (e.g., "1924" / "Mosaic 1924" / "1924 Mosaic")
function getYearFromEntry(entry) {
    const s = `${entry.ui_label || ''} ${entry.ui_group || ''}`;
    const m = s.match(/(19\d{2}|20\d{2})/);
    return m ? m[1] : null;
}

// XLSX cache
let _mosaicWorkbook = null;
let _mosaicWorkbookLoading = null;

async function loadMosaicWorkbook() {
    if (_mosaicWorkbook) return _mosaicWorkbook;
    if (_mosaicWorkbookLoading) return _mosaicWorkbookLoading;

    _mosaicWorkbookLoading = fetch(MOSAIC_METADATA_XLSX_URL)
        .then(r => {
            if (!r.ok) throw new Error(`Failed to load XLSX (${r.status})`);
            return r.arrayBuffer();
        })
        .then(buf => {
            const data = new Uint8Array(buf);
            _mosaicWorkbook = XLSX.read(data, {type: 'array'});
            return _mosaicWorkbook;
        })
        .catch(err => {
            _mosaicWorkbookLoading = null;
            throw err;
        });

    return _mosaicWorkbookLoading;
}

function renderSheetHtml(workbook, sheetName) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) {
        const available = (workbook.SheetNames || []).join(', ');
        return `<div class="sheet-wrap">
        <h3>Sheet not found: ${sheetName}</h3>
        <p>Available sheets: ${available || '(none)'}</p>
      </div>`;
    }
    const html = XLSX.utils.sheet_to_html(ws, {id: `sheet-${sheetName}`});
    return `<div class="sheet-wrap">${html}</div>`;
}

async function openMosaicMetadataWindow(year) {
    const leftPane = document.getElementById('left-pane');
    const dock = document.getElementById('map-window-dock');

    const key = `mosaic-meta-${year}`;
    const title = `Mosaic Metadata (${year})`;

    const winEl = openFloatingWindow({
        key, title,
        paneEl: leftPane,
        dockEl: dock,
        type: 'html',
        html: `<div class="sheet-wrap"><em>Loading metadata…</em></div>`
    });

    try {
        const wb = await loadMosaicWorkbook();
        const sheetName = String(year); // tab name is the year
        const html = renderSheetHtml(wb, sheetName);
        winEl.querySelector('.floating-body').innerHTML = html;
    } catch (e) {
        winEl.querySelector('.floating-body').innerHTML =
            `<div class="sheet-wrap"><h3>Could not load metadata</h3><pre>${String(e.message || e)}</pre></div>`;
    }
}

function openMosaicProvenanceWindow(year) {
    const leftPane = document.getElementById('left-pane');
    const dock = document.getElementById('map-window-dock');
    openFloatingWindow({
        key: `mosaic-prov-${year}`,
        title: `Mosaic Provenance (${year})`,
        paneEl: leftPane,
        dockEl: dock,
        type: 'pdf',
        src: AIM_PDF.buildPdfJsViewerUrl(mosaicProvenanceUrl(year), { zoom: 75, pagemode: 'none' }), // <-- default zoom
    });
}

// Create layer objects for an imagery CSV entry
function addLayerForEntry(entry) {
    const id = entry.ui_label;
    overlayMeta[id] = entry;
    const svc = String(entry.service_type || '').toLowerCase();

    // Tiled/MapServer tile layer (ArcGIS Tile/MapServer)
    if (svc === 'tiled' || svc === 'tiles') {
        try {
            const l = L.esri.tiledMapLayer({url: entry.url, maxZoom: 22});
            if (typeof l.setZIndex === 'function') l.setZIndex(Z.MOSAIC);
            overlays[id] = l;
            return l;
        } catch (e) {
            overlays[id] = L.layerGroup();
            return overlays[id];
        }
    }

    // Basemap entry (ESRI): can be a named basemap token (Imagery/ImageryLabels) or a MapServer URL
    if (svc === 'basemap') {
        const val = String(entry.url || '');
        if (/^https?:\/\//i.test(val)) {
            try {
                const l = L.esri.tiledMapLayer({url: val, maxZoom: 22});
                overlays[id] = l;
                return l;
            } catch (e) {
                overlays[id] = L.layerGroup();
                return overlays[id];
            }
        } else {
            try {
                const l = L.esri.basemapLayer(val);
                overlays[id] = l;
                return l;
            } catch (e) {
                overlays[id] = L.layerGroup();
                return overlays[id];
            }
        }
    }

    // hybrid: imagery + labels (explicit type)
    if (svc === 'hybrid') {
        try {
            const img = L.esri.basemapLayer('Imagery');
            const lbl = L.esri.basemapLayer('ImageryLabels');
            overlays[id] = {img, lbl};
            return overlays[id];
        } catch (e) {
            overlays[id] = L.layerGroup();
            return overlays[id];
        }
    }

    // vector-street (using mature basemap 'Streets' for now via basemapLayer to avoid API key)
    if (svc === 'vector-street') {
        try {
            const l = L.esri.basemapLayer('Streets');
            overlays[id] = l;
            return l;
        } catch (e) {
            overlays[id] = L.layerGroup();
            return overlays[id];
        }
    }

    // fallback
    overlays[id] = L.layerGroup();
    return overlays[id];
}

// Add layer to map (handles different object shapes)
function enableLayer(id) {
    const obj = overlays[id];
    if (!obj) return;

    if (obj.img && obj.lbl) {
        if (!map.hasLayer(obj.img)) obj.img.addTo(map);
        if (!map.hasLayer(obj.lbl)) obj.lbl.addTo(map);
        if (typeof obj.img.setZIndex === 'function') obj.img.setZIndex(Z.IMAGERY);
        return;
    }

    try {
        if (typeof obj.addTo === 'function') obj.addTo(map);
        if (id === 'Street Overlay' || (overlayMeta[id] && String(overlayMeta[id].service_type).toLowerCase() === 'vector-street')) {
            if (typeof obj.bringToFront === 'function') obj.bringToFront();
        }
    } catch (e) {
        if (obj && obj.layer && obj.layer.addTo) obj.layer.addTo(map);
    }
}

// Remove layer
function removeLayer(id) {
    const obj = overlays[id];
    if (!obj) return;
    if (obj.img && obj.lbl) {
        if (map.hasLayer(obj.img)) map.removeLayer(obj.img);
        if (map.hasLayer(obj.lbl)) map.removeLayer(obj.lbl);
        return;
    }
    try {
        if (typeof obj.remove === 'function') obj.remove();
        else if (typeof obj.removeLayer === 'function') obj.removeLayer();
        else if (map.hasLayer(obj)) map.removeLayer(obj);
    } catch (e) {
        for (const k in obj) {
            if (obj[k] && typeof obj[k].remove === 'function') obj[k].remove();
        }
    }
}

function setLayerOpacity(id, val) {
    const obj = overlays[id];
    if (!obj) return;
    if (obj.setOpacity) obj.setOpacity(val);
    else if (obj.img && obj.img.setOpacity) obj.img.setOpacity(val);
    else if (obj.lbl && obj.lbl.setOpacity) obj.lbl.setOpacity(val);
}

/* ---------------- Building of imagery UI ---------------- */
fetch('static/data/imagery.json').then(r => r.json()).then(rows => {
    // group by ui_group
    const grouped = {};
    rows.forEach(row => {
        const g = row.ui_group || 'ungrouped';
        if (!grouped[g]) grouped[g] = [];
        grouped[g].push(row);
        addLayerForEntry(row);
    });

    const container = document.getElementById('imagery-toggle');
    container.innerHTML = '';

    // 1) Street overlay at top (checkbox) - default ON
    const topList = document.createElement('ul');
    topList.style.marginBottom = '8px';

    const streetLi = document.createElement('li');
    const streetInput = document.createElement('input');
    streetInput.type = 'checkbox';
    streetInput.id = 'chk-street-overlay';
    streetInput.dataset.id = 'Street Overlay';
    streetInput.checked = true;

    const streetLabel = document.createElement('label');
    streetLabel.htmlFor = streetInput.id;
    streetLabel.textContent = ' Street Overlay (streets & names)';
    streetLi.appendChild(streetInput);
    streetLi.appendChild(streetLabel);
    topList.appendChild(streetLi);
    container.appendChild(topList);

    //  Transportation reference overlay (instead of basemap)
    overlays['Street Overlay'] = L.esri.tiledMapLayer({
        url: 'https://services.arcgisonline.com/arcgis/rest/services/Reference/World_Transportation/MapServer',
        pane: 'overlayPane'
    });
    enableLayer('Street Overlay');

    streetInput.addEventListener('change', (e) => {
        if (e.target.checked) enableLayer('Street Overlay');
        else removeLayer('Street Overlay');
        persistStateToSession();
    });

    // 2) OSM toggle near top
    const osmLi = document.createElement('li');
    const osmInput = document.createElement('input');
    osmInput.type = 'checkbox';
    osmInput.id = 'chk-osm';
    osmInput.dataset.id = 'OSM';
    const osmLabel = document.createElement('label');
    osmLabel.htmlFor = osmInput.id;
    osmLabel.textContent = ' OpenStreetMap (OSM)';
    osmLi.appendChild(osmInput);
    osmLi.appendChild(osmLabel);
    topList.appendChild(osmLi);

    osmInput.addEventListener('change', (e) => {
        if (e.target.checked) enableLayer('OSM'); else removeLayer('OSM');
        persistStateToSession();
    });

    // 3) iterate groups (decades)
    Object.keys(grouped).sort().forEach(group => {
        const gdiv = document.createElement('div');
        gdiv.className = 'year-group';
        const gtitle = document.createElement('div');
        gtitle.className = 'year-label';
        gtitle.textContent = group;
        gdiv.appendChild(gtitle);
        const ul = document.createElement('ul');

        grouped[group].forEach(entry => {
            const id = entry.ui_label;

            if (!overlays[id]) addLayerForEntry(entry);

            const li = document.createElement('li');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = `chk-${cssSafeId(id)}`;
            input.dataset.id = id;

            const def = String(entry.default_on || '').toLowerCase();
            if (def === 'true' || def === 'yes' || def === '1') input.checked = true;

            const label = document.createElement('label');
            label.htmlFor = input.id;
            label.textContent = ' ' + id;

            input.addEventListener('change', (ev) => {
                if (ev.target.checked) enableLayer(id); else removeLayer(id);

                // Keep slider visible; disable/dim when off
                const opEl = document.getElementById(`opacity-${cssSafeId(id)}`);
                if (opEl) {
                    opEl.disabled = !ev.target.checked;
                    opEl.style.opacity = ev.target.checked ? '1' : '0.45';
                }

                persistStateToSession();
            });

            li.appendChild(input);
            li.appendChild(label);

            // show opacity slider for raster / tiled layers (not for basemap names or vector-street)
            const svc = String(entry.service_type || '').toLowerCase();
            if (svc !== 'basemap' && svc !== 'vector-street') {
                const op = document.createElement('input');
                op.type = 'range';
                op.min = 0;
                op.max = 1;
                op.step = 0.05;
                op.value = 1;
                op.className = 'opacity-control';
                op.id = `opacity-${cssSafeId(id)}`;
                op.style.marginLeft = '8px';

                // init disabled/dim state
                op.disabled = !input.checked;
                op.style.opacity = input.checked ? '1' : '0.45';

                op.addEventListener('input', (e) => setLayerOpacity(id, Number(e.target.value)));
                li.appendChild(op);
            }

            /* Provenance + Metadata + Mosaic Extent buttons (for mosaics; year derived from label/group) */
            const year = getYearFromEntry(entry);
            if (year) {
                const mkBtn = (txt, title) => {
                    const b = document.createElement('button');
                    b.textContent = txt;
                    b.style.marginLeft = '6px';
                    b.style.padding = '3px 8px';
                    b.style.borderRadius = '6px';
                    b.style.border = '1px solid #666';
                    b.style.background = '#3a3a3a';
                    b.style.color = '#ddd';
                    b.style.cursor = 'pointer';
                    b.title = title;
                    return b;
                };

                const provBtn = mkBtn('Provenance', `Open provenance PDF for ${year}`);
                provBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openMosaicProvenanceWindow(year);
                });

                const metaBtn = mkBtn('Metadata', `Open metadata tab "${year}"`);
                metaBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openMosaicMetadataWindow(year);
                });

                const extentBtn = mkBtn('Mosaic Extent', 'Zoom to full mosaic extent');
                extentBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await zoomToMosaicExtent(entry);
                });

                // Requested: swap Mosaic Extent and Provenance button positions.
                li.appendChild(extentBtn);
                li.appendChild(metaBtn);
                li.appendChild(provBtn);
            }

            ul.appendChild(li);

            if (input.checked) setTimeout(() => enableLayer(id), 20);
        });

        gdiv.appendChild(ul);
        container.appendChild(gdiv);
    });

    // ensure default Imagery+Labels are on if CSV has entries that map to them:
    rows.forEach(entry => {
        const key = String(entry.ui_label || '');
        const urlVal = String(entry.url || '').toLowerCase();
        if (key.toLowerCase().includes('imagery') || urlVal.includes('imagery') || urlVal.includes('imagerylabels')) {
            const chk = document.querySelector(`#imagery-toggle input[data-id="${CSS.escape(key)}"]`) || document.getElementById(`chk-${cssSafeId(key)}`);
            if (chk && !chk.checked) {
                chk.checked = true;
                chk.dispatchEvent(new Event('change', {bubbles: true}));
            }
        }
    });

    // restore session state if present (sessionStorage)
    restoreStateFromSession();
}).catch(err => {
    console.error('Failed to load /api/imagery:', err);
    document.getElementById('imagery-toggle').textContent = 'Failed to load imagery metadata.';
});

/* ---------------- PDF archive UI ---------------- */
const decadeSelect = document.getElementById('decade-select');
const pdfSelect = document.getElementById('pdf-select');
const openPdfTab = document.getElementById('open-pdf-tab');
const openPdfInApp = document.getElementById('open-pdf-in-app');
const pdfTabs = document.getElementById('pdf-tabs');
const pdfViewer = document.getElementById('pdf-viewer');

// Chrome/Edge sometimes ignore #view/#zoom on first iframe load.
// This forces a single re-apply of the fragment once the iframe finishes loading.
if (pdfViewer) {
    pdfViewer.addEventListener('load', () => {
        try {
            const src = pdfViewer.getAttribute('src') || '';
            if (!src) return;

            // prevent loops
            if (pdfViewer.dataset.appliedOnce === src) return;

            // If it already has view/zoom params, mark and stop.
            if (src.includes('view=') && src.includes('zoom=')) {
                pdfViewer.dataset.appliedOnce = src;
                return;
            }

            // Re-apply our params once
            const fixed = withPdfView(src, 75);
            pdfViewer.dataset.appliedOnce = fixed;
            pdfViewer.setAttribute('src', fixed);
        } catch (_) {
        }
    });
}


let archiveData = {}; // mapping decade => rows array
let openPdfs = {};       // tabKey -> { tab, url, label, filename }
let activePdfKey = null; // currently active tabKey



function findArchiveRowByFilename(filename) {
    const fname = String(filename || '').trim();
    if (!fname) return null;
    for (const dec of Object.keys(archiveData)) {
        const hit = (archiveData[dec] || []).find(r => String(r.filename || '').trim() === fname);
        if (hit) return hit;
    }
    return null;
}

function findArchiveRow(decade, filename) {
    const list = (decade && archiveData[decade]) ? archiveData[decade] : [];
    return list.find(r => r.filename === filename) || null;
}


// (Find text button removed from the outer app toolbar; PDF.js has an always-visible search field.)

// load archive list
fetch('static/data/archive.json').then(r => r.json()).then(rows => {
    rows.forEach(r => {
        const d = r.ui_group || 'unknown';
        if (!archiveData[d]) archiveData[d] = [];
        archiveData[d].push(r);
    });
    // populate decades
    Object.keys(archiveData).sort().forEach(dec => {
        const opt = document.createElement('option');
        opt.value = dec;
        opt.textContent = dec;
        decadeSelect.appendChild(opt);
    });

    // restore open tabs (if any) AFTER archiveData has loaded
    restoreStateFromSession();
}).catch(err => {
    console.error('Failed to load /api/archive:', err);
});

function populatePdfSelect(decade) {
    pdfSelect.innerHTML = '<option value="">-- Select document --</option>';
    pdfSelect.disabled = true;
    openPdfTab.disabled = true;
    openPdfInApp.disabled = true;
    if (!decade || !archiveData[decade]) return;

    const list = archiveData[decade].slice().sort((a, b) => ((a.ui_label_2 || '').localeCompare(b.ui_label_2 || '')));
    list.forEach(doc => {
        let ui1 = (doc.ui_label_1 || '').trim();
        const ui2 = (doc.ui_label_2 || '').trim();

        // Drop the leading term "searchable" from ui_label_1 (catalog cleanup).
        ui1 = ui1.replace(/^searchable\s+/i, '').trim();

        // Document dropdown label: ui_label_1 + ui_label_2 ONLY.
        // (No filenames shown in the UI.)
        const label = (ui1 && ui2) ? `${ui1} ${ui2}`.replace(/\s+/g,' ').trim() : (ui1 || ui2 || '');

        const opt = document.createElement('option');
        opt.value = doc.filename;
        opt.textContent = label || 'Untitled document';
        // Store the actual decade key we are currently populating.
        opt.dataset.decade = decade;
        pdfSelect.appendChild(opt);
    });
    pdfSelect.disabled = false;
}

decadeSelect.addEventListener('change', () => populatePdfSelect(decadeSelect.value));

pdfSelect.addEventListener('change', () => {
    const has = pdfSelect.value !== '';
    openPdfTab.disabled = !has;
    openPdfInApp.disabled = !has;
});

openPdfTab.addEventListener('click', () => {
    const filename = pdfSelect.value;
    const decade = pdfSelect.options[pdfSelect.selectedIndex].dataset.decade;
    const url = pdfUrl([decade, filename]);
    const row = findArchiveRow(decade, filename);
    const aimTitle = row ? String(row.ui_label_2 || '').trim() : '';
    window.open(AIM_PDF.buildPdfJsViewerUrl(url, { zoom: 75, pagemode: 'none', aimTitle }), '_blank');
});

openPdfInApp.addEventListener('click', () => {
    const filename = pdfSelect.value;
    const decade = pdfSelect.options[pdfSelect.selectedIndex].dataset.decade;
    const url = pdfUrl([decade, filename]);
    const row = findArchiveRow(decade, filename);
    const aimTitle = row ? String(row.ui_label_2 || '').trim() : '';
    openPdfInTab(filename, url, aimTitle);
});

function openPdfInTab(filename, url, aimTitle) {
    // allow duplicates: "file.pdf", "file.pdf (2)", "file.pdf (3)", ...
    const baseKey = filename;
    let tabKey = baseKey;
    let n = 2;
    while (openPdfs[tabKey]) {
        tabKey = `${baseKey} (${n})`;
        n++;
    }
    const label = (aimTitle && String(aimTitle).trim()) ? String(aimTitle).trim() : filename;
    // if duplicate, reflect it in the tab label too
    const displayLabel = (tabKey === baseKey) ? label : `${label} (${tabKey.match(/\((\d+)\)$/)?.[1] || ''})`;

    const tab = document.createElement('div');
    tab.className = 'tab';

    const spanLabel = document.createElement('span');
    spanLabel.textContent = displayLabel;

    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.className = 'close-btn';
    closeBtn.title = 'Close';

    closeBtn.onclick = (e) => {
        e.stopPropagation();
        closePdfTab(tabKey);
    };

    tab.appendChild(spanLabel);
    tab.appendChild(closeBtn);

    tab.onclick = () => activatePdfTab(tabKey);

    pdfTabs.appendChild(tab);

    openPdfs[tabKey] = {tab, url, label: displayLabel, filename, aimTitle: label};
    activatePdfTab(tabKey);
    persistStateToSession();
}

function closePdfTab(tabKey) {
    const entry = openPdfs[tabKey];
    if (!entry) return;

    entry.tab.remove();
    delete openPdfs[tabKey];

    // If we closed the active tab, switch or clear the viewer
    if (activePdfKey === tabKey) {
        const remainingKeys = Object.keys(openPdfs);
        if (remainingKeys.length) {
            activatePdfTab(remainingKeys[0]);
        } else {
            activePdfKey = null;
            if (pdfViewer) pdfViewer.src = '';
        }
    } else {
        // If there are no tabs left at all, clear anyway
        if (Object.keys(openPdfs).length === 0) {
            activePdfKey = null;
            if (pdfViewer) pdfViewer.src = '';
        }
    }

    persistStateToSession();
}


function activatePdfTab(tabKey) {
    if (!openPdfs[tabKey]) return;

    activePdfKey = tabKey;

    Object.values(openPdfs).forEach(o => o.tab.classList.remove('active'));
    openPdfs[tabKey].tab.classList.add('active');

    if (pdfViewer) {
        pdfViewer.src = AIM_PDF.buildPdfJsViewerUrl(openPdfs[tabKey].url, { zoom: 75, pagemode: 'none', aimTitle: openPdfs[tabKey].aimTitle });
    }
}


/* Engineering Reports collection provenance button */
const archiveProvBtn = document.getElementById('open-archive-provenance');
const ARCHIVE_COLLECTION_PROVENANCE_URL = pdfUrl(['Provenance', 'Historical Annual Engineering Reports', 'AIMFredericton_Historical Engineering Report Collection_Provenance.pdf']);

archiveProvBtn.addEventListener('click', () => {
    const rightPane = document.getElementById('right-pane');
    const dock = document.getElementById('doc-window-dock');
    openFloatingWindow({
        key: 'archive-collection-provenance',
        title: 'Engineering Reports Collection Provenance',
        paneEl: rightPane,
        dockEl: dock,
        type: 'pdf',
        src: AIM_PDF.buildPdfJsViewerUrl(ARCHIVE_COLLECTION_PROVENANCE_URL, { zoom: 75, pagemode: 'none', aimTitle: 'Collection Provenance' }) // <-- default zoom
    });
});

/* ---------------- Resizer between PDF and map spaces ---------------- */
(function setupResizer() {
    const resizer = document.getElementById('resizer-btn');
    const leftPane = document.getElementById('left-pane');
    const mapEl = document.getElementById('map');

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // disable map interactions during resize
        try {
            map.dragging.disable();
            map.scrollWheelZoom.disable();
            map.doubleClickZoom.disable();
            map.boxZoom.disable();
            map.keyboard.disable();
            if (map.tap) map.tap.disable();
        } catch (_) {
        }

        mapEl.style.pointerEvents = 'none';
        document.body.style.cursor = 'ew-resize';

        const onMouseMove = (ev) => {
            const mainEl = document.getElementById('main');
            const mainLeft = mainEl ? mainEl.getBoundingClientRect().left : 0;
            let newWidth = ev.clientX - mainLeft;
            const minLeft = 300, maxLeft = window.innerWidth - 200;
            if (newWidth < minLeft) newWidth = minLeft;
            if (newWidth > maxLeft) newWidth = maxLeft;
            leftPane.style.width = newWidth + 'px';
            map.invalidateSize();
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            document.body.style.cursor = '';
            mapEl.style.pointerEvents = '';

            // re-enable map interactions
            try {
                map.dragging.enable();
                map.scrollWheelZoom.enable();
                map.doubleClickZoom.enable();
                map.boxZoom.enable();
                map.keyboard.enable();
                if (map.tap) map.tap.enable();
            } catch (_) {
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
})();

/* ------------ Session Storage Persistence (sessionStorage) ------------ */

function persistStateToSession() {
    try {
        const state = {enabledLayers: [], openTabs: []};
        document.querySelectorAll('#imagery-toggle input[type="checkbox"]').forEach(inp => {
            const id = inp.dataset && inp.dataset.id ? inp.dataset.id : (inp.id === 'chk-street-overlay' ? 'Street Overlay' : null);
            if (id && inp.checked) state.enabledLayers.push(id);
        });
        for (const filename in openPdfs) {
            state.openTabs.push({filename, url: openPdfs[filename].url, label: openPdfs[filename].label, aimTitle: openPdfs[filename].aimTitle});
        }
        sessionStorage.setItem('aim_session', JSON.stringify(state));
    } catch (e) {
        console.warn('persistStateToSession failed', e);
    }
}

function restoreStateFromSession() {
    try {
        const raw = sessionStorage.getItem('aim_session');
        if (!raw) return;
        const state = JSON.parse(raw);

        if (state.enabledLayers && state.enabledLayers.length) {
            state.enabledLayers.forEach(id => {
                let inp = document.querySelector(`#imagery-toggle input[data-id="${CSS.escape(id)}"]`);
                if (!inp) inp = document.getElementById(`chk-${cssSafeId(id)}`);
                if (!inp && id === 'Street Overlay') inp = document.getElementById('chk-street-overlay');
                if (inp && !inp.checked) {
                    inp.checked = true;
                    inp.dispatchEvent(new Event('change', {bubbles: true}));
                }
            });
        }

        if (state.openTabs && state.openTabs.length) {
            state.openTabs.forEach(t => {
                if (!openPdfs[t.filename]) {
                    const tab = document.createElement('div');
                    tab.className = 'tab';
                    const spanLabel = document.createElement('span');
                    const baseFilename = String(t.filename || '').replace(/\s*\(\d+\)\s*$/,'').trim();
                    const row = findArchiveRowByFilename(baseFilename);
                    const restoredTitle = row ? String(row.ui_label_2 || '').trim() : (t.aimTitle || t.label || t.filename);
                    spanLabel.textContent = restoredTitle || t.filename;
                    const closeBtn = document.createElement('span');
                    closeBtn.textContent = '×';
                    closeBtn.className = 'close-btn';
                    closeBtn.title = 'Close';
                    closeBtn.onclick = (e) => {
                        e.stopPropagation();
                        tab.remove();
                        delete openPdfs[t.filename];
                        persistStateToSession();
                        if (pdfViewer.src && pdfViewer.src.includes(t.filename)) {
                            const next = Object.keys(openPdfs)[0];
                            if (next) activatePdfTab(next); else pdfViewer.src = '';
                        }
                    };
                    tab.appendChild(spanLabel);
                    tab.appendChild(closeBtn);
                    tab.onclick = () => {
                        activatePdfTab(t.filename);
                    };
                    pdfTabs.appendChild(tab);
                    const baseFilename2 = String(t.filename || '').replace(/\s*\(\d+\)\s*$/,'').trim();
                    const row2 = findArchiveRowByFilename(baseFilename2);
                    const restoredTitle2 = row2 ? String(row2.ui_label_2 || '').trim() : (t.aimTitle || t.label || t.filename);
                    openPdfs[t.filename] = {tab, url: t.url, label: restoredTitle2 || t.filename, aimTitle: restoredTitle2 || t.filename};
                }
            });
            const first = state.openTabs[0];
            if (first) activatePdfTab(first.filename);
        }
    } catch (e) {
        console.warn('restoreStateFromSession failed', e);
    }
}

window.addEventListener('beforeunload', () => persistStateToSession());
