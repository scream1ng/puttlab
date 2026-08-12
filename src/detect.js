/* =====================================================================
   Per-frame detection. Everything works on a downscaled RGBA buffer.

   Three detectors:
     ball()      — bright, desaturated blob (a golf ball on coloured felt)
     markers()   — two same-coloured stickers on the putter head; the line
                   through them IS the face line
     putterBlob()— markerless fallback: orientation of the dark elongated
                   blob from its second moments

   Why markers for face angle: measuring ±0.3° markerless from a phone
   video is a research problem, not a weekend one. Two stickers turn it
   into arithmetic. That is the same trade PerfectLine makes by milling
   the mat — put the precision in the physical setup so the software can
   make a defensible claim.
   ===================================================================== */

/* ---------------------------- colour ---------------------------- */

export function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx / 255 };
}

const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/* ------------------------- connected blobs ------------------------- */

/** Flood-fill connected components over a boolean mask.
    Returns blobs sorted by weight, each with an intensity-weighted centroid
    and second-moment orientation. */
export function components(mask, weight, w, h, minPx, maxBlobs = 12) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const blobs = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let sp = 0; stack[sp++] = i; seen[i] = 1;
    let n = 0, sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    let minx = w, maxx = -1, miny = h, maxy = -1;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      const wt = weight ? weight[p] : 1;
      n++; sw += wt; sx += x * wt; sy += y * wt;
      sxx += x * x * wt; syy += y * y * wt; sxy += x * y * wt;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x > 0     && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0     && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (n < minPx || sw === 0) continue;
    const cx = sx / sw, cy = sy / sw;
    // central second moments -> principal axis
    const mxx = sxx / sw - cx * cx, myy = syy / sw - cy * cy, mxy = sxy / sw - cx * cy;
    const theta = 0.5 * Math.atan2(2 * mxy, mxx - myy);
    const common = Math.sqrt(Math.max(0, (mxx - myy) * (mxx - myy) + 4 * mxy * mxy));
    const l1 = (mxx + myy + common) / 2, l2 = (mxx + myy - common) / 2;
    blobs.push({ x: cx, y: cy, n, weight: sw, theta,
                 elongation: l2 > 1e-9 ? Math.sqrt(l1 / l2) : Infinity,
                 bbox: { minx, maxx, miny, maxy } });
  }
  blobs.sort((a, b) => b.weight - a.weight);
  return blobs.slice(0, maxBlobs);
}

/* ----------------------------- ball ----------------------------- */

/** Bright + desaturated. Motion blur smears the ball ALONG its travel, so
    the weighted centroid stays unbiased across-track — which is exactly
    the axis start-line measurement reads.

    Returns the heaviest CONNECTED blob, never the centroid of every
    qualifying pixel in the ROI. That distinction is the whole point: a
    carpet blemish, a shadow edge or a specular fleck lights up a scatter of
    stray pixels, and summing them produced a confident phantom ball at
    their centre of mass with no way to say "nothing here". On a real clip
    where the ball rolls out of shot that read as 692/692 frames tracked,
    and the impact search then found no ball motion at all. A ball is one
    compact thing: require connectivity, and require the blob to fill a
    plausible fraction of its own bounding box (a disc fills π/4 ≈ 0.79, a
    blurred ellipse about the same, a ring or an accidental chain of noise
    far less). */
function ballCandidates(px, w, h, roi, opt) {
  const { vThr = 0.55, sThr = 0.30, minPx = 6, minFill = 0.45,
          nMin = 0, nMax = Infinity } = opt || {};
  const mask = new Uint8Array(w * h);
  const weight = new Float32Array(w * h);
  const x0 = Math.max(0, roi.x0 | 0), x1 = Math.min(w - 1, roi.x1 | 0);
  const y0 = Math.max(0, roi.y0 | 0), y1 = Math.min(h - 1, roi.y1 | 0);
  let any = 0;
  for (let y = y0; y <= y1; y++) {
    let i = (y * w + x0) * 4, p = y * w + x0;
    for (let x = x0; x <= x1; x++, i += 4, p++) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (mx < vThr * 255) continue;
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if ((mx - mn) / mx > sThr) continue;
      mask[p] = 1; weight[p] = mx / 255; any++;
    }
  }
  if (any < minPx) return [];
  const out = [];
  for (const b of components(mask, weight, w, h, minPx, 12)) {
    // Size gate before fill, and INSIDE the loop so a rejected blob falls
    // through to the next candidate. components() sorts by intensity weight, so
    // without this the biggest bright desaturated thing wins — and a light
    // putter head is bigger than the ball, just as bright, and being rectangular
    // fills its bbox better than a disc's π/4. It would win every time.
    if (b.n < nMin || b.n > nMax) continue;
    const bw = b.bbox.maxx - b.bbox.minx + 1, bh = b.bbox.maxy - b.bbox.miny + 1;
    const fill = b.n / (bw * bh);
    if (fill < minFill) continue;
    out.push({ x: b.x, y: b.y, n: b.n, fill, w: bw, h: bh });
  }
  return out;
}

/** Every blob that could be the ball, heaviest first.

    Size and roundness cannot separate a golf ball from a target circle printed
    on the mat — on a real clip the printed ring won the weight sort and was
    tracked for all 325 frames. Only motion separates them, and motion is not
    visible in one frame, so the choice has to be deferred: hand back every
    candidate and let resolveBallTrack() pick the one that moves. */
export function detectBallCandidates(px, w, h, roi, opt) {
  return ballCandidates(px, w, h, roi, opt);
}

/** The single best candidate. Kept for callers that have no time dimension. */
export function detectBall(px, w, h, roi, opt) {
  return ballCandidates(px, w, h, roi, opt)[0] || null;
}

/* -------------------------- target line -------------------------- */

/**
 * The reference line printed down the middle of a putting mat.
 *
 * A top-down clip never shows the mat's corners, so the four-corner tap has
 * nothing to bite on — but the mat carries its own direction reference, and
 * finding it per frame beats a tap that goes stale as a handheld camera drifts.
 *
 * Two passes, because one is not enough on a real mat:
 *   1. Components, to find the longest strongly-elongated coloured run. The
 *      ball and the putter head SIT on the line and break it into segments, so
 *      this is a fragment, not the whole thing — good enough to say where the
 *      line roughly is.
 *   2. Re-scan, keeping only masked pixels within `bandPx` of that fragment's
 *      axis, and fit those by total least squares. That recovers the full
 *      length across the gaps while excluding the dotted rules and tick marks
 *      a mat prints in the same colour off to the side — which would otherwise
 *      pull the angle badly, being far off-axis.
 *
 * Returns { deg, rad, x, y, n, rms } — deg is the line's ORIENTATION (a line
 * has no direction), x/y a point on it, rms the perpendicular scatter in px.
 */
export function detectTargetLine(px, w, h, roi, opt) {
  const { hue = 55, hueTol = 22, sMin = 0.28, vMin = 0.28,
          minPx = 60, minElongation = 6, bandPx = 14 } = opt || {};
  const mask = new Uint8Array(w * h);
  const x0 = Math.max(0, roi.x0 | 0), x1 = Math.min(w - 1, roi.x1 | 0);
  const y0 = Math.max(0, roi.y0 | 0), y1 = Math.min(h - 1, roi.y1 | 0);
  let any = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = y * w + x, i = p * 4;
      const { h: hu, s, v } = rgb2hsv(px[i], px[i + 1], px[i + 2]);
      if (s < sMin || v < vMin) continue;
      let d = Math.abs(hu - hue); if (d > 180) d = 360 - d;
      if (d > hueTol) continue;
      mask[p] = 1; any++;
    }
  }
  if (any < minPx) return null;

  const seed = components(mask, null, w, h, minPx, 8)
    .find(b => b.elongation >= minElongation);
  if (!seed) return null;

  // Pass 2: total least squares over everything lying along the seed's axis.
  const ux = Math.cos(seed.theta), uy = Math.sin(seed.theta);
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!mask[y * w + x]) continue;
      // perpendicular distance from the seed axis
      const dx = x - seed.x, dy = y - seed.y;
      if (Math.abs(dx * uy - dy * ux) > bandPx) continue;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
  }
  if (n < minPx) return null;
  const mx = sx / n, my = sy / n;
  const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
  const rad = 0.5 * Math.atan2(2 * cxy, cxx - cyy);

  // perpendicular scatter about the fitted line
  const vx = Math.cos(rad), vy = Math.sin(rad);
  const varPerp = Math.max(0, cxx * vy * vy - 2 * cxy * vx * vy + cyy * vx * vx);
  return { deg: rad * 180 / Math.PI, rad, x: mx, y: my, n, rms: Math.sqrt(varPerp) };
}

/* -------------------------- putter face -------------------------- */

/**
 * The putter's face, fitted as the head's ball-facing EDGE.
 *
 * Not the head blob's principal axis, which is what markerless mode used and
 * why it measured 1.14° against 0.03° for stickers: a mallet head images about
 * 102x74 px, a ratio of only 1.38, and the axis of a near-square blob swings
 * wildly on small changes in shape. The face itself is a long straight edge,
 * and a line fitted to ~100 px of it is a far better conditioned estimate.
 *
 * Only the ball-facing boundary is used, so the wings and hosel — which stick
 * out the BACK of a mallet — cannot pull the angle.
 *
 * @param seed    a point inside the head (its centroid)
 * @param toward  a point on the ball side; picks which boundary is the face
 * @returns { deg, rad, x, y, n, rms } or null
 */
export function detectFaceEdge(px, w, h, roi, seed, toward, opt) {
  const { vThr = 0.62, minPx = 40, trimRms = 2.2 } = opt || {};
  const x0 = Math.max(0, roi.x0 | 0), x1 = Math.min(w - 1, roi.x1 | 0);
  const y0 = Math.max(0, roi.y0 | 0), y1 = Math.min(h - 1, roi.y1 | 0);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw < 3 || bh < 3) return null;

  const bright = (x, y) => {
    const i = (y * w + x) * 4;
    return Math.max(px[i], px[i + 1], px[i + 2]) >= vThr * 255;
  };
  // Flood fill from the seed so only THIS head contributes — a bright mat band
  // touching the bbox must not be mistaken for part of the club.
  const seen = new Uint8Array(bw * bh);
  const sx = Math.round(seed.x), sy = Math.round(seed.y);
  if (sx < x0 || sx > x1 || sy < y0 || sy > y1 || !bright(sx, sy)) return null;
  const stack = [sx - x0 + (sy - y0) * bw];
  seen[stack[0]] = 1;
  const pts = [];
  while (stack.length) {
    const p = stack.pop();
    const lx = p % bw, ly = (p / bw) | 0, gx = lx + x0, gy = ly + y0;
    pts.push({ x: gx, y: gy });
    const push = (nx, ny) => {
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) return;
      const q = nx - x0 + (ny - y0) * bw;
      if (seen[q] || !bright(nx, ny)) return;
      seen[q] = 1; stack.push(q);
    };
    push(gx - 1, gy); push(gx + 1, gy); push(gx, gy - 1); push(gx, gy + 1);
  }
  if (pts.length < minPx) return null;

  // d points at the ball; e runs along the face. Take, for each step across the
  // face, the pixel furthest toward the ball — that traces the leading edge.
  let dx = toward.x - seed.x, dy = toward.y - seed.y;
  const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
  const ex = -dy, ey = dx;
  const best = new Map();
  for (const p of pts) {
    const along = Math.round((p.x - seed.x) * ex + (p.y - seed.y) * ey);
    const depth = (p.x - seed.x) * dx + (p.y - seed.y) * dy;
    const cur = best.get(along);
    if (!cur || depth > cur.depth) best.set(along, { depth, x: p.x, y: p.y });
  }
  let edge = [...best.values()];
  if (edge.length < 8) return null;

  const fit = list => {
    let n = 0, sX = 0, sY = 0, sXX = 0, sYY = 0, sXY = 0;
    for (const p of list) { n++; sX += p.x; sY += p.y; sXX += p.x * p.x; sYY += p.y * p.y; sXY += p.x * p.y; }
    const mx = sX / n, my = sY / n;
    const cxx = sXX / n - mx * mx, cyy = sYY / n - my * my, cxy = sXY / n - mx * my;
    const rad = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const vx = Math.cos(rad), vy = Math.sin(rad);
    const varPerp = Math.max(0, cxx * vy * vy - 2 * cxy * vx * vy + cyy * vx * vx);
    return { rad, mx, my, n, rms: Math.sqrt(varPerp), vx, vy };
  };
  // Trim ITERATIVELY. At the ends of a rotated head the furthest-forward pixel
  // belongs to a SIDE edge, not the face, and those corner points drag the fit
  // — badly enough on a 2.5° head to cost half a degree. They are a minority
  // with large residuals, so repeated trimming converges onto the straight
  // majority; one pass leaves rms inflated enough that the cut misses them.
  let f = fit(edge);
  for (let pass = 0; pass < 3 && f.rms > 0.05; pass++) {
    const keep = edge.filter(p =>
      Math.abs((p.x - f.mx) * -f.vy + (p.y - f.my) * f.vx) <= trimRms * f.rms);
    if (keep.length < 8 || keep.length === edge.length) break;
    edge = keep; f = fit(edge);
  }
  return { deg: f.rad * 180 / Math.PI, rad: f.rad, x: f.mx, y: f.my, n: f.n, rms: f.rms };
}

/* ---------------------------- markers ---------------------------- */

/** Two same-coloured stickers on the putter head.
    Same colour on both is deliberate — a face line has no direction, only
    an orientation, so there is nothing to disambiguate. */
export function detectMarkers(px, w, h, roi, opt) {
  const { hue = 320, hueTol = 30, sMin = 0.45, vMin = 0.25, minPx = 4 } = opt || {};
  const mask = new Uint8Array(w * h);
  const weight = new Float32Array(w * h);
  const x0 = Math.max(0, roi.x0 | 0), x1 = Math.min(w - 1, roi.x1 | 0);
  const y0 = Math.max(0, roi.y0 | 0), y1 = Math.min(h - 1, roi.y1 | 0);
  let any = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = y * w + x, i = p * 4;
      const c = rgb2hsv(px[i], px[i + 1], px[i + 2]);
      if (c.s < sMin || c.v < vMin) continue;
      if (hueDist(c.h, hue) > hueTol) continue;
      mask[p] = 1; weight[p] = c.s * c.v; any++;
    }
  }
  if (any < minPx * 2) return null;
  const blobs = components(mask, weight, w, h, minPx, 8);
  if (blobs.length < 2) return null;
  // The two heaviest blobs are the two stickers.
  const [a, b] = blobs;
  return { a, b, all: blobs };
}

/** Markerless: the putter head is the dark elongated thing on the mat.
    Its principal axis approximates the face line. Cheaper setup, and
    materially less accurate — report it as approximate. */
export function detectPutterBlob(px, w, h, roi, opt) {
  const { vMax = 0.34, minPx = 40, minElongation = 1.7 } = opt || {};
  const mask = new Uint8Array(w * h);
  const x0 = Math.max(0, roi.x0 | 0), x1 = Math.min(w - 1, roi.x1 | 0);
  const y0 = Math.max(0, roi.y0 | 0), y1 = Math.min(h - 1, roi.y1 | 0);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = y * w + x, i = p * 4;
      const mx = Math.max(px[i], px[i + 1], px[i + 2]) / 255;
      if (mx <= vMax) mask[p] = 1;
    }
  }
  const blobs = components(mask, null, w, h, minPx, 6);
  const hit = blobs.find(b => b.elongation >= minElongation);
  return hit || null;
}

/** Sample the dominant hue in a small patch — lets the user tap a sticker
    instead of guessing a colour name. */
export function sampleHue(px, w, h, cx, cy, r = 6) {
  let sx = 0, sy = 0, sSum = 0, vSum = 0, n = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const i = (y * w + x) * 4;
      const c = rgb2hsv(px[i], px[i + 1], px[i + 2]);
      if (c.s < 0.2) continue;
      const a = c.h * Math.PI / 180;              // circular mean of hue
      sx += Math.cos(a) * c.s; sy += Math.sin(a) * c.s;
      sSum += c.s; vSum += c.v; n++;
    }
  }
  if (!n) return null;
  let hue = Math.atan2(sy, sx) * 180 / Math.PI;
  if (hue < 0) hue += 360;
  return { hue, s: sSum / n, v: vSum / n, n };
}
