/**
 * fSpy-style 3D Camera Calibration Solver from 2 orthogonal vanishing-point line pairs
 * (X-axis floor lines + Y-axis floor lines) and 1 real-world reference segment.
 */

function lineIntersect(a1, a2, b1, b2) {
  const x1 = a1.x, y1 = a1.y, x2 = a2.x, y2 = a2.y;
  const x3 = b1.x, y3 = b1.y, x4 = b2.x, y4 = b2.y;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-3) return null; // parallel
  const px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denom;
  const py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denom;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  return { x: px, y: py };
}

function norm3(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

export function solveCameraFromLines({
  cw,
  ch,
  xLine1,
  xLine2,
  yLine1,
  yLine2,
  refLine,
  refMeters = 1.5,
  refType = "floor" // "floor" | "vertical"
}) {
  const cx = cw / 2;
  const cy = ch / 2;

  const vpX = lineIntersect(xLine1[0], xLine1[1], xLine2[0], xLine2[1]);
  const vpY = lineIntersect(yLine1[0], yLine1[1], yLine2[0], yLine2[1]);

  // Estimate focal length f from orthogonal vanishing points: (vx-cx)(vyx-cx) + (vy-cy)(vyy-cy) + f^2 = 0
  let f = cw * 0.85;
  if (vpX && vpY) {
    const f2 = -((vpX.x - cx) * (vpY.x - cx) + (vpX.y - cy) * (vpY.y - cy));
    if (f2 > (cw * 0.35) ** 2 && f2 < (cw * 3.0) ** 2) {
      f = Math.sqrt(f2);
    }
  }

  // X axis direction in camera space
  let X_axis;
  if (vpX && Math.hypot(vpX.x - cx, vpX.y - cy) < cw * 20) {
    X_axis = norm3([vpX.x - cx, vpX.y - cy, f]);
    // Ensure X points generally right in screen space
    if (X_axis[0] < 0) X_axis = [-X_axis[0], -X_axis[1], -X_axis[2]];
  } else {
    const dx = xLine1[1].x - xLine1[0].x;
    const dy = xLine1[1].y - xLine1[0].y;
    const len = Math.hypot(dx, dy) || 1;
    X_axis = [dx / len, dy / len, 0];
    if (X_axis[0] < 0) X_axis = [-X_axis[0], -X_axis[1], 0];
  }

  // Y axis direction in camera space (orthogonalized against X_axis)
  let rawY;
  if (vpY && Math.hypot(vpY.x - cx, vpY.y - cy) < cw * 20) {
    rawY = norm3([vpY.x - cx, vpY.y - cy, f]);
    // Ensure Y points into the scene (positive camera Z)
    if (rawY[2] < 0) rawY = [-rawY[0], -rawY[1], -rawY[2]];
  } else {
    rawY = [0, -0.35, 0.93];
  }
  const projXY = dot3(rawY, X_axis);
  let Y_axis = norm3([
    rawY[0] - projXY * X_axis[0],
    rawY[1] - projXY * X_axis[1],
    rawY[2] - projXY * X_axis[2]
  ]);
  if (Y_axis[2] < 0) Y_axis = [-Y_axis[0], -Y_axis[1], -Y_axis[2]];

  // Z_up = X_axis x Y_axis; ensure it points UP in screen space (Z_up[1] < 0)
  let Z_up = norm3(cross3(X_axis, Y_axis));
  if (Z_up[1] > 0) {
    Z_up = [-Z_up[0], -Z_up[1], -Z_up[2]];
    Y_axis = [-Y_axis[0], -Y_axis[1], -Y_axis[2]];
  }
  // Ensure lower-screen ray hits the floor (dot(ray, Z_up) < 0)
  const testRay = [0, ch * 0.35, f];
  if (dot3(testRay, Z_up) > 0) {
    Z_up = [-Z_up[0], -Z_up[1], -Z_up[2]];
  }

  // Place unit-height camera at H_cam = 1.0 above floor plane (floor normal = Z_up)
  // Floor plane in camera space: dot(P_cam, Z_up) = -H_cam (since Z_up.y < 0, floor is below camera so dot(P_cam, Z_up) < 0)
  // Let's verify: if camera is at Z_world = +H_cam, a floor point at Z_world = 0 has P_cam = X*X_axis + Y*Y_axis - H_cam*Z_up
  // Wait: dot(P_cam, Z_up) = -H_cam! Let's check screen Y of floor:
  // Since Z_up[1] < 0, -H_cam * Z_up[1] > 0 (positive screen Y = lower half of image!). Exact!

  function screenToFloorWithH(sx, sy, hCam) {
    const ray = [sx - cx, sy - cy, f];
    const denom = dot3(ray, Z_up);
    if (Math.abs(denom) < 1e-5) return null;
    const t = -hCam / denom;
    if (t <= 1e-6) return null; // above horizon
    const P = [ray[0] * t, ray[1] * t, ray[2] * t];
    return {
      x: dot3(P, X_axis),
      y: dot3(P, Y_axis)
    };
  }

  function worldToScreenWithH(wx, wy, wz, hCam) {
    const px = wx * X_axis[0] + wy * Y_axis[0] + (wz - hCam) * Z_up[0];
    const py = wx * X_axis[1] + wy * Y_axis[1] + (wz - hCam) * Z_up[1];
    const pz = wx * X_axis[2] + wy * Y_axis[2] + (wz - hCam) * Z_up[2];
    const safeZ = pz < 0.05 ? 0.05 : pz;
    return {
      x: cx + f * (px / safeZ),
      y: cy + f * (py / safeZ),
      z: pz
    };
  }

  // Calibrate real camera height H_cam using refLine & refMeters
  let hCam = 1.6;
  if (refLine && refMeters > 0) {
    const [r1, r2] = refLine;
    const isVertical = refType === "vertical" || Math.abs(r2.y - r1.y) > Math.abs(r2.x - r1.x) * 1.3;
    if (isVertical) {
      // Bottom point is on floor (Z=0), top point is at Z=refMeters
      const bot = r1.y >= r2.y ? r1 : r2;
      const top = r1.y >= r2.y ? r2 : r1;
      const f1 = screenToFloorWithH(bot.x, bot.y, 1.0);
      if (f1) {
        const pUnitTop = worldToScreenWithH(f1.x, f1.y, 0.01, 1.0);
        const unitPxPerM = Math.hypot(pUnitTop.x - bot.x, pUnitTop.y - bot.y) * 100;
        const realPxPerM = Math.hypot(top.x - bot.x, top.y - bot.y) / refMeters;
        if (unitPxPerM > 2 && realPxPerM > 2) {
          hCam = Math.max(0.2, Math.min(30, unitPxPerM / realPxPerM));
        }
      }
    } else {
      // Both points on floor plane
      const f1 = screenToFloorWithH(r1.x, r1.y, 1.0);
      const f2 = screenToFloorWithH(r2.x, r2.y, 1.0);
      if (f1 && f2) {
        const unitDist = Math.hypot(f2.x - f1.x, f2.y - f1.y);
        if (unitDist > 0.01) {
          hCam = Math.max(0.2, Math.min(30, refMeters / unitDist));
        }
      }
    }
  }

  // Horizon line Y at left (x=0) and right (x=cw) where dot(ray, Z_up) = 0
  // (sx - cx)*Z_up[0] + (sy - cy)*Z_up[1] + f*Z_up[2] = 0
  const horizonY = (sx) => {
    if (Math.abs(Z_up[1]) < 1e-5) return cy;
    return cy - ((sx - cx) * Z_up[0] + f * Z_up[2]) / Z_up[1];
  };

  return {
    f,
    cx,
    cy,
    hCam,
    vpX,
    vpY,
    X_axis,
    Y_axis,
    Z_up,
    horizonY,
    screenToFloor: (sx, sy) => screenToFloorWithH(sx, sy, hCam),
    worldToScreen: (wx, wy, wz = 0) => worldToScreenWithH(wx, wy, wz, hCam),
    getPxPerMeterAt: (sx, sy) => {
      const fp = screenToFloorWithH(sx, sy, hCam);
      if (!fp) return 180;
      const p0 = worldToScreenWithH(fp.x, fp.y, 0, hCam);
      const p1 = worldToScreenWithH(fp.x, fp.y, 0.05, hCam);
      return Math.max(15, Math.min(2400, Math.hypot(p1.x - p0.x, p1.y - p0.y) * 20));
    }
  };
}
