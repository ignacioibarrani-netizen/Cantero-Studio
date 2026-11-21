/**
 * Procedural 3D-projected container, planter & ground-soil renderer
 * with real photographic texture mapping (affine triangle UV mapping),
 * custom Width x Height proportions, 360-deg horizontal yaw, vertical camera pitch,
 * and scene perspective Z-foreshortening.
 */

export const CONTAINER_MATERIALS = {
  cemento: {
    label: "Cemento",
    texSrc: "assets/textures/cemento.jpg",
    colors: [
      { id: "gris_claro", label: "Gris claro", base: "#9ca3af", tint: null },
      { id: "antracita", label: "Antracita", base: "#4b5563", tint: "rgba(24,24,27,0.48)" },
      { id: "arena", label: "Arena", base: "#c8bca8", tint: "rgba(214,195,160,0.42)" }
    ]
  },
  terracota: {
    label: "Terracota",
    texSrc: "assets/textures/terracota.jpg",
    colors: [
      { id: "barro", label: "Barro clásico", base: "#b85d3b", tint: null },
      { id: "terracota_claro", label: "Terracota claro", base: "#d07d57", tint: "rgba(240,180,145,0.28)" }
    ]
  },
  madera: {
    label: "Madera",
    texSrc: "assets/textures/madera.jpg",
    colors: [
      { id: "lapacho", label: "Deck Lapacho", base: "#7c4a2d", tint: null },
      { id: "pino", label: "Pino natural", base: "#b58350", tint: "rgba(215,165,105,0.38)" },
      { id: "gris_envejecido", label: "Gris envejecido", base: "#6e6a61", tint: "rgba(130,130,130,0.48)" }
    ]
  },
  corten: {
    label: "Corten",
    texSrc: "assets/textures/corten.jpg",
    colors: [
      { id: "corten_oxido", label: "Chapa Corten", base: "#8e3e1e", tint: null }
    ]
  },
  plastico: {
    label: "Plástico",
    texSrc: "assets/textures/plastico.jpg",
    colors: [
      { id: "plastico_negro", label: "Negro mate", base: "#27272a", tint: null },
      { id: "plastico_blanco", label: "Blanco", base: "#e4e4e7", tint: "rgba(244,244,245,0.78)" },
      { id: "plastico_gris", label: "Gris grafito", base: "#52525b", tint: "rgba(113,113,122,0.45)" },
      { id: "plastico_verde", label: "Verde musgo", base: "#3f5944", tint: "rgba(63,89,68,0.68)" },
      { id: "plastico_terracota", label: "Terracota", base: "#b55239", tint: "rgba(181,82,57,0.68)" }
    ]
  },
  hierro_negro: {
    label: "Hierro negro",
    texSrc: "assets/textures/hierro_negro.jpg",
    colors: [
      { id: "hierro_satin", label: "Negro satinado", base: "#1d1d20", tint: null },
      { id: "hierro_grafito", label: "Grafito oscuro", base: "#2d2f36", tint: "rgba(75,85,99,0.28)" }
    ]
  },
  negro_oxidado: {
    label: "Negro oxidado",
    texSrc: "assets/textures/negro_oxidado.jpg",
    colors: [
      { id: "negro_oxido", label: "Negro c/ óxido", base: "#201b19", tint: null }
    ]
  }
};

const TEXTURE_URLS = {
  ...Object.fromEntries(Object.entries(CONTAINER_MATERIALS).map(([k, v]) => [k, v.texSrc])),
  tierra: "assets/textures/tierra.jpg"
};

const texCache = new Map();
const renderCache = new Map();
const renderMetaCache = new Map();

export function getContainerRenderMeta(src) {
  return renderMetaCache.get(src) || { frontWallRatio: 1, widthToWallRatio: 1, depthToWallRatio: 1 };
}


export async function preloadContainerTextures() {
  const entries = Object.entries(TEXTURE_URLS);
  await Promise.all(
    entries.map(([key, url]) => new Promise((resolve) => {
      if (texCache.has(key)) return resolve();
      const img = new Image();
      img.onload = () => {
        texCache.set(key, img);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = url;
    }))
  );
  renderCache.clear();
}

function getColorSpec(materialId, colorId) {
  const mat = CONTAINER_MATERIALS[materialId] || CONTAINER_MATERIALS.cemento;
  return mat.colors.find(c => c.id === colorId) || mat.colors[0];
}

// Affine texture mapping for a single triangle (p0,p1,p2) -> UV (u0,v0),(u1,v1),(u2,v2)
function drawTexturedTriangle(ctx, img, p0, p1, p2, u0, v0, u1, v1, u2, v2) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]);
  ctx.lineTo(p1[0], p1[1]);
  ctx.lineTo(p2[0], p2[1]);
  ctx.closePath();
  ctx.clip();

  const denom = u0 * (v1 - v2) - v0 * (u1 - u2) + (u1 * v2 - u2 * v1);
  if (Math.abs(denom) > 1e-6) {
    const a = (p0[0] * (v1 - v2) - v0 * (p1[0] - p2[0]) + (p1[0] * v2 - p2[0] * v1)) / denom;
    const b = (p0[1] * (v1 - v2) - v0 * (p1[1] - p2[1]) + (p1[1] * v2 - p2[1] * v1)) / denom;
    const c = (u0 * (p1[0] - p2[0]) - p0[0] * (u1 - u2) + (u1 * p2[0] - u2 * p1[0])) / denom;
    const d = (u0 * (p1[1] - p2[1]) - p0[1] * (u1 - u2) + (u1 * p2[1] - u2 * p1[1])) / denom;
    const e = (u0 * (v1 * p2[0] - v2 * p1[0]) - v0 * (u1 * p2[0] - u2 * p1[0]) + p0[0] * (u1 * v2 - u2 * v1)) / denom;
    const f = (u0 * (v1 * p2[1] - v2 * p1[1]) - v0 * (u1 * p2[1] - u2 * p1[1]) + p0[1] * (u1 * v2 - u2 * v1)) / denom;
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
  }
  ctx.restore();
}

function paintTexturedQuad(ctx, poly, materialId, colorSpec, shadeFactor) {
  const tex = texCache.get(materialId);
  if (tex && tex.complete && tex.naturalWidth > 0) {
    const tw = tex.naturalWidth;
    const th = tex.naturalHeight;
    // Slight bleed by expanding triangle pairs cleanly
    drawTexturedTriangle(ctx, tex, poly[0], poly[1], poly[2], 0, 0, tw, 0, tw, th);
    drawTexturedTriangle(ctx, tex, poly[0], poly[2], poly[3], 0, 0, tw, th, 0, th);
  } else {
    ctx.save();
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = colorSpec.base;
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.clip();

  if (colorSpec.tint) {
    ctx.fillStyle = colorSpec.tint;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  if (shadeFactor < 1) {
    ctx.fillStyle = `rgba(0, 0, 0, ${(1 - shadeFactor) * 0.62})`;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  ctx.restore();
}

function paintSoilPoly(ctx, poly, mulch = false) {
  const tex = texCache.get("tierra");
  ctx.save();
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.clip();

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (tex && tex.complete && tex.naturalWidth > 0) {
    ctx.drawImage(tex, minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY));
    if (mulch) {
      ctx.fillStyle = "rgba(120, 62, 24, 0.32)";
      ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    }
  } else {
    ctx.fillStyle = mulch ? "#4e301b" : "#2c1e15";
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
  }
  ctx.restore();
}

function projectBox(W, H, D, yawDeg, pitchDeg, perspStrength, cw, ch) {
  const radY = (yawDeg * Math.PI) / 180;
  const cosY = Math.cos(radY);
  const sinY = Math.sin(radY);

  const radP = (Math.max(4, Math.min(72, pitchDeg)) * Math.PI) / 180;
  const cosP = Math.cos(radP);
  const sinP = Math.sin(radP);

  const hw = W / 2, hd = D / 2;
  const rawPts = [
    [-hw, 0, -hd],
    [ hw, 0, -hd],
    [ hw, 0,  hd],
    [-hw, 0,  hd],
    [-hw, H, -hd],
    [ hw, H, -hd],
    [ hw, H,  hd],
    [-hw, H,  hd]
  ];

  const proj = rawPts.map(([x, y, z]) => {
    const rx = x * cosY - z * sinY;
    const rz0 = x * sinY + z * cosY;
    const ry1 = y * cosP - rz0 * sinP;
    const rz1 = y * sinP + rz0 * cosP;
    const denom = Math.max(0.35, 1 - rz1 * perspStrength);
    const persp = 1 / denom;
    return [rx * persp, -ry1 * persp, rz1];
  });

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [sx, sy] of proj) {
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  const pad = 12;
  const scale = Math.min((cw - pad * 2) / Math.max(1, maxX - minX), (ch - pad * 2) / Math.max(1, maxY - minY));
  const cx = cw / 2 - ((minX + maxX) / 2) * scale;
  const cy = ch / 2 - ((minY + maxY) / 2) * scale;

  return proj.map(([sx, sy, rz]) => [cx + sx * scale, cy + sy * scale, rz]);
}

function renderBoxContainer(shape, materialId, colorId, yawDeg, pitchDeg, perspStrength, isGroundSoil, mulch, isEmpty, customWidthM, customHeightM, customDepthM) {
  let W = 240, H = 120, D = 110;
  if (shape === "cantero_rect") { W = 320; H = 105; D = 125; }
  else if (shape === "maceta_cubo") { W = 175; H = 175; D = 175; }
  else if (shape === "jardinera_alta") { W = 230; H = 195; D = 95; }
  else if (shape === "tierra_cantero") { W = 330; H = 36; D = 150; }

  if (customWidthM && customHeightM && customHeightM > 0) {
    const aspect = Math.max(0.05, customWidthM / customHeightM);
    const depthAspect = customDepthM && customDepthM > 0 ? Math.max(0.05, customDepthM / customHeightM) : 0.85;
    H = 140;
    W = Math.max(12, Math.round(H * aspect));
    D = Math.max(12, Math.round(H * depthAspect));
  }

  // Compute tight bounding box first so canvas aspect matches exact 3D projection without clipping or padding distortion
  const radY = (yawDeg * Math.PI) / 180;
  const cosY = Math.cos(radY), sinY = Math.sin(radY);
  const radP = (Math.max(4, Math.min(72, pitchDeg)) * Math.PI) / 180;
  const cosP = Math.cos(radP), sinP = Math.sin(radP);
  const hw = W / 2, hd = D / 2;
  const testPts = [
    [-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd],
    [-hw, H, -hd], [hw, H, -hd], [hw, H, hd], [-hw, H, hd]
  ].map(([x, y, z]) => {
    const rx = x * cosY - z * sinY;
    const rz0 = x * sinY + z * cosY;
    const ry1 = y * cosP - rz0 * sinP;
    const rz1 = y * sinP + rz0 * cosP;
    const p = 1 / Math.max(0.35, 1 - rz1 * (perspStrength * (240 / Math.max(240, Math.max(W, D)))));
    return [rx * p, -ry1 * p];
  });
  let tMinX = Infinity, tMaxX = -Infinity, tMinY = Infinity, tMaxY = -Infinity;
  for (const [sx, sy] of testPts) {
    if (sx < tMinX) tMinX = sx;
    if (sx > tMaxX) tMaxX = sx;
    if (sy < tMinY) tMinY = sy;
    if (sy > tMaxY) tMaxY = sy;
  }
  const projW = Math.max(40, tMaxX - tMinX);
  const projH = Math.max(40, tMaxY - tMinY);
  const fitScale = Math.min(1600 / projW, 600 / projH, 1.4);
  const cw = Math.max(180, Math.round(projW * fitScale + 12));
  const ch = Math.max(140, Math.round(projH * fitScale + 12));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");

  const normPersp = perspStrength * (240 / Math.max(240, Math.max(W, D)));
  const pts = projectBox(W, H, D, yawDeg, pitchDeg, normPersp, cw, ch);
  const colorSpec = getColorSpec(materialId, colorId);

  const faces = [
    { id: "front", idx: [3, 2, 6, 7], shade: 0.96 },
    { id: "right", idx: [2, 1, 5, 6], shade: 0.68 },
    { id: "back",  idx: [1, 0, 4, 5], shade: 0.58 },
    { id: "left",  idx: [0, 3, 7, 4], shade: 0.74 }
  ];

  const visibleFaces = [];
  for (const f of faces) {
    const poly = f.idx.map(i => pts[i]);
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      area += x1 * y2 - x2 * y1;
    }
    const avgZ = f.idx.reduce((acc, i) => acc + pts[i][2], 0) / 4;
    if (area < 0) visibleFaces.push({ ...f, poly, avgZ });
  }
  visibleFaces.sort((a, b) => a.avgZ - b.avgZ);

  for (const f of visibleFaces) {
    // Pass top-left, top-right, bot-right, bot-left order for clean UV
    const uvPoly = [pts[f.idx[3]], pts[f.idx[2]], pts[f.idx[1]], pts[f.idx[0]]].map(([x, y]) => [x, y]);
    paintTexturedQuad(ctx, uvPoly, materialId, colorSpec, f.shade);
    ctx.strokeStyle = "rgba(0,0,0,0.32)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    uvPoly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }

  const topPoly = [pts[4], pts[5], pts[6], pts[7]].map(([x, y]) => [x, y]);
  paintTexturedQuad(ctx, topPoly, materialId, colorSpec, 1.0);

  const inset = isGroundSoil ? 0.06 : 0.10;
  const cxTop = topPoly.reduce((s, p) => s + p[0], 0) / 4;
  const cyTop = topPoly.reduce((s, p) => s + p[1], 0) / 4;
  const innerPoly = topPoly.map(([x, y]) => [
    cxTop + (x - cxTop) * (1 - inset),
    cyTop + (y - cyTop) * (1 - inset)
  ]);

  if (isEmpty && !isGroundSoil) {
    paintTexturedQuad(ctx, innerPoly, materialId, colorSpec, 0.42);
  } else {
    paintSoilPoly(ctx, innerPoly, mulch);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  topPoly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.stroke();

  // Measure exact vertical front wall height in pixels (between bottom-front and top-front edge)
  const frontWallPx = Math.max(10, Math.abs(pts[3][1] - pts[7][1]));
  const frontWallRatio = Math.max(0.15, Math.min(1.0, frontWallPx / ch));
  const dataUrl = canvas.toDataURL("image/png");
  renderMetaCache.set(dataUrl, {
    frontWallRatio,
    widthToWallRatio: W / H,
    depthToWallRatio: D / H
  });
  return dataUrl;
}

function renderCylinderContainer(materialId, colorId, yawDeg, pitchDeg, isEmpty, customWidthM, customHeightM) {
  const pitchFactor = Math.sin((Math.max(6, Math.min(68, pitchDeg)) * Math.PI) / 180);
  const aspect = customWidthM && customHeightM ? Math.max(0.5, Math.min(2.2, customWidthM / customHeightM)) : 1;
  const topRx = Math.round(130 * Math.min(1.4, aspect));
  const topRy = Math.max(14, Math.round(92 * pitchFactor));
  const botRx = Math.round(topRx * 0.8);
  const botRy = Math.max(10, Math.round(72 * pitchFactor));
  const topY = 6 + topRy;
  const botY = topY + Math.round(280 * Math.cos((pitchDeg * Math.PI) / 220));
  const cw = Math.max(320, topRx * 2 + 16);
  const ch = botY + botRy + 2;
  const cx = cw / 2;
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  const colorSpec = getColorSpec(materialId, colorId);
  const tex = texCache.get(materialId);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - topRx, topY);
  ctx.lineTo(cx - botRx, botY);
  ctx.ellipse(cx, botY, botRx, botRy, 0, Math.PI, 0, true);
  ctx.lineTo(cx + topRx, topY);
  ctx.ellipse(cx, topY, topRx, topRy, 0, 0, Math.PI, false);
  ctx.closePath();
  ctx.clip();

  if (tex && tex.complete && tex.naturalWidth > 0) {
    ctx.drawImage(tex, cx - topRx, topY, topRx * 2, botY - topY + botRy);
  } else {
    ctx.fillStyle = colorSpec.base;
    ctx.fillRect(0, 0, cw, ch);
  }

  if (colorSpec.tint) {
    ctx.fillStyle = colorSpec.tint;
    ctx.fillRect(0, 0, cw, ch);
  }

  // Cylindrical 3D shading overlay
  const rad = (yawDeg * Math.PI) / 180;
  const lightPos = Math.max(0.18, Math.min(0.82, 0.35 + Math.sin(rad) * 0.25));
  const shade = ctx.createLinearGradient(cx - topRx, topY, cx + topRx, topY);
  shade.addColorStop(0, "rgba(0,0,0,0.48)");
  shade.addColorStop(lightPos, "rgba(255,255,255,0.12)");
  shade.addColorStop(1, "rgba(0,0,0,0.52)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, cw, ch);
  ctx.restore();

  // Top rim
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, topY, topRx, topRy, 0, 0, Math.PI * 2);
  ctx.clip();
  if (tex && tex.complete && tex.naturalWidth > 0) {
    ctx.drawImage(tex, cx - topRx, topY - topRy, topRx * 2, topRy * 2);
  } else {
    ctx.fillStyle = colorSpec.base;
    ctx.fill();
  }
  if (colorSpec.tint) {
    ctx.fillStyle = colorSpec.tint;
    ctx.fill();
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, topY, topRx, topRy, 0, 0, Math.PI * 2);
  ctx.stroke();

  const innerPts = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    innerPts.push([cx + Math.cos(a) * (topRx - 15), topY + 2 + Math.sin(a) * Math.max(5, topRy - 7)]);
  }
  if (isEmpty) {
    paintTexturedQuad(ctx, [innerPts[0], innerPts[6], innerPts[12], innerPts[18]], materialId, colorSpec, 0.45);
  } else {
    paintSoilPoly(ctx, innerPts, false);
  }

  const frontWallPx = Math.max(10, botY - topY);
  const frontWallRatio = Math.max(0.15, Math.min(1.0, frontWallPx / ch));
  const dataUrl = canvas.toDataURL("image/png");
  renderMetaCache.set(dataUrl, {
    frontWallRatio,
    widthToWallRatio: aspect,
    depthToWallRatio: aspect
  });
  return dataUrl;
}

function renderOrganicSoilBed(mulch = false, pitchDeg = 22, customWidthM = null, customDepthM = null) {
  const ratio = (customWidthM && customDepthM && customDepthM > 0) ? Math.max(0.25, Math.min(6, customWidthM / customDepthM)) : 2.4;
  const cw = Math.max(260, Math.min(900, Math.round(220 * ratio)));
  const ch = 220;
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");

  const pitchScale = Math.max(0.45, Math.min(1.25, pitchDeg / 22));
  const pts = [];
  const steps = 36;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wobble = 0.9 + Math.sin(i * 2.3) * 0.08;
    pts.push([
      cw / 2 + Math.cos(a) * (cw * 0.42) * wobble,
      ch / 2 + 8 + Math.sin(a) * 64 * pitchScale * wobble
    ]);
  }
  paintSoilPoly(ctx, pts, mulch);

  ctx.strokeStyle = "rgba(20, 12, 6, 0.45)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.stroke();

  return canvas.toDataURL("image/png");
}

export function getContainerRenderSrc({
  shape = "cantero_rect",
  material = "cemento",
  colorId = "gris_claro",
  viewAngle = 0,
  viewPitch = 22,
  perspStrength = 0.0011,
  isGroundSoil = false,
  mulch = false,
  liters = 45,
  customWidthM = null,
  customHeightM = null,
  customDepthM = null
}) {
  const normYaw = ((Math.round(viewAngle) % 360) + 360) % 360;
  const normPitch = Math.max(5, Math.min(68, Math.round(viewPitch)));
  const pBucket = Math.round(perspStrength * 10000);
  const isEmpty = !isGroundSoil && liters <= 0;
  const wKey = customWidthM ? customWidthM.toFixed(2) : "d";
  const hKey = customHeightM ? customHeightM.toFixed(2) : "d";
  const dKey = customDepthM ? customDepthM.toFixed(2) : "d";
  const texReady = texCache.size > 0 ? 1 : 0;
  const key = `${texReady}|${shape}|${material}|${colorId}|${normYaw}|${normPitch}|${pBucket}|${isGroundSoil ? 1 : 0}|${mulch ? 1 : 0}|${isEmpty ? 1 : 0}|${wKey}|${hKey}|${dKey}`;
  if (renderCache.has(key)) return renderCache.get(key);

  let dataUrl;
  if (shape === "tierra_organica") {
    dataUrl = renderOrganicSoilBed(mulch, normPitch, customWidthM, customDepthM);
  } else if (shape === "maceta_cilindro") {
    dataUrl = renderCylinderContainer(material, colorId, normYaw, normPitch, isEmpty, customWidthM, customHeightM);
  } else {
    dataUrl = renderBoxContainer(shape, material, colorId, normYaw, normPitch, perspStrength, isGroundSoil, mulch, isEmpty, customWidthM, customHeightM, customDepthM);
  }
  renderCache.set(key, dataUrl);
  return dataUrl;
}


/**
 * Renders a 3D rectangular container directly onto the main scene canvas
 * using the scene's 3D ground homography (groundToScreen + localPxPerMeter).
 * Returns the 2D screen bounding box { x, y, w, h, corners2D } for hit-testing & selection.
 */
export function drawSceneProjectedBox(ctx, {
  centerU,
  centerV,
  widthM,
  heightM,
  depthM,
  yawDeg = 0,
  elevationM = 0,
  material = "cemento",
  colorId = "gris_claro",
  isGroundSoil = false,
  mulch = false,
  liters = 45,
  brightness = 100,
  contrast = 100,
  saturation = 100,
  warmth = 0,
  groundToScreen,
  worldToScreen = null,
  getPxPerMeterAt
}) {
  const hw = widthM / 2;
  const hd = depthM / 2;
  const rad = (yawDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const localCorners = [
    [-hw, -hd], // 0: back-left
    [ hw, -hd], // 1: back-right
    [ hw,  hd], // 2: front-right
    [-hw,  hd]  // 3: front-left
  ];

  const worldCorners = localCorners.map(([lu, lv]) => ({
    u: centerU + lu * cos - lv * sin,
    v: centerV + lu * sin + lv * cos
  }));

  const floorScreen = worldCorners.map(({ u, v }) =>
    worldToScreen ? worldToScreen(u, v, 0) : groundToScreen(u, v)
  );

  const botPts = [];
  const topPts = [];
  for (let i = 0; i < 4; i++) {
    if (worldToScreen) {
      const { u, v } = worldCorners[i];
      const bp = worldToScreen(u, v, elevationM);
      const tp = worldToScreen(u, v, elevationM + heightM);
      botPts.push([bp.x, bp.y]);
      topPts.push([tp.x, tp.y]);
    } else {
      const fp = floorScreen[i];
      const ppm = getPxPerMeterAt(fp.x, fp.y);
      botPts.push([fp.x, fp.y - elevationM * ppm]);
      topPts.push([fp.x, fp.y - (elevationM + heightM) * ppm]);
    }
  }

  // Average depth (screen Y: larger Y is closer to camera)
  const colorSpec = getColorSpec(material, colorId);
  const faces = [
    { idx: [3, 2], shade: 0.96 }, // front
    { idx: [2, 1], shade: 0.72 }, // right
    { idx: [1, 0], shade: 0.60 }, // back
    { idx: [0, 3], shade: 0.78 }  // left
  ];

  // Determine front-most faces by screen Y of bottom edge (or winding)
  // Also sort back-to-front by average floor Y so far faces draw behind near faces
  const faceList = faces.map(f => {
    const [i0, i1] = f.idx;
    const avgY = (floorScreen[i0].y + floorScreen[i1].y) / 2;
    const poly = [topPts[i0], topPts[i1], botPts[i1], botPts[i0]];
    return { ...f, avgY, poly };
  }).sort((a, b) => a.avgY - b.avgY);

  ctx.save();
  const sepiaAmt = warmth > 0 ? warmth * 0.8 : 0;
  const hueAmt = warmth < 0 ? warmth * 0.7 : 0;
  ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) sepia(${sepiaAmt}%) hue-rotate(${hueAmt}deg)`;

  for (const f of faceList) {
    paintTexturedQuad(ctx, f.poly, material, colorSpec, f.shade);
    ctx.strokeStyle = "rgba(0,0,0,0.32)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    f.poly.forEach(([x, y], idx) => (idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }

  // Top face (rim + soil)
  const topPoly = [topPts[0], topPts[1], topPts[2], topPts[3]];
  paintTexturedQuad(ctx, topPoly, material, colorSpec, 1.0);

  const inset = isGroundSoil ? 0.06 : 0.09;
  const cxTop = topPoly.reduce((s, p) => s + p[0], 0) / 4;
  const cyTop = topPoly.reduce((s, p) => s + p[1], 0) / 4;
  const innerPoly = topPoly.map(([x, y]) => [
    cxTop + (x - cxTop) * (1 - inset),
    cyTop + (y - cyTop) * (1 - inset)
  ]);

  if (!isGroundSoil && liters <= 0) {
    paintTexturedQuad(ctx, innerPoly, material, colorSpec, 0.42);
  } else {
    paintSoilPoly(ctx, innerPoly, mulch);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  topPoly.forEach(([x, y], idx) => (idx === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  const allPts = [...botPts, ...topPts];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of allPts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    x: minX,
    y: minY,
    w: Math.max(10, maxX - minX),
    h: Math.max(10, maxY - minY),
    floorPts: floorScreen.map(p => [p.x, p.y]),
    botPts,
    topPts
  };
}
