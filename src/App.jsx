import { useState, useRef, useEffect, useCallback } from "react";
import * as THREE from "three";

const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap');`;

const IS_MOBILE = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) || window.innerWidth < 768;

/* ═══════════════════════════════════════════
 *  SURVEYOR GEOMETRY — true spherical area on
 *  an equirectangular map with pole padding
 *  ═══════════════════════════════════════════ */
// padN / padS are % of the FULL sphere height (180°), same semantics as the globe texture builder.
function latitudeBounds(padN, padS) {
  return { latTop: 90 - padN * 1.8, latBot: -90 + padS * 1.8 };
}

// points: array of {u, v} normalized 0..1 in image space → area in km²
function computeSphericalArea(points, imgW, imgH, padN, padS, radiusKm) {
  if (!points || points.length < 3) return 0;
  const { latTop, latBot } = latitudeBounds(padN, padS);
  const latTopR = (latTop * Math.PI) / 180;
  const latBotR = (latBot * Math.PI) / 180;

  const Wc = Math.min(2000, Math.max(600, Math.round(imgW)));
  const Hc = Math.max(2, Math.round((Wc * imgH) / imgW));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    const x = p.u * Wc, y = p.v * Hc;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minX = Math.max(0, Math.floor(minX));
  minY = Math.max(0, Math.floor(minY));
  maxX = Math.min(Wc, Math.ceil(maxX));
  maxY = Math.min(Hc, Math.ceil(maxY));
  const bw = maxX - minX, bh = maxY - minY;
  if (bw <= 0 || bh <= 0) return 0;

  const cv = document.createElement("canvas");
  cv.width = bw; cv.height = bh;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = p.u * Wc - minX, y = p.v * Hc - minY;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fill();

  const data = ctx.getImageData(0, 0, bw, bh).data;
  const dLon = (2 * Math.PI) / Wc;
  const dLat = (latTopR - latBotR) / Hc;
  const R2 = radiusKm * radiusKm;

  let area = 0;
  for (let row = 0; row < bh; row++) {
    const yImg = minY + row + 0.5;
    const phi = latTopR - (yImg / Hc) * (latTopR - latBotR);
    const rowWeight = R2 * Math.cos(phi) * dLon * dLat;
    let count = 0;
    const base = row * bw * 4;
    for (let col = 0; col < bw; col++) {
      if (data[base + col * 4 + 3] > 127) count++;
    }
    area += count * rowWeight;
  }
  return Math.max(0, area);
}

const REFERENCES = [
  { name: "Vatican City", area: 0.49 },
  { name: "Manhattan", area: 59 },
  { name: "Luxembourg", area: 2586 },
  { name: "Slovenia", area: 20273 },
  { name: "Iceland", area: 103000 },
  { name: "Great Britain", area: 209331 },
  { name: "France", area: 551695 },
  { name: "Texas", area: 695662 },
  { name: "Greenland", area: 2166086 },
  { name: "Australia", area: 7692024 },
  { name: "the Sahara", area: 9200000 },
  { name: "Russia", area: 17098246 },
  { name: "the Moon's surface", area: 37930000 },
  { name: "Earth's land", area: 148940000 },
  { name: "Earth's surface", area: 510072000 },
];

function nearestReference(areaKm2) {
  if (areaKm2 <= 0) return null;
  let best = null, bestScore = Infinity;
  for (const ref of REFERENCES) {
    const ratio = areaKm2 / ref.area;
    const score = Math.abs(Math.log10(ratio));
    if (score < bestScore) { bestScore = score; best = { ...ref, ratio }; }
  }
  if (!best) return null;
  const r = best.ratio;
  const rTxt = r >= 10 ? Math.round(r).toLocaleString() : r >= 0.95 ? r.toFixed(1) : r.toFixed(2);
  return `≈ ${rTxt}× ${best.name}`;
}

const KM_PER_MI = 1.609344;
const fmtNum = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v >= 1 ? v.toFixed(1) : v.toFixed(3));
const fmtArea = (km2, unit) => `${fmtNum(unit === "mi" ? km2 / (KM_PER_MI * KM_PER_MI) : km2)} ${unit}²`;

const REGION_COLORS = ["#c9a94e", "#a8543a", "#5e8a5e", "#4e7a9c", "#8a5e9c", "#9c8a4e"];
const ROMAN = ["I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII","XIII","XIV","XV","XVI","XVII","XVIII","XIX","XX"];

/* ═══════════════════════════════════════════
 *  WATER / LAND ANALYZER
 *  ═══════════════════════════════════════════ */
function SurveyPanel({ imgUrl, imgEl }) {
  const [analyzing, setAnalyzing] = useState(false);
  const [results, setResults] = useState(null);
  const [sensitivity, setSensitivity] = useState(50);
  const [hoverPixel, setHoverPixel] = useState(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [overlayData, setOverlayData] = useState(null);
  const canvasRef = useRef(null);
  const overlayCanvasRef = useRef(null);

  const classifyPixel = useCallback((r, g, b, a, sens) => {
    if (a < 30) return "transparent";
    const t = sens / 100;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta > 0) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
      if (hue < 0) hue += 360;
    }
    const saturation = max === 0 ? 0 : delta / max;
    const brightness = (r + g + b) / 3;
    const hueIsWater = (hue >= 170 && hue <= 270);
    const satThreshold = 0.08 + (1 - t) * 0.25;
    const blueWeight = b / Math.max(r, g, 1);
    if (hueIsWater && saturation > satThreshold && blueWeight > (0.8 + (1 - t) * 0.5)) return "water";
    if (hue >= 150 && hue < 170 && saturation > satThreshold * 1.3 && b > brightness * 0.7) return "water";
    if (hueIsWater && brightness < 80 && b > r && b > g && saturation > satThreshold * 0.6) return "water";
    if (hueIsWater && brightness > 150 && saturation > satThreshold * 0.8 && b > r * (1.0 + (1 - t) * 0.3)) return "water";
    return "land";
  }, []);

  const analyzeMap = useCallback(() => {
    if (!imgEl) return;
    setAnalyzing(true);
    setResults(null);
    setOverlayData(null);
    setPreviewMode(false);
    requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const maxDim = IS_MOBILE ? 400 : 800;
      let w = imgEl.naturalWidth, h = imgEl.naturalHeight;
      if (w > maxDim || h > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      canvas.width = w; canvas.height = h;
      ctx.drawImage(imgEl, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;
      let waterCount = 0, landCount = 0, transparentCount = 0;
      const overlay = new Uint8ClampedArray(data.length);
      for (let i = 0; i < data.length; i += 4) {
        const type = classifyPixel(data[i], data[i+1], data[i+2], data[i+3], sensitivity);
        if (type === "water") { waterCount++; overlay[i]=30; overlay[i+1]=120; overlay[i+2]=220; overlay[i+3]=140; }
        else if (type === "land") { landCount++; overlay[i]=120; overlay[i+1]=180; overlay[i+2]=60; overlay[i+3]=140; }
        else { transparentCount++; overlay[i+3]=0; }
      }
      const total = waterCount + landCount;
      const waterPct = total > 0 ? (waterCount / total) * 100 : 0;
      const landPct = total > 0 ? (landCount / total) * 100 : 0;
      const ratio = landCount > 0 ? (waterCount / landCount).toFixed(2) : "∞";
      setResults({ waterCount, landCount, transparentCount, waterPct, landPct, ratio, total, w, h });
      setOverlayData(new ImageData(overlay, w, h));
      setAnalyzing(false);
    });
  }, [imgEl, sensitivity, classifyPixel]);

  useEffect(() => {
    if (overlayData && previewMode && overlayCanvasRef.current) {
      const ctx = overlayCanvasRef.current.getContext("2d");
      overlayCanvasRef.current.width = overlayData.width;
      overlayCanvasRef.current.height = overlayData.height;
      ctx.putImageData(overlayData, 0, 0);
    }
  }, [overlayData, previewMode]);

  const handleMouseMove = (e) => {
    if (!canvasRef.current || !results) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = canvasRef.current.width / rect.width, sy = canvasRef.current.height / rect.height;
    const x = Math.floor((e.clientX - rect.left) * sx), y = Math.floor((e.clientY - rect.top) * sy);
    const ctx = canvasRef.current.getContext("2d", { willReadFrequently: true });
    const p = ctx.getImageData(x, y, 1, 1).data;
    setHoverPixel({ x, y, r: p[0], g: p[1], b: p[2], type: classifyPixel(p[0], p[1], p[2], p[3], sensitivity) });
  };

  return (
    <div className="survey-layout">
    <div className="survey-map-panel">
    <div className="map-container" onMouseMove={handleMouseMove} onMouseLeave={() => setHoverPixel(null)}>
    <img src={imgUrl} alt="Map" />
    {previewMode && overlayData && <canvas ref={overlayCanvasRef} className="overlay-canvas" />}
    {analyzing && <div className="analyzing-overlay"><div className="spinner" /><div className="analyzing-text">Surveying the realm…</div></div>}
    {hoverPixel && results && (
      <div className="pixel-info">
      <div className="pixel-swatch" style={{ background: `rgb(${hoverPixel.r},${hoverPixel.g},${hoverPixel.b})` }} />
      <span className={`pixel-type ${hoverPixel.type}`}>{hoverPixel.type}</span>
      <span style={{ color: "#5a4d36", fontSize: 11 }}>({hoverPixel.x}, {hoverPixel.y})</span>
      </div>
    )}
    </div>
    {results && <div className="dimension-info">Analyzed at {results.w}×{results.h} — {results.total.toLocaleString()} pixels</div>}
    <canvas ref={canvasRef} className="hidden-canvas" />
    </div>

    <div className="survey-controls">
    <div className="ctrl-card">
    <div className="ctrl-label">Water Sensitivity</div>
    <div className="slider-row">
    <input type="range" min="10" max="90" value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} />
    <span className="slider-val">{sensitivity}%</span>
    </div>
    <div className="slider-label-row"><span>Strict</span><span>Broad</span></div>
    </div>

    <button className="btn-action" onClick={analyzeMap} disabled={analyzing}>
    {analyzing ? "Surveying…" : results ? "Re-Survey" : "Survey Map"}
    </button>

    {results && overlayData && (
      <button
      className="btn-secondary"
      style={{ background: previewMode ? 'rgba(91,164,230,0.15)' : undefined, borderColor: previewMode ? '#5ba4e6' : undefined, color: previewMode ? '#5ba4e6' : undefined }}
      onClick={() => setPreviewMode(!previewMode)}
      >
      {previewMode ? "Hide Overlay" : "Show Classification"}
      </button>
    )}

    {previewMode && (
      <div className="legend">
      <div className="legend-item"><div className="legend-dot" style={{ background: "#3a8ae0" }} />Water</div>
      <div className="legend-item"><div className="legend-dot" style={{ background: "#78b43c" }} />Land</div>
      </div>
    )}

    {results && (
      <div className="ctrl-card">
      <div className="ctrl-label">Survey Results</div>
      <div className="results-grid">
      <div className="result-box">
      <div className="result-value water">{results.waterPct.toFixed(1)}%</div>
      <div className="result-label-sm">Water</div>
      </div>
      <div className="result-box">
      <div className="result-value land">{results.landPct.toFixed(1)}%</div>
      <div className="result-label-sm">Land</div>
      </div>
      <div className="result-box full">
      <div className="result-value ratio">{results.ratio} : 1</div>
      <div className="result-label-sm">Water to Land</div>
      </div>
      </div>
      <div className="bar-container">
      <div className="bar-water" style={{ width: `${results.waterPct}%` }}>{results.waterPct > 8 ? `${results.waterPct.toFixed(0)}%` : ""}</div>
      <div className="bar-land">{results.landPct > 8 ? `${results.landPct.toFixed(0)}%` : ""}</div>
      </div>
      <div style={{ textAlign: "center", marginTop: 12, fontSize: 12, color: "#6d6352" }}>
      {results.waterPct > 70 ? "A realm of vast oceans and scattered isles."
        : results.waterPct > 50 ? "The seas hold dominion, but land endures."
        : results.waterPct > 30 ? "A balanced realm of coast and continent."
        : results.waterPct > 15 ? "Great landmasses stretch between narrow seas."
        : "An arid world — water is precious here."}
        </div>
        </div>
    )}
    </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
 *  3D GLOBE VIEWER
 *  ═══════════════════════════════════════════ */
function GlobePanel({ imgEl, northPad, setNorthPad, southPad, setSouthPad }) {
  const [autoRotate, setAutoRotate] = useState(true);
  const [rotateSpeed, setRotateSpeed] = useState(0.3);
  const [showGrid, setShowGrid] = useState(false);
  const [atmosphere, setAtmosphere] = useState(true);
  const [tilt, setTilt] = useState(23.4);
  const [hOffset, setHOffset] = useState(0);
  const [poleColor, setPoleColor] = useState("#e8dcc8");

  const mountRef = useRef(null);
  const sceneRef = useRef({});
  const mouseRef = useRef({ isDown: false, prevX: 0, prevY: 0 });
  const rotRef = useRef({ x: 0.3, y: 0 });
  const momentumRef = useRef({ vx: 0, vy: 0 });
  const autoRotateRef = useRef(autoRotate);
  const rotateSpeedRef = useRef(rotateSpeed);
  const tiltRef = useRef(tilt);
  const showGridRef = useRef(showGrid);
  const atmosphereRef = useRef(atmosphere);

  useEffect(() => { autoRotateRef.current = autoRotate; }, [autoRotate]);
  useEffect(() => { rotateSpeedRef.current = rotateSpeed; }, [rotateSpeed]);
  useEffect(() => { tiltRef.current = tilt; }, [tilt]);
  useEffect(() => { showGridRef.current = showGrid; }, [showGrid]);
  useEffect(() => { atmosphereRef.current = atmosphere; }, [atmosphere]);

  const buildTextureCanvas = useCallback((img, nPad, sPad, hOff, pColor) => {
    const maxDim = IS_MOBILE ? 2048 : 4096;
    const texW = Math.min(img.naturalWidth, maxDim);
    const texH = Math.min(Math.round(texW / 2), maxDim);
    const canvas = document.createElement("canvas");
    canvas.width = texW; canvas.height = texH;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = pColor;
    ctx.fillRect(0, 0, texW, texH);
    const mapTop = Math.round(texH * (nPad / 100));
    const mapBottom = Math.round(texH * (1 - sPad / 100));
    const mapHeight = mapBottom - mapTop;
    if (mapHeight <= 0) return canvas;
    const hShift = Math.round((hOff / 100) * texW);
    ctx.drawImage(img, hShift, mapTop, texW, mapHeight);
    if (hShift > 0) ctx.drawImage(img, hShift - texW, mapTop, texW, mapHeight);
    else if (hShift < 0) ctx.drawImage(img, hShift + texW, mapTop, texW, mapHeight);
    return canvas;
  }, []);

  useEffect(() => {
    if (!imgEl || !sceneRef.current.globe) return;
    const canvas = buildTextureCanvas(imgEl, northPad, southPad, hOffset, poleColor);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = sceneRef.current.renderer?.capabilities.getMaxAnisotropy() || 1;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    if (sceneRef.current.globe.material.map) sceneRef.current.globe.material.map.dispose();
    sceneRef.current.globe.material.map = tex;
    sceneRef.current.globe.material.needsUpdate = true;
  }, [northPad, southPad, hOffset, poleColor, buildTextureCanvas, imgEl]);

  const initScene = useCallback(() => {
    if (!imgEl) return;
    const mount = mountRef.current;
    if (!mount) return;
    if (sceneRef.current.renderer) { sceneRef.current.renderer.dispose(); sceneRef.current.renderer.domElement.remove(); if (sceneRef.current.animId) cancelAnimationFrame(sceneRef.current.animId); }

    const w = mount.clientWidth, h = mount.clientHeight;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);
    camera.position.z = 2.8;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h); renderer.setPixelRatio(Math.min(window.devicePixelRatio, IS_MOBILE ? 1.5 : 2)); renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.0); sun.position.set(5, 3, 5); scene.add(sun);
    const fill = new THREE.DirectionalLight(0x8ab4f8, 0.25); fill.position.set(-3, -1, -2); scene.add(fill);

    const geo = new THREE.SphereGeometry(1, IS_MOBILE ? 64 : 128, IS_MOBILE ? 48 : 96);
    const texCanvas = buildTextureCanvas(imgEl, northPad, southPad, hOffset, poleColor);
    const texture = new THREE.CanvasTexture(texCanvas);
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const mat = new THREE.MeshPhongMaterial({ map: texture, specular: 0x333333, shininess: 15 });
    const globe = new THREE.Mesh(geo, mat);
    scene.add(globe);

    const atmosMesh = new THREE.Mesh(new THREE.SphereGeometry(1.03, 64, 48), new THREE.MeshBasicMaterial({ color: 0x6699cc, transparent: true, opacity: 0.08, side: THREE.FrontSide }));
    scene.add(atmosMesh);

    const gridGroup = new THREE.Group();
    const gmMinor = new THREE.LineBasicMaterial({ color: 0xc9a94e, transparent: true, opacity: 0.18, depthWrite: false });
    const gmMajor = new THREE.LineBasicMaterial({ color: 0xc9a94e, transparent: true, opacity: 0.35, depthWrite: false });
    const gmEquator = new THREE.LineBasicMaterial({ color: 0xe8c44a, transparent: true, opacity: 0.7, depthWrite: false, linewidth: 2 });
    const gmPrime = new THREE.LineBasicMaterial({ color: 0xe85050, transparent: true, opacity: 0.6, depthWrite: false, linewidth: 2 });
    const gr = 1.04;
    const gridSegs = IS_MOBILE ? 64 : 128;
    // Latitude lines every 15°
    for (let lat = -75; lat <= 75; lat += 15) {
      const phi = (90 - lat) * (Math.PI / 180);
      const pts = [];
      for (let i = 0; i <= gridSegs; i++) { const t = (i / gridSegs) * Math.PI * 2; pts.push(new THREE.Vector3(gr * Math.sin(phi) * Math.cos(t), gr * Math.cos(phi), gr * Math.sin(phi) * Math.sin(t))); }
      const lineMat = lat === 0 ? gmEquator : (lat % 30 === 0 ? gmMajor : gmMinor);
      gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }
    // Longitude lines every 15°
    for (let lon = 0; lon < 360; lon += 15) {
      const t = lon * (Math.PI / 180);
      const pts = [];
      for (let i = 0; i <= gridSegs; i++) { const p = (i / gridSegs) * Math.PI; pts.push(new THREE.Vector3(gr * Math.sin(p) * Math.cos(t), gr * Math.cos(p), gr * Math.sin(p) * Math.sin(t))); }
      const lineMat = lon === 0 ? gmPrime : (lon % 30 === 0 ? gmMajor : gmMinor);
      gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    }
    gridGroup.visible = false; scene.add(gridGroup);

    const starsGeo = new THREE.BufferGeometry(); const sp = []; const starCount = IS_MOBILE ? 500 : 1500;
    for (let i = 0; i < starCount; i++) { const r = 50 + Math.random() * 100; const t = Math.random() * Math.PI * 2; const p = Math.acos(2 * Math.random() - 1); sp.push(r * Math.sin(p) * Math.cos(t), r * Math.sin(p) * Math.sin(t), r * Math.cos(p)); }
    starsGeo.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
    scene.add(new THREE.Points(starsGeo, new THREE.PointsMaterial({ color: 0xccbb88, size: 0.15, sizeAttenuation: true })));

    sceneRef.current = { renderer, scene, camera, globe, atmosMesh, gridGroup, animId: null };

    const el = renderer.domElement;
    const onPD = (e) => { mouseRef.current = { isDown: true, prevX: e.clientX, prevY: e.clientY }; momentumRef.current = { vx: 0, vy: 0 }; el.style.cursor = "grabbing"; };
    const onPM = (e) => { if (!mouseRef.current.isDown) return; const dx = e.clientX - mouseRef.current.prevX; const dy = e.clientY - mouseRef.current.prevY; rotRef.current.y += dx * 0.005; rotRef.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotRef.current.x + dy * 0.005)); momentumRef.current = { vx: dx * 0.005, vy: dy * 0.005 }; mouseRef.current.prevX = e.clientX; mouseRef.current.prevY = e.clientY; };
    const onPU = () => { mouseRef.current.isDown = false; el.style.cursor = "grab"; };
    const onWh = (e) => { e.preventDefault(); camera.position.z = Math.max(1.6, Math.min(6, camera.position.z + e.deltaY * 0.002)); };
    const ts = { prevDist: 0 };
    const onTS = (e) => { if (e.touches.length === 1) { mouseRef.current = { isDown: true, prevX: e.touches[0].clientX, prevY: e.touches[0].clientY }; momentumRef.current = { vx: 0, vy: 0 }; } else if (e.touches.length === 2) { const dx = e.touches[0].clientX - e.touches[1].clientX; const dy = e.touches[0].clientY - e.touches[1].clientY; ts.prevDist = Math.sqrt(dx * dx + dy * dy); } };
    const onTM = (e) => { e.preventDefault(); if (e.touches.length === 1 && mouseRef.current.isDown) { const dx = e.touches[0].clientX - mouseRef.current.prevX; const dy = e.touches[0].clientY - mouseRef.current.prevY; rotRef.current.y += dx * 0.005; rotRef.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotRef.current.x + dy * 0.005)); momentumRef.current = { vx: dx * 0.005, vy: dy * 0.005 }; mouseRef.current.prevX = e.touches[0].clientX; mouseRef.current.prevY = e.touches[0].clientY; } else if (e.touches.length === 2) { const dx = e.touches[0].clientX - e.touches[1].clientX; const dy = e.touches[0].clientY - e.touches[1].clientY; const dist = Math.sqrt(dx * dx + dy * dy); camera.position.z = Math.max(1.6, Math.min(6, camera.position.z + (ts.prevDist - dist) * 0.008)); ts.prevDist = dist; } };
    const onTE = () => { mouseRef.current.isDown = false; };

    el.addEventListener("pointerdown", onPD); el.addEventListener("pointermove", onPM); el.addEventListener("pointerup", onPU); el.addEventListener("pointerleave", onPU);
    el.addEventListener("wheel", onWh, { passive: false });
    el.addEventListener("touchstart", onTS, { passive: true }); el.addEventListener("touchmove", onTM, { passive: false }); el.addEventListener("touchend", onTE);
    el.style.cursor = "grab"; el.style.touchAction = "none";

    const animate = () => {
      sceneRef.current.animId = requestAnimationFrame(animate);
      const tr = tiltRef.current * (Math.PI / 180);
      if (autoRotateRef.current && !mouseRef.current.isDown) rotRef.current.y += rotateSpeedRef.current * 0.003;
      if (!mouseRef.current.isDown) { momentumRef.current.vx *= 0.95; momentumRef.current.vy *= 0.95; rotRef.current.y += momentumRef.current.vx; rotRef.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotRef.current.x + momentumRef.current.vy)); }
      globe.rotation.set(0, 0, 0);
      globe.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), tr);
      globe.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), rotRef.current.y);
      globe.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), rotRef.current.x);
      atmosMesh.rotation.copy(globe.rotation); gridGroup.rotation.copy(globe.rotation);
      gridGroup.visible = showGridRef.current;
      atmosMesh.visible = atmosphereRef.current;
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => { const nw = mount.clientWidth; const nh = mount.clientHeight; camera.aspect = nw / nh; camera.updateProjectionMatrix(); renderer.setSize(nw, nh); };
    window.addEventListener("resize", onResize);
    sceneRef.current.cleanup = () => { window.removeEventListener("resize", onResize); el.removeEventListener("pointerdown", onPD); el.removeEventListener("pointermove", onPM); el.removeEventListener("pointerup", onPU); el.removeEventListener("pointerleave", onPU); el.removeEventListener("wheel", onWh); el.removeEventListener("touchstart", onTS); el.removeEventListener("touchmove", onTM); el.removeEventListener("touchend", onTE); };
  }, [imgEl, buildTextureCanvas, northPad, southPad, hOffset, poleColor]);

  useEffect(() => {
    if (imgEl) initScene();
    return () => { if (sceneRef.current.animId) cancelAnimationFrame(sceneRef.current.animId); if (sceneRef.current.cleanup) sceneRef.current.cleanup(); if (sceneRef.current.renderer) { sceneRef.current.renderer.dispose(); if (sceneRef.current.renderer.domElement?.parentNode) sceneRef.current.renderer.domElement.remove(); } };
  }, [imgEl, initScene]);

  return (
    <div className="globe-layout">
    <div className="globe-viewport" ref={mountRef}>
    <div className="hint-bar">Drag to rotate · Scroll to zoom</div>
    </div>
    <div className="globe-controls">
    <div className="ctrl-card">
    <div className="ctrl-label">Pole Projection</div>
    <div className="section-hint">Push the map away from the poles to add unmapped regions.</div>
    <div style={{ marginBottom: 10 }}>
    <div className="sub-label">North Pole Padding</div>
    <div className="slider-row"><input type="range" min="0" max="49" step="0.5" value={northPad} onChange={(e) => setNorthPad(Number(e.target.value))} /><span className="slider-val">{northPad}%</span></div>
    <div className="slider-label-row"><span>None</span><span>More arctic</span></div>
    </div>
    <div style={{ marginBottom: 10 }}>
    <div className="sub-label">South Pole Padding</div>
    <div className="slider-row"><input type="range" min="0" max="49" step="0.5" value={southPad} onChange={(e) => setSouthPad(Number(e.target.value))} /><span className="slider-val">{southPad}%</span></div>
    <div className="slider-label-row"><span>None</span><span>More antarctic</span></div>
    </div>
    <div style={{ marginBottom: 10 }}>
    <div className="sub-label">Horizontal Shift</div>
    <div className="slider-row"><input type="range" min="-50" max="50" step="1" value={hOffset} onChange={(e) => setHOffset(Number(e.target.value))} /><span className="slider-val">{hOffset > 0 ? '+' : ''}{hOffset}%</span></div>
    <div className="slider-label-row"><span>← West</span><span>East →</span></div>
    </div>
    <div className="color-row">
    <input type="color" className="color-input" value={poleColor} onChange={(e) => setPoleColor(e.target.value)} />
    <span className="color-label">Pole fill color</span>
    </div>
    </div>

    <div className="ctrl-card">
    <div className="ctrl-label">Rotation</div>
    <div className="toggle-row"><span className="toggle-name">Auto-rotate</span><div className={`toggle-switch ${autoRotate ? "on" : ""}`} onClick={() => setAutoRotate(!autoRotate)} /></div>
    <div className="slider-row" style={{ marginTop: 10 }}><input type="range" min="0.05" max="2" step="0.05" value={rotateSpeed} onChange={(e) => setRotateSpeed(Number(e.target.value))} /><span className="slider-val">{rotateSpeed.toFixed(1)}×</span></div>
    </div>

    <div className="ctrl-card">
    <div className="ctrl-label">Axial Tilt</div>
    <div className="slider-row"><input type="range" min="0" max="45" step="0.5" value={tilt} onChange={(e) => setTilt(Number(e.target.value))} /><span className="slider-val">{tilt.toFixed(1)}°</span></div>
    </div>

    <div className="ctrl-card">
    <div className="ctrl-label">Display</div>
    <div className="toggle-row"><span className="toggle-name">Grid Lines</span><div className={`toggle-switch ${showGrid ? "on" : ""}`} onClick={() => setShowGrid(!showGrid)} /></div>
    {showGrid && (
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#8a7e66' }}>
      <div style={{ width: 18, height: 3, background: '#e8c44a', borderRadius: 1 }} /> Equator
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#8a7e66' }}>
      <div style={{ width: 18, height: 3, background: '#e85050', borderRadius: 1 }} /> Prime Meridian
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#8a7e66' }}>
      <div style={{ width: 18, height: 3, background: 'rgba(201,169,78,0.5)', borderRadius: 1 }} /> 30° intervals
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#8a7e66' }}>
      <div style={{ width: 18, height: 3, background: 'rgba(201,169,78,0.25)', borderRadius: 1 }} /> 15° intervals
      </div>
      </div>
    )}
    <div className="toggle-row" style={{ marginTop: 8 }}><span className="toggle-name">Atmosphere</span><div className={`toggle-switch ${atmosphere ? "on" : ""}`} onClick={() => setAtmosphere(!atmosphere)} /></div>
    </div>
    </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
 *  SURVEYOR PANEL
 *  ═══════════════════════════════════════════ */
function SurveyorPanel({ imgEl, northPad, setNorthPad, southPad, setSouthPad, circumference, setCircumference, unit, setUnit, regions, setRegions }) {
  const [mode, setMode] = useState("polygon"); // polygon | freehand | pan
  const [showGraticule, setShowGraticule] = useState(true);
  const [draft, setDraft] = useState(null); // { points: [{u,v}] }
  const [draftArea, setDraftArea] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [hoverRegion, setHoverRegion] = useState(null);

  const viewportRef = useRef(null);
  const canvasRef = useRef(null);
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const panRef = useRef(null);
  const drawingRef = useRef(false);
  const rafRef = useRef(null);

  const imgW = imgEl ? imgEl.naturalWidth : 1;
  const imgH = imgEl ? imgEl.naturalHeight : 1;
  const circKm = unit === "mi" ? circumference * KM_PER_MI : circumference;
  const radiusKm = circKm / (2 * Math.PI);
  const sphereArea = 4 * Math.PI * radiusKm * radiusKm;
  const { latTop, latBot } = latitudeBounds(northPad, southPad);

  /* ---------- canvas sizing + view fit ---------- */
  const fitView = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !imgEl) return;
    const vw = vp.clientWidth, vh = vp.clientHeight;
    const scale = Math.min(vw / imgW, vh / imgH) * 0.94;
    viewRef.current = { scale, tx: (vw - imgW * scale) / 2, ty: (vh - imgH * scale) / 2 };
  }, [imgEl, imgW, imgH]);

  const sizeCanvas = useCallback(() => {
    const vp = viewportRef.current, cv = canvasRef.current;
    if (!vp || !cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = vp.clientWidth * dpr;
    cv.height = vp.clientHeight * dpr;
    cv.style.width = vp.clientWidth + "px";
    cv.style.height = vp.clientHeight + "px";
  }, []);

  /* ---------- drawing ---------- */
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !imgEl) return;
    const ctx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const { scale, tx, ty } = viewRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cv.width / dpr, cv.height / dpr);

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(imgEl, 0, 0, imgW, imgH);

    if (showGraticule) {
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = "rgba(201,169,78,0.35)";
      ctx.fillStyle = "rgba(201,169,78,0.75)";
      ctx.font = `${11 / scale}px 'Crimson Text', serif`;
      const span = latTop - latBot;
      for (let lat = -75; lat <= 75; lat += 15) {
        if (lat > latTop || lat < latBot) continue;
        const y = ((latTop - lat) / span) * imgH;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(imgW, y); ctx.stroke();
        const label = lat === 0 ? "0° equator" : `${Math.abs(lat)}°${lat > 0 ? "N" : "S"}`;
        ctx.fillText(label, 5 / scale, y - 3 / scale);
      }
      for (let i = 1; i < 12; i++) {
        const x = (i / 12) * imgW;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, imgH); ctx.stroke();
      }
    }

    for (const reg of regions) {
      ctx.beginPath();
      reg.points.forEach((p, i) => {
        const x = p.u * imgW, y = p.v * imgH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      const hovered = hoverRegion === reg.id;
      ctx.fillStyle = reg.color + (hovered ? "55" : "33");
      ctx.fill();
      ctx.lineWidth = (hovered ? 2.5 : 1.5) / scale;
      ctx.strokeStyle = reg.color;
      ctx.stroke();
      let cx = 0, cy = 0;
      reg.points.forEach((p) => { cx += p.u; cy += p.v; });
      cx = (cx / reg.points.length) * imgW;
      cy = (cy / reg.points.length) * imgH;
      ctx.font = `600 ${13 / scale}px 'Cinzel', serif`;
      const tw = ctx.measureText(reg.name).width;
      ctx.fillStyle = "rgba(12,11,9,0.75)";
      ctx.fillRect(cx - tw / 2 - 5 / scale, cy - 9 / scale, tw + 10 / scale, 18 / scale);
      ctx.fillStyle = reg.color;
      ctx.textBaseline = "middle";
      ctx.fillText(reg.name, cx - tw / 2, cy);
      ctx.textBaseline = "alphabetic";
    }

    if (draft && draft.points.length > 0) {
      const col = REGION_COLORS[regions.length % REGION_COLORS.length];
      ctx.beginPath();
      draft.points.forEach((p, i) => {
        const x = p.u * imgW, y = p.v * imgH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      if (draft.points.length >= 3) {
        ctx.save(); ctx.closePath(); ctx.fillStyle = col + "22"; ctx.fill(); ctx.restore();
      }
      ctx.lineWidth = 1.5 / scale;
      ctx.strokeStyle = col;
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (mode === "polygon") {
        draft.points.forEach((p, i) => {
          const x = p.u * imgW, y = p.v * imgH;
          ctx.beginPath();
          ctx.arc(x, y, (i === 0 ? 5 : 3.5) / scale, 0, Math.PI * 2);
          ctx.fillStyle = i === 0 ? "#f0e0b0" : col;
          ctx.fill();
          ctx.lineWidth = 1 / scale;
          ctx.strokeStyle = "#0c0b09";
          ctx.stroke();
        });
      }
    }
    ctx.restore();
  }, [imgEl, imgW, imgH, regions, draft, showGraticule, latTop, latBot, mode, hoverRegion]);

  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => { rafRef.current = null; draw(); });
  }, [draw]);

  useEffect(() => {
    sizeCanvas();
    fitView();
    draw();
    const onResize = () => { sizeCanvas(); draw(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [imgEl]); // eslint-disable-line

  useEffect(() => { requestDraw(); }, [draw]); // eslint-disable-line

  /* ---------- recompute areas when planet params change ---------- */
  useEffect(() => {
    if (!imgEl) return;
    setRegions((prev) => prev.map((r) => ({
      ...r,
      area: computeSphericalArea(r.points, imgW, imgH, northPad, southPad, radiusKm),
    })));
  }, [northPad, southPad, radiusKm, imgEl]); // eslint-disable-line

  /* ---------- coordinate helpers ---------- */
  const toImage = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const { scale, tx, ty } = viewRef.current;
    const x = (e.clientX - rect.left - tx) / scale;
    const y = (e.clientY - rect.top - ty) / scale;
    return { u: x / imgW, v: y / imgH };
  };
  const inBounds = (p) => p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1;
  const clampP = (p) => ({ u: Math.min(1, Math.max(0, p.u)), v: Math.min(1, Math.max(0, p.v)) });

  const commitDraft = useCallback((points) => {
    if (!points || points.length < 3) { setDraft(null); setDraftArea(null); return; }
    const area = computeSphericalArea(points, imgW, imgH, northPad, southPad, radiusKm);
    setRegions((prev) => {
      const id = prev.length ? Math.max(...prev.map((r) => r.id)) + 1 : 1;
      const color = REGION_COLORS[(id - 1) % REGION_COLORS.length];
      return [...prev, { id, name: `Region ${ROMAN[(id - 1) % ROMAN.length]}`, points, color, area }];
    });
    setDraft(null);
    setDraftArea(null);
  }, [imgW, imgH, northPad, southPad, radiusKm, setRegions]);

  /* ---------- pointer events ---------- */
  const onPointerDown = (e) => {
    if (!imgEl) return;
    const cvEl = canvasRef.current;
    if (e.button === 1 || mode === "pan" || e.shiftKey) {
      panRef.current = { x: e.clientX, y: e.clientY };
      cvEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const p = clampP(toImage(e));

    if (mode === "polygon") {
      const { scale } = viewRef.current;
      const cur = draft ? draft.points : [];
      if (cur.length >= 3) {
        const f = cur[0];
        const dx = (f.u - p.u) * imgW * scale;
        const dy = (f.v - p.v) * imgH * scale;
        if (Math.hypot(dx, dy) < 12) { commitDraft(cur); return; }
      }
      const next = [...cur, p];
      setDraft({ points: next });
      if (next.length >= 3) {
        setDraftArea(computeSphericalArea(next, imgW, imgH, northPad, southPad, radiusKm));
      }
    } else if (mode === "freehand") {
      drawingRef.current = true;
      cvEl.setPointerCapture(e.pointerId);
      setDraft({ points: [p] });
      setDraftArea(null);
    }
  };

  const onPointerMove = (e) => {
    if (!imgEl) return;
    if (panRef.current) {
      const dx = e.clientX - panRef.current.x;
      const dy = e.clientY - panRef.current.y;
      panRef.current = { x: e.clientX, y: e.clientY };
      viewRef.current.tx += dx;
      viewRef.current.ty += dy;
      requestDraw();
      return;
    }
    const p = toImage(e);
    if (inBounds(p)) {
      const span = latTop - latBot;
      setCursor({ lat: latTop - p.v * span, lon: (p.u - 0.5) * 360 });
    } else setCursor(null);

    if (drawingRef.current && mode === "freehand" && draft) {
      const cp = clampP(p);
      const last = draft.points[draft.points.length - 1];
      const { scale } = viewRef.current;
      const dx = (cp.u - last.u) * imgW * scale;
      const dy = (cp.v - last.v) * imgH * scale;
      if (Math.hypot(dx, dy) > 3) {
        setDraft((d) => ({ points: [...d.points, cp] }));
      }
    }
  };

  const onPointerUp = () => {
    if (panRef.current) { panRef.current = null; return; }
    if (drawingRef.current && mode === "freehand") {
      drawingRef.current = false;
      if (draft && draft.points.length >= 3) commitDraft(draft.points);
      else { setDraft(null); setDraftArea(null); }
    }
  };

  const onDoubleClick = () => {
    if (mode === "polygon" && draft && draft.points.length >= 3) commitDraft(draft.points);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { setDraft(null); setDraftArea(null); drawingRef.current = false; }
      if (e.key === "Enter" && mode === "polygon" && draft && draft.points.length >= 3) {
        commitDraft(draft.points);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, mode, commitDraft]);

  // non-passive wheel zoom (re-attached each render to keep closures fresh)
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const v = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newScale = Math.min(40, Math.max(0.05, v.scale * factor));
      const k = newScale / v.scale;
      v.tx = mx - (mx - v.tx) * k;
      v.ty = my - (my - v.ty) * k;
      v.scale = newScale;
      requestDraw();
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  });

  const totalArea = regions.reduce((s, r) => s + r.area, 0);
  const removeRegion = (id) => setRegions((prev) => prev.filter((r) => r.id !== id));
  const renameRegion = (id, name) => setRegions((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)));
  const radiusDisplay = `${Math.round(unit === "mi" ? radiusKm / KM_PER_MI : radiusKm).toLocaleString()} ${unit}`;

  return (
    <div className="srv-layout">
      <div className={`srv-viewport mode-${mode}`} ref={viewportRef}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          onPointerLeave={() => setCursor(null)}
        />
        {cursor && (
          <div className="srv-coord">
            {Math.abs(cursor.lat).toFixed(1)}°{cursor.lat >= 0 ? "N" : "S"} · {Math.abs(cursor.lon).toFixed(1)}°{cursor.lon >= 0 ? "E" : "W"}
          </div>
        )}
        {draft && draft.points.length >= 3 && draftArea != null && (
          <div className="srv-draft">{fmtArea(draftArea, unit)}</div>
        )}
        <div className="hint-bar">
          {mode === "polygon" && !draft && "Click to place markers · scroll to zoom · shift-drag to pan"}
          {mode === "polygon" && draft && "Click first marker, Enter, or double-click to close · Esc cancels"}
          {mode === "freehand" && "Drag to trace a border · release to close · Esc cancels"}
          {mode === "pan" && "Drag to pan · scroll to zoom"}
        </div>
      </div>

      <div className="srv-controls">
        <div className="ctrl-card">
          <div className="ctrl-label">The Planet</div>
          <div className="srv-field-row">
            <input className="srv-num" type="number" min="1" value={circumference}
              onChange={(e) => setCircumference(Math.max(0, parseFloat(e.target.value) || 0))} />
            <select className="srv-unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="km">km</option>
              <option value="mi">mi</option>
            </select>
          </div>
          <div className="section-hint" style={{ marginTop: 8 }}>Equatorial circumference. Earth is 40,075 km / 24,901 mi.</div>
          <div className="srv-stats">
            Radius: <b>{radiusDisplay}</b><br />
            Total surface: <b>{fmtArea(sphereArea, unit)}</b>
          </div>
        </div>

        <div className="ctrl-card">
          <div className="ctrl-label">Pole Projection</div>
          <div className="section-hint">Shared with the Globe tab — pad the gap if your map stops short of the poles.</div>
          <div style={{ marginBottom: 10 }}>
            <div className="sub-label">North Pole Padding</div>
            <div className="slider-row"><input type="range" min="0" max="49" step="0.5" value={northPad} onChange={(e) => setNorthPad(Number(e.target.value))} /><span className="slider-val">{northPad}%</span></div>
            <div className="srv-sub">Map's top edge sits at {latTop.toFixed(1)}°</div>
          </div>
          <div>
            <div className="sub-label">South Pole Padding</div>
            <div className="slider-row"><input type="range" min="0" max="49" step="0.5" value={southPad} onChange={(e) => setSouthPad(Number(e.target.value))} /><span className="slider-val">{southPad}%</span></div>
            <div className="srv-sub">Map's bottom edge sits at {latBot.toFixed(1)}°</div>
          </div>
        </div>

        <div className="ctrl-card">
          <div className="ctrl-label">Survey Tools</div>
          <div className="srv-mode-btns">
            <button className={`srv-mode-btn ${mode === "polygon" ? "active" : ""}`} onClick={() => setMode("polygon")}>Markers</button>
            <button className={`srv-mode-btn ${mode === "freehand" ? "active" : ""}`} onClick={() => setMode("freehand")}>Freehand</button>
            <button className={`srv-mode-btn ${mode === "pan" ? "active" : ""}`} onClick={() => setMode("pan")}>Pan</button>
          </div>
          <div className="toggle-row" style={{ marginTop: 10 }}>
            <span className="toggle-name">Latitude graticule</span>
            <div className={`toggle-switch ${showGraticule ? "on" : ""}`} onClick={() => setShowGraticule(!showGraticule)} />
          </div>
        </div>

        <div className="ctrl-card">
          <div className="ctrl-label">Surveyed Regions</div>
          {regions.length === 0 && (
            <div className="section-hint">
              No regions surveyed yet. Areas account for the projection — a shape near the poles
              covers far less true ground than the same shape at the equator.
            </div>
          )}
          {regions.map((reg) => (
            <div key={reg.id} className="srv-region-card"
              onMouseEnter={() => setHoverRegion(reg.id)}
              onMouseLeave={() => setHoverRegion(null)}>
              <div className="srv-region-head">
                <div className="srv-region-dot" style={{ background: reg.color }} />
                <input className="srv-region-name" value={reg.name}
                  onChange={(e) => renameRegion(reg.id, e.target.value)} />
                <button className="srv-region-del" title="Remove region"
                  onClick={() => removeRegion(reg.id)}>✕</button>
              </div>
              <div className="srv-region-area">{fmtArea(reg.area, unit)}</div>
              <div className="srv-region-meta">
                {((reg.area / sphereArea) * 100).toFixed(2)}% of the world · {nearestReference(reg.area)}
              </div>
            </div>
          ))}
          {regions.length > 0 && (
            <>
              <div className="srv-total-card">
                <div className="srv-total-label">Combined dominion</div>
                <div className="srv-total-value">{fmtArea(totalArea, unit)}</div>
                <div className="srv-total-meta">
                  {((totalArea / sphereArea) * 100).toFixed(2)}% of the planet · {nearestReference(totalArea)}
                </div>
              </div>
              <button className="btn-secondary" style={{ marginTop: 8 }} onClick={() => setRegions([])}>Clear all regions</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
 *  MAIN APP
 *  ═══════════════════════════════════════════ */
export default function RealmForge() {
  const [image, setImage] = useState(null);
  const [imageName, setImageName] = useState("");
  const [imgEl, setImgEl] = useState(null);
  const [tab, setTab] = useState("survey");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // shared between Globe and Surveyor tabs
  const [northPad, setNorthPad] = useState(0);
  const [southPad, setSouthPad] = useState(0);
  // surveyor state lives here so it survives tab switches
  const [circumference, setCircumference] = useState(40075);
  const [unit, setUnit] = useState("km");
  const [regions, setRegions] = useState([]);

  const handleFile = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    setImageName(file.name);
    setRegions([]);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (IS_MOBILE && (img.naturalWidth > 2048 || img.naturalHeight > 2048)) {
        // Downscale on mobile to prevent OOM
        const scale = 2048 / Math.max(img.naturalWidth, img.naturalHeight);
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const scaled = new Image();
        scaled.onload = () => { setImgEl(scaled); setImage(scaled.src); URL.revokeObjectURL(url); };
        scaled.src = c.toDataURL("image/jpeg", 0.9);
      } else {
        setImgEl(img); setImage(url);
      }
    };
    img.src = url;
  };

  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); };

  const clearMap = () => { setImage(null); setImageName(""); setImgEl(null); setRegions([]); setTab("survey"); };

  return (
    <>
    <style>{FONTS}{`
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: #0f0e0c; }

      .forge-app {
        font-family: 'Crimson Text', Georgia, serif;
        min-height: 100vh;
        background:
        radial-gradient(ellipse at 15% 85%, rgba(139,109,60,0.06) 0%, transparent 50%),
          radial-gradient(ellipse at 85% 15%, rgba(60,90,139,0.05) 0%, transparent 50%),
          radial-gradient(ellipse at 50% 50%, rgba(20,18,14,1) 0%, #0f0e0c 100%);
          color: #d4c8a8;
          display: flex;
          flex-direction: column;
      }

      /* ── Header ── */
      .forge-header {
        text-align: center;
        padding: 28px 24px 0;
        position: relative;
        z-index: 5;
      }
      .forge-title {
        font-family: 'Cinzel', serif;
        font-size: 32px;
        font-weight: 900;
        color: #c9a94e;
        letter-spacing: 5px;
        text-transform: uppercase;
        text-shadow: 0 2px 20px rgba(201,169,78,0.15);
      }

      /* ── Map info bar ── */
      .map-bar {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 16px;
        padding: 12px 24px;
        font-size: 13px;
        color: #8a7e66;
      }
      .map-bar-name {
        font-family: 'Cinzel', serif;
        letter-spacing: 1px;
      }
      .map-bar-clear {
        font-size: 11px;
        color: #5a4d36;
        cursor: pointer;
        border: 1px solid #3a3328;
        border-radius: 4px;
        padding: 3px 10px;
        transition: all 0.2s;
        background: none;
        font-family: 'Cinzel', serif;
        letter-spacing: 1px;
        text-transform: uppercase;
      }
      .map-bar-clear:hover { border-color: #8a7e66; color: #a89670; }

      /* ── Tabs ── */
      .tab-bar {
        display: flex;
        justify-content: center;
        gap: 0;
        padding: 0 24px 16px;
      }
      .tab-btn {
        font-family: 'Cinzel', serif;
        font-size: 13px;
        letter-spacing: 2px;
        text-transform: uppercase;
        padding: 10px 28px;
        border: 1px solid #2a2520;
        background: rgba(20,18,14,0.8);
        color: #6d6352;
        cursor: pointer;
        transition: all 0.3s;
      }
      .tab-btn:first-child { border-radius: 8px 0 0 8px; }
      .tab-btn:last-child { border-radius: 0 8px 8px 0; }
      .tab-btn.active {
        background: rgba(201,169,78,0.1);
        color: #c9a94e;
        border-color: #c9a94e;
        z-index: 1;
      }
      .tab-btn:hover:not(.active) { color: #a89670; border-color: #3a3328; }

      /* ── Drop zone ── */
      .drop-zone {
        margin: 40px auto;
        width: 420px;
        max-width: calc(100% - 48px);
        aspect-ratio: 1;
        border: 2px dashed #3a3328;
        border-radius: 50%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.4s;
        background: rgba(30,27,22,0.2);
      }
      .drop-zone:hover, .drop-zone.dragover {
        border-color: #c9a94e;
        background: rgba(201,169,78,0.04);
        box-shadow: 0 0 80px rgba(201,169,78,0.06);
      }
      .drop-icon { font-size: 64px; opacity: 0.5; }
      .drop-text { font-family: 'Cinzel', serif; font-size: 18px; color: #a89670; letter-spacing: 3px; margin-top: 16px; text-transform: uppercase; }
      .drop-hint { font-size: 13px; color: #5a4d36; margin-top: 8px; }

      /* ── Shared panel styles ── */
      .ctrl-card { background: rgba(30,27,22,0.6); border: 1px solid #2a2520; border-radius: 10px; padding: 14px; }
      .ctrl-label { font-family: 'Cinzel', serif; font-size: 10px; color: #8a7e66; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; }
      .sub-label { font-size: 12px; color: #a89670; margin-bottom: 4px; }
      .section-hint { font-size: 11px; color: #5a4d36; font-style: italic; margin-bottom: 8px; line-height: 1.4; }
      .slider-row { display: flex; align-items: center; gap: 10px; }
      .slider-row input[type="range"] { flex: 1; -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px; background: #2a2520; outline: none; }
      .slider-row input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #c9a94e; border: 2px solid #0c0b09; cursor: pointer; box-shadow: 0 0 6px rgba(201,169,78,0.3); }
      .slider-val { font-family: 'Cinzel', serif; font-size: 12px; color: #c9a94e; min-width: 36px; text-align: right; }
      .slider-label-row { display: flex; justify-content: space-between; font-size: 10px; color: #5a4d36; margin-top: 3px; letter-spacing: 0.5px; }
      .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; }
      .toggle-name { font-size: 13px; color: #a89670; }
      .toggle-switch { width: 38px; height: 20px; border-radius: 10px; border: 1px solid #3a3328; background: #1a1714; position: relative; cursor: pointer; transition: all 0.3s; }
      .toggle-switch.on { background: rgba(201,169,78,0.2); border-color: #c9a94e; }
      .toggle-switch::after { content: ''; position: absolute; width: 14px; height: 14px; border-radius: 50%; top: 2px; left: 2px; background: #5a4d36; transition: all 0.3s; }
      .toggle-switch.on::after { left: 20px; background: #c9a94e; }
      .color-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
      .color-input { width: 32px; height: 24px; border: 1px solid #3a3328; border-radius: 4px; background: none; cursor: pointer; padding: 0; }
      .color-label { font-size: 12px; color: #8a7e66; }

      /* ── Survey tab ── */
      .survey-layout { display: flex; gap: 20px; padding: 0 24px 24px; flex: 1; }
      @media (max-width: 800px) { .survey-layout { flex-direction: column; } }
      .survey-map-panel { flex: 1; background: rgba(30,27,22,0.5); border: 1px solid #2a2520; border-radius: 12px; padding: 14px; display: flex; flex-direction: column; }
      .survey-controls { width: 300px; display: flex; flex-direction: column; gap: 14px; }
      @media (max-width: 800px) { .survey-controls { width: 100%; } }
      .map-container { position: relative; width: 100%; border-radius: 8px; overflow: hidden; background: #0e0d0b; flex: 1; }
      .map-container img { display: block; width: 100%; height: auto; }
      .overlay-canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
      .hidden-canvas { display: none; }
      .analyzing-overlay { position: absolute; inset: 0; background: rgba(15,13,10,0.85); display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: 8px; z-index: 10; }
      .spinner { width: 40px; height: 40px; border: 3px solid #3a3328; border-top-color: #c9a94e; border-radius: 50%; animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .analyzing-text { font-family: 'Cinzel', serif; font-size: 13px; color: #c9a94e; margin-top: 12px; letter-spacing: 2px; text-transform: uppercase; }
      .pixel-info { position: absolute; bottom: 8px; left: 8px; background: rgba(15,13,10,0.92); border: 1px solid #3a3328; border-radius: 6px; padding: 6px 10px; font-size: 12px; display: flex; align-items: center; gap: 8px; backdrop-filter: blur(6px); }
      .pixel-swatch { width: 16px; height: 16px; border-radius: 3px; border: 1px solid #5a4d36; }
      .pixel-type { font-family: 'Cinzel', serif; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
      .pixel-type.water { color: #5ba4e6; }
      .pixel-type.land { color: #8bc34a; }
      .dimension-info { font-size: 11px; color: #5a4d36; margin-top: 8px; text-align: right; }
      .btn-action { font-family: 'Cinzel', serif; font-size: 14px; letter-spacing: 2px; text-transform: uppercase; padding: 12px 24px; border: 1px solid #c9a94e; background: rgba(201,169,78,0.1); color: #c9a94e; border-radius: 8px; cursor: pointer; transition: all 0.3s; width: 100%; }
      .btn-action:hover { background: rgba(201,169,78,0.2); box-shadow: 0 0 20px rgba(201,169,78,0.15); }
      .btn-action:disabled { opacity: 0.4; cursor: not-allowed; }
      .btn-secondary { font-family: 'Cinzel', serif; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; padding: 8px 14px; border: 1px solid #5a4d36; background: rgba(30,27,22,0.6); color: #8a7e66; border-radius: 6px; cursor: pointer; transition: all 0.3s; width: 100%; }
      .btn-secondary:hover { border-color: #8a7e66; color: #a89670; }
      .legend { display: flex; gap: 16px; justify-content: center; }
      .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #8a7e66; }
      .legend-dot { width: 10px; height: 10px; border-radius: 2px; }
      .results-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .result-box { background: rgba(15,13,10,0.6); border: 1px solid #2a2520; border-radius: 8px; padding: 12px; text-align: center; }
      .result-box.full { grid-column: 1 / -1; }
      .result-value { font-family: 'Cinzel', serif; font-size: 24px; font-weight: 700; line-height: 1; }
      .result-value.water { color: #5ba4e6; }
      .result-value.land { color: #8bc34a; }
      .result-value.ratio { color: #c9a94e; }
      .result-label-sm { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: #6d6352; margin-top: 5px; }
      .bar-container { height: 26px; border-radius: 6px; overflow: hidden; display: flex; border: 1px solid #2a2520; margin-top: 12px; }
      .bar-water { background: linear-gradient(180deg, #4a9de0, #2a6aaa); height: 100%; display: flex; align-items: center; justify-content: center; font-family: 'Cinzel', serif; font-size: 11px; color: #fff; letter-spacing: 1px; text-shadow: 0 1px 3px rgba(0,0,0,0.5); transition: width 0.8s; }
      .bar-land { background: linear-gradient(180deg, #7ab33a, #4a7a1a); height: 100%; flex: 1; display: flex; align-items: center; justify-content: center; font-family: 'Cinzel', serif; font-size: 11px; color: #fff; letter-spacing: 1px; text-shadow: 0 1px 3px rgba(0,0,0,0.5); transition: width 0.8s; }

      /* ── Globe tab ── */
      .globe-layout { display: flex; flex: 1; padding: 0 24px 24px; gap: 20px; }
      @media (max-width: 800px) { .globe-layout { flex-direction: column; } }
      .globe-viewport { flex: 1; position: relative; min-height: 480px; border-radius: 12px; overflow: hidden; background: rgba(10,9,7,0.5); border: 1px solid #2a2520; }
      .globe-viewport canvas { display: block; }
      .globe-controls { width: 280px; display: flex; flex-direction: column; gap: 14px; }
      @media (max-width: 800px) { .globe-controls { width: 100%; } }
      .hint-bar { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); background: rgba(12,11,9,0.8); border: 1px solid #2a2520; border-radius: 20px; padding: 6px 18px; font-size: 11px; color: #5a4d36; letter-spacing: 1px; white-space: nowrap; z-index: 3; backdrop-filter: blur(6px); pointer-events: none; }

      /* ── Surveyor tab ── */
      .srv-layout { display: flex; flex: 1; padding: 0 24px 24px; gap: 20px; }
      @media (max-width: 800px) { .srv-layout { flex-direction: column; } }
      .srv-viewport { flex: 1; position: relative; min-height: 480px; border-radius: 12px; overflow: hidden; border: 1px solid #2a2520; background: repeating-conic-gradient(#14110d 0% 25%, #0f0d0a 0% 50%) 0 0 / 24px 24px; }
      .srv-viewport canvas { position: absolute; inset: 0; touch-action: none; }
      .srv-viewport.mode-pan canvas { cursor: grab; }
      .srv-viewport.mode-polygon canvas, .srv-viewport.mode-freehand canvas { cursor: crosshair; }
      .srv-controls { width: 300px; display: flex; flex-direction: column; gap: 14px; }
      @media (max-width: 800px) { .srv-controls { width: 100%; } }
      .srv-field-row { display: flex; gap: 8px; align-items: center; }
      .srv-num { flex: 1; background: #1a1714; border: 1px solid #3a3328; color: #d8c690; font-family: 'Crimson Text', serif; font-size: 15px; padding: 7px 10px; border-radius: 6px; outline: none; min-width: 0; }
      .srv-num:focus { border-color: #c9a94e; }
      .srv-unit { background: #1a1714; border: 1px solid #3a3328; color: #a89670; font-family: 'Cinzel', serif; font-size: 11px; letter-spacing: 1px; padding: 8px 6px; border-radius: 6px; cursor: pointer; outline: none; }
      .srv-stats { font-size: 12.5px; color: #6d6352; line-height: 1.6; margin-top: 8px; }
      .srv-stats b { color: #a89670; font-weight: 600; }
      .srv-sub { font-size: 11px; color: #5a4d36; margin-top: 2px; font-style: italic; }
      .srv-mode-btns { display: flex; gap: 6px; }
      .srv-mode-btn { flex: 1; font-family: 'Cinzel', serif; font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase; padding: 9px 4px; border: 1px solid #3a3328; background: rgba(30,27,22,0.6); color: #6d6352; border-radius: 6px; cursor: pointer; transition: all 0.25s; }
      .srv-mode-btn:hover { border-color: #8a7e66; color: #a89670; }
      .srv-mode-btn.active { border-color: #c9a94e; background: rgba(201,169,78,0.14); color: #c9a94e; }
      .srv-coord { position: absolute; top: 12px; right: 14px; background: rgba(12,11,9,0.82); border: 1px solid #2a2520; border-radius: 6px; padding: 5px 12px; font-size: 12px; color: #8a7e66; z-index: 3; backdrop-filter: blur(6px); pointer-events: none; font-variant-numeric: tabular-nums; }
      .srv-draft { position: absolute; top: 12px; left: 14px; background: rgba(12,11,9,0.85); border: 1px solid rgba(201,169,78,0.4); border-radius: 6px; padding: 6px 14px; font-size: 13px; color: #c9a94e; z-index: 3; backdrop-filter: blur(6px); pointer-events: none; }
      .srv-region-card { border: 1px solid #2a2520; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: rgba(15,13,10,0.5); transition: border-color 0.2s; }
      .srv-region-card:hover { border-color: #5a4d36; }
      .srv-region-head { display: flex; align-items: center; gap: 8px; }
      .srv-region-dot { width: 11px; height: 11px; border-radius: 3px; flex-shrink: 0; }
      .srv-region-name { flex: 1; background: transparent; border: none; border-bottom: 1px solid transparent; color: #d8c690; font-family: 'Cinzel', serif; font-size: 13px; font-weight: 600; letter-spacing: 1px; outline: none; min-width: 0; }
      .srv-region-name:focus { border-bottom-color: #c9a94e; }
      .srv-region-del { background: none; border: none; color: #5a4d36; font-size: 16px; cursor: pointer; padding: 0 2px; line-height: 1; transition: color 0.2s; }
      .srv-region-del:hover { color: #e85050; }
      .srv-region-area { font-size: 16px; color: #c9a94e; margin-top: 5px; }
      .srv-region-meta { font-size: 11.5px; color: #6d6352; font-style: italic; }
      .srv-total-card { border: 1px solid rgba(201,169,78,0.27); border-radius: 8px; padding: 12px 14px; background: rgba(201,169,78,0.06); margin-top: 4px; }
      .srv-total-label { font-family: 'Cinzel', serif; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #8a7e66; }
      .srv-total-value { font-size: 21px; color: #e8d8a0; margin-top: 3px; font-family: 'Cinzel', serif; }
      .srv-total-meta { font-size: 12px; color: #8a7e66; font-style: italic; margin-top: 2px; }

      /* ── Content area ── */
      .content-area { flex: 1; display: flex; flex-direction: column; }
      `}</style>

      <div className="forge-app">
      <div className="forge-header">
      <div className="forge-title">Realm Forge</div>

      </div>

      {!image ? (
        <div
        className={`drop-zone ${dragOver ? "dragover" : ""}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        >
        <div className="drop-icon">🗺️</div>
        <div className="drop-text">Present Your Map</div>
        <div className="drop-hint">Drop an image or click to browse</div>
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
        </div>
      ) : (
        <>
        <div className="map-bar">
        <span>📜</span>
        <span className="map-bar-name">{imageName}</span>
        <button className="map-bar-clear" onClick={clearMap}>✕ Clear</button>
        </div>

        <div className="tab-bar">
        <button className={`tab-btn ${tab === "survey" ? "active" : ""}`} onClick={() => setTab("survey")}>
        Survey
        </button>
        <button className={`tab-btn ${tab === "globe" ? "active" : ""}`} onClick={() => setTab("globe")}>
        Globe
        </button>
        <button className={`tab-btn ${tab === "surveyor" ? "active" : ""}`} onClick={() => setTab("surveyor")}>
        Surveyor
        </button>
        </div>

        <div className="content-area">
        {tab === "survey" && <SurveyPanel imgUrl={image} imgEl={imgEl} />}
        {tab === "globe" && <GlobePanel imgEl={imgEl} northPad={northPad} setNorthPad={setNorthPad} southPad={southPad} setSouthPad={setSouthPad} />}
        {tab === "surveyor" && <SurveyorPanel imgEl={imgEl} northPad={northPad} setNorthPad={setNorthPad} southPad={southPad} setSouthPad={setSouthPad} circumference={circumference} setCircumference={setCircumference} unit={unit} setUnit={setUnit} regions={regions} setRegions={setRegions} />}
        </div>
        </>
      )}
      </div>
      </>
  );
}
