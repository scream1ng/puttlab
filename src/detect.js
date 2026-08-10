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
    the axis start-line measurement reads. */
export function detectBall(px, w, h, roi, opt) {
  const { vThr = 0.55, sThr = 0.30, minPx = 6 } = opt || {};
  let sx = 0, sy = 0, sw = 0, n = 0;
  const x0 = Math.max(0, roi.x0 | 0), x1 = Math.min(w - 1, roi.x1 | 0);
  const y0 = Math.max(0, roi.y0 | 0), y1 = Math.min(h - 1, roi.y1 | 0);
  for (let y = y0; y <= y1; y++) {
    let i = (y * w + x0) * 4;
    for (let x = x0; x <= x1; x++, i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (mx < vThr * 255) continue;
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if ((mx - mn) / mx > sThr) continue;
      const wt = mx / 255;
      sx += x * wt; sy += y * wt; sw += wt; n++;
    }
  }
  if (n < minPx || sw === 0) return null;
  return { x: sx / sw, y: sy / sw, n };
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
