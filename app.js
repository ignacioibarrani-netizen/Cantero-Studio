import { SAMPLE_BG_SRC, BUILTIN_ITEMS } from "./data/catalog.js";

// App State
const catalog = [...BUILTIN_ITEMS];
let activeFilter = "all";
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

const canvas = document.getElementById("mainCanvas");
const ctx = canvas.getContext("2d");
const imageCache = new Map();

const tempCanvas = document.createElement("canvas");
const tempCtx = tempCanvas.getContext("2d");

// PNG Cleaner State
let cleanerTargetUid = null;

function loadImage(src) {
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

function heightMToScale(heightM) {
  const ch = canvas.height || 714;
  return (heightM * calibration.pxPerMeter) / ch;
}

function getLayerRealHeightM(layer) {
  const ch = canvas.height || 714;
  const px = ch * layer.scale;
  return px / calibration.pxPerMeter;
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

  if (container) {
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
  if (!container || !item || item.kind !== "plant") return;
  const maxH = getPotMaxHeightM(item, container.liters || 40);
  const maxScale = heightMToScale(maxH);
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
  const targetH = heightMOverride !== null ? heightMOverride : (item.defaultHeightM || 1.2) * persp;
  const scale = Math.max(0.08, heightMToScale(targetH));

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
    rotation: 0,
    flip: flipOverride,
    brightness: 100,
    contrast: 100,
    saturation: 100,
    warmth: 0,
    shadowOpacity: 45,
    shadowOffset: 15,
    visible: true,
    liters: item.liters || 45,
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
      plantLayer.y <= rect.y + rect.h * 0.65
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
    // Horizontal lines (far to near)
    const lx = p.tl.x + (p.bl.x - p.tl.x) * t;
    const ly = p.tl.y + (p.bl.y - p.tl.y) * t;
    const rx = p.tr.x + (p.br.x - p.tr.x) * t;
    const ry = p.tr.y + (p.br.y - p.tr.y) * t;
    targetCtx.beginPath();
    targetCtx.moveTo(lx, ly);
    targetCtx.lineTo(rx, ry);
    targetCtx.stroke();

    // Depth lines (left to right)
    const tx = p.tl.x + (p.tr.x - p.tl.x) * t;
    const ty = p.tl.y + (p.tr.y - p.tl.y) * t;
    const bx = p.bl.x + (p.br.x - p.bl.x) * t;
    const by = p.bl.y + (p.br.y - p.bl.y) * t;
    targetCtx.beginPath();
    targetCtx.moveTo(tx, ty);
    targetCtx.lineTo(bx, by);
    targetCtx.stroke();
  }

  // Draggable corner handles
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
      offsetX: x - hitLayer.x,
      offsetY: y - hitLayer.y,
      prevPersp: perspective.autoScale ? getPerspectiveFactorAtY(hitLayer.y) : 1
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
    l.x = x - dragState.offsetX;
    l.y = y - dragState.offsetY;

    if (perspective.autoScale) {
      const newPersp = getPerspectiveFactorAtY(l.y);
      if (dragState.prevPersp > 0.05) {
        l.scale = Math.max(0.08, Math.min(2.8, l.scale * (newPersp / dragState.prevPersp)));
      }
      dragState.prevPersp = newPersp;
      clampScaleToPotIfNeeded(l);
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
        showToast(`${l.name} ubicada en ${found.name} (${found.liters} L)`);
        syncUI();
        draw();
      }
    }
  }
  dragState = null;
  canvas.style.cursor = maskMode || calibration.mode ? "crosshair" : "grab";
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
  }
});

// Catalog UI
function renderCatalog() {
  const grid = document.getElementById("catalogGrid");
  const items = catalog.filter(p => activeFilter === "all" || p.category === activeFilter);
  document.getElementById("catalogCount").textContent = `${items.length} ${items.length === 1 ? "ítem" : "ítems"}`;
  grid.innerHTML = "";

  if (items.length === 0) {
    grid.innerHTML = `<div class="col-span-2 text-center py-6 text-xs text-zinc-500">Todavía no subiste PNGs propios. Usá "Subir PNG" arriba.</div>`;
    return;
  }

  for (const item of items) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "group text-left bg-zinc-950/70 hover:bg-zinc-800/80 border border-zinc-800 hover:border-emerald-500/50 rounded-lg p-2 transition flex flex-col";
    const badgeColor =
      item.category === "cerco"
        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
        : item.category === "primera"
        ? "bg-violet-500/15 text-violet-300 border-violet-500/30"
        : item.category === "macetas"
        ? "bg-orange-500/15 text-orange-300 border-orange-500/30"
        : "bg-amber-500/15 text-amber-300 border-amber-500/30";
    const badgeLabel =
      item.category === "cerco"
        ? "Cerco"
        : item.category === "primera"
        ? "1ª Fila"
        : item.category === "macetas"
        ? "Maceta"
        : "Propia";

    card.innerHTML = `
      <div class="w-full h-24 rounded-md checker-bg flex items-center justify-center overflow-hidden mb-1.5 relative">
        <img src="${item.src}" alt="${item.name}" class="max-h-full max-w-full object-contain group-hover:scale-105 transition-transform duration-200" />
        <span class="absolute top-1 right-1 text-[9px] px-1.5 py-0.5 rounded border ${badgeColor}">${badgeLabel}</span>
      </div>
      <div class="text-xs font-medium text-zinc-100 truncate w-full">${item.name}</div>
      <div class="text-[10px] text-zinc-400 truncate w-full">${item.heightLabel || item.sci}</div>
    `;
    card.addEventListener("click", async () => {
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

function syncBotanicalInspector(sel) {
  const hM = getLayerRealHeightM(sel);
  document.getElementById("valRealHeight").textContent = hM >= 1 ? `${hM.toFixed(2)} m` : `${Math.round(hM * 100)} cm`;

  const plantBox = document.getElementById("plantBotanicalDetails");
  const contBox = document.getElementById("containerDetails");
  const item = catalog.find(p => p.id === sel.itemId);

  if (sel.kind === "container") {
    plantBox.classList.add("hidden");
    contBox.classList.remove("hidden");
    document.getElementById("ctrlPotLiters").value = sel.liters || 45;
    document.getElementById("valPotLiters").textContent = `${sel.liters || 45} L`;
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
    opt.textContent = `${c.name} (${c.liters} L)`;
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
  // Unlink plants that pointed to removed container
  for (const l of layers) {
    if (l.containerUid === removed) l.containerUid = null;
  }
  selectedId = layers.length ? layers[layers.length - 1].uid : null;
  setMaskMode(false);
  syncUI();
  draw();
}

// Calibration & Perspective Listeners
document.getElementById("btnCalibrate").addEventListener("click", () => {
  setCalibrationMode(!calibration.mode);
});
document.getElementById("btnCancelCalibrate").addEventListener("click", () => {
  setCalibrationMode(false);
});
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

document.getElementById("btnPerspective").addEventListener("click", () => {
  setPerspectiveVisible(!perspective.visible);
});
document.getElementById("btnExitPerspective").addEventListener("click", () => {
  setPerspectiveVisible(false);
});
document.getElementById("chkAutoPerspective").addEventListener("change", (e) => {
  perspective.autoScale = e.target.checked;
  showToast(perspective.autoScale ? "Auto-escala por perspectiva activada" : "Auto-escala desactivada");
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
  // Re-clamp plants inside this container
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
    if (c) {
      const potMax = getPotMaxHeightM(item, c.liters || 40);
      targetM = Math.min(targetM, potMax * 0.95);
    }
  }
  sel.scale = Math.max(0.08, heightMToScale(targetM));
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

  // Threshold: brightness high and low color saturation (neutral white/light-gray)
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
    // BFS flood fill from all 4 borders
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

  // Apply removal + feather
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

  // Defringe: erode alpha by defringePx near transparent pixels
  if (defringePx > 0) {
    const origAlpha = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) origAlpha[i] = d[i * 4 + 3];
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
  // Also update custom catalog item if applicable
  const catItem = catalog.find(c => c.id === layer.itemId && c.category === "custom");
  if (catItem) {
    catItem.src = newSrc;
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

// Upload Custom Plant PNG (auto-opens cleaner if opaque white background detected)
document.getElementById("plantUploadInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const src = ev.target.result;
    const img = await loadImage(src);
    const cleanName = file.name.replace(/\.[^/.]+$/, "").slice(0, 22);
    const customPlant = {
      id: "custom_" + Date.now(),
      kind: "plant",
      name: cleanName || "Planta propia",
      sci: "PNG cargado",
      category: "custom",
      heightLabel: "0.3 – 2.5 m",
      defaultHeightM: 1.0,
      minHeightM: 0.15,
      idealMinM: 0.3,
      idealMaxM: 2.5,
      maxHeightM: 4.0,
      minPotLiters: 10,
      idealPotLiters: 35,
      src
    };
    catalog.unshift(customPlant);
    renderCatalog();
    const newLayer = createLayer(customPlant, 0.5, 0.74);
    layers.push(newLayer);
    selectedId = newLayer.uid;
    syncUI();
    draw();

    // Check top-left corner opacity to see if it has a solid background
    const probe = document.createElement("canvas");
    probe.width = 4;
    probe.height = 4;
    const pctx = probe.getContext("2d");
    pctx.drawImage(img, 0, 0, 4, 4);
    const cornerAlpha = pctx.getImageData(0, 0, 1, 1).data[3];
    if (cornerAlpha > 220) {
      openPngCleaner(newLayer.uid);
      showToast("Fondo sólido detectado: limpiá el blanco antes de aplicar");
    } else {
      showToast(`"${customPlant.name}" agregada al catálogo y escena`);
    }
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
