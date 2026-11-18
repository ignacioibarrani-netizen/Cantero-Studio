/**
 * Procedural 3D-projected container, planter & ground-soil renderer.
 * Supports 360-degree view angles (Frente, 3/4, Perfil, Espaldas) and multiple materials/colors.
 */

export const CONTAINER_MATERIALS = {
  cemento: {
    label: "Cemento",
    colors: [
      { id: "gris_claro", label: "Gris claro", base: "#9ca3af", dark: "#6b7280", light: "#d1d5db", texture: "concrete" },
      { id: "antracita", label: "Antracita", base: "#4b5563", dark: "#27272a", light: "#71717a", texture: "concrete" },
      { id: "arena", label: "Arena", base: "#c8bca8", dark: "#968974", light: "#e2d8c8", texture: "concrete" }
    ]
  },
  terracota: {
    label: "Terracota",
    colors: [
      { id: "barro", label: "Barro clásico", base: "#b85d3b", dark: "#7c371f", light: "#d97b59", texture: "terracotta" },
      { id: "terracota_claro", label: "Terracota claro", base: "#d07d57", dark: "#9a4f30", light: "#e59c7b", texture: "terracotta" }
    ]
  },
  madera: {
    label: "Madera",
    colors: [
      { id: "lapacho", label: "Deck Lapacho", base: "#7c4a2d", dark: "#4e2c18", light: "#a36843", texture: "wood" },
      { id: "pino", label: "Pino natural", base: "#b58350", dark: "#82582e", light: "#cfa272", texture: "wood" },
      { id: "gris_envejecido", label: "Gris envejecido", base: "#6e6a61", dark: "#47443e", light: "#918c81", texture: "wood" }
    ]
  },
  corten: {
    label: "Corten",
    colors: [
      { id: "corten_oxido", label: "Chapa Corten", base: "#8e3e1e", dark: "#56220e", light: "#b9592f", texture: "corten" }
    ]
  },
  plastico: {
    label: "Plástico",
    colors: [
      { id: "plastico_negro", label: "Negro mate", base: "#27272a", dark: "#141417", light: "#45454c", texture: "plastic" },
      { id: "plastico_blanco", label: "Blanco", base: "#e4e4e7", dark: "#a1a1aa", light: "#fafafa", texture: "plastic" },
      { id: "plastico_gris", label: "Gris grafito", base: "#52525b", dark: "#303036", light: "#71717a", texture: "plastic" },
      { id: "plastico_verde", label: "Verde musgo", base: "#3f5944", dark: "#273a2b", light: "#5a7c60", texture: "plastic" },
      { id: "plastico_terracota", label: "Terracota", base: "#b55239", dark: "#803421", light: "#cf6f57", texture: "plastic" }
    ]
  },
  hierro_negro: {
    label: "Hierro negro",
    colors: [
      { id: "hierro_satin", label: "Negro satinado", base: "#1d1d20", dark: "#0c0c0e", light: "#3b3b42", texture: "iron" },
      { id: "hierro_grafito", label: "Grafito oscuro", base: "#2d2f36", dark: "#16171b", light: "#4b4e59", texture: "iron" }
    ]
  },
  negro_oxidado: {
    label: "Negro oxidado",
    colors: [
      { id: "negro_oxido", label: "Negro c/ óxido", base: "#201b19", dark: "#100d0c", light: "#46352c", rust: "#8a3e1b", texture: "oxidized_iron" }
    ]
  }
};

export const VIEW_PRESETS = [
  { label: "Frente", angle: 0 },
  { label: "3/4 Der", angle: 40 },
  { label: "Perfil Der", angle: 90 },
  { label: "Espaldas", angle: 180 },
  { label: "3/4 Izq", angle: 320 }
];

const renderCache = new Map();

function seededRand(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function getColorSpec(materialId, colorId) {
  const mat = CONTAINER_MATERIALS[materialId] || CONTAINER_MATERIALS.cemento;
  const col = mat.colors.find(c => c.id === colorId) || mat.colors[0];
  return col;
}

function paintMaterialTexture(ctx, poly, colorSpec, shadeFactor, seed = 101) {
  ctx.save();
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.clip();

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);

  // Base gradient
  const grad = ctx.createLinearGradient(minX, minY, maxX, maxY);
  if (shadeFactor >= 0.85) {
    grad.addColorStop(0, colorSpec.light);
    grad.addColorStop(0.55, colorSpec.base);
    grad.addColorStop(1, colorSpec.dark);
  } else {
    grad.addColorStop(0, colorSpec.base);
    grad.addColorStop(1, colorSpec.dark);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(minX, minY, w, h);

  // Darken overlay based on face orientation
  if (shadeFactor < 1) {
    ctx.fillStyle = `rgba(0, 0, 0, ${(1 - shadeFactor) * 0.52})`;
    ctx.fillRect(minX, minY, w, h);
  }

  const rand = seededRand(seed);

  if (colorSpec.texture === "wood") {
    // Horizontal planks + wood grain
    const planks = 4;
    ctx.strokeStyle = "rgba(25, 12, 5, 0.38)";
    ctx.lineWidth = 2;
    for (let i = 1; i < planks; i++) {
      const py = minY + (h * i) / planks;
      ctx.beginPath();
      ctx.moveTo(minX, py);
      ctx.lineTo(maxX, py);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255, 230, 200, 0.08)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 24; i++) {
      const py = minY + rand() * h;
      ctx.beginPath();
      ctx.moveTo(minX, py);
      ctx.lineTo(maxX, py + (rand() - 0.5) * 3);
      ctx.stroke();
    }
  } else if (colorSpec.texture === "corten") {
    for (let i = 0; i < 38; i++) {
      const rx = minX + rand() * w;
      const ry = minY + rand() * h;
      const rr = 8 + rand() * 28;
      ctx.fillStyle = rand() > 0.45 ? "rgba(185, 85, 35, 0.18)" : "rgba(65, 22, 8, 0.22)";
      ctx.beginPath();
      ctx.ellipse(rx, ry, rr, rr * 0.55, rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (colorSpec.texture === "oxidized_iron") {
    // Dark iron with rust patina patches & edge streaks
    for (let i = 0; i < 34; i++) {
      const rx = minX + rand() * w;
      const ry = minY + rand() * h;
      const rr = 6 + rand() * 24;
      ctx.fillStyle = rand() > 0.35 ? "rgba(148, 66, 26, 0.26)" : "rgba(96, 40, 16, 0.22)";
      ctx.beginPath();
      ctx.ellipse(rx, ry, rr, rr * 0.6, rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(165, 76, 32, 0.35)";
    ctx.lineWidth = 3;
    ctx.strokeRect(minX + 1, minY + 1, w - 2, h - 2);
  } else if (colorSpec.texture === "iron") {
    // Subtle satin specular band
    const spec = ctx.createLinearGradient(minX, minY, maxX, minY);
    spec.addColorStop(0, "rgba(255,255,255,0)");
    spec.addColorStop(0.35, "rgba(255,255,255,0.08)");
    spec.addColorStop(0.6, "rgba(255,255,255,0)");
    ctx.fillStyle = spec;
    ctx.fillRect(minX, minY, w, h);
  } else if (colorSpec.texture === "concrete" || colorSpec.texture === "terracotta") {
    for (let i = 0; i < 45; i++) {
      const rx = minX + rand() * w;
      const ry = minY + rand() * h;
      const rr = 1 + rand() * 3.5;
      ctx.fillStyle = rand() > 0.5 ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.09)";
      ctx.beginPath();
      ctx.arc(rx, ry, rr, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (colorSpec.texture === "plastic") {
    // Smooth satin highlight
    const spec = ctx.createLinearGradient(minX, minY, maxX, minY);
    spec.addColorStop(0, "rgba(255,255,255,0.02)");
    spec.addColorStop(0.28, "rgba(255,255,255,0.14)");
    spec.addColorStop(0.65, "rgba(255,255,255,0)");
    ctx.fillStyle = spec;
    ctx.fillRect(minX, minY, w, h);
  }

  ctx.restore();
}

function paintSoilTexture(ctx, poly, mulch = false, seed = 77) {
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
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);

  const grad = ctx.createRadialGradient(minX + w * 0.5, minY + h * 0.5, 4, minX + w * 0.5, minY + h * 0.5, Math.max(w, h) * 0.6);
  grad.addColorStop(0, mulch ? "#5c3b24" : "#3a291e");
  grad.addColorStop(1, mulch ? "#3b2314" : "#221710");
  ctx.fillStyle = grad;
  ctx.fillRect(minX, minY, w, h);

  const rand = seededRand(seed);
  for (let i = 0; i < 95; i++) {
    const rx = minX + rand() * w;
    const ry = minY + rand() * h;
    if (mulch) {
      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate(rand() * Math.PI);
      ctx.fillStyle = rand() > 0.45 ? "#7a4d2e" : "#4a2c18";
      ctx.fillRect(-5, -1.8, 10 + rand() * 6, 3.5);
      ctx.restore();
    } else {
      const rr = 1.5 + rand() * 4;
      ctx.fillStyle = rand() > 0.5 ? "#4a3628" : "#1a110b";
      ctx.beginPath();
      ctx.arc(rx, ry, rr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function projectBox(W, H, D, angleDeg, cw, ch) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const tilt = 0.34; // camera elevation pitch

  // 8 corners centered at (0,0,0) in X/Z, Y is vertical (0 bottom, H top)
  const hw = W / 2, hd = D / 2;
  const rawPts = [
    [-hw, 0, -hd], // 0: back-left bottom
    [ hw, 0, -hd], // 1: back-right bottom
    [ hw, 0,  hd], // 2: front-right bottom
    [-hw, 0,  hd], // 3: front-left bottom
    [-hw, H, -hd], // 4: back-left top
    [ hw, H, -hd], // 5: back-right top
    [ hw, H,  hd], // 6: front-right top
    [-hw, H,  hd]  // 7: front-left top
  ];

  const proj = rawPts.map(([x, y, z]) => {
    const rx = x * cos - z * sin;
    const rz = x * sin + z * cos;
    // Slight perspective compression with depth rz
    const persp = 1 / (1 - rz * 0.00045);
    const sx = rx * persp;
    const sy = -y * persp + rz * tilt;
    return [sx, sy, rz];
  });

  // Fit inside canvas
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [sx, sy] of proj) {
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  const pad = 14;
  const scale = Math.min((cw - pad * 2) / (maxX - minX), (ch - pad * 2) / (maxY - minY));
  const cx = cw / 2 - ((minX + maxX) / 2) * scale;
  const cy = ch / 2 - ((minY + maxY) / 2) * scale;

  return proj.map(([sx, sy, rz]) => [cx + sx * scale, cy + sy * scale, rz]);
}

function renderBoxContainer(shape, materialId, colorId, angleDeg, isGroundSoil = false, mulch = false) {
  const cw = 520;
  const ch = shape === "cantero_rect" ? 320 : shape === "jardinera_alta" ? 420 : shape === "tierra_cantero" ? 240 : 420;
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");

  let W = 240, H = 120, D = 110;
  if (shape === "cantero_rect") { W = 320; H = 105; D = 125; }
  else if (shape === "maceta_cubo") { W = 175; H = 175; D = 175; }
  else if (shape === "jardinera_alta") { W = 230; H = 195; D = 95; }
  else if (shape === "tierra_cantero") { W = 330; H = 36; D = 150; }

  const pts = projectBox(W, H, D, angleDeg, cw, ch);
  const colorSpec = getColorSpec(materialId, colorId);

  // Faces: [indices, normalZ-ish avg depth, shade]
  const faces = [
    { id: "front", idx: [3, 2, 6, 7], shade: 0.96 },
    { id: "right", idx: [2, 1, 5, 6], shade: 0.72 },
    { id: "back",  idx: [1, 0, 4, 5], shade: 0.62 },
    { id: "left",  idx: [0, 3, 7, 4], shade: 0.78 }
  ];

  // Determine visible vertical faces via 2D signed area (winding)
  const visibleFaces = [];
  for (const f of faces) {
    const poly = f.idx.map(i => pts[i]);
    // Shoelace signed area
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      area += x1 * y2 - x2 * y1;
    }
    const avgZ = f.idx.reduce((acc, i) => acc + pts[i][2], 0) / 4;
    if (area < 0) {
      visibleFaces.push({ ...f, poly, avgZ });
    }
  }
  visibleFaces.sort((a, b) => a.avgZ - b.avgZ);

  for (const f of visibleFaces) {
    paintMaterialTexture(ctx, f.poly.map(([x, y]) => [x, y]), colorSpec, f.shade, f.id.charCodeAt(0) * 19);
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    f.poly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }

  // Top face (rim + inner soil)
  const topPoly = [pts[4], pts[5], pts[6], pts[7]].map(([x, y]) => [x, y]);
  paintMaterialTexture(ctx, topPoly, colorSpec, 1.0, 303);

  // Inner soil inset
  const inset = isGroundSoil ? 0.06 : 0.11;
  const cxTop = topPoly.reduce((s, p) => s + p[0], 0) / 4;
  const cyTop = topPoly.reduce((s, p) => s + p[1], 0) / 4;
  const soilPoly = topPoly.map(([x, y]) => [
    cxTop + (x - cxTop) * (1 - inset),
    cyTop + (y - cyTop) * (1 - inset)
  ]);
  paintSoilTexture(ctx, soilPoly, mulch, 91);

  // Subtle rim highlight
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  topPoly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.stroke();

  return canvas.toDataURL("image/png");
}

function renderCylinderContainer(materialId, colorId, angleDeg) {
  const cw = 420;
  const ch = 460;
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  const colorSpec = getColorSpec(materialId, colorId);

  const cx = cw / 2;
  const topY = 78;
  const botY = 415;
  const topRx = 152;
  const topRy = 42;
  const botRx = 122;
  const botRy = 34;

  // Body path
  const bodyPoly = [
    [cx - topRx, topY],
    [cx + topRx, topY],
    [cx + botRx, botY],
    [cx - botRx, botY]
  ];

  // Curved cylinder body
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - topRx, topY);
  ctx.lineTo(cx - botRx, botY);
  ctx.ellipse(cx, botY, botRx, botRy, 0, Math.PI, 0, true);
  ctx.lineTo(cx + topRx, topY);
  ctx.ellipse(cx, topY, topRx, topRy, 0, 0, Math.PI, false);
  ctx.closePath();
  ctx.clip();

  // Lighting angle shifts with rotation
  const rad = (angleDeg * Math.PI) / 180;
  const lightShift = Math.sin(rad) * 0.25;
  const grad = ctx.createLinearGradient(cx - topRx, topY, cx + topRx, topY);
  grad.addColorStop(0, colorSpec.dark);
  grad.addColorStop(Math.max(0.15, Math.min(0.85, 0.35 + lightShift)), colorSpec.light);
  grad.addColorStop(0.75, colorSpec.base);
  grad.addColorStop(1, colorSpec.dark);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cw, ch);

  // Texture details
  const rand = seededRand(404 + Math.round(angleDeg / 15));
  if (colorSpec.texture === "oxidized_iron" || colorSpec.texture === "corten") {
    for (let i = 0; i < 32; i++) {
      const rx = cx - topRx + rand() * topRx * 2;
      const ry = topY + rand() * (botY - topY);
      const rr = 8 + rand() * 22;
      ctx.fillStyle = rand() > 0.4 ? "rgba(155, 68, 25, 0.24)" : "rgba(45, 18, 8, 0.2)";
      ctx.beginPath();
      ctx.ellipse(rx, ry, rr, rr * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (colorSpec.texture === "concrete" || colorSpec.texture === "terracotta") {
    for (let i = 0; i < 40; i++) {
      const rx = cx - topRx + rand() * topRx * 2;
      const ry = topY + rand() * (botY - topY);
      ctx.fillStyle = rand() > 0.5 ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)";
      ctx.beginPath();
      ctx.arc(rx, ry, 1.5 + rand() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // Top rim
  ctx.save();
  ctx.fillStyle = colorSpec.light;
  ctx.strokeStyle = "rgba(0,0,0,0.28)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, topY, topRx, topRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Inner soil ellipse
  const soilPts = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    soilPts.push([cx + Math.cos(a) * (topRx - 16), topY + 3 + Math.sin(a) * (topRy - 7)]);
  }
  paintSoilTexture(ctx, soilPts, false, 88);

  return canvas.toDataURL("image/png");
}

function renderOrganicSoilBed(mulch = false) {
  const cw = 520;
  const ch = 220;
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");

  const pts = [];
  const rand = seededRand(mulch ? 512 : 256);
  const steps = 36;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wobble = 0.88 + rand() * 0.22;
    pts.push([
      cw / 2 + Math.cos(a) * 215 * wobble,
      ch / 2 + 12 + Math.sin(a) * 68 * wobble
    ]);
  }
  paintSoilTexture(ctx, pts, mulch, mulch ? 777 : 333);

  // Soft outer rim
  ctx.strokeStyle = "rgba(20, 12, 6, 0.35)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.stroke();

  return canvas.toDataURL("image/png");
}

export function getContainerRenderSrc({ shape = "cantero_rect", material = "cemento", colorId = "gris_claro", viewAngle = 0, isGroundSoil = false, mulch = false }) {
  const normAngle = ((Math.round(viewAngle) % 360) + 360) % 360;
  const key = `${shape}|${material}|${colorId}|${normAngle}|${isGroundSoil ? 1 : 0}|${mulch ? 1 : 0}`;
  if (renderCache.has(key)) return renderCache.get(key);

  let dataUrl;
  if (shape === "tierra_organica") {
    dataUrl = renderOrganicSoilBed(mulch);
  } else if (shape === "maceta_cilindro") {
    dataUrl = renderCylinderContainer(material, colorId, normAngle);
  } else {
    dataUrl = renderBoxContainer(shape, material, colorId, normAngle, isGroundSoil, mulch);
  }
  renderCache.set(key, dataUrl);
  return dataUrl;
}
