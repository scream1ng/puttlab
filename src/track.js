/* =====================================================================
   Per-frame tracker: RGBA pixels in, mat-coordinate observations out.

   Kept free of DOM and WebCodecs so the same code runs in the app, in a
   worker, and under test.
   ===================================================================== */

import { applyH, pointInQuad } from './geom.js';
import { detectBall, detectBallCandidates, detectMarkers, detectPutterBlob, detectTargetLine, detectFaceEdge } from './detect.js';

/**
 * Choose which of the ball-shaped candidates is actually the ball.
 *
 * Size and roundness cannot do it: a target circle printed on the mat is
 * ball-sized and round, and on a real clip one of them outweighed the ball and
 * was tracked for every frame of the clip. What separates them is motion — the
 * ball is struck, the printed circles never move — and that is not visible in a
 * single frame. So candidates are chained into tracks across the whole clip
 * first, and the decision is made once, at the end, on the evidence.
 *
 * Pure and frame-agnostic so it can be tested without decoding anything.
 *
 * @param perFrame  array (one entry per frame) of candidate arrays, in
 *                  detection pixels: [{ x, y, n }, …]
 * @param gatePx    how far a ball may travel between frames and still be the
 *                  same ball
 * @returns { track, tracks } where track is an array, one entry per input
 *          frame, holding the chosen candidate or null
 */
export function resolveBallTrack(perFrame, gatePx = 26, minMovePx = 40) {
  const tracks = [];
  perFrame.forEach((cands, f) => {
    const taken = new Set();
    // Extend existing tracks first, nearest candidate wins, so a track that is
    // genuinely following something keeps it rather than losing it to a
    // younger track spawned on the same blob.
    for (const tr of tracks) {
      if (tr.done) continue;
      const px = tr.lastX + tr.vx, py = tr.lastY + tr.vy;   // where it should be
      let best = -1, bestD = Infinity;
      (cands || []).forEach((c, i) => {
        if (taken.has(i)) return;
        const d = Math.hypot(c.x - px, c.y - py);
        if (d < bestD) { bestD = d; best = i; }
      });
      const reach = gatePx + Math.hypot(tr.vx, tr.vy);
      if (best >= 0 && bestD <= reach) {
        const c = cands[best]; taken.add(best);
        tr.vx = c.x - tr.lastX; tr.vy = c.y - tr.lastY;
        tr.lastX = c.x; tr.lastY = c.y;
        tr.at[f] = c;
        tr.miss = 0;
        tr.span = Math.max(tr.span, Math.hypot(c.x - tr.x0, c.y - tr.y0));
      } else if (++tr.miss > 6) {
        tr.done = true;
      }
    }
    (cands || []).forEach((c, i) => {
      if (taken.has(i)) return;
      tracks.push({ x0: c.x, y0: c.y, lastX: c.x, lastY: c.y, vx: 0, vy: 0,
                    span: 0, miss: 0, done: false, at: { [f]: c } });
    });
  });

  // Which track is the ball?
  //
  // NOT "the one that moves most" — that is the putter head, which travels
  // further than the ball ever does, and a moving foot or shadow can beat both.
  // The ball's signature is one-way: it sits still at address, is struck, and
  // leaves without ever coming back. The putter oscillates through its own
  // start; printed targets never move at all.
  // Crucially NOT "the track that starts still and then leaves". On a mat with a
  // printed aiming dot the ball sits ON that dot, so the address-phase track
  // slides straight onto the dot when the ball goes and registers no departure
  // at all. The ball's own track begins mid-flight, already moving, with no
  // still phase to find. Score on one-way departure from wherever each track
  // began, and the ball wins on its rolling phase alone.
  let best = null;
  for (const tr of tracks) {
    const fs = Object.keys(tr.at).map(Number).sort((a, b) => a - b);
    if (fs.length < 4) continue;
    const p0 = tr.at[fs[0]];
    const dist = f => Math.hypot(tr.at[f].x - p0.x, tr.at[f].y - p0.y);
    const departure = dist(fs[fs.length - 1]);
    const peak = Math.max(...fs.map(dist));
    if (peak < minMovePx) continue;            // static: a printed mark, or camera drift
    // Came back towards where it started => a swing, not a struck ball.
    if (departure < peak * 0.6) continue;
    if (!best || departure > best.departure) best = { tr, departure, first: fs[0], p0 };
  }
  if (!best) return { track: perFrame.map(() => null), tracks, spanPx: 0, found: false };

  // Recover the address phase. The ball's track starts the moment it moved, so
  // every frame before that is missing — but the ball was sitting still at the
  // track's own first position, which is exactly where to look for it. On a mat
  // with an aiming dot this re-adopts the dot, and that is correct: the ball was
  // on top of it.
  const track = perFrame.map((_, f) => best.tr.at[f] || null);
  for (let f = best.first - 1; f >= 0; f--) {
    let pick = null, bd = Infinity;
    for (const c of perFrame[f] || []) {
      const d = Math.hypot(c.x - best.p0.x, c.y - best.p0.y);
      if (d < bd) { bd = d; pick = c; }
    }
    if (pick && bd <= gatePx) track[f] = pick; else break;
  }
  return { track, tracks, spanPx: best.departure, found: true };
}

export const DEFAULTS = {
  detWidth: 640,          // detection raster width; drives angular precision
  // 0.80, not 0.55: a putting mat is often light grey, and at 0.55 a white ball
  // crossing a light band merges into it and vanishes. A golf ball is close to
  // pure white, so a high floor keeps it and drops the mat.
  ball: { vThr: 0.80, sThr: 0.30, minPx: 6, minFill: 0.45 },
  marker: { hue: 322, hueTol: 32, sMin: 0.40, vMin: 0.22, minPx: 5 },
  markerless: false,
  putter: { vMax: 0.34, minPx: 40, minElongation: 1.7 },
  // A face-edge fit whose residual scatter exceeds this many pixels is not
  // reading an edge. Measured on a real clip: every trustworthy frame came in
  // at 0.7–2.0 px and every bad one at 6.4–24.4, with nothing between — the
  // head is at peak speed just after impact and its leading edge smears.
  face: { rmsMax: 3 },
  // The mat's printed reference. Yellow by default because that is what the
  // common mats use; a mat with a white, black or red line needs this changed
  // or detectTargetLine returns null on every frame.
  line: { hue: 55, hueTol: 22 }
};

export function createTracker(cfg) {
  const { H, quad, matW, srcWidth, srcHeight } = cfg;
  const opt = {
    ...DEFAULTS, ...cfg.opt,
    ball: { ...DEFAULTS.ball, ...(cfg.opt?.ball) },
    marker: { ...DEFAULTS.marker, ...(cfg.opt?.marker) },
    putter: { ...DEFAULTS.putter, ...(cfg.opt?.putter) },
    face: { ...DEFAULTS.face, ...(cfg.opt?.face) },
    line: { ...DEFAULTS.line, ...(cfg.opt?.line) }
  };
  const scale = opt.detWidth / srcWidth;              // src px -> detection px
  const detW = opt.detWidth;
  const detH = Math.round(srcHeight * scale);

  // Top-down mode: the camera looks straight down, so the clip never shows the
  // mat's corners and there is nothing to tap. There is also no perspective to
  // undo — the mapping is a similarity, needing only a direction and a scale.
  // Both are already in the picture: the line printed down the mat gives
  // direction, the ball gives scale. Everything is therefore left in image
  // pixels during process() and converted in finish(), once the ball has been
  // resolved and the scale is known.
  const topDown = !!opt.topDown;
  const quadDet = topDown ? null : quad.map(p => ({ x: p.x * scale, y: p.y * scale }));
  const matBox = topDown
    ? { x0: 0, y0: 0, x1: detW - 1, y1: detH - 1 }
    : (() => {
        const xs = quadDet.map(p => p.x), ys = quadDet.map(p => p.y);
        return { x0: Math.min(...xs), x1: Math.max(...xs),
                 y0: Math.min(...ys), y1: Math.max(...ys) };
      })();
  // The putter head and its markers routinely sit outside the mat outline,
  // so give that search a generous margin. The ball never does.
  const pad = (matBox.x1 - matBox.x0) * 0.35;
  const putterBox = { x0: matBox.x0 - pad, x1: matBox.x1 + pad,
                      y0: matBox.y0 - pad * 0.4, y1: matBox.y1 + pad * 0.6 };

  const toMat = (dx, dy) => {
    const m = applyH(H, dx / scale, dy / scale);
    return { x: m.x - matW / 2, y: m.y };            // origin on the target line
  };

  let lastBall = null, ballVel = { x: 0, y: 0 }, ballMiss = 0, ballSize = 0;
  let lastMarkerBox = null, markerMiss = 0;
  const ballCands = [];          // per frame, for the end-of-clip resolve
  let lastLine = null;           // seeds a cheap banded search on the next frame

  // Running background, so "did this move?" is answerable per pixel. The mat and
  // everything printed on it hold still; the ball and the putter do not. Slow
  // decay on purpose: a ball parked at address for two hundred frames is
  // absorbed into the background, which is fine — it is found by appearance
  // there, and its address frames are back-filled from the track once resolved.

  // A search over the whole mat has nothing behind it but blob quality, so once
  // we know how big this ball actually is, hold any (re-)acquisition to that
  // size. ballSize deliberately OUTLIVES the `lastBall = null` miss reset: after
  // six misses the *primary* path becomes a full-mat search too, and a gate that
  // died with lastBall would let a static blemish be adopted one frame later —
  // which is exactly how a phantom lock survived to the end of a clip.
  const sizeOk = b => !ballSize || (b.n > ballSize * 0.4 && b.n < ballSize * 2.5);

  // ballSize above is learned from the first blob accepted, which begs the
  // question on frame 0: the whole-mat search has nothing but blob quality
  // behind it, and a light putter head beats the ball on every test detectBall
  // applies. So gate the FIRST acquisition on geometry instead — a golf ball is
  // 42.7 mm and the homography knows the mat scale, so its diameter in
  // detection pixels is known before anything is detected. Recomputed per ROI
  // because perspective makes the far end of the mat smaller.
  const BALL_MM = 42.7;
  const HEAD_MM = 110;        // a mallet head across the face, near enough
  // ACROSS-mat mm per pixel, never the along-mat figure. Shot from behind the
  // ball a 3 m mat is foreshortened ~10:1, so mm-per-px along the mat is huge
  // and says nothing about how big the ball looks — the ball is a sphere
  // sitting above the plane, and its apparent diameter follows the axis
  // perpendicular to the view, which is across the mat.
  const ballAreaAt = (dx, dy) => {
    const mmPerPx = Math.abs(toMat(dx + 1, dy).x - toMat(dx, dy).x);
    if (!(mmPerPx > 0)) return 0;
    const d = BALL_MM / mmPerPx;
    return Math.PI / 4 * d * d;
  };
  // Perspective makes the far end of the mat several times smaller than the
  // near end, so a whole-mat search has to admit that whole range; the
  // prediction-bounded ROI is small and gets a correspondingly tight window.
  // Slack beyond that covers motion blur (smears the disc) and a ball
  // half-occluded by the head or clipping the frame edge.
  const ballOptFor = roi => {
    // Bootstrap: the gate predicts the ball's size from the mat scale, so it is
    // only usable when that scale is real. If the mat was never measured the
    // predicted size is a guess, and gating on a guess throws away the actual
    // ball — leave the gate open and let the motion signature in
    // resolveBallTrack do the separating instead.
    if (topDown || opt.scaleKnown === false) return opt.ball;
    const areas = [[roi.x0, roi.y0], [roi.x1, roi.y0], [roi.x0, roi.y1], [roi.x1, roi.y1]]
      .map(([x, y]) => ballAreaAt(x, y)).filter(a => a > 0);
    if (!areas.length) return opt.ball;
    return { ...opt.ball, nMin: Math.min(...areas) * 0.3, nMax: Math.max(...areas) * 2.5 };
  };

  /**
   * Top-down: build mat coordinates from the printed line and the ball.
   *
   * Straight down means no perspective, so the map is a similarity — a
   * rotation and a uniform scale — and both parts are already in the picture.
   * The line fixes rotation and the lateral origin; the ball, being 42.7 mm
   * always, fixes scale. Nothing is measured or typed in by hand.
   *
   * The line is an orientation, not a direction, so which way is "away" is
   * settled by the ball itself: it is struck away from the golfer, so its
   * travel picks the sign.
   */
  function finishTopDown(frames, track, wPx, spanPx) {
    const lines = frames.map(f => f.raw && f.raw.line);
    const seen = track.map((c, i) => (c && lines[i]) ? i : -1).filter(i => i >= 0);
    if (!wPx || seen.length < 4) {
      for (const fr of frames) { fr.ball = null; fr.face = null; fr.head = null; }
      return { ballSpanPx: spanPx, ballWidthPx: wPx, topDown: true, ok: false,
               reason: !wPx ? 'the ball was never measured'
                            : 'the mat’s printed line was not found often enough' };
    }
    const mmPerPx = BALL_MM / wPx;
    const cx0 = detW / 2, cy0 = detH / 2;    // fixed along-mat origin, see toM
    let headFrames = 0;

    // Sign of "away": where the ball ended up, relative to where it started.
    const a = track[seen[0]], b = track[seen[seen.length - 1]];
    const travel = { x: b.x - a.x, y: b.y - a.y };

    let n = 0;
    frames.forEach((fr, i) => {
      const L = lines[i], c = track[i];
      if (!L) { fr.ball = null; fr.face = null; fr.head = null; return; }
      let ux = Math.cos(L.rad), uy = Math.sin(L.rad);
      // Remember whether the line's raw direction had to be flipped: the two
      // edge fits were made against the RAW direction, so this is what says
      // which of them faces the target.
      const flipped = travel.x * ux + travel.y * uy < 0;
      if (flipped) { ux = -ux; uy = -uy; }
      // Image y runs DOWN, so the golfer's right is u turned +90° on screen.
      const rx = -uy, ry = ux;
      // Two different origins, on purpose.
      //
      // ACROSS the mat, the line itself is the origin — that is the whole point
      // of finding it, and perpendicular distance to a line is well defined no
      // matter which part of it is visible.
      //
      // ALONG the mat it is NOT: a line has no features along its length, so
      // the detected centroid slides as the ball and putter occlude different
      // segments, and using it moved the origin frame to frame. That put impact
      // at 0.37 s on a clip where the ball is plainly still until 1.04 s. So
      // measure the along-mat axis from a fixed image point instead. Camera
      // drift along the line then leaks into distance and speed, but not into
      // any angle — and angles are what this reference exists to protect.
      const toM = p => ({
        x: ((p.x - L.x) * rx + (p.y - L.y) * ry) * mmPerPx,   // across, + right
        y: ((p.x - cx0) * ux + (p.y - cy0) * uy) * mmPerPx     // down the mat, + away
      });
      fr.ball = c ? toM(c) : null;

      // Pick the head among the big blobs by SIZE: a putter head is ~110 mm
      // across and the ball is 42.7, so at a known scale they are never
      // confusable. Then carry its fitted face edge into mat coordinates as two
      // points, which is the form analyseStroke expects.
      const cands = (fr.raw && fr.raw.faceCands) || [];
      const wantPx = HEAD_MM / mmPerPx;
      const head = cands
        .filter(q => q.w >= wantPx * 0.55 && q.w <= wantPx * 1.7)
        .sort((p, q) => Math.abs(p.w - wantPx) - Math.abs(q.w - wantPx))[0];
      // The face is the boundary pointing where the ball goes: +u is "away", so
      // the fit made toward +u is the front of the head.
      let edge = head && (flipped ? head.minus : head.plus);
      // Drop a smeared edge rather than average it in: post-impact frames read
      // tens of degrees out and dragged the face angle from ~0° to -13°.
      if (edge && edge.rms > (opt.face?.rmsMax ?? 3)) edge = null;
      if (head && edge) {
        const L2 = 20;
        const hx = Math.cos(edge.rad) * L2, hy = Math.sin(edge.rad) * L2;
        fr.face = { a: toM({ x: edge.x - hx, y: edge.y - hy }),
                    b: toM({ x: edge.x + hx, y: edge.y + hy }) };
        fr.head = toM({ x: head.cx, y: head.cy });
        fr.faceRms = edge.rms;
        headFrames++;
      } else if (!opt.markerless && fr.raw && fr.raw.faceImg) {
        // Stickers ONLY. Top-down + markers otherwise produced no face, path,
        // face-to-path or tempo at all — silently, and markers is the DEFAULT
        // face mode, so switching only the calibration landed here.
        //
        // The !markerless guard is load-bearing: the markerless branch also
        // writes faceImg, from the head blob's principal axis. Without it every
        // frame the rms gate rightly rejected fell through to exactly the
        // ill-conditioned estimate the edge fit exists to replace — which took
        // face from +1.06° to -29° and doubled the arc span.
        const fi = fr.raw.faceImg;
        fr.face = { a: toM(fi.a), b: toM(fi.b) };
        fr.head = { x: (fr.face.a.x + fr.face.b.x) / 2,
                    y: (fr.face.a.y + fr.face.b.y) / 2 };
        headFrames++;
      } else { fr.face = null; fr.head = null; }
      if (fr.ball) n++;
    });

    return { ballSpanPx: spanPx, ballWidthPx: wPx, topDown: true, ok: true,
             mmPerPx, ballFrames: n, headFrames, lineFrames: lines.filter(Boolean).length,
             matWidthMm: detW * mmPerPx };
  }

  return {
    detW, detH, scale, matBox, putterBox,

    /** @param px Uint8ClampedArray RGBA at detW×detH */
    /**
     * @param linePx  optional higher-resolution raster { data, width, height }
     *   for finding the mat's printed line. The CV raster is sized for speed,
     *   and on a 1920-wide clip that is a 3x downscale which BLENDS a thin
     *   printed line into the mat — measured on a real clip: 161 surviving
     *   yellow pixels at 640 wide and no blob large enough to fit, against
     *   2594 at full size. Detection width therefore decided whether top-down
     *   worked at all. Keep the heavy work at detW and look for the line here.
     */
    process(px, t, linePx, motionCands) {
      const out = { t, ball: null, face: null, head: null, raw: {} };

      // The mat's own printed reference, re-found every frame. A tap is frozen
      // at the moment it was made, so a handheld camera drifting through the
      // clip silently invalidates it — measured at ~1.15° of rotation over 10 s
      // on a real clip, against 0.005° of frame-to-frame noise here. Finding it
      // per frame means impact is measured against the line AS IT IS at impact.
      if (topDown) {
        if (linePx && linePx.width && linePx.width !== detW) {
          const lw = linePx.width, lh = linePx.height;
          // Search a band around where the line was last seen, not the whole
          // raster. Scanning every pixel of a 1280-wide frame 371 times is 340
          // million colour conversions and as many megabytes of scratch array —
          // it locked the page for minutes. The line only drifts as far as the
          // camera does, which was 20 px over a whole clip, so a band is both
          // far cheaper and no less correct.
          let lroi = { x0: 0, y0: 0, x1: lw - 1, y1: lh - 1 };
          if (lastLine) {
            const B = 70;
            const ux = Math.cos(lastLine.rad), uy = Math.sin(lastLine.rad);
            // Band perpendicular to the line, spanning its full length.
            const hx = Math.abs(uy) * B + Math.abs(ux) * lw;
            const hy = Math.abs(ux) * B + Math.abs(uy) * lh;
            lroi = { x0: Math.max(0, lastLine.x - hx), x1: Math.min(lw - 1, lastLine.x + hx),
                     y0: Math.max(0, lastLine.y - hy), y1: Math.min(lh - 1, lastLine.y + hy) };
          }
          let L = detectTargetLine(linePx.data, lw, lh, lroi, opt.line);
          if (!L && lastLine) L = detectTargetLine(linePx.data, lw, lh,
            { x0: 0, y0: 0, x1: lw - 1, y1: lh - 1 }, opt.line);
          if (L) lastLine = L;
          // Uniform scale back to detection pixels: positions scale, angle does not.
          const k = detW / lw;
          out.raw.line = L ? { ...L, x: L.x * k, y: L.y * k } : null;
        } else {
          out.raw.line = detectTargetLine(px, detW, detH, matBox, opt.line);
        }
      }

      /* ---------------- ball ---------------- */
      let roi = matBox, predicted = false;
      if (lastBall) {
        const r = 22 + Math.hypot(ballVel.x, ballVel.y) * 1.7;
        roi = { x0: lastBall.x + ballVel.x - r, x1: lastBall.x + ballVel.x + r,
                y0: lastBall.y + ballVel.y - r, y1: lastBall.y + ballVel.y + r };
        predicted = true;
      }
      // Every ball-shaped candidate over the whole mat, banked for resolveBallTrack()
      // to arbitrate at the end. The per-frame pick below still runs so that
      // process() keeps returning a usable observation on its own.
      // matBox is the axis-aligned BOUNDING BOX of the quad, so for any
      // perspective trapezoid it includes wedges of floor outside the mat. Cut
      // those here, before resolveBallTrack scores departures — a bright shoe or
      // ball-marker out there can otherwise win the track outright, and the
      // later pointInQuad only nulls it frame by frame, by which point the real
      // ball's track has already been discarded.
      // Appearance first, unchanged — it is what works when the ball is parked
      // on a dark band. Motion candidates are then ADDED, not merged into the
      // mask: widening the mask let moving shadows and feet join up with the
      // ball and swallow it, taking a clip that tracked 288 frames down to 25.
      // As separate candidates they can only ever rescue a ball that appearance
      // missed, never take one away.
      const seen0 = detectBallCandidates(px, detW, detH, matBox, ballOptFor(matBox));
      const extra = (motionCands || []).filter(m =>
        !seen0.some(c => Math.hypot(c.x - m.x, c.y - m.y) < 12));
      const cands = [...seen0, ...extra]
        .filter(c => !quadDet || pointInQuad({ x: c.x, y: c.y }, quadDet));
      ballCands.push(cands);

      // Fit a face line to every candidate big enough to be a head, while the
      // pixels are still here — finish() only sees results, not the frame. The
      // ball's rough position is a good enough "which side" hint: only the
      // DIRECTION matters and the face is a wide target.
      if (topDown && opt.markerless && out.raw.line) {
        // Fit BOTH boundaries, along and against the mat line, and let finish()
        // take the one facing the target once the ball's travel has settled
        // which way that is. Picking here with the nearest small blob as the
        // hint is unreliable — that blob is sometimes a dot printed off to the
        // side, which fits the head's SIDE edge and reads tens of degrees out.
        const L = out.raw.line;
        const lux = Math.cos(L.rad), luy = Math.sin(L.rad);
        // Scale the "big enough to be a head" bar with the raster: 2500 px is a
        // 640-wide figure, and at the 320 setting a mallet images ~1050 px, so a
        // fixed bar silently yields no face for the whole clip.
        const bigPx = 2500 * (detW / 640) * (detW / 640);
        out.raw.faceCands = cands.filter(c => c.n >= bigPx).slice(0, 3).map(c => {
          const roi = { x0: c.x - c.w, y0: c.y - c.h, x1: c.x + c.w, y1: c.y + c.h };
          const fitTo = (sx, sy) => {
            const e = detectFaceEdge(px, detW, detH, roi, { x: c.x, y: c.y },
                                     { x: c.x + sx * 100, y: c.y + sy * 100 }, opt.face);
            return e ? { deg: e.deg, rad: e.rad, x: e.x, y: e.y, rms: e.rms } : null;
          };
          const plus = fitTo(lux, luy), minus = fitTo(-lux, -luy);
          return (plus || minus)
            ? { plus, minus, cx: c.x, cy: c.y, n: c.n, w: c.w, h: c.h }
            : null;
        }).filter(Boolean);
      }

      let b = detectBall(px, detW, detH, roi, ballOptFor(roi));
      if (!b && predicted) { b = detectBall(px, detW, detH, matBox, ballOptFor(matBox)); predicted = false; }
      // Only the prediction-bounded hit is trusted on size alone — the ball may be
      // clipping the frame edge or half-occluded by the head, and there it is
      // already pinned in space by where it was last frame.
      if (b && !predicted && !sizeOk(b)) b = null;
      if (b && quadDet && !pointInQuad({ x: b.x, y: b.y }, quadDet)) b = null;
      if (b) {
        if (lastBall) ballVel = { x: b.x - lastBall.x, y: b.y - lastBall.y };
        ballSize = ballSize ? ballSize * 0.8 + b.n * 0.2 : b.n;
        lastBall = b; ballMiss = 0;
        if (!topDown) out.ball = toMat(b.x, b.y);
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
          out.raw.faceImg = { a, b: c };            // pixels; finish() maps them
          if (!topDown) {
            out.face = { a: toMat(a.x, a.y), b: toMat(c.x, c.y) };
            out.head = toMat(blob.x, blob.y);
          }
          out.raw.putter = blob;
          lastMarkerBox = { x0: blob.bbox.minx, x1: blob.bbox.maxx,
                            y0: blob.bbox.miny, y1: blob.bbox.maxy };
          markerMiss = 0;
        } else if (++markerMiss > 4) lastMarkerBox = null;
      } else {
        let m = detectMarkers(px, detW, detH, pRoi, opt.marker);
        if (!m && lastMarkerBox) m = detectMarkers(px, detW, detH, putterBox, opt.marker);
        if (m) {
          out.raw.faceImg = { a: m.a, b: m.b };     // pixels; finish() maps them
          if (!topDown) {
            const A = toMat(m.a.x, m.a.y), B = toMat(m.b.x, m.b.y);
            out.face = { a: A, b: B };
            out.head = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
          }
          out.raw.markers = m;
          lastMarkerBox = {
            x0: Math.min(m.a.x, m.b.x), x1: Math.max(m.a.x, m.b.x),
            y0: Math.min(m.a.y, m.b.y), y1: Math.max(m.a.y, m.b.y)
          };
          markerMiss = 0;
        } else if (++markerMiss > 4) lastMarkerBox = null;
      }

      return out;
    },

    /**
     * Second thoughts, once the whole clip has been seen.
     *
     * process() has to commit to a ball every frame, and on frame 0 it has
     * nothing but blob quality to go on — which is exactly how a printed target
     * circle got tracked for an entire clip. Now that every candidate has been
     * banked, pick the one that moved and rewrite the ball series in place.
     * Angles and impact are then measured on the real ball.
     *
     * Also returns the ball's apparent size, which is the scale reference: a
     * golf ball is 42.7 mm, so its width in pixels is a ruler the user does not
     * have to measure or type in.
     */
    /**
     * @param opt.scaleFromBall  derive absolute scale from the ball's apparent
     *   width instead of trusting the declared mat size. Only for when the mat
     *   was never measured: a ball is ~30 px across at detection width, so one
     *   pixel of edge uncertainty is ~3% of scale, and a typed-in tape measure
     *   beats it. Angles are identical either way.
     */
    finish(frames, opt2 = {}) {
      // A struck ball crosses a good fraction of the mat; a printed mark moves
      // only as far as the camera drifts, which on a handheld clip is real but
      // small. Scale the bar to the mat so it means the same thing at any zoom.
      const diag = Math.hypot(matBox.x1 - matBox.x0, matBox.y1 - matBox.y0);
      const { track, spanPx, found } = resolveBallTrack(ballCands, 26, diag * 0.06);
      // No track qualified — the ball left within a few frames of being struck,
      // or it never travelled the 6%-of-mat bar. Rewriting anyway would null
      // every frame and throw away the per-frame series that process() already
      // built, turning a partial result into "the ball was tracked in 0 frames".
      // Keep what we had; the resolve is an improvement, not a precondition.
      if (!found && !topDown) {
        return { ballSpanPx: 0, ballWidthPx: 0, scaleK: 1, scaleFromBall: false,
                 matWidthMm: matW, resolved: false,
                 candidateCount: ballCands.reduce((s, c) => s + (c ? c.length : 0), 0) };
      }
      if (!found && topDown) {
        for (const fr of frames) { fr.ball = null; fr.face = null; fr.head = null; }
        return { topDown: true, ok: false, resolved: false,
                 reason: 'no ball-shaped blob travelled far enough to be a struck ball' };
      }
      const widths = [];
      let sx = 0, sy = 0, sn = 0;
      frames.forEach((fr, i) => {
        const c = track[i];
        if (!c || (quadDet && !pointInQuad({ x: c.x, y: c.y }, quadDet))) { fr.ball = null; return; }
        if (!topDown) fr.ball = toMat(c.x, c.y);
        fr.raw = fr.raw || {};
        fr.raw.ball = c;
        // min(w,h): motion blur stretches one axis of the bounding box but
        // leaves the other at the true diameter.
        if (c.w && c.h) { widths.push(Math.min(c.w, c.h)); sx += c.x; sy += c.y; sn++; }
      });

      // THE BALL IS THE RULER. A golf ball is 42.7 mm, always. Its width in
      // pixels therefore fixes the absolute scale, so the mat's real size never
      // has to be measured or typed in — the homography is built at a nominal
      // width and the whole thing is rescaled here. Scaling matW and matL
      // together is a uniform scale of mat coordinates, so every angle is
      // untouched and only distances move.
      widths.sort((a, b) => a - b);
      const wPx = widths.length ? widths[widths.length >> 1] : 0;

      if (topDown) return finishTopDown(frames, track, wPx, spanPx);

      let scaleK = 1, impliedMm = 0;
      if (opt2.scaleFromBall && wPx > 0 && sn) {
        const cx = sx / sn, cy = sy / sn;
        const mmPerPx = Math.abs(toMat(cx + 1, cy).x - toMat(cx, cy).x);
        impliedMm = wPx * mmPerPx;
        // A correction this far out means the ball width is not a ball width;
        // leave the nominal scale alone rather than invent a number.
        if (impliedMm > 0) {
          const k = BALL_MM / impliedMm;
          if (k > 0.15 && k < 8) scaleK = k;
        }
      }
      if (scaleK !== 1) {
        for (const fr of frames) {
          if (fr.ball) { fr.ball.x *= scaleK; fr.ball.y *= scaleK; }
          if (fr.head) { fr.head.x *= scaleK; fr.head.y *= scaleK; }
          if (fr.face) {
            fr.face.a.x *= scaleK; fr.face.a.y *= scaleK;
            fr.face.b.x *= scaleK; fr.face.b.y *= scaleK;
          }
        }
      }
      return {
        ballSpanPx: spanPx,
        ballWidthPx: wPx,
        scaleK,
        scaleFromBall: scaleK !== 1,
        matWidthMm: matW * scaleK,
        candidateCount: ballCands.reduce((s, c) => s + (c ? c.length : 0), 0)
      };
    }
  };
}
