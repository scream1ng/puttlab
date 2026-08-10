/* =====================================================================
   Per-frame tracker: RGBA pixels in, mat-coordinate observations out.

   Kept free of DOM and WebCodecs so the same code runs in the app, in a
   worker, and under test.
   ===================================================================== */

import { applyH, pointInQuad } from './geom.js';
import { detectBall, detectMarkers, detectPutterBlob } from './detect.js';

export const DEFAULTS = {
  detWidth: 640,          // detection raster width; drives angular precision
  ball: { vThr: 0.55, sThr: 0.30, minPx: 6 },
  marker: { hue: 322, hueTol: 32, sMin: 0.40, vMin: 0.22, minPx: 5 },
  markerless: false,
  putter: { vMax: 0.34, minPx: 40, minElongation: 1.7 }
};

export function createTracker(cfg) {
  const { H, quad, matW, srcWidth, srcHeight } = cfg;
  const opt = {
    ...DEFAULTS, ...cfg.opt,
    ball: { ...DEFAULTS.ball, ...(cfg.opt?.ball) },
    marker: { ...DEFAULTS.marker, ...(cfg.opt?.marker) },
    putter: { ...DEFAULTS.putter, ...(cfg.opt?.putter) }
  };
  const scale = opt.detWidth / srcWidth;              // src px -> detection px
  const detW = opt.detWidth;
  const detH = Math.round(srcHeight * scale);

  const quadDet = quad.map(p => ({ x: p.x * scale, y: p.y * scale }));
  const xs = quadDet.map(p => p.x), ys = quadDet.map(p => p.y);
  const matBox = {
    x0: Math.min(...xs), x1: Math.max(...xs),
    y0: Math.min(...ys), y1: Math.max(...ys)
  };
  // The putter head and its markers routinely sit outside the mat outline,
  // so give that search a generous margin. The ball never does.
  const pad = (matBox.x1 - matBox.x0) * 0.35;
  const putterBox = { x0: matBox.x0 - pad, x1: matBox.x1 + pad,
                      y0: matBox.y0 - pad * 0.4, y1: matBox.y1 + pad * 0.6 };

  const toMat = (dx, dy) => {
    const m = applyH(H, dx / scale, dy / scale);
    return { x: m.x - matW / 2, y: m.y };            // origin on the target line
  };

  let lastBall = null, ballVel = { x: 0, y: 0 }, ballMiss = 0;
  let lastMarkerBox = null, markerMiss = 0;

  return {
    detW, detH, scale, matBox, putterBox,

    /** @param px Uint8ClampedArray RGBA at detW×detH */
    process(px, t) {
      const out = { t, ball: null, face: null, head: null, raw: {} };

      /* ---------------- ball ---------------- */
      let roi = matBox;
      if (lastBall) {
        const r = 22 + Math.hypot(ballVel.x, ballVel.y) * 1.7;
        roi = { x0: lastBall.x + ballVel.x - r, x1: lastBall.x + ballVel.x + r,
                y0: lastBall.y + ballVel.y - r, y1: lastBall.y + ballVel.y + r };
      }
      let b = detectBall(px, detW, detH, roi, opt.ball);
      if (!b && lastBall) b = detectBall(px, detW, detH, matBox, opt.ball);
      if (b && !pointInQuad({ x: b.x, y: b.y }, quadDet)) b = null;
      if (b) {
        if (lastBall) ballVel = { x: b.x - lastBall.x, y: b.y - lastBall.y };
        lastBall = b; ballMiss = 0;
        out.ball = toMat(b.x, b.y);
        out.raw.ball = b;
      } else if (++ballMiss > 6) { lastBall = null; ballVel = { x: 0, y: 0 }; }

      /* ---------------- putter ---------------- */
      let pRoi = putterBox;
      if (lastMarkerBox) {
        const m = lastMarkerBox, g = 40;
        pRoi = { x0: m.x0 - g, x1: m.x1 + g, y0: m.y0 - g, y1: m.y1 + g };
      }

      if (opt.markerless) {
        let blob = detectPutterBlob(px, detW, detH, pRoi, opt.putter);
        if (!blob && lastMarkerBox) blob = detectPutterBlob(px, detW, detH, putterBox, opt.putter);
        if (blob) {
          // principal axis -> two points along the face line
          const L = 20;
          const a = { x: blob.x - Math.cos(blob.theta) * L, y: blob.y - Math.sin(blob.theta) * L };
          const c = { x: blob.x + Math.cos(blob.theta) * L, y: blob.y + Math.sin(blob.theta) * L };
          out.face = { a: toMat(a.x, a.y), b: toMat(c.x, c.y) };
          out.head = toMat(blob.x, blob.y);
          out.raw.putter = blob;
          lastMarkerBox = { x0: blob.bbox.minx, x1: blob.bbox.maxx,
                            y0: blob.bbox.miny, y1: blob.bbox.maxy };
          markerMiss = 0;
        } else if (++markerMiss > 4) lastMarkerBox = null;
      } else {
        let m = detectMarkers(px, detW, detH, pRoi, opt.marker);
        if (!m && lastMarkerBox) m = detectMarkers(px, detW, detH, putterBox, opt.marker);
        if (m) {
          const A = toMat(m.a.x, m.a.y), B = toMat(m.b.x, m.b.y);
          out.face = { a: A, b: B };
          out.head = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
          out.raw.markers = m;
          lastMarkerBox = {
            x0: Math.min(m.a.x, m.b.x), x1: Math.max(m.a.x, m.b.x),
            y0: Math.min(m.a.y, m.b.y), y1: Math.max(m.a.y, m.b.y)
          };
          markerMiss = 0;
        } else if (++markerMiss > 4) lastMarkerBox = null;
      }

      return out;
    }
  };
}
