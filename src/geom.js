/* =====================================================================
   Geometry: homography, small linear algebra, robust fits.
   Mat coordinate frame throughout:  x = across (+right), y = down the
   mat (+away from the golfer), millimetres, origin on the target line.
   ===================================================================== */

/** Gauss-Jordan with partial pivoting. n is small (8), so clarity wins. */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);   // row[i] is this row's pivot
}

/** Direct Linear Transform from 4 point correspondences. h33 fixed at 1. */
export function computeHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], u = dst[i].x, v = dst[i].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solveLinear(A, b);
  return h ? [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1] : null;
}

export function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
}

export function invert3(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [A * id, (c * h - b * i) * id, (b * f - c * e) * id,
          B * id, (a * i - c * g) * id, (c * d - a * f) * id,
          C * id, (b * g - a * h) * id, (a * e - b * d) * id];
}

export function pointInQuad(p, q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cr) < 1e-9) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

/* --------------------------- fitting --------------------------- */

/** Ordinary least squares y = a + b·x over {x,y} pairs. */
export function linreg(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / den;
  const a = (sy - b * sx) / n;
  let ss = 0; for (const p of pts) { const e = p.y - (a + b * p.x); ss += e * e; }
  return { a, b, n, rms: Math.sqrt(ss / n) };
}

/** Quadratic least squares y = a + b·x + c·x² — used near impact, where a
    straight line is a poor model of a rotating face. */
export function quadfit(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (const p of pts) {
    const x = p.x, x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += p.y; t1 += p.y * x; t2 += p.y * x2;
  }
  const sol = solveLinear([[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]], [t0, t1, t2]);
  if (!sol) return null;
  const [a, b, c] = sol;
  let ss = 0; for (const p of pts) { const e = p.y - (a + b * p.x + c * p.x * p.x); ss += e * e; }
  return { a, b, c, n, rms: Math.sqrt(ss / n), at: x => a + b * x + c * x * x,
           slopeAt: x => b + 2 * c * x };
}

/** Fit the ball's departure line: x = a + b·y over the first `windowMm` of
    roll. x-on-y because y is the near-noiseless independent variable. */
export function fitStartLine(track, windowMm) {
  if (track.length < 4) return null;
  const y0 = track[0].y;
  const pts = track.filter(p => Math.abs(p.y - y0) <= windowMm).map(p => ({ x: p.y, y: p.x }));
  if (pts.length < 4) return null;
  const r = linreg(pts);
  if (!r) return null;
  return { a: r.a, b: r.b, angleDeg: Math.atan(r.b) * 180 / Math.PI, n: r.n, rms: r.rms };
}

/** Ball speed from a regression of arc length on time (m/s). */
export function fitSpeed(track, windowMm) {
  if (track.length < 4) return null;
  const y0 = track[0].y, t0 = track[0].t;
  const pts = []; let d = 0;
  for (let i = 0; i < track.length; i++) {
    if (i > 0) d += Math.hypot(track[i].x - track[i - 1].x, track[i].y - track[i - 1].y);
    if (Math.abs(track[i].y - y0) > windowMm) break;
    pts.push({ x: track[i].t - t0, y: d });
  }
  if (pts.length < 4) return null;
  const r = linreg(pts);
  return r ? r.b / 1000 : null;
}

/* --------------------------- angles --------------------------- */

/** Angle of a direction vector measured from the target line (+y),
    positive to the right. Range (−180, 180]. */
export function bearingDeg(dx, dy) {
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

/**
 * Face angle from the toe-to-heel vector, in mat coordinates.
 *
 * Convention: a SQUARE face has its face line running straight across the
 * mat, i.e. along +x, so the vector is (1, 0) and the angle is 0. Positive
 * means open (aimed right). Note this is atan2(dy, dx) — transposed from
 * `bearingDeg`, which measures a direction of travel from the target line.
 * Getting these two the wrong way round yields a face angle near 90°, which
 * is at least an obvious failure.
 */
export function faceAngleFromVector(dx, dy) {
  return foldFaceAngle(Math.atan2(dy, dx) * 180 / Math.PI);
}

/** A face is a LINE, not a vector — toe-to-heel and heel-to-toe mean the
    same face angle. Fold into (−90, 90]. */
export function foldFaceAngle(deg) {
  let a = ((deg + 90) % 180 + 180) % 180 - 90;
  return a === -90 ? 90 : a;
}

/** Unwrap a folded-angle series so it is continuous for fitting. */
export function unwrapAngles(series) {
  const out = series.slice();
  for (let i = 1; i < out.length; i++) {
    let d = out[i] - out[i - 1];
    while (d > 90) { out[i] -= 180; d = out[i] - out[i - 1]; }
    while (d < -90) { out[i] += 180; d = out[i] - out[i - 1]; }
  }
  return out;
}
