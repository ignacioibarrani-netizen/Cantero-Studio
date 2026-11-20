import { SAMPLE_BG_SRC, BUILTIN_ITEMS } from "./data/catalog.js";
import { solveCameraFromLines } from "./utils/cameraSolver.js";
import { CONTAINER_MATERIALS, getContainerRenderSrc, getContainerRenderMeta, preloadContainerTextures, drawSceneProjectedBox } from "./utils/containerRenderer.js";

const CUSTOM_STORAGE_KEY = "cantero_custom_catalog_v1";

function loadCustomCatalog() {
  try {
    const raw = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCustomCatalog(customItems) {
  try {
    localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(customItems));
  } catch {
    // Ignore storage quota errors
  }
}

// App State
const catalog = [...loadCustomCatalog(), ...BUILTIN_ITEMS];
let activeFilter = "all";
let searchQuery = "";
let bgImage = null;
let layers = [];
let selectedId = null;
let compareMode = false;
let maskMode = false;
let brushSize = 28;
let nextUid = 1;

// Viewer Zoom & Pan State
let viewZoom = 1;
let viewPanX = 0;
let viewPanY = 0;
let spacePressed = false;

// Scale & Perspective State
const undoStack = [];
const MAX_UNDO = 30;

const calibration = {
  pxPerMeter: 195,
  refPxPerMeter: 195,
  refY: 600,
  step: 1, // 1 = Adelante, 2 = Atrás
  frontSample: null, // { y, pxPerM }
  mode: false,
  pts: [] // [{x, y}, {x, y}]
};

const perspective = {
  visible: false,
  autoScale: true,
  showFloorGrid: true,
  fspy: {
    xLine1: [{ x: 0.16, y: 0.86 }, { x: 0.84, y: 0.86 }],
    xLine2: [{ x: 0.25, y: 0.62 }, { x: 0.75, y: 0.62 }],
    yLine1: [{ x: 0.16, y: 0.86 }, { x: 0.30, y: 0.56 }],
    yLine2: [{ x: 0.84, y: 0.86 }, { x: 0.70, y: 0.56 }],
    refLine: [{ x: 0.42, y: 0.78 }, { x: 0.58, y: 0.78 }],
    refMeters: 1.5,
    refType: "auto"
  }
};

// Drag / Resize / Paint / Perspective interaction state
let dragState = null;

// Modals state
let cleanerTargetUid = null;
let pendingContainerItem = null;
let pendingExistingContainerUid = null;
let newPlantImageDataUrl = null;
let catalogTargetContainerUid = null;

const stageWrapper = document.getElementById("stageWrapper");
const canvas = document.getElementById("mainCanvas");
const ctx = canvas.getContext("2d");
const imageCache = new Map();

const tempCanvas = document.createElement("canvas");
const tempCtx = tempCanvas.getContext("2d");

function getScenePerspStrength() {
  return 0.0011;
}

// Hydrate procedural src for built-in containers/soil
function hydrateBuiltinContainers() {
  const ps = getScenePerspStrength();
  for (const item of BUILTIN_ITEMS) {
    if (item.kind === "container") {
      item.src = getContainerRenderSrc({
        shape: item.shape || "cantero_rect",
        material: item.material || "cemento",
        colorId: item.colorId || "gris_claro",
        viewAngle: item.viewAngle || 0,
        viewPitch: item.viewPitch ?? 22,
        perspStrength: ps,
        isGroundSoil: !!item.isGroundSoil,
        mulch: !!item.mulch,
        liters: item.liters ?? 45
      });
    }
  }
}
hydrateBuiltinContainers();

function loadImage(src) {
  if (!src) return Promise.resolve(null);
  if (imageCache.has(src)) return Promise.resolve(imageCache.get(src));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = () => {
      console.warn("No se pudo cargar imagen:", src);
      resolve(null);
    };
    img.src = src;
  });
}


function cloneMaskCanvas(srcCanvas) {
  const c = document.createElement("canvas");
  c.width = srcCanvas.width;
  c.height = srcCanvas.height;
  c.getContext("2d").drawImage(srcCanvas, 0, 0);
  return c;
}

function pushUndoSnapshot() {
  const snap = {
    layers: layers.map(l => ({ ...l, maskCanvas: cloneMaskCanvas(l.maskCanvas) })),
    selectedId,
    calibration: { ...calibration, pts: [] },
    fspy: JSON.parse(JSON.stringify(perspective.fspy))
  };
  undoStack.push(snap);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  const btn = document.getElementById("btnUndo");
  if (btn) btn.disabled = undoStack.length === 0;
}

async function undoLastAction() {
  if (undoStack.length === 0) return;
  const snap = undoStack.pop();
  layers = snap.layers;
  selectedId = snap.selectedId;
  calibration.pxPerMeter = snap.calibration.pxPerMeter;
  calibration.refPxPerMeter = snap.calibration.refPxPerMeter;
  calibration.refY = snap.calibration.refY;
  perspective.fspy = snap.fspy;
  rebuildGroundHomography();
  await Promise.all(layers.map(l => loadImage(l.src)));
  const btn = document.getElementById("btnUndo");
  if (btn) btn.disabled = undoStack.length === 0;
  syncUI();
  draw();
  showToast("Acción deshecha");
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("opacity-0");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("opacity-0"), 2600);
}

// Viewer Zoom & Pan helpers
function applyViewTransform() {
  canvas.style.transform = `translate(${viewPanX}px, ${viewPanY}px) scale(${viewZoom})`;
  document.getElementById("valViewZoom").textContent = `${Math.round(viewZoom * 100)}%`;
}

function setViewerZoom(newZoom, pivotClientX = null, pivotClientY = null) {
  const clamped = Math.max(0.5, Math.min(3.5, newZoom));
  if (pivotClientX !== null && pivotClientY !== null) {
    const wrapRect = stageWrapper.getBoundingClientRect();
    const cx = pivotClientX - (wrapRect.left + wrapRect.width / 2);
    const cy = pivotClientY - (wrapRect.top + wrapRect.height / 2);
    const factor = clamped / viewZoom;
    viewPanX = cx - (cx - viewPanX) * factor;
    viewPanY = cy - (cy - viewPanY) * factor;
  }
  viewZoom = clamped;
  if (Math.abs(viewZoom - 1) < 0.03) {
    rebuildGroundHomography();
    viewZoom = 1;
    viewPanX = 0;
    viewPanY = 0;
  }
  applyViewTransform();
}

stageWrapper.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.89;
  setViewerZoom(viewZoom * factor, e.clientX, e.clientY);
}, { passive: false });

document.getElementById("btnZoomIn").addEventListener("click", () => setViewerZoom(viewZoom * 1.2));
document.getElementById("btnZoomOut").addEventListener("click", () => setViewerZoom(viewZoom * 0.82));
document.getElementById("btnZoomReset").addEventListener("click", () => {
  viewZoom = 1;
  viewPanX = 0;
  viewPanY = 0;
  applyViewTransform();
});

// Perspective & Homography Math

// === fSpy 3D Camera Engine ===
let activeCamera = null;

function rebuildGroundHomography() {
  const cw = canvas.width || 1000;
  const ch = canvas.height || 714;
  const f = perspective.fspy;
  const toPx = (pt) => ({ x: pt.x * cw, y: pt.y * ch });
  activeCamera = solveCameraFromLines({
    cw,
    ch,
    xLine1: [toPx(f.xLine1[0]), toPx(f.xLine1[1])],
    xLine2: [toPx(f.xLine2[0]), toPx(f.xLine2[1])],
    yLine1: [toPx(f.yLine1[0]), toPx(f.yLine1[1])],
    yLine2: [toPx(f.yLine2[0]), toPx(f.yLine2[1])],
    refLine: [toPx(f.refLine[0]), toPx(f.refLine[1])],
    refMeters: f.refMeters || 1.5,
    refType: f.refType || "auto"
  });
}

function groundToScreen(u, v) {
  if (!activeCamera) rebuildGroundHomography();
  return activeCamera ? activeCamera.worldToScreen(u, v, 0) : { x: 0, y: 0 };
}

function worldToScreen(wx, wy, wz = 0) {
  if (!activeCamera) rebuildGroundHomography();
  return activeCamera ? activeCamera.worldToScreen(wx, wy, wz) : { x: 0, y: 0 };
}

function screenToGround(x, y) {
  if (!activeCamera) rebuildGroundHomography();
  const fp = activeCamera ? activeCamera.screenToFloor(x, y) : null;
  return fp ? { u: fp.x, v: fp.y } : { u: 0, v: 0 };
}

function getHomographyPxPerMeterAt(x, y) {
  if (!activeCamera) rebuildGroundHomography();
  return activeCamera ? activeCamera.getPxPerMeterAt(x, y) : 180;
}

function getPerspectiveFactorAtY(yPx, xPx = null) {
  const cx = xPx !== null ? xPx : (canvas.width || 1000) / 2;
  const basePx = getHomographyPxPerMeterAt((canvas.width || 1000) / 2, (canvas.height || 714) * 0.85);
  const localPx = getHomographyPxPerMeterAt(cx, yPx);
  return Math.max(0.15, Math.min(3.0, localPx / Math.max(10, basePx)));
}

function getEffectivePxPerMeterAtXY(xPx, yPx) {
  if (!perspective.autoScale) return calibration.refPxPerMeter || calibration.pxPerMeter;
  return getHomographyPxPerMeterAt(xPx, yPx);
}

function getEffectivePxPerMeterAtFactor(pf) {
  if (!perspective.autoScale) return calibration.refPxPerMeter || calibration.pxPerMeter;
  const basePx = getHomographyPxPerMeterAt((canvas.width || 1000) / 2, (canvas.height || 714) * 0.85);
  return basePx * Math.max(0.15, pf);
}

function heightMToScale(heightM, perspFactor = 1, xPx = null, yPx = null) {
  const ch = canvas.height || 714;
  const effPxPerM = (xPx !== null && yPx !== null)
    ? getEffectivePxPerMeterAtXY(xPx, yPx)
    : getEffectivePxPerMeterAtFactor(perspFactor);
  return (heightM * effPxPerM) / ch;
}

function getLayerWallRatio(layer) {
  if (layer.kind !== "container" || layer.isGroundSoil) return 1;
  const meta = getContainerRenderMeta(layer.src);
  return meta.frontWallRatio || 1;
}

function getLayerRealHeightM(layer) {
  const ch = canvas.height || 714;
  const px = ch * layer.scale * getLayerWallRatio(layer);
  const effPxPerM = perspective.autoScale
    ? (layer.shiftLockedPxPerM || getHomographyPxPerMeterAt(layer.x, layer.y))
    : (calibration.refPxPerMeter || calibration.pxPerMeter);
  return px / Math.max(5, effPxPerM);
}

function getLayerRealWidthM(layer) {
  const rect = getLayerRect(layer);
  const effPxPerM = perspective.autoScale
    ? (layer.shiftLockedPxPerM || getHomographyPxPerMeterAt(layer.x, layer.y))
    : (calibration.refPxPerMeter || calibration.pxPerMeter);
  return rect.w / Math.max(5, effPxPerM);
}

function formatDimM(m) {
  return m >= 1 ? `${m.toFixed(2)} m` : `${Math.round(m * 100)} cm`;
}

function getPotMaxHeightM(item, containerLiters) {
  if (!item || item.kind !== "plant") return Infinity;
  const idealPot = item.idealPotLiters || 50;
  const ratio = Math.min(1.15, Math.pow(Math.max(1, containerLiters) / idealPot, 0.42));
  return Math.max(item.minHeightM || 0.25, (item.idealMaxM || 2.0) * ratio);
}

function formatSubstrateRecommendation(liters) {
  if (liters <= 0) {
    return `<strong>0 L</strong> — Cantero vacío / portamaceta (ideal para colocar macetas adentro sin sustrato suelto).`;
  }
  const bags25 = Math.ceil(liters / 25);
  const drain = Math.round(liters * 0.15);
  const soil = Math.round(liters * 0.60);
  const perlite = Math.max(1, liters - drain - soil);
  return `
    <div class="font-medium text-emerald-300 mb-0.5">Sustrato recomendado: ${liters} L (${bags25} ${bags25 === 1 ? "bolsa" : "bolsas"} de 25 L)</div>
    <div class="text-zinc-400">• Drenaje (leca/pometina): ${drain} L · Tierra fértil: ${soil} L · Perlita/turba: ${perlite} L</div>
  `;
}

function evaluateBotanicalRealism(layer) {
  const item = catalog.find(p => p.id === layer.itemId);
  if (!item || item.kind !== "plant") return { level: "ok", message: "" };

  const hM = getLayerRealHeightM(layer);
  const container = layer.containerUid ? layers.find(l => l.uid === layer.containerUid) : null;

  if (container && !container.isGroundSoil) {
    const potL = container.liters ?? 40;
    if (potL <= 0) {
      return {
        level: "error",
        message: `${container.name} está en 0 L (sin sustrato). Sumale sustrato o poné una maceta adentro.`
      };
    }
    const minPot = item.minPotLiters || 15;
    if (potL < minPot) {
      return {
        level: "error",
        message: `Maceta chica: ${item.name} necesita al menos ${minPot} L para raíces sanas (actual: ${potL} L).`
      };
    }
    const potMax = getPotMaxHeightM(item, potL);
    if (hM > potMax * 1.06) {
      return {
        level: "warn",
        message: `En ${potL} L esta especie suele alcanzar hasta ${potMax.toFixed(2)} m (actual: ${hM.toFixed(2)} m).`
      };
    }
  }

  if (item.maxHeightM && hM > item.maxHeightM) {
    return {
      level: "error",
      message: `Tamaño poco realista: ${item.name} rara vez supera ${item.maxHeightM.toFixed(2)} m (actual: ${hM.toFixed(2)} m).`
    };
  }
  if (item.minHeightM && hM < item.minHeightM) {
    return {
      level: "error",
      message: `Muy chica para ${item.name}: porte mínimo habitual ${item.minHeightM.toFixed(2)} m (actual: ${hM.toFixed(2)} m).`
    };
  }
  if (item.idealMaxM && hM > item.idealMaxM) {
    return {
      level: "warn",
      message: `Porte muy alto (${hM.toFixed(2)} m). Lo habitual es ${item.idealMinM.toFixed(2)}–${item.idealMaxM.toFixed(2)} m.`
    };
  }
  return { level: "ok", message: "" };
}

function clampScaleToPotIfNeeded(layer) {
  if (!layer.respectPotLimit || !layer.containerUid) return;
  const container = layers.find(l => l.uid === layer.containerUid);
  const item = catalog.find(p => p.id === layer.itemId);
  if (!container || container.isGroundSoil || (container.liters ?? 40) <= 0 || !item || item.kind !== "plant") return;
  const maxH = getPotMaxHeightM(item, container.liters || 40);
  const pf = perspective.autoScale ? (layer.perspFactor || 1) : 1;
  const maxScale = heightMToScale(maxH, pf);
  if (layer.scale > maxScale) {
    layer.scale = maxScale;
  }
}

function createLayer(item, xNorm, yNorm, heightMOverride = null, flipOverride = false) {
  const img = imageCache.get(item.src);
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = img ? img.naturalWidth : 500;
  maskCanvas.height = img ? img.naturalHeight : 500;
  const mctx = maskCanvas.getContext("2d");
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);

  const yPx = yNorm * canvas.height;
  const persp = perspective.autoScale ? getPerspectiveFactorAtY(yPx) : 1;
  const targetRealH = heightMOverride !== null ? heightMOverride : (item.defaultHeightM || 1.2);
  const wallRatio = (item.kind === "container" && !item.isGroundSoil) ? (getContainerRenderMeta(item.src).frontWallRatio || 1) : 1;
  const scale = Math.max(0.015, heightMToScale(targetRealH / wallRatio, persp));

  return {
    uid: "layer_" + (nextUid++),
    itemId: item.id,
    kind: item.kind || "plant",
    name: item.name,
    src: item.src,
    origSrc: item.src,
    x: xNorm * canvas.width,
    y: yPx,
    scale,
    perspFactor: persp,
    rotation: 0,
    flip: flipOverride,
    brightness: 100,
    contrast: 100,
    saturation: 100,
    warmth: 0,
    shadowOpacity: item.isGroundSoil ? 20 : 45,
    shadowOffset: 15,
    visible: true,
    locked: false,
    elevationM: 0,
    customWidthM: item.customWidthM || (item.shape === "cantero_rect" ? 1.20 : item.shape === "jardinera_alta" ? 0.90 : item.shape === "tierra_cantero" ? 1.50 : item.shape === "maceta_cubo" ? 0.45 : null),
    customHeightM: item.customHeightM || (item.kind === "container" && !item.isGroundSoil ? (item.defaultHeightM || 0.42) : item.shape === "tierra_cantero" ? 0.14 : null),
    customDepthM: item.customDepthM || (item.shape === "cantero_rect" ? 0.45 : item.shape === "jardinera_alta" ? 0.35 : item.shape === "tierra_cantero" ? 0.65 : item.shape === "maceta_cubo" ? 0.45 : null),
    liters: item.liters ?? 45,
    isGroundSoil: !!item.isGroundSoil,
    shape: item.shape || "cantero_rect",
    material: item.material || "cemento",
    colorId: item.colorId || "gris_claro",
    viewAngle: item.viewAngle ?? 0,
    viewPitch: item.viewPitch ?? 22,
    mulch: !!item.mulch,
    containerUid: null,
    parentContainerUid: null,
    respectPotLimit: true,
    maskCanvas
  };
}

function isHomographyBox(layer) {
  return (
    layer &&
    layer.kind === "container" &&
    (layer.shape === "cantero_rect" || layer.shape === "maceta_cubo" || layer.shape === "jardinera_alta" || layer.shape === "tierra_cantero") &&
    perspective.autoScale &&
    activeCamera
  );
}

function getLayerRect(layer) {
  if (isHomographyBox(layer) && layer._lastProjRect) {
    return layer._lastProjRect;
  }
  const img = imageCache.get(layer.src);
  if (!img) return { x: 0, y: 0, w: 0, h: 0 };
  const baseH = canvas.height * layer.scale;
  const aspect = img.naturalWidth / img.naturalHeight;
  const w = baseH * aspect;
  const h = baseH;
  const elevPx = (layer.elevationM || 0) * getHomographyPxPerMeterAt(layer.x, layer.y);
  return {
    x: layer.x - w / 2,
    y: layer.y - elevPx - h,
    w,
    h
  };
}

function getSelectedLayer() {
  return layers.find(l => l.uid === selectedId) || null;
}

// Hierarchy helpers (Cantero -> Maceta -> Planta)
function getDirectChildren(parentUid) {
  return layers.filter(l => l.containerUid === parentUid || l.parentContainerUid === parentUid);
}

function getAllDescendants(parentUid) {
  const result = [];
  const stack = [...getDirectChildren(parentUid)];
  while (stack.length) {
    const child = stack.shift();
    if (!result.includes(child)) {
      result.push(child);
      stack.push(...getDirectChildren(child.uid));
    }
  }
  return result;
}

function getRootContainer(layer) {
  let curr = layer;
  const seen = new Set([curr.uid]);
  while (true) {
    const pUid = curr.containerUid || curr.parentContainerUid;
    if (!pUid || seen.has(pUid)) break;
    const parent = layers.find(l => l.uid === pUid);
    if (!parent) break;
    seen.add(parent.uid);
    curr = parent;
  }
  return curr;
}

function detectContainerUnderLayer(targetLayer) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const c = layers[i];
    if (c.uid === targetLayer.uid || c.kind !== "container" || !c.visible) continue;
    // Prevent circular containment
    if (getAllDescendants(targetLayer.uid).some(d => d.uid === c.uid)) continue;
    const rect = getLayerRect(c);
    if (
      targetLayer.x >= rect.x &&
      targetLayer.x <= rect.x + rect.w &&
      targetLayer.y >= rect.y - rect.h * 0.15 &&
      targetLayer.y <= rect.y + rect.h * 0.75
    ) {
      return c;
    }
  }
  return null;
}

function renderScene(targetCtx, forExport = false) {
  const cw = canvas.width;
  const ch = canvas.height;
  targetCtx.clearRect(0, 0, cw, ch);

  if (bgImage) {
    targetCtx.drawImage(bgImage, 0, 0, cw, ch);
  } else {
    targetCtx.fillStyle = "#18181b";
    targetCtx.fillRect(0, 0, cw, ch);
  }

  if (compareMode && !forExport) return;

  if (!forExport && perspective.visible) {
    drawPerspectiveGrid(targetCtx, cw, ch);
  }

  for (const layer of layers) {
    if (!layer.visible) continue;

    if (isHomographyBox(layer)) {
      const { u, v } = screenToGround(layer.x, layer.y);
      const proj = drawSceneProjectedBox(targetCtx, {
        centerU: u,
        centerV: v,
        widthM: layer.customWidthM || 1.2,
        heightM: layer.customHeightM || 0.42,
        depthM: layer.customDepthM || 0.45,
        yawDeg: layer.viewAngle || 0,
        elevationM: layer.elevationM || 0,
        material: layer.material || "cemento",
        colorId: layer.colorId || "gris_claro",
        isGroundSoil: !!layer.isGroundSoil,
        mulch: !!layer.mulch,
        liters: layer.liters ?? 45,
        brightness: layer.brightness,
        contrast: layer.contrast,
        saturation: layer.saturation,
        warmth: layer.warmth,
        groundToScreen,
        worldToScreen,
        getPxPerMeterAt: getHomographyPxPerMeterAt
      });
      layer._lastProjRect = proj;

      if (layer.shadowOpacity > 0 && proj.floorPts) {
        targetCtx.save();
        targetCtx.fillStyle = `rgba(10, 15, 10, ${(layer.shadowOpacity / 100) * 0.35})`;
        targetCtx.beginPath();
        proj.floorPts.forEach(([fx, fy], i) => (i === 0 ? targetCtx.moveTo(fx + 6, fy + 4) : targetCtx.lineTo(fx + 6, fy + 4)));
        targetCtx.closePath();
        targetCtx.fill();
        targetCtx.restore();
      }
      continue;
    }

    const img = imageCache.get(layer.src);
    if (!img) continue;

    const rect = getLayerRect(layer);

    if (layer.shadowOpacity > 0) {
      targetCtx.save();
      const shadowAlpha = (layer.shadowOpacity / 100) * 0.65 * Math.max(0.35, 1 - (layer.elevationM || 0) * 0.25);
      const sx = layer.x + (layer.shadowOffset * rect.w * 0.004);
      const sy = layer.y - rect.h * 0.02;
      const rx = rect.w * 0.42;
      const ry = Math.max(6, rect.h * 0.06);
      const grad = targetCtx.createRadialGradient(sx, sy, rx * 0.1, sx, sy, rx);
      grad.addColorStop(0, `rgba(10, 15, 10, ${shadowAlpha})`);
      grad.addColorStop(0.65, `rgba(10, 15, 10, ${shadowAlpha * 0.45})`);
      grad.addColorStop(1, "rgba(10, 15, 10, 0)");
      targetCtx.fillStyle = grad;
      targetCtx.beginPath();
      targetCtx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.restore();
    }

    const tw = Math.max(1, Math.round(rect.w));
    const th = Math.max(1, Math.round(rect.h));
    tempCanvas.width = tw;
    tempCanvas.height = th;
    tempCtx.clearRect(0, 0, tw, th);

    const sepiaAmt = layer.warmth > 0 ? layer.warmth * 0.8 : 0;
    const hueAmt = layer.warmth < 0 ? layer.warmth * 0.7 : 0;
    tempCtx.filter = `brightness(${layer.brightness}%) contrast(${layer.contrast}%) saturate(${layer.saturation}%) sepia(${sepiaAmt}%) hue-rotate(${hueAmt}deg)`;
    tempCtx.drawImage(img, 0, 0, tw, th);
    tempCtx.filter = "none";

    tempCtx.globalCompositeOperation = "destination-in";
    tempCtx.drawImage(layer.maskCanvas, 0, 0, tw, th);
    tempCtx.globalCompositeOperation = "source-over";

    const elevPx = (layer.elevationM || 0) * getHomographyPxPerMeterAt(layer.x, layer.y);
    targetCtx.save();
    targetCtx.translate(layer.x, layer.y - elevPx);
    targetCtx.rotate((layer.rotation * Math.PI) / 180);
    if (layer.flip) targetCtx.scale(-1, 1);
    targetCtx.drawImage(tempCanvas, -rect.w / 2, -rect.h, rect.w, rect.h);
    targetCtx.restore();
  }

  if (forExport) return;

  // Vertical Shift-Lock Guide Line
  if (dragState && dragState.type === "move" && dragState.shiftLocked) {
    const l = dragState.layer;
    targetCtx.save();
    targetCtx.strokeStyle = "rgba(56, 189, 248, 0.9)";
    targetCtx.lineWidth = Math.max(2, cw / 500);
    targetCtx.setLineDash([7, 5]);
    targetCtx.beginPath();
    targetCtx.moveTo(l.x, 0);
    targetCtx.lineTo(l.x, ch);
    targetCtx.stroke();
    targetCtx.setLineDash([]);

    const fontSize = Math.max(16, Math.round(cw / 65));
    targetCtx.font = `600 ${fontSize}px Inter, sans-serif`;
    const badgeText = "Solo vertical (Shift) · sin profundidad";
    const bw = targetCtx.measureText(badgeText).width + 20;
    const bh = fontSize + 12;
    const bx = Math.min(cw - bw - 10, Math.max(10, l.x + 14));
    const by = Math.max(10, l.y - bh - 10);
    targetCtx.fillStyle = "rgba(15, 23, 42, 0.94)";
    targetCtx.beginPath();
    targetCtx.roundRect(bx, by, bw, bh, 6);
    targetCtx.fill();
    targetCtx.fillStyle = "#38bdf8";
    targetCtx.fillText(badgeText, bx + 10, by + fontSize + 2);
    targetCtx.restore();
  }

  // Calibration 2-point line
  if (calibration.mode && calibration.pts.length > 0) {
    targetCtx.save();
    targetCtx.strokeStyle = "#38bdf8";
    targetCtx.fillStyle = "#38bdf8";
    targetCtx.lineWidth = Math.max(3, cw / 380);
    for (const p of calibration.pts) {
      targetCtx.beginPath();
      targetCtx.arc(p.x, p.y, Math.max(7, cw / 140), 0, Math.PI * 2);
      targetCtx.fill();
    }
    if (calibration.pts.length === 2) {
      const [p1, p2] = calibration.pts;
      targetCtx.beginPath();
      targetCtx.moveTo(p1.x, p1.y);
      targetCtx.lineTo(p2.x, p2.y);
      targetCtx.stroke();
    }
    targetCtx.restore();
  }

  // Selection bounding box, Ground-Contact Indicator & Exact Dimension Pill
  const sel = getSelectedLayer();
  if (sel && sel.visible && !sel.locked) {
    const rect = getLayerRect(sel);
    const realism = evaluateBotanicalRealism(sel);
    const strokeCol = maskMode
      ? "#fbbf24"
      : realism.level === "error"
      ? "#ef4444"
      : realism.level === "warn"
      ? "#f59e0b"
      : "#34d399";

    const elevM = sel.elevationM || 0;
    const ppm = getHomographyPxPerMeterAt(sel.x, sel.y);
    const elevPx = elevM * ppm;

    targetCtx.save();
    if (isHomographyBox(sel) && rect.floorPts) {
      targetCtx.strokeStyle = elevM > 0.02 ? "#38bdf8" : "#10b981";
      targetCtx.lineWidth = 2.5;
      targetCtx.beginPath();
      rect.floorPts.forEach(([fx, fy], i) => (i === 0 ? targetCtx.moveTo(fx, fy) : targetCtx.lineTo(fx, fy)));
      targetCtx.closePath();
      targetCtx.stroke();
    } else {
      targetCtx.strokeStyle = elevM > 0.02 ? "#38bdf8" : "#10b981";
      targetCtx.lineWidth = 2.5;
      targetCtx.beginPath();
      targetCtx.ellipse(sel.x, sel.y, Math.max(14, rect.w * 0.28), Math.max(5, rect.w * 0.08), 0, 0, Math.PI * 2);
      targetCtx.stroke();
    }
    if (elevM > 0.02) {
      targetCtx.setLineDash([5, 4]);
      targetCtx.strokeStyle = "#38bdf8";
      targetCtx.beginPath();
      targetCtx.moveTo(sel.x, sel.y);
      targetCtx.lineTo(sel.x, sel.y - elevPx);
      targetCtx.stroke();
      targetCtx.setLineDash([]);
    }
    targetCtx.restore();

    targetCtx.save();
    targetCtx.strokeStyle = strokeCol;
    targetCtx.lineWidth = Math.max(2.5, cw / 420);
    targetCtx.setLineDash([8, 5]);
    targetCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    targetCtx.setLineDash([]);

    let label;
    if (isHomographyBox(sel)) {
      label = `${formatDimM(sel.customWidthM || 1.2)} × ${formatDimM(sel.customHeightM || 0.42)} × ${formatDimM(sel.customDepthM || 0.45)}`;
    } else {
      const hM = getLayerRealHeightM(sel);
      const wM = getLayerRealWidthM(sel);
      label = `${formatDimM(hM)} × ${formatDimM(wM)}`;
    }
    label += elevM > 0.02 ? ` · +${formatDimM(elevM)}` : " · Apoyado";
    if (realism.level !== "ok") label += " !";

    const fontSize = Math.max(18, Math.round(cw / 50));
    targetCtx.font = `700 ${fontSize}px Inter, sans-serif`;
    const padX = Math.round(fontSize * 0.55);
    const tw = targetCtx.measureText(label).width + padX * 2;
    const th = fontSize + 12;
    const pillX = Math.max(6, Math.min(cw - tw - 6, rect.x));
    const pillY = Math.max(6, rect.y - th - 6);

    targetCtx.fillStyle = "rgba(9, 9, 11, 0.92)";
    targetCtx.strokeStyle = strokeCol;
    targetCtx.lineWidth = 2;
    targetCtx.beginPath();
    targetCtx.roundRect(pillX, pillY, tw, th, 7);
    targetCtx.fill();
    targetCtx.stroke();
    targetCtx.fillStyle = strokeCol;
    targetCtx.fillText(label, pillX + padX, pillY + fontSize + 1);

    if (!maskMode && !isHomographyBox(sel)) {
      const handleR = Math.max(8, cw / 120);
      const corners = [
        [rect.x, rect.y],
        [rect.x + rect.w, rect.y],
        [rect.x, rect.y + rect.h],
        [rect.x + rect.w, rect.y + rect.h]
      ];
      for (const [cx, cy] of corners) {
        targetCtx.fillStyle = "#ffffff";
        targetCtx.strokeStyle = "#059669";
        targetCtx.lineWidth = 2.5;
        targetCtx.beginPath();
        targetCtx.arc(cx, cy, handleR, 0, Math.PI * 2);
        targetCtx.fill();
        targetCtx.stroke();
      }
    }
    targetCtx.restore();
  }

  drawScaleBar(targetCtx, cw, ch);
}

function drawScaleBar(targetCtx, cw, ch) {
  const px1m = calibration.refPxPerMeter || calibration.pxPerMeter;
  if (!px1m || px1m <= 10) return;
  const barPx = Math.min(cw * 0.32, px1m);
  const metersShown = barPx / px1m;
  const fontSize = Math.max(15, Math.round(cw / 65));
  const x0 = 18;
  const y0 = fontSize + 24;

  targetCtx.save();
  targetCtx.fillStyle = "rgba(9, 9, 11, 0.86)";
  targetCtx.beginPath();
  targetCtx.roundRect(x0 - 10, 10, barPx + 22, fontSize + 22, 7);
  targetCtx.fill();

  targetCtx.strokeStyle = "#38bdf8";
  targetCtx.lineWidth = 3;
  targetCtx.beginPath();
  targetCtx.moveTo(x0, y0 - 7);
  targetCtx.lineTo(x0, y0);
  targetCtx.lineTo(x0 + barPx, y0);
  targetCtx.lineTo(x0 + barPx, y0 - 7);
  targetCtx.stroke();

  targetCtx.fillStyle = "#f4f4f5";
  targetCtx.font = `700 ${fontSize}px Inter, sans-serif`;
  targetCtx.fillText(`${metersShown.toFixed(2)} m`, x0 + 6, y0 - 8);
  targetCtx.restore();
}

function drawPerspectiveGrid(targetCtx, cw, ch) {
  if (!activeCamera) rebuildGroundHomography();
  const cam = activeCamera;
  if (!cam) return;

  targetCtx.save();

  // 1. Optional 1m x 1m 3D floor grid centered on visible floor
  if (perspective.showFloorGrid) {
    const centerFloor = cam.screenToFloor(cw * 0.5, ch * 0.72) || { x: 0, y: 4 };
    const cx0 = Math.round(centerFloor.x);
    const cy0 = Math.round(centerFloor.y);
    const span = 6;

    // Subtle horizon line
    const hyL = cam.horizonY(0);
    const hyR = cam.horizonY(cw);
    targetCtx.strokeStyle = "rgba(167, 139, 250, 0.35)";
    targetCtx.lineWidth = 1.5;
    targetCtx.setLineDash([6, 6]);
    targetCtx.beginPath();
    targetCtx.moveTo(0, hyL);
    targetCtx.lineTo(cw, hyR);
    targetCtx.stroke();
    targetCtx.setLineDash([]);

    targetCtx.strokeStyle = "rgba(167, 139, 250, 0.45)";
    targetCtx.lineWidth = Math.max(1.5, cw / 650);
    for (let u = cx0 - span; u <= cx0 + span; u += 1) {
      const a = cam.worldToScreen(u, cy0 - span, 0);
      const b = cam.worldToScreen(u, cy0 + span, 0);
      if (a.z > 0.1 && b.z > 0.1) {
        targetCtx.beginPath();
        targetCtx.moveTo(a.x, a.y);
        targetCtx.lineTo(b.x, b.y);
        targetCtx.stroke();
      }
    }
    for (let v = cy0 - span; v <= cy0 + span; v += 1) {
      const a = cam.worldToScreen(cx0 - span, v, 0);
      const b = cam.worldToScreen(cx0 + span, v, 0);
      if (a.z > 0.1 && b.z > 0.1) {
        targetCtx.beginPath();
        targetCtx.moveTo(a.x, a.y);
        targetCtx.lineTo(b.x, b.y);
        targetCtx.stroke();
      }
    }
  }

  // 2. Draw fSpy Vanishing Lines (2 Red X, 2 Green Y, 1 Blue Ref)
  const f = perspective.fspy;
  const lineSpecs = [
    { key: "xLine1", pts: f.xLine1, color: "#ef4444", label: "X1" },
    { key: "xLine2", pts: f.xLine2, color: "#ef4444", label: "X2" },
    { key: "yLine1", pts: f.yLine1, color: "#10b981", label: "Y1" },
    { key: "yLine2", pts: f.yLine2, color: "#10b981", label: "Y2" },
    { key: "refLine", pts: f.refLine, color: "#38bdf8", label: `${(f.refMeters || 1.5).toFixed(2)}m` }
  ];

  const handleR = Math.max(8, cw / 115);
  const fSize = Math.max(13, Math.round(cw / 78));
  targetCtx.font = `700 ${fSize}px Inter, sans-serif`;

  for (const spec of lineSpecs) {
    const p0 = { x: spec.pts[0].x * cw, y: spec.pts[0].y * ch };
    const p1 = { x: spec.pts[1].x * cw, y: spec.pts[1].y * ch };

    // Dark contrast halo + bright line
    targetCtx.strokeStyle = "rgba(0,0,0,0.7)";
    targetCtx.lineWidth = Math.max(5, cw / 230);
    targetCtx.beginPath();
    targetCtx.moveTo(p0.x, p0.y);
    targetCtx.lineTo(p1.x, p1.y);
    targetCtx.stroke();

    targetCtx.strokeStyle = spec.color;
    targetCtx.lineWidth = Math.max(2.5, cw / 400);
    targetCtx.beginPath();
    targetCtx.moveTo(p0.x, p0.y);
    targetCtx.lineTo(p1.x, p1.y);
    targetCtx.stroke();

    for (const pt of [p0, p1]) {
      targetCtx.fillStyle = spec.color;
      targetCtx.strokeStyle = "#ffffff";
      targetCtx.lineWidth = 2.5;
      targetCtx.beginPath();
      targetCtx.arc(pt.x, pt.y, handleR, 0, Math.PI * 2);
      targetCtx.fill();
      targetCtx.stroke();
    }

    // Midpoint label
    const mx = (p0.x + p1.x) / 2;
    const my = (p0.y + p1.y) / 2;
    const tw = targetCtx.measureText(spec.label).width + 10;
    targetCtx.fillStyle = "rgba(9, 9, 11, 0.88)";
    targetCtx.beginPath();
    targetCtx.roundRect(mx - tw / 2, my - fSize / 2 - 4, tw, fSize + 8, 4);
    targetCtx.fill();
    targetCtx.fillStyle = spec.color;
    targetCtx.fillText(spec.label, mx - tw / 2 + 5, my + fSize / 2 - 1);
  }

  targetCtx.restore();
}

function draw() {
  renderScene(ctx, false);
}

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function toLayerLocal(layer, cx, cy) {
  const dx = cx - layer.x;
  const dy = cy - layer.y;
  const rad = (-layer.rotation * Math.PI) / 180;
  return {
    rx: dx * Math.cos(rad) - dy * Math.sin(rad),
    ry: dx * Math.sin(rad) + dy * Math.cos(rad)
  };
}

function paintMaskAt(layer, cx, cy) {
  const rect = getLayerRect(layer);
  const { rx, ry } = toLayerLocal(layer, cx, cy);
  let u = (rx + rect.w / 2) / rect.w;
  if (layer.flip) u = 1 - u;
  const v = (ry + rect.h) / rect.h;
  if (u < -0.1 || u > 1.1 || v < -0.1 || v > 1.1) return;

  const mctx = layer.maskCanvas.getContext("2d");
  const mx = u * layer.maskCanvas.width;
  const my = v * layer.maskCanvas.height;
  const mr = (brushSize / rect.w) * layer.maskCanvas.width;

  mctx.save();
  mctx.globalCompositeOperation = "destination-out";
  const grad = mctx.createRadialGradient(mx, my, mr * 0.35, mx, my, mr);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  mctx.fillStyle = grad;
  mctx.beginPath();
  mctx.arc(mx, my, mr, 0, Math.PI * 2);
  mctx.fill();
  mctx.restore();
  draw();
}

// Canvas Pointer Events
canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 1 || spacePressed) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    dragState = {
      type: "pan",
      startClientX: e.clientX,
      startClientY: e.clientY,
      origPanX: viewPanX,
      origPanY: viewPanY
    };
    canvas.style.cursor = "move";
    return;
  }

  if (compareMode) return;
  canvas.setPointerCapture(e.pointerId);
  const { x, y } = getCanvasCoords(e);

  // 1. Calibration 2-point mode
  if (calibration.mode) {
    if (calibration.pts.length >= 2) calibration.pts = [];
    calibration.pts.push({ x, y });
    if (calibration.pts.length === 2) {
      document.getElementById("calibratePromptText").textContent = "Ingresá la medida real entre los 2 puntos:";
      document.getElementById("calibrateInputGroup").classList.remove("hidden");
      document.getElementById("calibrateInputGroup").classList.add("flex");
    }
    draw();
    return;
  }

  // 2. fSpy vanishing line handles
  if (perspective.visible) {
    const tol = Math.max(20, canvas.width / 48);
    const f = perspective.fspy;
    for (const lineKey of ["refLine", "xLine1", "xLine2", "yLine1", "yLine2"]) {
      for (let idx = 0; idx < 2; idx++) {
        const px = f[lineKey][idx].x * canvas.width;
        const py = f[lineKey][idx].y * canvas.height;
        if (Math.hypot(x - px, y - py) <= tol) {
          pushUndoSnapshot();
          dragState = { type: "fspy", lineKey, idx };
          return;
        }
      }
    }
  }

  // 3. Mask brush mode
  const sel = getSelectedLayer();
  if (maskMode && sel) {
    dragState = { type: "mask", layer: sel };
    paintMaskAt(sel, x, y);
    return;
  }

  // 4. Corner scale handles of selected layer
  if (sel && sel.visible && !sel.locked) {
    const rect = getLayerRect(sel);
    const { rx, ry } = toLayerLocal(sel, x, y);
    const tol = Math.max(16, canvas.width / 60);
    const corners = [
      [-rect.w / 2, -rect.h],
      [rect.w / 2, -rect.h],
      [-rect.w / 2, 0],
      [rect.w / 2, 0]
    ];
    for (const [hx, hy] of corners) {
      if (Math.hypot(rx - hx, ry - hy) <= tol) {
        const distStart = Math.max(10, Math.hypot(x - sel.x, y - (sel.y - rect.h / 2)));
        pushUndoSnapshot();
        dragState = { type: "scale", layer: sel, origScale: sel.scale, distStart };
        return;
      }
    }
  }

  // 5. Hit test layers top-to-bottom
  let hitLayer = null;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible || l.locked) continue;
    const rect = getLayerRect(l);
    if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
      hitLayer = l;
      break;
    }
  }

  if (hitLayer) {
    pushUndoSnapshot();
    selectedId = hitLayer.uid;
    // Move hitLayer + its descendants (plant -> only plant; maceta -> maceta + plants; cantero -> all inside)
    const group = e.altKey ? [hitLayer] : [hitLayer, ...getAllDescendants(hitLayer.uid)];
    for (const m of group) m._dragStartElevM = m.elevationM || 0;
    if (e.altKey && (hitLayer.containerUid || hitLayer.parentContainerUid)) {
      hitLayer.containerUid = null;
      hitLayer.parentContainerUid = null;
      showToast(`${hitLayer.name} separada del contenedor`);
    }

    dragState = {
      type: "move",
      layer: hitLayer,
      anchor: hitLayer,
      group,
      startX: hitLayer.x,
      startY: hitLayer.y,
      startMouseY: y,
      lastX: hitLayer.x,
      lastY: hitLayer.y,
      offsetX: x - hitLayer.x,
      offsetY: y - hitLayer.y,
      prevPxPerM: perspective.autoScale ? (hitLayer.shiftLockedPxPerM || getHomographyPxPerMeterAt(hitLayer.x, hitLayer.y)) : 195,
      shiftLocked: false
    };
    canvas.style.cursor = "grabbing";
  } else {
    selectedId = null;
  }
  syncUI();
  draw();
});

canvas.addEventListener("pointermove", (e) => {
  if (!dragState) return;
  if (dragState.type === "pan") {
    viewPanX = dragState.origPanX + (e.clientX - dragState.startClientX);
    viewPanY = dragState.origPanY + (e.clientY - dragState.startClientY);
    applyViewTransform();
    return;
  }

  const { x, y } = getCanvasCoords(e);

  if (dragState.type === "fspy") {
    const pt = perspective.fspy[dragState.lineKey][dragState.idx];
    pt.x = Math.max(0.01, Math.min(0.99, x / canvas.width));
    pt.y = Math.max(0.01, Math.min(0.99, y / canvas.height));
    rebuildGroundHomography();
    draw();
  } else if (dragState.type === "mask") {
    paintMaskAt(dragState.layer, x, y);
  } else if (dragState.type === "move") {
    const anchor = dragState.anchor;
    let targetX, targetY;
    if (e.shiftKey) {
      targetX = dragState.startX;
      targetY = dragState.startY;
      dragState.shiftLocked = true;
      const ppm = getHomographyPxPerMeterAt(dragState.startX, dragState.startY);
      const deltaElevM = (dragState.startMouseY - y) / Math.max(15, ppm);
      for (const member of dragState.group) {
        const baseElev = member._dragStartElevM ?? 0;
        member.elevationM = Math.max(0, +(baseElev + deltaElevM).toFixed(3));
      }
    } else {
      targetX = x - dragState.offsetX;
      targetY = y - dragState.offsetY;
      dragState.shiftLocked = false;
    }

    const dx = targetX - dragState.lastX;
    const dy = targetY - dragState.lastY;
    dragState.lastX = targetX;
    dragState.lastY = targetY;

    let scaleRatio = 1;
    if (!e.shiftKey && perspective.autoScale) {
      const newPxM = getHomographyPxPerMeterAt(targetX, targetY);
      const prevPxM = dragState.prevPxPerM || newPxM;
      if (prevPxM > 5) {
        scaleRatio = newPxM / prevPxM;
      }
      dragState.prevPxPerM = newPxM;
      for (const member of dragState.group) {
        member.shiftLockedPxPerM = null;
      }
    } else if (e.shiftKey) {
      for (const member of dragState.group) {
        if (!member.shiftLockedPxPerM) {
          member.shiftLockedPxPerM = getHomographyPxPerMeterAt(member.x, member.y);
        }
      }
      dragState.prevPxPerM = getHomographyPxPerMeterAt(targetX, targetY);
    }

    for (const member of dragState.group) {
      member.x += dx;
      member.y += dy;
      if (scaleRatio !== 1) {
        member.scale = Math.max(0.015, Math.min(4.0, member.scale * scaleRatio));
        member.perspFactor = getPerspectiveFactorAtY(member.y, member.x);
        clampScaleToPotIfNeeded(member);
      }
    }

    syncInspectorValues();
    draw();
  } else if (dragState.type === "scale") {
    const l = dragState.layer;
    const rect = getLayerRect(l);
    const distNow = Math.max(10, Math.hypot(x - l.x, y - (l.y - rect.h / 2)));
    const factor = distNow / dragState.distStart;
    const prevScale = l.scale;
    l.scale = Math.max(0.015, Math.min(4.0, dragState.origScale * factor));
    if (l.kind === "container" && !l.isGroundSoil && prevScale > 0) {
      const stepRatio = l.scale / prevScale;
      if (l.customWidthM) l.customWidthM = +(l.customWidthM * stepRatio).toFixed(2);
      if (l.customHeightM) l.customHeightM = +(l.customHeightM * stepRatio).toFixed(2);
      if (l.customDepthM) l.customDepthM = +(l.customDepthM * stepRatio).toFixed(2);
    }
    clampScaleToPotIfNeeded(l);
    syncInspectorValues();
    draw();
  }
});

async function refreshAllContainersPerspective() {
  const conts = layers.filter(l => l.kind === "container");
  for (const c of conts) {
    await refreshContainerLayerAppearance(c);
  }
}

function endDrag() {
  if (dragState && dragState.type === "persp") {
    refreshAllContainersPerspective();
  } else if (dragState && dragState.type === "move") {
    const l = dragState.layer;
    if (l.kind === "plant" && !l.containerUid) {
      const found = detectContainerUnderLayer(l);
      if (found) {
        l.containerUid = found.uid;
        clampScaleToPotIfNeeded(l);
        showToast(found.isGroundSoil ? `${l.name} ubicada en ${found.name}` : `${l.name} ubicada en ${found.name} (${found.liters} L)`);
        syncUI();
      }
    } else if (l.kind === "container" && !l.isGroundSoil && !l.parentContainerUid) {
      const found = detectContainerUnderLayer(l);
      if (found && found.uid !== l.uid) {
        l.parentContainerUid = found.uid;
        showToast(`${l.name} ubicada dentro de ${found.name}`);
        syncUI();
      }
    }
  }
  dragState = null;
  canvas.style.cursor = maskMode || calibration.mode ? "crosshair" : spacePressed ? "move" : "grab";
  draw();
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

document.getElementById("btnUndo").addEventListener("click", undoLastAction);

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undoLastAction();
    return;
  }
  if (e.code === "Space") {
    spacePressed = true;
    canvas.style.cursor = "move";
  } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
    e.preventDefault();
    deleteSelectedLayer();
  } else if (e.key === "Escape") {
    if (maskMode) setMaskMode(false);
    if (calibration.mode) setCalibrationMode(false);
    document.getElementById("potPlantPickerModal").classList.add("hidden");
    document.getElementById("addPlantModal").classList.add("hidden");
    document.getElementById("specSheetModal").classList.add("hidden");
    document.getElementById("perspectiveGuideModal").classList.add("hidden");
  }
});

window.addEventListener("keyup", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undoLastAction();
    return;
  }
  if (e.code === "Space") {
    spacePressed = false;
    canvas.style.cursor = maskMode || calibration.mode ? "crosshair" : "grab";
  }
});


function showBlockedActionModal({ title, message, buttons }) {
  const modal = document.getElementById("blockedActionModal");
  document.getElementById("blockedActionTitle").textContent = title;
  document.getElementById("blockedActionMsg").textContent = message;
  const btnWrap = document.getElementById("blockedActionButtons");
  btnWrap.innerHTML = "";
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = b.primary
      ? "px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition"
      : "px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-200 transition";
    btn.textContent = b.label;
    btn.addEventListener("click", async () => {
      modal.classList.add("hidden");
      if (b.onClick) await b.onClick();
    });
    btnWrap.appendChild(btn);
  }
  modal.classList.remove("hidden");
}

async function ensureContainerHasSubstrateOrResolve(containerLayer, onResolved) {
  if (!containerLayer || containerLayer.isGroundSoil || (containerLayer.liters ?? 45) > 0) {
    return true;
  }
  const catItem = catalog.find(i => i.id === containerLayer.itemId);
  const defaultLiters = catItem?.liters && catItem.liters > 0 ? catItem.liters : 150;
  showBlockedActionModal({
    title: `${containerLayer.name} no tiene sustrato (0 L)`,
    message: `No podés plantar directo en un cantero con 0 L de sustrato. Agregale sustrato o meté una maceta con tierra adentro.`,
    buttons: [
      {
        label: `+ Agregar sustrato (${defaultLiters} L)`,
        primary: true,
        onClick: async () => {
          containerLayer.liters = defaultLiters;
          await refreshContainerLayerAppearance(containerLayer);
          syncUI();
          showToast(`Sustrato agregado: ${defaultLiters} L`);
          if (onResolved) await onResolved();
        }
      },
      {
        label: "Elegir maceta para meter adentro",
        primary: false,
        onClick: () => {
          activeFilter = "macetas";
          document.querySelectorAll(".filter-btn").forEach(b => {
            b.className = b.dataset.filter === "macetas"
              ? "filter-btn px-1 py-1 rounded text-[10px] font-medium bg-emerald-600 text-white"
              : "filter-btn px-1 py-1 rounded text-[10px] font-medium text-zinc-400 hover:text-zinc-200";
          });
          renderCatalog();
          showToast("Elegí una maceta del catálogo para meterla en el cantero");
        }
      },
      { label: "Cancelar", primary: false }
    ]
  });
  return false;
}

// Helper: place plant inside a container layer
async function addPlantInsideContainer(plantItem, containerLayer) {
  const ok = await ensureContainerHasSubstrateOrResolve(containerLayer, () => addPlantInsideContainer(plantItem, containerLayer));
  if (!ok) return;
  await loadImage(plantItem.src);
  const cItem = catalog.find(x => x.id === containerLayer.itemId);
  const cRect = getLayerRect(containerLayer);
  const soilRatio = cItem?.soilTopRatio ?? 0.2;
  const targetY = cRect.y + cRect.h * soilRatio;
  const xNorm = containerLayer.x / canvas.width;
  const yNorm = Math.max(0.1, Math.min(0.96, targetY / canvas.height));

  const plantLayer = createLayer(plantItem, xNorm, yNorm);
  plantLayer.containerUid = containerLayer.uid;
  clampScaleToPotIfNeeded(plantLayer);

  const cIdx = layers.findIndex(l => l.uid === containerLayer.uid);
  if (cIdx >= 0) {
    layers.splice(cIdx + 1, 0, plantLayer);
  } else {
    layers.push(plantLayer);
  }
  selectedId = plantLayer.uid;
  setMaskMode(false);
  syncUI();
  draw();
  showToast(`${plantItem.name} plantada en ${containerLayer.name}`);
}

// Pot + Plant Picker Modal
function openPotPlantPicker(containerItem = null, existingContainerUid = null) {
  pendingContainerItem = containerItem;
  pendingExistingContainerUid = existingContainerUid;

  const modal = document.getElementById("potPlantPickerModal");
  const title = document.getElementById("potPickerTitle");
  const sub = document.getElementById("potPickerSubtitle");
  const emptyBtn = document.getElementById("btnAddEmptyPot");

  if (existingContainerUid) {
    const c = layers.find(l => l.uid === existingContainerUid);
    title.textContent = `Plantar en ${c?.name || "maceta"}`;
    sub.textContent = c?.isGroundSoil
      ? "Elegí la especie para plantar directo en tierra."
      : `Elegí una especie compatible con ${c?.liters ?? 45} L de sustrato.`;
    emptyBtn.classList.add("hidden");
  } else {
    title.textContent = `¿Querés ponerle una planta a "${containerItem.name}"?`;
    sub.textContent = containerItem.isGroundSoil
      ? "Podés agregar el sector de tierra solo o con una planta ya ubicada."
      : `Capacidad: ${containerItem.liters} L. Elegí una planta o agregala vacía.`;
    emptyBtn.classList.remove("hidden");
  }

  document.getElementById("potPickerSearch").value = "";
  renderPotPickerGrid();
  modal.classList.remove("hidden");
}

function renderPotPickerGrid() {
  const grid = document.getElementById("potPickerGrid");
  const q = document.getElementById("potPickerSearch").value.trim().toLowerCase();
  const plants = catalog.filter(i => i.kind === "plant" && (!q || i.name.toLowerCase().includes(q) || (i.sci || "").toLowerCase().includes(q)));

  const targetLiters = pendingExistingContainerUid
    ? (layers.find(l => l.uid === pendingExistingContainerUid)?.isGroundSoil ? 9999 : layers.find(l => l.uid === pendingExistingContainerUid)?.liters ?? 45)
    : (pendingContainerItem?.isGroundSoil ? 9999 : pendingContainerItem?.liters ?? 45);

  grid.innerHTML = "";
  for (const p of plants) {
    const fits = targetLiters >= (p.minPotLiters || 10);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "text-left bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 hover:border-emerald-500/60 rounded-lg p-2 transition flex flex-col";
    btn.innerHTML = `
      <div class="w-full h-20 rounded checker-bg flex items-center justify-center overflow-hidden mb-1.5 relative">
        <img src="${p.src}" alt="${p.name}" class="max-h-full max-w-full object-contain" />
        <span class="absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded ${fits ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}">
          ${fits ? "Apta" : `Mín ${p.minPotLiters || 10}L`}
        </span>
      </div>
      <div class="text-xs font-medium text-zinc-100 truncate">${p.name}</div>
      <div class="text-[10px] text-zinc-400 truncate">${p.heightLabel || ""}</div>
    `;
    btn.addEventListener("click", async () => {
      document.getElementById("potPlantPickerModal").classList.add("hidden");
      if (pendingExistingContainerUid) {
        const cLayer = layers.find(l => l.uid === pendingExistingContainerUid);
        if (cLayer) await addPlantInsideContainer(p, cLayer);
      } else if (pendingContainerItem) {
        await loadImage(pendingContainerItem.src);
        const jitterX = 0.48 + (Math.random() - 0.5) * 0.1;
        const jitterY = 0.78 + (Math.random() - 0.5) * 0.06;
        const cLayer = createLayer(pendingContainerItem, jitterX, jitterY);
        layers.push(cLayer);
        await addPlantInsideContainer(p, cLayer);
      }
      pendingContainerItem = null;
      pendingExistingContainerUid = null;
    });
    grid.appendChild(btn);
  }
}

document.getElementById("potPickerSearch").addEventListener("input", renderPotPickerGrid);
document.getElementById("btnClosePotPicker").addEventListener("click", () => {
  document.getElementById("potPlantPickerModal").classList.add("hidden");
  pendingContainerItem = null;
  pendingExistingContainerUid = null;
});
document.getElementById("btnAddEmptyPot").addEventListener("click", async () => {
  if (!pendingContainerItem) return;
  const item = pendingContainerItem;
  pendingContainerItem = null;
  document.getElementById("potPlantPickerModal").classList.add("hidden");
  await loadImage(item.src);
  const jitterX = 0.48 + (Math.random() - 0.5) * 0.1;
  const jitterY = 0.78 + (Math.random() - 0.5) * 0.06;
  const newLayer = createLayer(item, jitterX, jitterY);
  layers.push(newLayer);
  selectedId = newLayer.uid;
  setMaskMode(false);
  syncUI();
  draw();
  showToast(`${item.name} agregada a la escena`);
});

// Catalog UI
function renderCatalog() {
  const grid = document.getElementById("catalogGrid");
  const q = searchQuery.trim().toLowerCase();
  const items = catalog.filter(p => {
    const matchFilter = activeFilter === "all" || p.category === activeFilter;
    const matchSearch = !q || p.name.toLowerCase().includes(q) || (p.sci || "").toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });
  document.getElementById("catalogCount").textContent = `${items.length} ${items.length === 1 ? "ítem" : "ítems"}`;
  grid.innerHTML = "";

  if (items.length === 0) {
    grid.innerHTML = `<div class="col-span-2 text-center py-6 text-xs text-zinc-500">No hay ítems que coincidan. Probá cargar una planta nueva con "+ Cargar".</div>`;
    return;
  }

  const badgeMap = {
    cerco: ["Cerco", "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"],
    arboles: ["Árbol", "bg-teal-500/15 text-teal-300 border-teal-500/30"],
    trepadoras: ["Trepad.", "bg-pink-500/15 text-pink-300 border-pink-500/30"],
    primera: ["1ª Fila", "bg-violet-500/15 text-violet-300 border-violet-500/30"],
    macetas: ["Maceta", "bg-orange-500/15 text-orange-300 border-orange-500/30"],
    tierra: ["Tierra", "bg-lime-500/15 text-lime-300 border-lime-500/30"],
    custom: ["Propia", "bg-amber-500/15 text-amber-300 border-amber-500/30"]
  };

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "group relative text-left bg-zinc-950/70 hover:bg-zinc-800/80 border border-zinc-800 hover:border-emerald-500/50 rounded-lg p-2 transition flex flex-col cursor-pointer";
    const [badgeLabel, badgeColor] = badgeMap[item.category] || badgeMap.custom;

    card.innerHTML = `
      <div class="w-full h-24 rounded-md checker-bg flex items-center justify-center overflow-hidden mb-1.5 relative">
        <img src="${item.src}" alt="${item.name}" class="max-h-full max-w-full object-contain group-hover:scale-105 transition-transform duration-200" />
        <span class="absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded border ${badgeColor}">${badgeLabel}</span>
        ${item.isCustom ? `<button type="button" class="del-custom-btn hidden group-hover:flex absolute top-1 left-1 w-4 h-4 rounded-full bg-red-600 text-white text-[10px] items-center justify-center" title="Eliminar del catálogo">×</button>` : ""}
      </div>
      <div class="text-xs font-medium text-zinc-100 truncate w-full">${item.name}</div>
      <div class="text-[10px] text-zinc-400 truncate w-full">${item.heightLabel || item.sci}</div>
    `;
    card.addEventListener("click", async (e) => {
      if (e.target.closest(".del-custom-btn")) {
        e.stopPropagation();
        const idx = catalog.findIndex(c => c.id === item.id);
        if (idx >= 0) catalog.splice(idx, 1);
        saveCustomCatalog(catalog.filter(c => c.isCustom));
        renderCatalog();
        showToast(`"${item.name}" eliminada del catálogo`);
        return;
      }

      const targetCont = catalogTargetContainerUid ? layers.find(l => l.uid === catalogTargetContainerUid) : null;

      if (item.kind === "container") {
        // If a cantero is targeted and user clicks a maceta, place maceta inside cantero!
        if (targetCont && !item.isGroundSoil && (targetCont.shape === "cantero_rect" || targetCont.shape === "jardinera_alta" || targetCont.isGroundSoil) && item.shape !== "cantero_rect") {
          await loadImage(item.src);
          const cRect = getLayerRect(targetCont);
          const newMaceta = createLayer(item, targetCont.x / canvas.width, Math.min(0.95, (cRect.y + cRect.h * 0.35) / canvas.height));
          newMaceta.parentContainerUid = targetCont.uid;
          const idx = layers.findIndex(l => l.uid === targetCont.uid);
          if (idx >= 0) layers.splice(idx + 1, 0, newMaceta);
          else layers.push(newMaceta);
          selectedId = newMaceta.uid;
          syncUI();
          draw();
          showToast(`${item.name} colocada dentro de ${targetCont.name}`);
          return;
        }
        openPotPlantPicker(item, null);
        return;
      }

      if (targetCont) {
        await addPlantInsideContainer(item, targetCont);
        return;
      }

      await loadImage(item.src);
      const jitterX = 0.45 + (Math.random() - 0.5) * 0.14;
      const jitterY = 0.75 + (Math.random() - 0.5) * 0.08;
      const newLayer = createLayer(item, jitterX, jitterY);
      layers.push(newLayer);
      selectedId = newLayer.uid;
      setMaskMode(false);
      syncUI();
      draw();
      showToast(`${item.name} agregada a la escena`);
    });
    grid.appendChild(card);
  }
}

document.getElementById("catalogSearch").addEventListener("input", (e) => {
  searchQuery = e.target.value;
  renderCatalog();
});

document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    activeFilter = btn.dataset.filter;
    document.querySelectorAll(".filter-btn").forEach(b => {
      b.className = b === btn
        ? "filter-btn px-1 py-1 rounded text-[10px] font-medium bg-emerald-600 text-white"
        : "filter-btn px-1 py-1 rounded text-[10px] font-medium text-zinc-400 hover:text-zinc-200";
    });
    renderCatalog();
  });
});

// Layers List UI (Photoshop clipping/child hierarchy!)
function renderLayersList() {
  const list = document.getElementById("layersList");
  document.getElementById("layerCount").textContent = layers.length;
  list.innerHTML = "";

  if (layers.length === 0) {
    list.innerHTML = `<div class="text-xs text-zinc-500 py-3 text-center">Sin capas todavía.</div>`;
    return;
  }

  const rendered = new Set();

  function renderLayerRow(l, depth = 0) {
    if (rendered.has(l.uid)) return;
    rendered.add(l.uid);

    const isSel = l.uid === selectedId;
    const realism = evaluateBotanicalRealism(l);
    const hM = getLayerRealHeightM(l);
    const row = document.createElement("div");

    const indentStyle = depth === 1
      ? "ml-4 border-l-2 border-l-emerald-500/60"
      : depth >= 2
      ? "ml-8 border-l-2 border-l-sky-500/60"
      : "";

    row.className = `flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border text-xs cursor-pointer transition ${indentStyle} ${
      isSel ? "bg-emerald-500/15 border-emerald-500/50 text-zinc-100" : "bg-zinc-950/60 border-zinc-800 text-zinc-300 hover:border-zinc-700"
    }`;

    const warnDot = realism.level === "error"
      ? `<span class="w-2 h-2 rounded-full bg-red-500 shrink-0" title="${realism.message}"></span>`
      : realism.level === "warn"
      ? `<span class="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="${realism.message}"></span>`
      : "";

    const childArrow = depth > 0
      ? `<span class="text-emerald-400/80 font-mono text-[11px] shrink-0">↳</span>`
      : "";

    row.draggable = true;
    row.dataset.uid = l.uid;

    row.innerHTML = `
      <div class="flex items-center gap-1 min-w-0 flex-1">
        ${childArrow}
        <img src="${l.src}" class="w-6 h-6 object-contain rounded bg-zinc-800 shrink-0" alt="" />
        <span class="truncate font-medium">${l.name}</span>
        ${warnDot}
        <span class="text-[10px] text-zinc-500 shrink-0">${hM.toFixed(1)}m</span>
      </div>
      <div class="flex items-center gap-0.5 shrink-0">
        ${depth > 0 ? `<button type="button" class="detach-btn px-1 py-0.5 rounded hover:bg-zinc-800 text-[10px] text-amber-300" title="Sacar al piso (desvincular)">⇤</button>` : ""}
        <button type="button" class="up-btn px-1 py-0.5 rounded hover:bg-zinc-800 text-[10px] text-zinc-400 hover:text-zinc-100" title="Subir capa">↑</button>
        <button type="button" class="down-btn px-1 py-0.5 rounded hover:bg-zinc-800 text-[10px] text-zinc-400 hover:text-zinc-100" title="Bajar capa">↓</button>
        <button type="button" class="lock-btn p-1 rounded hover:bg-zinc-800 ${l.locked ? "text-amber-400" : "text-zinc-500 hover:text-zinc-300"}" title="${l.locked ? "Desbloquear capa" : "Bloquear capa"}">
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="${l.locked ? "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" : "M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"}"/>
          </svg>
        </button>
        <button type="button" class="vis-btn p-1 rounded hover:bg-zinc-800 ${l.visible ? "text-zinc-300" : "text-zinc-600"}" title="Mostrar/Ocultar">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="${l.visible ? "M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" : "M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18"}"/>
          </svg>
        </button>
      </div>
    `;

    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", l.uid);
      row.classList.add("opacity-50");
    });
    row.addEventListener("dragend", () => row.classList.remove("opacity-50"));
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("ring-1", "ring-emerald-400");
    });
    row.addEventListener("dragleave", () => row.classList.remove("ring-1", "ring-emerald-400"));
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      row.classList.remove("ring-1", "ring-emerald-400");
      const draggedUid = e.dataTransfer.getData("text/plain");
      if (!draggedUid || draggedUid === l.uid) return;
      const dragged = layers.find(x => x.uid === draggedUid);
      if (!dragged) return;
      if (getAllDescendants(dragged.uid).some(d => d.uid === l.uid)) return;

      if (l.kind === "container") {
        // Nest inside container
        if (dragged.kind === "plant") {
          const ok = await ensureContainerHasSubstrateOrResolve(l, () => {
            dragged.containerUid = l.uid;
            clampScaleToPotIfNeeded(dragged);
            syncUI();
            draw();
          });
          if (!ok) return;
          dragged.containerUid = l.uid;
          clampScaleToPotIfNeeded(dragged);
          showToast(`${dragged.name} metida en ${l.name}`);
        } else {
          dragged.parentContainerUid = l.uid;
          showToast(`${dragged.name} metida en ${l.name}`);
        }
      } else {
        // Reorder z-index in layers array
        const fromIdx = layers.findIndex(x => x.uid === draggedUid);
        const toIdx = layers.findIndex(x => x.uid === l.uid);
        if (fromIdx >= 0 && toIdx >= 0) {
          const [moved] = layers.splice(fromIdx, 1);
          layers.splice(toIdx, 0, moved);
        }
      }
      syncUI();
      draw();
    });

    row.addEventListener("click", (e) => {
      if (e.target.closest(".lock-btn")) {
        l.locked = !l.locked;
        if (l.locked && selectedId === l.uid) selectedId = null;
        renderLayersList();
        draw();
        showToast(l.locked ? `${l.name} bloqueada` : `${l.name} desbloqueada`);
        return;
      }
      if (e.target.closest(".vis-btn")) {
        l.visible = !l.visible;
        renderLayersList();
        draw();
        return;
      }
      if (e.target.closest(".detach-btn")) {
        l.containerUid = null;
        l.parentContainerUid = null;
        showToast(`${l.name} sacada al piso`);
        syncUI();
        draw();
        return;
      }
      if (e.target.closest(".up-btn")) {
        const idx = layers.findIndex(x => x.uid === l.uid);
        if (idx >= 0 && idx < layers.length - 1) {
          [layers[idx], layers[idx + 1]] = [layers[idx + 1], layers[idx]];
          renderLayersList();
          draw();
        }
        return;
      }
      if (e.target.closest(".down-btn")) {
        const idx = layers.findIndex(x => x.uid === l.uid);
        if (idx > 0) {
          [layers[idx], layers[idx - 1]] = [layers[idx - 1], layers[idx]];
          renderLayersList();
          draw();
        }
        return;
      }
      selectedId = l.uid;
      syncUI();
      draw();
    });

    list.appendChild(row);

    // Render attached children immediately below parent (like Photoshop adjustment/clipping layers)
    const children = getDirectChildren(l.uid);
    for (let j = children.length - 1; j >= 0; j--) {
      renderLayerRow(children[j], depth + 1);
    }
  }

  // First render root layers top-to-bottom
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.containerUid && !l.parentContainerUid) {
      renderLayerRow(l, 0);
    }
  }
  // Safety: render any orphan if parent was missing
  for (let i = layers.length - 1; i >= 0; i--) {
    if (!rendered.has(layers[i].uid)) {
      renderLayerRow(layers[i], 0);
    }
  }
}

async function refreshContainerLayerAppearance(layer) {
  if (!layer || layer.kind !== "container") return;
  const prevRealH = layer.customHeightM || getLayerRealHeightM(layer);
  const newSrc = getContainerRenderSrc({
    shape: layer.shape || "cantero_rect",
    material: layer.material || "cemento",
    colorId: layer.colorId || "gris_claro",
    viewAngle: layer.viewAngle || 0,
    viewPitch: layer.viewPitch ?? 22,
    perspStrength: getScenePerspStrength(),
    isGroundSoil: !!layer.isGroundSoil,
    mulch: !!layer.mulch,
    liters: layer.liters ?? 45,
    customWidthM: layer.customWidthM,
    customHeightM: layer.customHeightM,
    customDepthM: layer.customDepthM
  });
  await loadImage(newSrc);
  layer.src = newSrc;
  layer.origSrc = newSrc;
  if (!layer.isGroundSoil) {
    const pf = perspective.autoScale ? (layer.perspFactor || getPerspectiveFactorAtY(layer.y)) : 1;
    const wallRatio = getLayerWallRatio(layer);
    layer.scale = Math.max(0.015, heightMToScale(prevRealH / wallRatio, pf));
  }
  renderLayersList();
  draw();
}

function renderMaterialAndColorControls(sel) {
  const matSelect = document.getElementById("ctrlContainerMaterial");
  const swatchesDiv = document.getElementById("containerColorSwatches");
  const viewSec = document.getElementById("containerViewSection");
  const matSec = document.getElementById("containerMaterialSection");

  viewSec.classList.remove("hidden");
  if (sel.shape === "tierra_organica") {
    matSec.classList.add("hidden");
  } else {
    matSec.classList.remove("hidden");
  }

  matSelect.innerHTML = "";
  for (const [mKey, mObj] of Object.entries(CONTAINER_MATERIALS)) {
    const opt = document.createElement("option");
    opt.value = mKey;
    opt.textContent = mObj.label;
    if (sel.material === mKey) opt.selected = true;
    matSelect.appendChild(opt);
  }

  const mat = CONTAINER_MATERIALS[sel.material] || CONTAINER_MATERIALS.cemento;
  swatchesDiv.innerHTML = "";
  for (const col of mat.colors) {
    const btn = document.createElement("button");
    btn.type = "button";
    const isSel = sel.colorId === col.id;
    btn.className = `inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] border transition ${
      isSel ? "border-emerald-400 bg-emerald-500/15 text-emerald-200" : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
    }`;
    btn.innerHTML = `<span class="w-3 h-3 rounded-full border border-white/25 shrink-0" style="background:${col.base}"></span><span>${col.label}</span>`;
    btn.addEventListener("click", async () => {
      sel.colorId = col.id;
      await refreshContainerLayerAppearance(sel);
      renderMaterialAndColorControls(sel);
    });
    swatchesDiv.appendChild(btn);
  }
}

function syncBotanicalInspector(sel) {
  const hM = getLayerRealHeightM(sel);
  const wM = getLayerRealWidthM(sel);

  const plantBox = document.getElementById("plantBotanicalDetails");
  const contBox = document.getElementById("containerDetails");
  const item = catalog.find(p => p.id === sel.itemId);

  if (sel.kind === "container") {
    plantBox.classList.add("hidden");
    contBox.classList.remove("hidden");

    const potWrap = document.getElementById("potLitersWrap");
    const soilNote = document.getElementById("groundSoilNote");
    const parentWrap = document.getElementById("parentContainerWrap");

    if (sel.isGroundSoil) {
      potWrap.classList.add("hidden");
      soilNote.classList.remove("hidden");
      parentWrap.classList.add("hidden");
    } else {
      potWrap.classList.remove("hidden");
      soilNote.classList.add("hidden");
      parentWrap.classList.remove("hidden");
      const inW = document.getElementById("ctrlCustomWidthM");
      const inH = document.getElementById("ctrlCustomHeightM");
      const inD = document.getElementById("ctrlCustomDepthM");
      if (document.activeElement !== inW) inW.value = (sel.customWidthM || wM).toFixed(2);
      if (document.activeElement !== inH) inH.value = (sel.customHeightM || hM).toFixed(2);
      if (document.activeElement !== inD) inD.value = (sel.customDepthM || Math.max(0.25, hM * 0.9)).toFixed(2);
      const liters = sel.liters ?? 45;
      document.getElementById("ctrlPotLiters").value = liters;
      document.getElementById("valPotLiters").textContent = `${liters} L`;
      document.getElementById("recommendedSubstrateBox").innerHTML = formatSubstrateRecommendation(liters);

      // Populate parent container dropdown (allow placing macetas inside canteros)
      const pSel = document.getElementById("ctrlParentContainerSelect");
      const validParents = layers.filter(l => l.kind === "container" && l.uid !== sel.uid && !getAllDescendants(sel.uid).some(d => d.uid === l.uid));
      pSel.innerHTML = `<option value="">Suelto en el piso</option>`;
      for (const pc of validParents) {
        const opt = document.createElement("option");
        opt.value = pc.uid;
        opt.textContent = pc.isGroundSoil ? `${pc.name} (Suelo directo)` : `${pc.name} (${pc.liters} L)`;
        if (sel.parentContainerUid === pc.uid) opt.selected = true;
        pSel.appendChild(opt);
      }
    }

    document.getElementById("ctrlContainerAngle").value = sel.viewAngle || 0;
    document.getElementById("valContainerAngle").textContent = `${sel.viewAngle || 0}°`;
    document.querySelectorAll(".view-preset-btn").forEach(b => {
      const a = Number(b.dataset.angle);
      b.classList.toggle("border-emerald-500", Math.abs((sel.viewAngle || 0) - a) <= 5);
      b.classList.toggle("text-emerald-300", Math.abs((sel.viewAngle || 0) - a) <= 5);
      b.classList.toggle("bg-emerald-500/15", Math.abs((sel.viewAngle || 0) - a) <= 5);
    });

    const pitch = sel.viewPitch ?? 22;
    document.getElementById("ctrlContainerPitch").value = pitch;
    document.getElementById("valContainerPitch").textContent = `${pitch}°`;
    document.querySelectorAll(".pitch-preset-btn").forEach(b => {
      const p = Number(b.dataset.pitch);
      b.classList.toggle("border-emerald-500", Math.abs(pitch - p) <= 3);
      b.classList.toggle("text-emerald-300", Math.abs(pitch - p) <= 3);
      b.classList.toggle("bg-emerald-500/15", Math.abs(pitch - p) <= 3);
    });

    renderMaterialAndColorControls(sel);
    return;
  }

  plantBox.classList.remove("hidden");
  contBox.classList.add("hidden");
  const inPlantH = document.getElementById("ctrlPlantHeightM");
  if (document.activeElement !== inPlantH) inPlantH.value = hM.toFixed(2);
  document.getElementById("valPlantWidthM").textContent = formatDimM(wM);
  document.getElementById("valBotanicalRange").textContent = item?.heightLabel || "Personalizada";

  const select = document.getElementById("ctrlContainerSelect");
  const containers = layers.filter(l => l.kind === "container");
  select.innerHTML = `<option value="">En tierra directa (sin límite)</option>`;
  for (const c of containers) {
    const opt = document.createElement("option");
    opt.value = c.uid;
    opt.textContent = c.isGroundSoil ? `${c.name} (Suelo directo)` : `${c.name} (${c.liters} L)`;
    if (sel.containerUid === c.uid) opt.selected = true;
    select.appendChild(opt);
  }

  document.getElementById("chkRespectPotLimit").checked = !!sel.respectPotLimit;

  const realism = evaluateBotanicalRealism(sel);
  const alertBox = document.getElementById("realismAlert");
  const alertText = document.getElementById("realismAlertText");
  if (realism.level === "ok") {
    alertBox.classList.add("hidden");
  } else {
    alertBox.classList.remove("hidden");
    alertText.textContent = realism.message;
    alertBox.className =
      realism.level === "error"
        ? "p-2 rounded-md text-[11px] leading-snug space-y-1.5 bg-red-500/15 border border-red-500/40 text-red-200"
        : "p-2 rounded-md text-[11px] leading-snug space-y-1.5 bg-amber-500/15 border border-amber-500/40 text-amber-200";
  }
}

function syncInspectorValues() {
  const sel = getSelectedLayer();
  if (!sel) return;
  document.getElementById("ctrlRotate").value = sel.rotation;
  document.getElementById("valRotate").textContent = sel.rotation + "°";
  document.getElementById("ctrlBright").value = sel.brightness;
  document.getElementById("valBright").textContent = sel.brightness + "%";
  document.getElementById("ctrlContrast").value = sel.contrast;
  document.getElementById("valContrast").textContent = sel.contrast + "%";
  document.getElementById("ctrlSat").value = sel.saturation;
  document.getElementById("valSat").textContent = sel.saturation + "%";
  document.getElementById("ctrlWarmth").value = sel.warmth;
  document.getElementById("valWarmth").textContent = sel.warmth;
  document.getElementById("ctrlShadowOpacity").value = sel.shadowOpacity;
  document.getElementById("valShadowOpacity").textContent = sel.shadowOpacity + "%";
  document.getElementById("ctrlShadowOffset").value = sel.shadowOffset;
  document.getElementById("valShadowOffset").textContent = sel.shadowOffset;
  syncBotanicalInspector(sel);
}

function syncUI() {
  const sel = getSelectedLayer();
  const badge = document.getElementById("selectedNameBadge");
  const empty = document.getElementById("noSelectionState");
  const ctrls = document.getElementById("inspectorControls");

  if (sel) {
    badge.textContent = sel.name;
    empty.classList.add("hidden");
    ctrls.classList.remove("hidden");
    syncInspectorValues();
  } else {
    badge.textContent = "Ninguna";
    empty.classList.remove("hidden");
    ctrls.classList.add("hidden");
  }
  if (sel && sel.kind === "container") {
    catalogTargetContainerUid = sel.uid;
  } else if (!layers.some(l => l.uid === catalogTargetContainerUid)) {
    catalogTargetContainerUid = null;
  }
  const targetBanner = document.getElementById("catalogTargetBanner");
  const targetCont = catalogTargetContainerUid ? layers.find(l => l.uid === catalogTargetContainerUid) : null;
  if (targetCont) {
    document.getElementById("catalogTargetName").textContent = targetCont.name;
    targetBanner.classList.remove("hidden");
  } else {
    targetBanner.classList.add("hidden");
  }

  document.getElementById("scaleStatusText").textContent = activeCamera ? `Cámara 3D: alt. ${activeCamera.hCam.toFixed(2)} m · f ${Math.round(activeCamera.f)} px` : "Escala lista";
  renderLayersList();
}

document.getElementById("btnClearCatalogTarget").addEventListener("click", () => {
  catalogTargetContainerUid = null;
  document.getElementById("catalogTargetBanner").classList.add("hidden");
  showToast("Modo libre: las plantas nuevas se agregan al piso");
});

function setMaskMode(active) {
  maskMode = active;
  if (active) setCalibrationMode(false);
  const banner = document.getElementById("maskBanner");
  const btnText = document.getElementById("maskBtnText");
  const btn = document.getElementById("btnToggleMask");
  if (active) {
    banner.classList.remove("hidden");
    btnText.textContent = "Salir de máscara";
    btn.classList.add("border-amber-500", "bg-amber-500/20");
    canvas.style.cursor = "crosshair";
  } else {
    banner.classList.add("hidden");
    btnText.textContent = "Pintar máscara";
    btn.classList.remove("border-amber-500", "bg-amber-500/20");
    canvas.style.cursor = "grab";
  }
  draw();
}

function setCalibrationMode(active, step = 1) {
  calibration.mode = active;
  calibration.step = step;
  calibration.pts = [];
  if (step === 1) calibration.frontSample = null;
  const banner = document.getElementById("calibrateBanner");
  const btn = document.getElementById("btnCalibrate");
  const inpGrp = document.getElementById("calibrateInputGroup");
  const skipBtn = document.getElementById("btnSkipBackCalibrate");
  if (active) {
    if (maskMode) setMaskMode(false);
    banner.classList.remove("hidden");
    inpGrp.classList.add("hidden");
    inpGrp.classList.remove("flex");
    if (step === 1) {
      skipBtn.classList.add("hidden");
      document.getElementById("calibratePromptText").textContent =
        "Paso 1 (Adelante): marcá 2 puntos de algo cercano cuya medida conozcas (ej. puerta o maceta)";
    } else {
      skipBtn.classList.remove("hidden");
      document.getElementById("calibratePromptText").textContent =
        "Paso 2 (Atrás): marcá 2 puntos de algo lejano para calcular la perspectiva";
    }
    if (btn) btn.classList.add("tool-btn-active");
    canvas.style.cursor = "crosshair";
  } else {
    banner.classList.add("hidden");
    skipBtn.classList.add("hidden");
    if (btn) btn.classList.remove("tool-btn-active");
    canvas.style.cursor = maskMode ? "crosshair" : "grab";
  }
  draw();
}

function setPerspectiveVisible(active) {
  perspective.visible = active;
  const banner = document.getElementById("perspectiveBanner");
  const btn = document.getElementById("btnPerspective");
  if (active) {
    banner.classList.remove("hidden");
    if (btn) btn.classList.add("tool-btn-active");
  } else {
    banner.classList.add("hidden");
    if (btn) btn.classList.remove("tool-btn-active");
  }
  draw();
}

function deleteSelectedLayer() {
  if (!selectedId) return;
  pushUndoSnapshot();
  const removed = selectedId;
  layers = layers.filter(l => l.uid !== removed);
  for (const l of layers) {
    if (l.containerUid === removed) l.containerUid = null;
    if (l.parentContainerUid === removed) l.parentContainerUid = null;
  }
  selectedId = layers.length ? layers[layers.length - 1].uid : null;
  setMaskMode(false);
  syncUI();
  draw();
}

// fSpy Perspective Listeners
document.getElementById("btnPerspective").addEventListener("click", () => setPerspectiveVisible(!perspective.visible));
document.getElementById("btnExitPerspective").addEventListener("click", () => setPerspectiveVisible(false));
document.getElementById("chkAutoPerspective").addEventListener("change", (e) => {
  perspective.autoScale = e.target.checked;
  showToast(perspective.autoScale ? "Auto-escala por perspectiva activada" : "Auto-escala desactivada");
});
document.getElementById("btnStartPerspectiveNow").addEventListener("click", () => {
  document.getElementById("perspectiveGuideModal").classList.add("hidden");
  setPerspectiveVisible(true);
});

document.getElementById("ctrlFspyRefMeters").addEventListener("input", (e) => {
  const val = parseFloat(e.target.value);
  if (val > 0.02) {
    perspective.fspy.refMeters = val;
    rebuildGroundHomography();
    syncUI();
    draw();
  }
});
document.getElementById("ctrlFspyRefType").addEventListener("change", (e) => {
  perspective.fspy.refType = e.target.value;
  rebuildGroundHomography();
  syncUI();
  draw();
});
document.getElementById("chkShowFloorGrid").addEventListener("change", (e) => {
  perspective.showFloorGrid = e.target.checked;
  draw();
});

// Container 3D View (Horizontal + Vertical) & Material Listeners
document.querySelectorAll(".view-preset-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const sel = getSelectedLayer();
    if (!sel || sel.kind !== "container") return;
    sel.viewAngle = Number(btn.dataset.angle);
    await refreshContainerLayerAppearance(sel);
    syncBotanicalInspector(sel);
  });
});

document.getElementById("ctrlContainerAngle").addEventListener("input", async (e) => {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "container") return;
  sel.viewAngle = Number(e.target.value);
  await refreshContainerLayerAppearance(sel);
  syncBotanicalInspector(sel);
});

document.querySelectorAll(".pitch-preset-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const sel = getSelectedLayer();
    if (!sel || sel.kind !== "container") return;
    sel.viewPitch = Number(btn.dataset.pitch);
    await refreshContainerLayerAppearance(sel);
    syncBotanicalInspector(sel);
  });
});

document.getElementById("ctrlContainerPitch").addEventListener("input", async (e) => {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "container") return;
  sel.viewPitch = Number(e.target.value);
  await refreshContainerLayerAppearance(sel);
  syncBotanicalInspector(sel);
});


async function applyCustomContainerDims() {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "container") return;
  const rawW = parseFloat(document.getElementById("ctrlCustomWidthM").value);
  const rawH = parseFloat(document.getElementById("ctrlCustomHeightM").value);
  const rawD = parseFloat(document.getElementById("ctrlCustomDepthM").value);
  if (!rawW || rawW <= 0 || !rawH || rawH <= 0 || !rawD || rawD <= 0) return;

  sel.customWidthM = rawW;
  sel.customHeightM = rawH;
  sel.customDepthM = rawD;
  await refreshContainerLayerAppearance(sel);
  const pf = perspective.autoScale ? (sel.perspFactor || getPerspectiveFactorAtY(sel.y)) : 1;
  const wallRatio = getLayerWallRatio(sel);
  sel.scale = Math.max(0.015, heightMToScale(rawH / wallRatio, pf));
  syncInspectorValues();
  draw();
}
let customDimsTimer = null;
["ctrlCustomWidthM", "ctrlCustomHeightM", "ctrlCustomDepthM"].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener("input", () => {
    clearTimeout(customDimsTimer);
    customDimsTimer = setTimeout(applyCustomContainerDims, 160);
  });
  el.addEventListener("change", applyCustomContainerDims);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(customDimsTimer);
      applyCustomContainerDims();
      el.blur();
    }
  });
});

document.getElementById("ctrlContainerMaterial").addEventListener("change", async (e) => {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "container") return;
  const matKey = e.target.value;
  sel.material = matKey;
  const mat = CONTAINER_MATERIALS[matKey];
  if (mat && mat.colors.length) {
    sel.colorId = mat.colors[0].id;
  }
  await refreshContainerLayerAppearance(sel);
  renderMaterialAndColorControls(sel);
});

document.getElementById("ctrlParentContainerSelect").addEventListener("change", (e) => {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "container") return;
  sel.parentContainerUid = e.target.value || null;
  syncUI();
  draw();
});

document.getElementById("btnPlantInContainer").addEventListener("click", async () => {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "container") return;
  const ok = await ensureContainerHasSubstrateOrResolve(sel, () => openPotPlantPicker(null, sel.uid));
  if (!ok) return;
  openPotPlantPicker(null, sel.uid);
});

// Inspector Listeners
document.getElementById("ctrlPlantHeightM").addEventListener("input", (e) => {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "plant") return;
  const hM = Math.max(0.08, Math.min(20, parseFloat(e.target.value) || 1.0));
  const pf = perspective.autoScale ? (sel.perspFactor || getPerspectiveFactorAtY(sel.y)) : 1;
  sel.scale = Math.max(0.015, heightMToScale(hM, pf));
  clampScaleToPotIfNeeded(sel);
  document.getElementById("valPlantWidthM").textContent = formatDimM(getLayerRealWidthM(sel));
  renderLayersList();
  draw();
});
document.getElementById("ctrlRotate").addEventListener("input", (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.rotation = Number(e.target.value);
  document.getElementById("valRotate").textContent = e.target.value + "°";
  draw();
});
document.getElementById("ctrlBright").addEventListener("input", (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.brightness = Number(e.target.value);
  document.getElementById("valBright").textContent = e.target.value + "%";
  draw();
});
document.getElementById("ctrlContrast").addEventListener("input", (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.contrast = Number(e.target.value);
  document.getElementById("valContrast").textContent = e.target.value + "%";
  draw();
});
document.getElementById("ctrlSat").addEventListener("input", (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.saturation = Number(e.target.value);
  document.getElementById("valSat").textContent = e.target.value + "%";
  draw();
});
document.getElementById("ctrlWarmth").addEventListener("input", (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.warmth = Number(e.target.value);
  document.getElementById("valWarmth").textContent = e.target.value;
  draw();
});
document.getElementById("ctrlShadowOpacity").addEventListener("input", (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.shadowOpacity = Number(e.target.value);
  document.getElementById("valShadowOpacity").textContent = e.target.value + "%";
  draw();
});
document.getElementById("ctrlShadowOffset").addEventListener("input", (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.shadowOffset = Number(e.target.value);
  document.getElementById("valShadowOffset").textContent = e.target.value;
  draw();
});
document.getElementById("ctrlBrushSize").addEventListener("input", (e) => {
  brushSize = Number(e.target.value);
  document.getElementById("valBrushSize").textContent = brushSize + " px";
});

document.getElementById("ctrlContainerSelect").addEventListener("change", async (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  const newUid = e.target.value || null;
  if (newUid) {
    const targetC = layers.find(l => l.uid === newUid);
    const ok = await ensureContainerHasSubstrateOrResolve(targetC, async () => {
      sel.containerUid = newUid;
      clampScaleToPotIfNeeded(sel);
      syncUI();
      draw();
    });
    if (!ok) {
      e.target.value = sel.containerUid || "";
      return;
    }
  }
  sel.containerUid = newUid;
  clampScaleToPotIfNeeded(sel);
  syncUI();
  draw();
});
document.getElementById("chkRespectPotLimit").addEventListener("change", (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.respectPotLimit = e.target.checked;
  clampScaleToPotIfNeeded(sel);
  syncUI();
  draw();
});
document.getElementById("ctrlPotLiters").addEventListener("input", async (e) => {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "container") return;
  const prevZero = (sel.liters ?? 45) <= 0;
  sel.liters = Number(e.target.value);
  const nowZero = sel.liters <= 0;
  document.getElementById("valPotLiters").textContent = sel.liters + " L";
  document.getElementById("recommendedSubstrateBox").innerHTML = formatSubstrateRecommendation(sel.liters);
  for (const l of layers) {
    if (l.containerUid === sel.uid) clampScaleToPotIfNeeded(l);
  }
  if (prevZero !== nowZero) {
    await refreshContainerLayerAppearance(sel);
  }
  renderLayersList();
  draw();
});
document.getElementById("btnFixRealism").addEventListener("click", () => {
  const sel = getSelectedLayer();
  if (!sel) return;
  const item = catalog.find(p => p.id === sel.itemId);
  if (!item) return;
  let targetM = item.defaultHeightM || ((item.idealMinM + item.idealMaxM) / 2);
  if (sel.containerUid) {
    const c = layers.find(l => l.uid === sel.containerUid);
    if (c && !c.isGroundSoil && (c.liters ?? 40) > 0) {
      const potMax = getPotMaxHeightM(item, c.liters || 40);
      targetM = Math.min(targetM, potMax * 0.95);
    }
  }
  const pf = perspective.autoScale ? (sel.perspFactor || 1) : 1;
  sel.scale = Math.max(0.015, heightMToScale(targetM, pf));
  syncUI();
  draw();
  showToast(`Ajustada a ${targetM.toFixed(2)} m`);
});

document.getElementById("btnFlip").addEventListener("click", () => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.flip = !sel.flip;
  draw();
});

document.getElementById("btnDuplicate").addEventListener("click", () => {
  const sel = getSelectedLayer();
  if (!sel) return;
  pushUndoSnapshot();
  const copy = {
    ...sel,
    uid: "layer_" + (nextUid++),
    x: sel.x + 35,
    y: sel.y + 8,
    containerUid: null,
    parentContainerUid: null,
    maskCanvas: document.createElement("canvas")
  };
  copy.maskCanvas.width = sel.maskCanvas.width;
  copy.maskCanvas.height = sel.maskCanvas.height;
  copy.maskCanvas.getContext("2d").drawImage(sel.maskCanvas, 0, 0);
  layers.push(copy);
  selectedId = copy.uid;
  syncUI();
  draw();
});

document.getElementById("btnLayerUp").addEventListener("click", () => {
  const idx = layers.findIndex(l => l.uid === selectedId);
  if (idx < 0 || idx === layers.length - 1) return;
  [layers[idx], layers[idx + 1]] = [layers[idx + 1], layers[idx]];
  renderLayersList();
  draw();
});

document.getElementById("btnLayerDown").addEventListener("click", () => {
  const idx = layers.findIndex(l => l.uid === selectedId);
  if (idx <= 0) return;
  [layers[idx], layers[idx - 1]] = [layers[idx - 1], layers[idx]];
  renderLayersList();
  draw();
});

document.getElementById("btnResetColor").addEventListener("click", () => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.brightness = 100;
  sel.contrast = 100;
  sel.saturation = 100;
  sel.warmth = 0;
  syncInspectorValues();
  draw();
});

document.getElementById("btnToggleMask").addEventListener("click", () => {
  if (!getSelectedLayer()) return;
  setMaskMode(!maskMode);
});
document.getElementById("btnExitMask").addEventListener("click", () => setMaskMode(false));

document.getElementById("btnClearMask").addEventListener("click", () => {
  const sel = getSelectedLayer();
  if (!sel) return;
  const mctx = sel.maskCanvas.getContext("2d");
  mctx.globalCompositeOperation = "source-over";
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(0, 0, sel.maskCanvas.width, sel.maskCanvas.height);
  draw();
  showToast("Máscara restaurada");
});

document.getElementById("btnDeleteLayer").addEventListener("click", deleteSelectedLayer);

// PNG Background & Halo Cleaner
function processPngCleaner(img, tol, feather, defringePx, floodOnly) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d");
  octx.drawImage(img, 0, 0);
  const imgData = octx.getImageData(0, 0, w, h);
  const d = imgData.data;

  const minLum = 255 - tol * 1.4;
  const maxSat = 18 + tol * 0.65;

  const isBgCandidate = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4];
    const g = d[i * 4 + 1];
    const b = d[i * 4 + 2];
    const a = d[i * 4 + 3];
    if (a < 15) {
      isBgCandidate[i] = 1;
      continue;
    }
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const lum = (r + g + b) / 3;
    const sat = maxC - minC;
    if (lum >= minLum && sat <= maxSat) {
      isBgCandidate[i] = 1;
    }
  }

  const removeMask = new Uint8Array(w * h);
  if (floodOnly) {
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const pushIf = (idx) => {
      if (isBgCandidate[idx] && !removeMask[idx]) {
        removeMask[idx] = 1;
        queue[tail++] = idx;
      }
    };
    for (let x = 0; x < w; x++) {
      pushIf(x);
      pushIf((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      pushIf(y * w);
      pushIf(y * w + (w - 1));
    }
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % w;
      const y = (idx - x) / w;
      if (x > 0) pushIf(idx - 1);
      if (x < w - 1) pushIf(idx + 1);
      if (y > 0) pushIf(idx - w);
      if (y < h - 1) pushIf(idx + w);
    }
  } else {
    removeMask.set(isBgCandidate);
  }

  for (let i = 0; i < w * h; i++) {
    if (removeMask[i]) {
      d[i * 4 + 3] = 0;
    } else if (feather > 0) {
      const r = d[i * 4];
      const g = d[i * 4 + 1];
      const b = d[i * 4 + 2];
      const lum = (r + g + b) / 3;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum > minLum - feather * 1.6 && sat < maxSat + feather * 0.6) {
        const factor = Math.max(0, Math.min(1, (minLum - lum) / (feather * 1.6)));
        d[i * 4 + 3] = Math.round(d[i * 4 + 3] * factor);
      }
    }
  }

  if (defringePx > 0) {
    for (let pass = 0; pass < defringePx; pass++) {
      const copyA = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) copyA[i] = d[i * 4 + 3];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const idx = y * w + x;
          if (copyA[idx] === 0) continue;
          const minN = Math.min(copyA[idx - 1], copyA[idx + 1], copyA[idx - w], copyA[idx + w]);
          if (minN < 40) {
            d[idx * 4 + 3] = Math.round(copyA[idx] * 0.25);
          }
        }
      }
    }
  }

  octx.putImageData(imgData, 0, 0);
  return off;
}

async function refreshCleanerPreview() {
  const layer = layers.find(l => l.uid === cleanerTargetUid);
  if (!layer) return;
  const img = await loadImage(layer.origSrc || layer.src);
  const tol = Number(document.getElementById("ctrlCleanTol").value);
  const feather = Number(document.getElementById("ctrlCleanFeather").value);
  const defringe = Number(document.getElementById("ctrlCleanDefringe").value);
  const floodOnly = document.getElementById("chkCleanFloodFill").checked;

  document.getElementById("valCleanTol").textContent = tol;
  document.getElementById("valCleanFeather").textContent = feather;
  document.getElementById("valCleanDefringe").textContent = `${defringe} px`;

  const cleaned = processPngCleaner(img, tol, feather, defringe, floodOnly);
  const prev = document.getElementById("cleanerPreviewCanvas");
  prev.width = cleaned.width;
  prev.height = cleaned.height;
  prev.getContext("2d").drawImage(cleaned, 0, 0);
}

function openPngCleaner(uid) {
  cleanerTargetUid = uid;
  document.getElementById("pngCleanerModal").classList.remove("hidden");
  refreshCleanerPreview();
}

document.getElementById("btnOpenPngCleaner").addEventListener("click", () => {
  if (selectedId) openPngCleaner(selectedId);
});
document.getElementById("btnClosePngCleaner").addEventListener("click", () => {
  document.getElementById("pngCleanerModal").classList.add("hidden");
});
["ctrlCleanTol", "ctrlCleanFeather", "ctrlCleanDefringe", "chkCleanFloodFill"].forEach(id => {
  document.getElementById(id).addEventListener("input", refreshCleanerPreview);
});
document.getElementById("btnApplyPngCleaner").addEventListener("click", async () => {
  const layer = layers.find(l => l.uid === cleanerTargetUid);
  if (!layer) return;
  const prev = document.getElementById("cleanerPreviewCanvas");
  const newSrc = prev.toDataURL("image/png");
  await loadImage(newSrc);
  layer.src = newSrc;
  const catItem = catalog.find(c => c.id === layer.itemId && c.isCustom);
  if (catItem) {
    catItem.src = newSrc;
    saveCustomCatalog(catalog.filter(c => c.isCustom));
    renderCatalog();
  }
  document.getElementById("pngCleanerModal").classList.add("hidden");
  syncUI();
  draw();
  showToast("Fondo limpio aplicado al PNG");
});
document.getElementById("btnRestorePngOriginal").addEventListener("click", async () => {
  const layer = layers.find(l => l.uid === cleanerTargetUid);
  if (!layer || !layer.origSrc) return;
  await loadImage(layer.origSrc);
  layer.src = layer.origSrc;
  document.getElementById("pngCleanerModal").classList.add("hidden");
  syncUI();
  draw();
  showToast("PNG original restaurado");
});

// Add New Plant Modal + Drag & Drop
function openAddPlantModal(prefillFile = null) {
  newPlantImageDataUrl = null;
  document.getElementById("newPlantPreviewImg").classList.add("hidden");
  document.getElementById("newPlantDropPrompt").classList.remove("hidden");
  document.getElementById("npName").value = "";
  document.getElementById("npSci").value = "";
  document.getElementById("npHeight").value = "0.90";
  document.getElementById("npMin").value = "0.4";
  document.getElementById("npMax").value = "1.8";
  document.getElementById("npMinPot").value = "15";
  document.getElementById("addPlantModal").classList.remove("hidden");
  if (prefillFile) handleNewPlantFile(prefillFile);
}

function handleNewPlantFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    newPlantImageDataUrl = ev.target.result;
    const prevImg = document.getElementById("newPlantPreviewImg");
    prevImg.src = newPlantImageDataUrl;
    prevImg.classList.remove("hidden");
    document.getElementById("newPlantDropPrompt").classList.add("hidden");
    const nameInput = document.getElementById("npName");
    if (!nameInput.value.trim()) {
      nameInput.value = file.name.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ").slice(0, 26);
    }
  };
  reader.readAsDataURL(file);
}

document.getElementById("btnOpenNewPlant").addEventListener("click", () => openAddPlantModal());
document.getElementById("btnCatalogAdd").addEventListener("click", () => openAddPlantModal());
document.getElementById("btnCloseAddPlant").addEventListener("click", () => {
  document.getElementById("addPlantModal").classList.add("hidden");
});
document.getElementById("newPlantFileInput").addEventListener("change", (e) => {
  if (e.target.files?.[0]) handleNewPlantFile(e.target.files[0]);
  e.target.value = "";
});

const dropzone = document.getElementById("newPlantDropzone");
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("border-emerald-400"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("border-emerald-400"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("border-emerald-400");
  if (e.dataTransfer.files?.[0]) handleNewPlantFile(e.dataTransfer.files[0]);
});

const catalogAside = document.getElementById("catalogAside");
catalogAside.addEventListener("dragover", (e) => { e.preventDefault(); });
catalogAside.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files?.[0]) openAddPlantModal(e.dataTransfer.files[0]);
});

document.getElementById("btnSaveAddPlant").addEventListener("click", async () => {
  if (!newPlantImageDataUrl) {
    showToast("Subí una imagen PNG o JPG primero");
    return;
  }
  const name = document.getElementById("npName").value.trim() || "Planta propia";
  const sci = document.getElementById("npSci").value.trim() || "Especie personalizada";
  const category = document.getElementById("npCategory").value;
  const defH = Math.max(0.1, Number(document.getElementById("npHeight").value) || 0.9);
  const minH = Math.max(0.1, Number(document.getElementById("npMin").value) || 0.3);
  const maxH = Math.max(minH + 0.1, Number(document.getElementById("npMax").value) || 1.8);
  const minPot = Math.max(2, Number(document.getElementById("npMinPot").value) || 15);
  const sun = document.getElementById("npSun").value.trim() || "Sol / Media sombra";
  const water = document.getElementById("npWater").value.trim() || "Moderado";
  const autoClean = document.getElementById("npAutoClean").checked;

  let finalSrc = newPlantImageDataUrl;
  const img = await loadImage(finalSrc);
  if (autoClean && img) {
    const probe = document.createElement("canvas");
    probe.width = 4;
    probe.height = 4;
    const pctx = probe.getContext("2d");
    pctx.drawImage(img, 0, 0, 4, 4);
    const cornerAlpha = pctx.getImageData(0, 0, 1, 1).data[3];
    if (cornerAlpha > 220) {
      const cleaned = processPngCleaner(img, 35, 12, 1, true);
      finalSrc = cleaned.toDataURL("image/png");
      await loadImage(finalSrc);
    }
  }

  const newItem = {
    id: "custom_" + Date.now(),
    kind: "plant",
    isCustom: true,
    name,
    sci,
    category,
    heightLabel: `${minH.toFixed(1)} – ${maxH.toFixed(1)} m`,
    defaultHeightM: defH,
    minHeightM: minH * 0.7,
    idealMinM: minH,
    idealMaxM: maxH,
    maxHeightM: maxH * 1.3,
    minPotLiters: minPot,
    idealPotLiters: minPot * 2.5,
    sun,
    water,
    notes: "Especie cargada por el usuario.",
    src: finalSrc
  };

  catalog.unshift(newItem);
  saveCustomCatalog(catalog.filter(c => c.isCustom));
  renderCatalog();

  const newLayer = createLayer(newItem, 0.5, 0.74);
  layers.push(newLayer);
  selectedId = newLayer.uid;
  document.getElementById("addPlantModal").classList.add("hidden");
  syncUI();
  draw();
  showToast(`"${newItem.name}" guardada en catálogo y agregada`);
});

// Compare Before/After
document.getElementById("btnCompare").addEventListener("click", () => {
  compareMode = !compareMode;
  const btn = document.getElementById("btnCompare");
  const lbl = document.getElementById("compareLabel");
  if (compareMode) {
    btn.classList.add("bg-emerald-600", "text-white", "border-emerald-500");
    lbl.textContent = "Viendo Antes";
  } else {
    btn.classList.remove("bg-emerald-600", "text-white", "border-emerald-500");
    lbl.textContent = "Antes / Después";
  }
  draw();
});

// Upload Background Photo -> MANDATORY perspective setup popup!
document.getElementById("bgUploadInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const img = await loadImage(ev.target.result);
    bgImage = img;
    const maxW = 1400;
    const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    rebuildGroundHomography();
    viewZoom = 1;
    viewPanX = 0;
    viewPanY = 0;
    applyViewTransform();
    draw();
    // Show mandatory perspective guide modal immediately
    document.getElementById("perspectiveGuideModal").classList.remove("hidden");
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});

// Export Composition PNG
document.getElementById("btnExport").addEventListener("click", () => {
  const outCanvas = document.createElement("canvas");
  outCanvas.width = canvas.width;
  outCanvas.height = canvas.height;
  renderScene(outCanvas.getContext("2d"), true);

  const link = document.createElement("a");
  link.download = "paisajismo-cantero.png";
  link.href = outCanvas.toDataURL("image/png");
  link.click();
  showToast("Imagen exportada en PNG");
});

// Ficha Técnica (Technical Spec Sheet) Generation & Export
function buildSpecData() {
  const visibleLayers = layers.filter(l => l.visible);
  const plantLayers = visibleLayers.filter(l => l.kind === "plant");
  const containerLayers = visibleLayers.filter(l => l.kind === "container");

  const groupedPlants = new Map();
  for (const pl of plantLayers) {
    const item = catalog.find(i => i.id === pl.itemId) || {};
    const cont = pl.containerUid ? containerLayers.find(c => c.uid === pl.containerUid) : null;
    const locLabel = cont ? (cont.isGroundSoil ? `${cont.name} (Suelo directo)` : `${cont.name} (${cont.liters} L)`) : "Tierra directa";
    const key = `${pl.itemId}|${pl.containerUid || "ground"}`;
    const hM = getLayerRealHeightM(pl);

    if (!groupedPlants.has(key)) {
      groupedPlants.set(key, {
        name: pl.name,
        sci: item.sci || "",
        category: item.category === "cerco" ? "Cerco" : item.category === "arboles" ? "Árbol" : item.category === "trepadoras" ? "Trepadora" : item.category === "primera" ? "1ª Fila" : "Propia",
        count: 0,
        heights: [],
        heightRange: item.heightLabel || "—",
        minPotLiters: item.minPotLiters || "—",
        sun: item.sun || "Sol / Media sombra",
        water: item.water || "Moderado",
        notes: item.notes || "",
        location: locLabel,
        src: pl.src
      });
    }
    const g = groupedPlants.get(key);
    g.count++;
    g.heights.push(hM);
  }

  const plantRows = Array.from(groupedPlants.values()).map(g => {
    const avgH = g.heights.reduce((a, b) => a + b, 0) / g.heights.length;
    return { ...g, avgHeightM: avgH };
  });

  const containerRows = containerLayers.map(c => {
    const mat = CONTAINER_MATERIALS[c.material];
    const col = mat?.colors.find(x => x.id === c.colorId);
    const assigned = plantLayers.filter(p => p.containerUid === c.uid).map(p => p.name);
    const parentC = c.parentContainerUid ? containerLayers.find(x => x.uid === c.parentContainerUid) : null;
    const liters = c.liters ?? 45;
    const bags = c.isGroundSoil || liters <= 0 ? 0 : Math.ceil(liters / 25);
    return {
      name: parentC ? `${c.name} (en ${parentC.name})` : c.name,
      isGroundSoil: !!c.isGroundSoil,
      materialLabel: c.shape === "tierra_organica" ? "Tierra orgánica" : `${mat?.label || c.material} (${col?.label || c.colorId})`,
      liters: c.isGroundSoil ? "Suelo directo" : `${liters} L${bags ? ` (${bags}×25L)` : " (vacío)"}`,
      viewAngle: c.shape === "tierra_organica" ? "Orgánica" : `H:${c.viewAngle || 0}° / V:${c.viewPitch ?? 22}°`,
      assignedPlants: assigned.length ? assigned.join(", ") : "Sin plantas asignadas"
    };
  });

  const totalLiters = containerLayers.filter(c => !c.isGroundSoil).reduce((s, c) => s + (c.liters ?? 0), 0);
  const distinctSpecies = new Set(plantLayers.map(p => p.itemId)).size;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = canvas.width;
  outCanvas.height = canvas.height;
  renderScene(outCanvas.getContext("2d"), true);
  const sceneImgUrl = outCanvas.toDataURL("image/png");

  return {
    dateStr: new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" }),
    totalPlants: plantLayers.length,
    distinctSpecies,
    totalContainers: containerLayers.length,
    totalLiters,
    plantRows,
    containerRows,
    sceneImgUrl
  };
}

function renderSpecSheetHtml(data, standalone = false) {
  const plantsHtml = data.plantRows.length
    ? data.plantRows.map(r => `
      <tr style="border-bottom:1px solid #e4e4e7;">
        <td style="padding:8px 6px;font-weight:700;text-align:center;">${r.count}×</td>
        <td style="padding:8px 6px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="${r.src}" style="width:32px;height:32px;object-fit:contain;border-radius:4px;background:#f4f4f5;" />
            <div>
              <div style="font-weight:600;color:#18181b;">${r.name}</div>
              <div style="font-size:11px;color:#71717a;font-style:italic;">${r.sci}</div>
            </div>
          </div>
        </td>
        <td style="padding:8px 6px;font-size:12px;">${r.category}</td>
        <td style="padding:8px 6px;font-size:12px;"><strong>${r.avgHeightM.toFixed(2)} m</strong><br/><span style="color:#71717a;font-size:11px;">(${r.heightRange})</span></td>
        <td style="padding:8px 6px;font-size:12px;">${r.location}</td>
        <td style="padding:8px 6px;font-size:11px;color:#3f3f46;">
          <div><strong>Luz:</strong> ${r.sun}</div>
          <div><strong>Riego:</strong> ${r.water}</div>
          <div><strong>Maceta mín:</strong> ${r.minPotLiters} L</div>
          ${r.notes ? `<div style="margin-top:2px;color:#52525b;">${r.notes}</div>` : ""}
        </td>
      </tr>`).join("")
    : `<tr><td colspan="6" style="padding:16px;text-align:center;color:#71717a;">No hay plantas visibles en la escena.</td></tr>`;

  const contHtml = data.containerRows.length
    ? data.containerRows.map(c => `
      <tr style="border-bottom:1px solid #e4e4e7;">
        <td style="padding:7px 6px;font-weight:600;">${c.name}</td>
        <td style="padding:7px 6px;font-size:12px;">${c.materialLabel}</td>
        <td style="padding:7px 6px;font-size:12px;">${c.liters}</td>
        <td style="padding:7px 6px;font-size:12px;">${c.viewAngle}</td>
        <td style="padding:7px 6px;font-size:12px;color:#3f3f46;">${c.assignedPlants}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="padding:12px;text-align:center;color:#71717a;">No hay macetas, canteros ni sectores de tierra en la escena.</td></tr>`;

  const inner = `
    <div style="font-family:Inter,system-ui,sans-serif;color:#18181b;max-width:900px;margin:0 auto;">
      <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #10b981;padding-bottom:10px;margin-bottom:16px;">
        <div>
          <h1 style="margin:0;font-size:20px;font-weight:700;">Cantero Studio — Ficha Técnica de Paisajismo</h1>
          <p style="margin:3px 0 0;font-size:12px;color:#52525b;">Desglose botánico, especificaciones de cultivo y sustratos recomendados</p>
        </div>
        <div style="text-align:right;font-size:12px;color:#52525b;">
          <div><strong>Fecha:</strong> ${data.dateStr}</div>
          <div><strong>Escala:</strong> 1 m ≈ ${Math.round(calibration.pxPerMeter)} px</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">
        <div style="background:#f4f4f5;padding:10px;border-radius:8px;">
          <div style="font-size:11px;color:#71717a;">Total Plantas</div>
          <div style="font-size:18px;font-weight:700;">${data.totalPlants}</div>
        </div>
        <div style="background:#f4f4f5;padding:10px;border-radius:8px;">
          <div style="font-size:11px;color:#71717a;">Especies</div>
          <div style="font-size:18px;font-weight:700;">${data.distinctSpecies}</div>
        </div>
        <div style="background:#f4f4f5;padding:10px;border-radius:8px;">
          <div style="font-size:11px;color:#71717a;">Canteros / Tierra</div>
          <div style="font-size:18px;font-weight:700;">${data.totalContainers}</div>
        </div>
        <div style="background:#f4f4f5;padding:10px;border-radius:8px;">
          <div style="font-size:11px;color:#71717a;">Sustrato Total</div>
          <div style="font-size:18px;font-weight:700;">${data.totalLiters} L (${Math.ceil(data.totalLiters / 25)}×25L)</div>
        </div>
      </div>

      <div style="margin-bottom:18px;">
        <img src="${data.sceneImgUrl}" style="width:100%;max-height:340px;object-fit:contain;border-radius:8px;border:1px solid #e4e4e7;background:#18181b;" />
      </div>

      <h2 style="font-size:14px;font-weight:700;margin:0 0 8px;color:#065f46;text-transform:uppercase;letter-spacing:0.04em;">Desglose de Plantas Incluidas</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
        <thead>
          <tr style="background:#f4f4f5;text-align:left;font-size:11px;color:#52525b;">
            <th style="padding:8px 6px;text-align:center;">Cant.</th>
            <th style="padding:8px 6px;">Especie</th>
            <th style="padding:8px 6px;">Categoría</th>
            <th style="padding:8px 6px;">Altura est.</th>
            <th style="padding:8px 6px;">Contenedor / Suelo</th>
            <th style="padding:8px 6px;">Especificaciones</th>
          </tr>
        </thead>
        <tbody>${plantsHtml}</tbody>
      </table>

      <h2 style="font-size:14px;font-weight:700;margin:0 0 8px;color:#065f46;text-transform:uppercase;letter-spacing:0.04em;">Macetas, Canteros y Tierra al Piso</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f4f4f5;text-align:left;font-size:11px;color:#52525b;">
            <th style="padding:7px 6px;">Elemento</th>
            <th style="padding:7px 6px;">Materialidad y Color</th>
            <th style="padding:7px 6px;">Sustrato</th>
            <th style="padding:7px 6px;">Vista</th>
            <th style="padding:7px 6px;">Plantas asignadas</th>
          </tr>
        </thead>
        <tbody>${contHtml}</tbody>
      </table>
    </div>
  `;

  if (!standalone) return inner;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Ficha Técnica - Cantero Studio</title></head><body style="padding:24px;background:#fff;">${inner}</body></html>`;
}

document.getElementById("btnSpecSheet").addEventListener("click", () => {
  const data = buildSpecData();
  document.getElementById("specSheetBody").innerHTML = renderSpecSheetHtml(data, false);
  document.getElementById("specSheetModal").classList.remove("hidden");
});

document.getElementById("btnCloseSpec").addEventListener("click", () => {
  document.getElementById("specSheetModal").classList.add("hidden");
});

document.getElementById("btnPrintSpec").addEventListener("click", () => {
  window.print();
});

document.getElementById("btnDownloadSpecHtml").addEventListener("click", () => {
  const data = buildSpecData();
  const html = renderSpecSheetHtml(data, true);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "ficha-tecnica-cantero.html";
  link.click();
  showToast("Ficha técnica HTML descargada");
});

document.getElementById("btnDownloadSpecCsv").addEventListener("click", () => {
  const data = buildSpecData();
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["Tipo", "Cantidad", "Nombre", "Científico / Material", "Altura / Sustrato", "Ubicación / Vista", "Luz", "Riego", "Notas"].map(esc).join(",")
  ];
  for (const r of data.plantRows) {
    lines.push(["Planta", r.count, r.name, r.sci, `${r.avgHeightM.toFixed(2)} m (${r.heightRange})`, r.location, r.sun, r.water, r.notes].map(esc).join(","));
  }
  for (const c of data.containerRows) {
    lines.push(["Contenedor/Tierra", 1, c.name, c.materialLabel, c.liters, c.viewAngle, "", "", c.assignedPlants].map(esc).join(","));
  }
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "ficha-tecnica-cantero.csv";
  link.click();
  showToast("Ficha técnica CSV descargada");
});

// Load Sample Demo Scene
async function loadDemoScene() {
  const bg = await loadImage(SAMPLE_BG_SRC);
  bgImage = bg;
  canvas.width = bg ? bg.naturalWidth : 1000;
  canvas.height = bg ? bg.naturalHeight : 714;
  rebuildGroundHomography();
  calibration.pxPerMeter = 195;
  viewZoom = 1;
  viewPanX = 0;
  viewPanY = 0;
  applyViewTransform();

  await Promise.all(BUILTIN_ITEMS.map(p => loadImage(p.src)));

  const byId = id => BUILTIN_ITEMS.find(p => p.id === id);
  layers = [
    createLayer(byId("bambu"), 0.52, 0.54, 2.3, false),
    createLayer(byId("fotinia"), 0.37, 0.60, 1.75, false),
    createLayer(byId("alpinia"), 0.24, 0.68, 1.35, true),
    createLayer(byId("formio_rubra"), 0.35, 0.72, 0.85, false),
    createLayer(byId("agapanto"), 0.22, 0.76, 0.75, false)
  ];
  selectedId = layers[1].uid;
  setMaskMode(false);
  setCalibrationMode(false);
  setPerspectiveVisible(false);
  syncUI();
  draw();
}

document.getElementById("btnResetDemo").addEventListener("click", () => {
  loadDemoScene();
  showToast("Escena de ejemplo restaurada");
});

window.addEventListener("DOMContentLoaded", async () => {
  await preloadContainerTextures();
  hydrateBuiltinContainers();
  renderCatalog();
  await loadDemoScene();
});


// Software-style Top Dropdown Menus
document.querySelectorAll(".menu-trigger").forEach(trigger => {
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const group = trigger.closest(".menu-group");
    const drop = group.querySelector(".menu-dropdown");
    const wasHidden = drop.classList.contains("hidden");
    document.querySelectorAll(".menu-dropdown").forEach(d => d.classList.add("hidden"));
    if (wasHidden) drop.classList.remove("hidden");
  });
});
document.addEventListener("click", () => {
  document.querySelectorAll(".menu-dropdown").forEach(d => d.classList.add("hidden"));
});
document.querySelectorAll(".menu-dropdown button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".menu-dropdown").forEach(d => d.classList.add("hidden"));
  });
});
document.getElementById("btnMenuZoomIn").addEventListener("click", () => setViewerZoom(viewZoom * 1.2));
document.getElementById("btnMenuZoomOut").addEventListener("click", () => setViewerZoom(viewZoom * 0.82));
document.getElementById("btnMenuZoomReset").addEventListener("click", () => {
  viewZoom = 1; viewPanX = 0; viewPanY = 0; applyViewTransform();
});
