import { SAMPLE_BG_SRC, BUILTIN_ITEMS } from "./data/catalog.js";
import { CONTAINER_MATERIALS, getContainerRenderSrc } from "./utils/containerRenderer.js";

const CUSTOM_STORAGE_KEY = "cantero_custom_catalog_v1";

// Hydrate procedural src for built-in containers/soil that have src: null
for (const item of BUILTIN_ITEMS) {
  if (!item.src && item.kind === "container") {
    item.src = getContainerRenderSrc({
      shape: item.shape || "cantero_rect",
      material: item.material || "cemento",
      colorId: item.colorId || "gris_claro",
      viewAngle: item.viewAngle || 0,
      isGroundSoil: !!item.isGroundSoil,
      mulch: !!item.mulch
    });
  }
}

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

// Scale & Perspective State
const calibration = {
  pxPerMeter: 195,
  mode: false,
  pts: [] // [{x, y}, {x, y}]
};

const perspective = {
  visible: false,
  autoScale: true,
  // Normalized [0..1] quad: tl, tr (back/far), br, bl (front/near)
  quad: {
    tl: { x: 0.28, y: 0.56 },
    tr: { x: 0.72, y: 0.56 },
    br: { x: 0.92, y: 0.94 },
    bl: { x: 0.08, y: 0.94 }
  }
};

// Drag / Resize / Paint / Perspective interaction state
let dragState = null;

// Modals state
let cleanerTargetUid = null;
let pendingContainerItem = null;
let pendingExistingContainerUid = null;
let newPlantImageDataUrl = null;

const canvas = document.getElementById("mainCanvas");
const ctx = canvas.getContext("2d");
const imageCache = new Map();

const tempCanvas = document.createElement("canvas");
const tempCtx = tempCanvas.getContext("2d");

function loadImage(src) {
  if (!src) return Promise.resolve(null);
  if (imageCache.has(src)) return Promise.resolve(imageCache.get(src));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = src;
  });
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("opacity-0");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("opacity-0"), 2600);
}

// Perspective Math
function getPerspectiveFactorAtY(yPx) {
  const ch = canvas.height || 714;
  const q = perspective.quad;
  const topY = ((q.tl.y + q.tr.y) / 2) * ch;
  const botY = ((q.bl.y + q.br.y) / 2) * ch;
  const topW = Math.hypot(q.tr.x - q.tl.x, q.tr.y - q.tl.y);
  const botW = Math.hypot(q.br.x - q.bl.x, q.br.y - q.bl.y);
  const ratio = botW > 0.01 ? Math.max(0.25, Math.min(1.0, topW / botW)) : 0.65;
  const span = Math.max(20, botY - topY);
  const t = Math.max(-0.2, Math.min(1.35, (yPx - topY) / span));
  return ratio + (1 - ratio) * t;
}

function heightMToScale(heightM, perspFactor = 1) {
  const ch = canvas.height || 714;
  return (heightM * perspFactor * calibration.pxPerMeter) / ch;
}

function getLayerRealHeightM(layer) {
  const ch = canvas.height || 714;
  const px = ch * layer.scale;
  const pf = perspective.autoScale ? (layer.perspFactor || 1) : 1;
  return px / (calibration.pxPerMeter * Math.max(0.15, pf));
}

function getPotMaxHeightM(item, containerLiters) {
  if (!item || item.kind !== "plant") return Infinity;
  const idealPot = item.idealPotLiters || 50;
  const ratio = Math.min(1.15, Math.pow(Math.max(3, containerLiters) / idealPot, 0.42));
  return Math.max(item.minHeightM || 0.25, (item.idealMaxM || 2.0) * ratio);
}

function evaluateBotanicalRealism(layer) {
  const item = catalog.find(p => p.id === layer.itemId);
  if (!item || item.kind !== "plant") return { level: "ok", message: "" };

  const hM = getLayerRealHeightM(layer);
  const container = layer.containerUid ? layers.find(l => l.uid === layer.containerUid) : null;

  if (container && !container.isGroundSoil) {
    const potL = container.liters || 40;
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
  if (!container || container.isGroundSoil || !item || item.kind !== "plant") return;
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
  const scale = Math.max(0.08, heightMToScale(targetRealH, persp));

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
    liters: item.liters || 45,
    isGroundSoil: !!item.isGroundSoil,
    shape: item.shape || "cantero_rect",
    material: item.material || "cemento",
    colorId: item.colorId || "gris_claro",
    viewAngle: item.viewAngle ?? 0,
    mulch: !!item.mulch,
    containerUid: null,
    respectPotLimit: true,
    maskCanvas
  };
}

function getLayerRect(layer) {
  const img = imageCache.get(layer.src);
  if (!img) return { x: 0, y: 0, w: 0, h: 0 };
  const baseH = canvas.height * layer.scale;
  const aspect = img.naturalWidth / img.naturalHeight;
  const w = baseH * aspect;
  const h = baseH;
  return {
    x: layer.x - w / 2,
    y: layer.y - h,
    w,
    h
  };
}

function getSelectedLayer() {
  return layers.find(l => l.uid === selectedId) || null;
}

function detectContainerUnderLayer(plantLayer) {
  if (plantLayer.kind !== "plant") return null;
  for (let i = layers.length - 1; i >= 0; i--) {
    const c = layers[i];
    if (c.kind !== "container" || !c.visible) continue;
    const rect = getLayerRect(c);
    if (
      plantLayer.x >= rect.x &&
      plantLayer.x <= rect.x + rect.w &&
      plantLayer.y >= rect.y - rect.h * 0.15 &&
      plantLayer.y <= rect.y + rect.h * 0.75
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

  // Perspective Grid Overlay (under layers)
  if (!forExport && perspective.visible) {
    drawPerspectiveGrid(targetCtx, cw, ch);
  }

  for (const layer of layers) {
    if (!layer.visible) continue;
    const img = imageCache.get(layer.src);
    if (!img) continue;

    const rect = getLayerRect(layer);

    // 1. Ground contact & cast shadow
    if (layer.shadowOpacity > 0) {
      targetCtx.save();
      const shadowAlpha = (layer.shadowOpacity / 100) * 0.65;
      const sx = layer.x + (layer.shadowOffset * rect.w * 0.004);
      const sy = layer.y - rect.h * 0.03;
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

    // 2. Masked + color-filtered item in offscreen buffer
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

    // 3. Draw onto main canvas anchored at bottom center
    targetCtx.save();
    targetCtx.translate(layer.x, layer.y);
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
    targetCtx.strokeStyle = "rgba(56, 189, 248, 0.85)";
    targetCtx.lineWidth = 1.5;
    targetCtx.setLineDash([5, 5]);
    targetCtx.beginPath();
    targetCtx.moveTo(l.x, 0);
    targetCtx.lineTo(l.x, ch);
    targetCtx.stroke();
    targetCtx.setLineDash([]);

    const badgeText = "Solo vertical (Shift) · sin profundidad";
    targetCtx.font = "600 11px Inter, sans-serif";
    const bw = targetCtx.measureText(badgeText).width + 16;
    targetCtx.fillStyle = "rgba(15, 23, 42, 0.9)";
    targetCtx.beginPath();
    targetCtx.roundRect(Math.min(cw - bw - 10, Math.max(10, l.x + 12)), Math.max(10, l.y - 28), bw, 22, 6);
    targetCtx.fill();
    targetCtx.fillStyle = "#38bdf8";
    targetCtx.fillText(badgeText, Math.min(cw - bw - 10, Math.max(10, l.x + 12)) + 8, Math.max(10, l.y - 28) + 15);
    targetCtx.restore();
  }

  // Calibration 2-point line
  if (calibration.mode && calibration.pts.length > 0) {
    targetCtx.save();
    targetCtx.strokeStyle = "#38bdf8";
    targetCtx.fillStyle = "#38bdf8";
    targetCtx.lineWidth = Math.max(2, cw / 450);
    for (const p of calibration.pts) {
      targetCtx.beginPath();
      targetCtx.arc(p.x, p.y, Math.max(5, cw / 180), 0, Math.PI * 2);
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

  // Selection bounding box, corner handles & real-height label
  const sel = getSelectedLayer();
  if (sel && sel.visible) {
    const rect = getLayerRect(sel);
    const realism = evaluateBotanicalRealism(sel);
    targetCtx.save();
    targetCtx.translate(sel.x, sel.y);
    targetCtx.rotate((sel.rotation * Math.PI) / 180);

    const strokeCol = maskMode
      ? "#fbbf24"
      : realism.level === "error"
      ? "#ef4444"
      : realism.level === "warn"
      ? "#f59e0b"
      : "#34d399";

    targetCtx.strokeStyle = strokeCol;
    targetCtx.lineWidth = Math.max(1.5, cw / 550);
    targetCtx.setLineDash([6, 4]);
    targetCtx.strokeRect(-rect.w / 2, -rect.h, rect.w, rect.h);
    targetCtx.setLineDash([]);

    // Height tag pill at top-left of selection
    const hM = getLayerRealHeightM(sel);
    const label = `${hM >= 1 ? hM.toFixed(2) + " m" : Math.round(hM * 100) + " cm"}${realism.level !== "ok" ? " !" : ""}`;
    targetCtx.font = `600 ${Math.max(11, Math.round(cw / 95))}px Inter, sans-serif`;
    const padX = 7;
    const tw = targetCtx.measureText(label).width + padX * 2;
    const th = 20;
    targetCtx.fillStyle = "rgba(9, 9, 11, 0.85)";
    targetCtx.beginPath();
    targetCtx.roundRect(-rect.w / 2, -rect.h - th - 4, tw, th, 5);
    targetCtx.fill();
    targetCtx.fillStyle = strokeCol;
    targetCtx.fillText(label, -rect.w / 2 + padX, -rect.h - 9);

    if (!maskMode) {
      const handleR = Math.max(6, cw / 150);
      const corners = [
        [-rect.w / 2, -rect.h],
        [rect.w / 2, -rect.h],
        [-rect.w / 2, 0],
        [rect.w / 2, 0]
      ];
      for (const [cx, cy] of corners) {
        targetCtx.fillStyle = "#ffffff";
        targetCtx.strokeStyle = "#059669";
        targetCtx.lineWidth = 2;
        targetCtx.beginPath();
        targetCtx.arc(cx, cy, handleR, 0, Math.PI * 2);
        targetCtx.fill();
        targetCtx.stroke();
      }
    }
    targetCtx.restore();
  }

  // Scale reference bar (bottom-left)
  drawScaleBar(targetCtx, cw, ch);
}

function drawScaleBar(targetCtx, cw, ch) {
  const px1m = calibration.pxPerMeter;
  if (!px1m || px1m <= 10) return;
  const barPx = Math.min(cw * 0.35, px1m);
  const metersShown = barPx / px1m;
  const x0 = 18;
  const y0 = ch - 18;

  targetCtx.save();
  targetCtx.fillStyle = "rgba(9, 9, 11, 0.72)";
  targetCtx.beginPath();
  targetCtx.roundRect(x0 - 8, y0 - 24, barPx + 16, 32, 6);
  targetCtx.fill();

  targetCtx.strokeStyle = "#38bdf8";
  targetCtx.lineWidth = 2.5;
  targetCtx.beginPath();
  targetCtx.moveTo(x0, y0 - 6);
  targetCtx.lineTo(x0, y0);
  targetCtx.lineTo(x0 + barPx, y0);
  targetCtx.lineTo(x0 + barPx, y0 - 6);
  targetCtx.stroke();

  targetCtx.fillStyle = "#e4e4e7";
  targetCtx.font = "600 11px Inter, sans-serif";
  targetCtx.fillText(`${metersShown.toFixed(2)} m`, x0 + 4, y0 - 9);
  targetCtx.restore();
}

function drawPerspectiveGrid(targetCtx, cw, ch) {
  const q = perspective.quad;
  const p = {
    tl: { x: q.tl.x * cw, y: q.tl.y * ch },
    tr: { x: q.tr.x * cw, y: q.tr.y * ch },
    br: { x: q.br.x * cw, y: q.br.y * ch },
    bl: { x: q.bl.x * cw, y: q.bl.y * ch }
  };

  targetCtx.save();
  targetCtx.strokeStyle = "rgba(167, 139, 250, 0.55)";
  targetCtx.lineWidth = 1.5;

  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lx = p.tl.x + (p.bl.x - p.tl.x) * t;
    const ly = p.tl.y + (p.bl.y - p.tl.y) * t;
    const rx = p.tr.x + (p.br.x - p.tr.x) * t;
    const ry = p.tr.y + (p.br.y - p.tr.y) * t;
    targetCtx.beginPath();
    targetCtx.moveTo(lx, ly);
    targetCtx.lineTo(rx, ry);
    targetCtx.stroke();

    const tx = p.tl.x + (p.tr.x - p.tl.x) * t;
    const ty = p.tl.y + (p.tr.y - p.tl.y) * t;
    const bx = p.bl.x + (p.br.x - p.bl.x) * t;
    const by = p.bl.y + (p.br.y - p.bl.y) * t;
    targetCtx.beginPath();
    targetCtx.moveTo(tx, ty);
    targetCtx.lineTo(bx, by);
    targetCtx.stroke();
  }

  for (const key of ["tl", "tr", "br", "bl"]) {
    const pt = p[key];
    targetCtx.fillStyle = "#8b5cf6";
    targetCtx.strokeStyle = "#ffffff";
    targetCtx.lineWidth = 2;
    targetCtx.beginPath();
    targetCtx.arc(pt.x, pt.y, Math.max(7, cw / 140), 0, Math.PI * 2);
    targetCtx.fill();
    targetCtx.stroke();
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

  // 2. Perspective quad handles
  if (perspective.visible) {
    const tol = Math.max(16, canvas.width / 60);
    for (const key of ["tl", "tr", "br", "bl"]) {
      const px = perspective.quad[key].x * canvas.width;
      const py = perspective.quad[key].y * canvas.height;
      if (Math.hypot(x - px, y - py) <= tol) {
        dragState = { type: "persp", key };
        return;
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
  if (sel && sel.visible) {
    const rect = getLayerRect(sel);
    const { rx, ry } = toLayerLocal(sel, x, y);
    const tol = Math.max(14, canvas.width / 65);
    const corners = [
      [-rect.w / 2, -rect.h],
      [rect.w / 2, -rect.h],
      [-rect.w / 2, 0],
      [rect.w / 2, 0]
    ];
    for (const [hx, hy] of corners) {
      if (Math.hypot(rx - hx, ry - hy) <= tol) {
        const distStart = Math.max(10, Math.hypot(x - sel.x, y - (sel.y - rect.h / 2)));
        dragState = { type: "scale", layer: sel, origScale: sel.scale, distStart };
        return;
      }
    }
  }

  // 5. Hit test layers top-to-bottom
  let hitLayer = null;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible) continue;
    const rect = getLayerRect(l);
    const { rx, ry } = toLayerLocal(l, x, y);
    if (rx >= -rect.w / 2 && rx <= rect.w / 2 && ry >= -rect.h && ry <= 0) {
      hitLayer = l;
      break;
    }
  }

  if (hitLayer) {
    selectedId = hitLayer.uid;
    dragState = {
      type: "move",
      layer: hitLayer,
      startX: hitLayer.x,
      offsetX: x - hitLayer.x,
      offsetY: y - hitLayer.y,
      prevPersp: perspective.autoScale ? getPerspectiveFactorAtY(hitLayer.y) : 1,
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
  const { x, y } = getCanvasCoords(e);

  if (dragState.type === "persp") {
    perspective.quad[dragState.key].x = Math.max(0.02, Math.min(0.98, x / canvas.width));
    perspective.quad[dragState.key].y = Math.max(0.05, Math.min(0.98, y / canvas.height));
    draw();
  } else if (dragState.type === "mask") {
    paintMaskAt(dragState.layer, x, y);
  } else if (dragState.type === "move") {
    const l = dragState.layer;
    if (e.shiftKey) {
      // Shift = solo mover arriba o abajo (eje vertical), SIN eje de profundidad ni auto-escala
      l.x = dragState.startX;
      l.y = y - dragState.offsetY;
      dragState.shiftLocked = true;
      dragState.prevPersp = perspective.autoScale ? getPerspectiveFactorAtY(l.y) : 1;
    } else {
      l.x = x - dragState.offsetX;
      l.y = y - dragState.offsetY;
      dragState.shiftLocked = false;

      if (perspective.autoScale) {
        const newPersp = getPerspectiveFactorAtY(l.y);
        if (dragState.prevPersp > 0.05) {
          l.scale = Math.max(0.08, Math.min(2.8, l.scale * (newPersp / dragState.prevPersp)));
        }
        l.perspFactor = newPersp;
        dragState.prevPersp = newPersp;
        clampScaleToPotIfNeeded(l);
      }
    }
    syncInspectorValues();
    draw();
  } else if (dragState.type === "scale") {
    const l = dragState.layer;
    const rect = getLayerRect(l);
    const distNow = Math.max(10, Math.hypot(x - l.x, y - (l.y - rect.h / 2)));
    const factor = distNow / dragState.distStart;
    l.scale = Math.max(0.08, Math.min(2.8, dragState.origScale * factor));
    clampScaleToPotIfNeeded(l);
    syncInspectorValues();
    draw();
  }
});

function endDrag() {
  if (dragState && dragState.type === "move" && dragState.layer.kind === "plant") {
    const l = dragState.layer;
    if (!l.containerUid) {
      const found = detectContainerUnderLayer(l);
      if (found) {
        l.containerUid = found.uid;
        clampScaleToPotIfNeeded(l);
        showToast(found.isGroundSoil ? `${l.name} ubicada en ${found.name}` : `${l.name} ubicada en ${found.name} (${found.liters} L)`);
        syncUI();
        draw();
      }
    }
  }
  dragState = null;
  canvas.style.cursor = maskMode || calibration.mode ? "crosshair" : "grab";
  draw();
}

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

canvas.addEventListener("wheel", (e) => {
  const sel = getSelectedLayer();
  if (!sel || compareMode || maskMode || calibration.mode) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1.06 : 0.94;
  sel.scale = Math.max(0.08, Math.min(2.8, sel.scale * delta));
  clampScaleToPotIfNeeded(sel);
  syncInspectorValues();
  draw();
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
    e.preventDefault();
    deleteSelectedLayer();
  } else if (e.key === "Escape") {
    if (maskMode) setMaskMode(false);
    if (calibration.mode) setCalibrationMode(false);
    document.getElementById("potPlantPickerModal").classList.add("hidden");
    document.getElementById("addPlantModal").classList.add("hidden");
    document.getElementById("specSheetModal").classList.add("hidden");
  }
});

// Helper: place plant inside a container layer
async function addPlantInsideContainer(plantItem, containerLayer) {
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
      : `Elegí una especie compatible con ${c?.liters || 45} L de sustrato.`;
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
    ? (layers.find(l => l.uid === pendingExistingContainerUid)?.isGroundSoil ? 9999 : layers.find(l => l.uid === pendingExistingContainerUid)?.liters || 45)
    : (pendingContainerItem?.isGroundSoil ? 9999 : pendingContainerItem?.liters || 45);

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

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "group relative text-left bg-zinc-950/70 hover:bg-zinc-800/80 border border-zinc-800 hover:border-emerald-500/50 rounded-lg p-2 transition flex flex-col cursor-pointer";
    const badgeColor =
      item.category === "cerco"
        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
        : item.category === "primera"
        ? "bg-violet-500/15 text-violet-300 border-violet-500/30"
        : item.category === "macetas"
        ? "bg-orange-500/15 text-orange-300 border-orange-500/30"
        : item.category === "tierra"
        ? "bg-lime-500/15 text-lime-300 border-lime-500/30"
        : "bg-amber-500/15 text-amber-300 border-amber-500/30";
    const badgeLabel =
      item.category === "cerco"
        ? "Cerco"
        : item.category === "primera"
        ? "1ª Fila"
        : item.category === "macetas"
        ? "Maceta"
        : item.category === "tierra"
        ? "Tierra"
        : "Propia";

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

      if (item.kind === "container") {
        openPotPlantPicker(item, null);
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

// Layers List UI
function renderLayersList() {
  const list = document.getElementById("layersList");
  document.getElementById("layerCount").textContent = layers.length;
  list.innerHTML = "";

  if (layers.length === 0) {
    list.innerHTML = `<div class="text-xs text-zinc-500 py-3 text-center">Sin capas todavía.</div>`;
    return;
  }

  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const isSel = l.uid === selectedId;
    const realism = evaluateBotanicalRealism(l);
    const hM = getLayerRealHeightM(l);
    const row = document.createElement("div");
    row.className = `flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border text-xs cursor-pointer transition ${
      isSel ? "bg-emerald-500/15 border-emerald-500/50 text-zinc-100" : "bg-zinc-950/60 border-zinc-800 text-zinc-300 hover:border-zinc-700"
    }`;

    const warnDot = realism.level === "error"
      ? `<span class="w-2 h-2 rounded-full bg-red-500 shrink-0" title="${realism.message}"></span>`
      : realism.level === "warn"
      ? `<span class="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="${realism.message}"></span>`
      : "";

    row.innerHTML = `
      <div class="flex items-center gap-2 min-w-0">
        <img src="${l.src}" class="w-6 h-6 object-contain rounded bg-zinc-800 shrink-0" alt="" />
        <span class="truncate font-medium">${l.name}</span>
        ${warnDot}
        <span class="text-[10px] text-zinc-500 shrink-0">${hM.toFixed(1)}m</span>
      </div>
      <button type="button" class="vis-btn p-1 rounded hover:bg-zinc-800 ${l.visible ? "text-zinc-300" : "text-zinc-600"}" title="Mostrar/Ocultar">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="${l.visible ? "M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" : "M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18"}"/>
        </svg>
      </button>
    `;

    row.addEventListener("click", (e) => {
      if (e.target.closest(".vis-btn")) {
        l.visible = !l.visible;
        renderLayersList();
        draw();
        return;
      }
      selectedId = l.uid;
      syncUI();
      draw();
    });

    list.appendChild(row);
  }
}

async function refreshContainerLayerAppearance(layer) {
  if (!layer || layer.kind !== "container") return;
  const newSrc = getContainerRenderSrc({
    shape: layer.shape || "cantero_rect",
    material: layer.material || "cemento",
    colorId: layer.colorId || "gris_claro",
    viewAngle: layer.viewAngle || 0,
    isGroundSoil: !!layer.isGroundSoil,
    mulch: !!layer.mulch
  });
  await loadImage(newSrc);
  layer.src = newSrc;
  layer.origSrc = newSrc;
  renderLayersList();
  draw();
}

function renderMaterialAndColorControls(sel) {
  const matSelect = document.getElementById("ctrlContainerMaterial");
  const swatchesDiv = document.getElementById("containerColorSwatches");
  const viewSec = document.getElementById("containerViewSection");
  const matSec = document.getElementById("containerMaterialSection");

  if (sel.shape === "tierra_organica") {
    viewSec.classList.add("hidden");
    matSec.classList.add("hidden");
    return;
  }

  viewSec.classList.remove("hidden");
  matSec.classList.remove("hidden");

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
  document.getElementById("valRealHeight").textContent = hM >= 1 ? `${hM.toFixed(2)} m` : `${Math.round(hM * 100)} cm`;

  const plantBox = document.getElementById("plantBotanicalDetails");
  const contBox = document.getElementById("containerDetails");
  const item = catalog.find(p => p.id === sel.itemId);

  if (sel.kind === "container") {
    plantBox.classList.add("hidden");
    contBox.classList.remove("hidden");

    const potWrap = document.getElementById("potLitersWrap");
    const soilNote = document.getElementById("groundSoilNote");
    if (sel.isGroundSoil) {
      potWrap.classList.add("hidden");
      soilNote.classList.remove("hidden");
    } else {
      potWrap.classList.remove("hidden");
      soilNote.classList.add("hidden");
      document.getElementById("ctrlPotLiters").value = sel.liters || 45;
      document.getElementById("valPotLiters").textContent = `${sel.liters || 45} L`;
    }

    document.getElementById("ctrlContainerAngle").value = sel.viewAngle || 0;
    document.getElementById("valContainerAngle").textContent = `${sel.viewAngle || 0}°`;
    document.querySelectorAll(".view-preset-btn").forEach(b => {
      const a = Number(b.dataset.angle);
      if (Math.abs((sel.viewAngle || 0) - a) <= 5) {
        b.classList.add("border-emerald-500", "text-emerald-300", "bg-emerald-500/15");
      } else {
        b.classList.remove("border-emerald-500", "text-emerald-300", "bg-emerald-500/15");
      }
    });

    renderMaterialAndColorControls(sel);
    return;
  }

  plantBox.classList.remove("hidden");
  contBox.classList.add("hidden");
  document.getElementById("valBotanicalRange").textContent = item?.heightLabel || "Personalizada";

  // Populate container dropdown
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

  // Realism alert
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
  document.getElementById("ctrlScale").value = Math.round(sel.scale * 100);
  document.getElementById("valScale").textContent = Math.round(sel.scale * 100) + "%";
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
  document.getElementById("scaleStatusText").textContent = `Escala: 1 m ≈ ${Math.round(calibration.pxPerMeter)} px`;
  renderLayersList();
}

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

function setCalibrationMode(active) {
  calibration.mode = active;
  calibration.pts = [];
  const banner = document.getElementById("calibrateBanner");
  const btn = document.getElementById("btnCalibrate");
  const inpGrp = document.getElementById("calibrateInputGroup");
  if (active) {
    if (maskMode) setMaskMode(false);
    banner.classList.remove("hidden");
    inpGrp.classList.add("hidden");
    inpGrp.classList.remove("flex");
    document.getElementById("calibratePromptText").textContent =
      "Hacé clic en 2 puntos de un objeto cuya medida real conozcas (ej. puerta, pared o maceta)";
    btn.classList.add("tool-btn-active");
    canvas.style.cursor = "crosshair";
  } else {
    banner.classList.add("hidden");
    btn.classList.remove("tool-btn-active");
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
    btn.classList.add("tool-btn-active");
  } else {
    banner.classList.add("hidden");
    btn.classList.remove("tool-btn-active");
  }
  draw();
}

function deleteSelectedLayer() {
  if (!selectedId) return;
  const removed = selectedId;
  layers = layers.filter(l => l.uid !== removed);
  for (const l of layers) {
    if (l.containerUid === removed) l.containerUid = null;
  }
  selectedId = layers.length ? layers[layers.length - 1].uid : null;
  setMaskMode(false);
  syncUI();
  draw();
}

// Calibration & Perspective Listeners
document.getElementById("btnCalibrate").addEventListener("click", () => setCalibrationMode(!calibration.mode));
document.getElementById("btnCancelCalibrate").addEventListener("click", () => setCalibrationMode(false));
document.getElementById("btnApplyCalibrate").addEventListener("click", () => {
  if (calibration.pts.length < 2) return;
  const meters = Number(document.getElementById("calibrateMetersInput").value);
  if (!meters || meters <= 0) return;
  const [p1, p2] = calibration.pts;
  const distPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (distPx < 8) {
    showToast("Marcá dos puntos más separados");
    return;
  }
  calibration.pxPerMeter = distPx / meters;
  setCalibrationMode(false);
  syncUI();
  draw();
  showToast(`Escala calibrada: 1 m ≈ ${Math.round(calibration.pxPerMeter)} px`);
});

document.getElementById("btnPerspective").addEventListener("click", () => setPerspectiveVisible(!perspective.visible));
document.getElementById("btnExitPerspective").addEventListener("click", () => setPerspectiveVisible(false));
document.getElementById("chkAutoPerspective").addEventListener("change", (e) => {
  perspective.autoScale = e.target.checked;
  showToast(perspective.autoScale ? "Auto-escala por perspectiva activada" : "Auto-escala desactivada");
});

// Container 3D View & Material Listeners
document.querySelectorAll(".view-preset-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const sel = getSelectedLayer();
    if (!sel || sel.kind !== "container") return;
    sel.viewAngle = Number(btn.dataset.angle);
    document.getElementById("ctrlContainerAngle").value = sel.viewAngle;
    document.getElementById("valContainerAngle").textContent = `${sel.viewAngle}°`;
    await refreshContainerLayerAppearance(sel);
    syncBotanicalInspector(sel);
  });
});

document.getElementById("ctrlContainerAngle").addEventListener("input", async (e) => {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "container") return;
  sel.viewAngle = Number(e.target.value);
  document.getElementById("valContainerAngle").textContent = `${sel.viewAngle}°`;
  await refreshContainerLayerAppearance(sel);
  syncBotanicalInspector(sel);
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

document.getElementById("btnPlantInContainer").addEventListener("click", () => {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "container") return;
  openPotPlantPicker(null, sel.uid);
});

// Inspector Listeners
document.getElementById("ctrlScale").addEventListener("input", (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.scale = Number(e.target.value) / 100;
  clampScaleToPotIfNeeded(sel);
  syncInspectorValues();
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

document.getElementById("ctrlContainerSelect").addEventListener("change", (e) => {
  const sel = getSelectedLayer();
  if (!sel) return;
  sel.containerUid = e.target.value || null;
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
document.getElementById("ctrlPotLiters").addEventListener("input", (e) => {
  const sel = getSelectedLayer();
  if (!sel || sel.kind !== "container") return;
  sel.liters = Number(e.target.value);
  document.getElementById("valPotLiters").textContent = sel.liters + " L";
  for (const l of layers) {
    if (l.containerUid === sel.uid) clampScaleToPotIfNeeded(l);
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
    if (c && !c.isGroundSoil) {
      const potMax = getPotMaxHeightM(item, c.liters || 40);
      targetM = Math.min(targetM, potMax * 0.95);
    }
  }
  const pf = perspective.autoScale ? (sel.perspFactor || 1) : 1;
  sel.scale = Math.max(0.08, heightMToScale(targetM, pf));
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
  const copy = {
    ...sel,
    uid: "layer_" + (nextUid++),
    x: sel.x + 35,
    y: sel.y + 8,
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

// Drag & Drop directly onto catalog panel to load new plant fast
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

// Upload Background Photo
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
    draw();
    showToast("Foto cargada. Usá 'Calibrar escala' para ajustar medidas reales.");
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

  // Group plants by itemId + containerUid
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
        category: item.category === "cerco" ? "Cerco" : item.category === "primera" ? "1ª Fila" : "Propia",
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
    return {
      name: c.name,
      isGroundSoil: !!c.isGroundSoil,
      materialLabel: c.shape === "tierra_organica" ? "Tierra orgánica" : `${mat?.label || c.material} (${col?.label || c.colorId})`,
      liters: c.isGroundSoil ? "Suelo directo" : `${c.liters} L`,
      viewAngle: c.shape === "tierra_organica" ? "Planta orgánica" : `${c.viewAngle || 0}°`,
      assignedPlants: assigned.length ? assigned.join(", ") : "Sin plantas asignadas"
    };
  });

  const totalLiters = containerLayers.filter(c => !c.isGroundSoil).reduce((s, c) => s + (c.liters || 0), 0);
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
          <p style="margin:3px 0 0;font-size:12px;color:#52525b;">Desglose botánico, especificaciones de cultivo y contenedores</p>
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
          <div style="font-size:11px;color:#71717a;">Sustrato en Macetas</div>
          <div style="font-size:18px;font-weight:700;">${data.totalLiters} L</div>
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
            <th style="padding:8px 6px;">Ubicación</th>
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
            <th style="padding:7px 6px;">Volumen</th>
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
    ["Tipo", "Cantidad", "Nombre", "Científico / Material", "Altura / Volumen", "Ubicación / Vista", "Luz", "Riego", "Notas"].map(esc).join(",")
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
  canvas.width = bg.naturalWidth;
  canvas.height = bg.naturalHeight;
  calibration.pxPerMeter = 195;

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
  renderCatalog();
  await loadDemoScene();
});
