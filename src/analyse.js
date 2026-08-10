/* =====================================================================
   Stroke metrics from a per-frame observation series.

   Input: frames[] = { t, ball:{x,y}|null, face:{a,b}|null, head:{x,y}|null }
   all in mat millimetres, t in seconds.

   The central trick here is sub-frame resolution. Even at 240 fps a frame
   is 4.2 ms, and the face rotates ~0.17° in that time. Rather than take
   "the nearest frame to impact", we:
     - solve for the impact INSTANT by extrapolating the ball's motion back
       to where it started (its own rest position), and
     - evaluate a local quadratic fit of face angle at that instant.
   That recovers well under a frame's worth of angle.
   ===================================================================== */

import { linreg, quadfit, fitStartLine, fitSpeed, bearingDeg, faceAngleFromVector,
         foldFaceAngle, unwrapAngles } from './geom.js';

const DEG = 180 / Math.PI;

/** Where and when the ball left. Returns sub-frame impact time. */
export function findImpact(frames, moveThreshMm = 4) {
  const obs = frames.filter(f => f.ball);
  if (obs.length < 6) return null;

  // Rest position: median of the first quarter of ball sightings, before
  // anything moves. Median not mean — one bad detection shouldn't shift it.
  const head = obs.slice(0, Math.max(3, Math.floor(obs.length / 4)));
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
  const rest = { x: med(head.map(o => o.ball.x)), y: med(head.map(o => o.ball.y)) };

  let iMove = -1;
  for (let i = 0; i < obs.length; i++) {
    if (Math.hypot(obs[i].ball.x - rest.x, obs[i].ball.y - rest.y) > moveThreshMm) { iMove = i; break; }
  }
  if (iMove < 1) return null;

  // Fit distance-from-rest vs time over the clean rolling segment, then
  // solve d(t) = 0. That intercept is the launch instant, sub-frame.
  const seg = [];
  for (let i = iMove; i < obs.length && seg.length < 24; i++) {
    const d = Math.hypot(obs[i].ball.x - rest.x, obs[i].ball.y - rest.y);
    seg.push({ x: obs[i].t, y: d });
  }
  if (seg.length < 4) return null;
  const r = linreg(seg);
  if (!r || Math.abs(r.b) < 1e-6) return null;
  const tImpact = -r.a / r.b;

  return { t: tImpact, rest, iMove, launchSpeed: r.b / 1000, rms: r.rms };
}

/** Collect the unwrapped face-angle series inside a window around `tAt`. */
function faceWindow(frames, tAt, halfWindowSec) {
  const pts = [];
  for (const f of frames) {
    if (!f.face) continue;
    if (Math.abs(f.t - tAt) > halfWindowSec) continue;
    pts.push({ t: f.t, ang: faceAngleFromVector(f.face.b.x - f.face.a.x, f.face.b.y - f.face.a.y) });
  }
  pts.sort((a, b) => a.t - b.t);
  const un = unwrapAngles(pts.map(p => foldFaceAngle(p.ang)));
  return pts.map((p, i) => ({ x: p.t - tAt, y: un[i] }));
}

/**
 * Face angle at an instant, plus its rate of rotation.
 *
 * The angle and the rate want different windows. The ANGLE wants a short
 * one — the face is genuinely rotating, so a wide window is a biased model.
 * The RATE wants a wide one: it's a slope, so its uncertainty falls as
 * σ/(spread·√n), and over ±60 ms the true curve is still linear to well
 * under 1%. Using one window for both makes the rate needlessly noisy.
 */
export function faceAngleAt(frames, tAt, halfWindowSec, rateHalfWindowSec = halfWindowSec * 2) {
  const near = faceWindow(frames, tAt, halfWindowSec);
  if (near.length < 3) return null;
  const fit = quadfit(near);
  if (!fit) return null;

  let rate = fit.slopeAt(0), rateSE = null;
  const wide = faceWindow(frames, tAt, rateHalfWindowSec);
  if (wide.length >= 6) {
    const wf = quadfit(wide);
    if (wf) {
      rate = wf.slopeAt(0);
      // SE of the linear term ≈ σ / (sd(x)·√n) — worth surfacing, because a
      // rotation rate quoted without one invites over-reading.
      const mx = wide.reduce((a, p) => a + p.x, 0) / wide.length;
      const sd = Math.sqrt(wide.reduce((a, p) => a + (p.x - mx) ** 2, 0) / wide.length);
      if (sd > 0) rateSE = wf.rms / (sd * Math.sqrt(wide.length));
    }
  }

  return {
    deg: foldFaceAngle(fit.at(0)),
    rateDegPerSec: rate,
    rateSE,
    n: fit.n,
    rateN: wide.length,
    rms: fit.rms
  };
}

/** Putter head direction of travel at an instant (the "path"). */
export function pathAngleAt(frames, tAt, halfWindowSec) {
  const pts = frames.filter(f => f.head && Math.abs(f.t - tAt) <= halfWindowSec);
  if (pts.length < 4) return null;
  const fx = quadfit(pts.map(f => ({ x: f.t - tAt, y: f.head.x })));
  const fy = quadfit(pts.map(f => ({ x: f.t - tAt, y: f.head.y })));
  if (!fx || !fy) return null;
  const vx = fx.slopeAt(0), vy = fy.slopeAt(0);
  if (Math.hypot(vx, vy) < 1e-6) return null;
  return { deg: bearingDeg(vx, vy), speed: Math.hypot(vx, vy) / 1000, rms: (fx.rms + fy.rms) / 2 };
}

/**
 * Backswing / downswing timing and stroke lengths.
 *
 * TAKEAWAY_FRACTION is a definition, not a measurement. A pendulum stroke
 * leaves address asymptotically, so "when did the takeaway start" has no
 * physical answer — you have to pick a threshold. We use the first moment
 * the head exceeds 5% of its peak backswing speed, and say so, because a
 * tempo ratio quoted without its threshold is not comparable to anyone
 * else's.
 */
export const TAKEAWAY_FRACTION = 0.05;

/** Population mean/SD over a putt history, null-safe. Session dispersion (the tile
 *  readouts and the dispersion chart) both need this — it's a metric, so it lives here,
 *  not in app.js or charts.js. */
export function sessionStats(vals) {
  const v = vals.filter(x => x != null && isFinite(x));
  if (v.length < 2) return { mean: v[0] ?? null, sd: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { mean, sd };
}

export function tempoAndLength(frames, tImpact) {
  const obs = frames.filter(f => f.head);
  if (obs.length < 12) return null;
  const s = obs.map(f => f.head.y);                 // along the target line
  const t = obs.map(f => f.t);
  const s0 = s[0];

  // Local-linear (Savitzky-Golay style) velocity. A raw central difference
  // amplifies pixel noise; fitting a line over a small window does not.
  const HALF = 5;
  const v = new Array(obs.length).fill(0);
  for (let i = 0; i < obs.length; i++) {
    const lo = Math.max(0, i - HALF), hi = Math.min(obs.length - 1, i + HALF);
    const seg = [];
    for (let k = lo; k <= hi; k++) seg.push({ x: t[k], y: s[k] });
    const r = linreg(seg);
    if (r) v[i] = r.b;
  }

  // Coarse top, then refine. The backswing top is a FLAT minimum: with
  // ~0.5 mm of position noise, argmin alone is uncertain by ±20 ms, which
  // is a 7% tempo error on its own. Fit a parabola and take its vertex.
  let iTop = 0;
  for (let i = 0; i < obs.length; i++) {
    if (t[i] > tImpact) break;
    if (s[i] < s[iTop]) iTop = i;
  }
  if (iTop < 3) return null;

  let tTop = t[iTop], sTop = s[iTop];
  {
    const win = 0.040;
    const seg = [];
    for (let i = 0; i < obs.length; i++) {
      if (Math.abs(t[i] - t[iTop]) <= win) seg.push({ x: t[i] - t[iTop], y: s[i] });
    }
    const q = seg.length >= 5 ? quadfit(seg) : null;
    if (q && q.c > 0) {                       // opens upward => real minimum
      const dx = -q.b / (2 * q.c);
      if (Math.abs(dx) <= win) { tTop = t[iTop] + dx; sTop = q.at(dx); }
    }
  }

  // Takeaway: first crossing of 5% of peak backswing speed, interpolated
  // between the bracketing samples rather than snapped to a frame.
  let peakBack = 0;
  for (let i = 0; i <= iTop; i++) peakBack = Math.max(peakBack, -v[i]);
  if (peakBack <= 0) return null;
  const thr = TAKEAWAY_FRACTION * peakBack;
  let tStart = t[0];
  for (let i = 1; i <= iTop; i++) {
    if (-v[i] > thr) {
      const a = -v[i - 1], b = -v[i];
      const frac = b > a ? (thr - a) / (b - a) : 0;
      tStart = t[i - 1] + (t[i] - t[i - 1]) * Math.min(1, Math.max(0, frac));
      break;
    }
  }

  let sMax = -Infinity;
  for (let i = 0; i < obs.length; i++) if (t[i] > tImpact && s[i] > sMax) sMax = s[i];

  const back = tTop - tStart;
  const fwd = tImpact - tTop;
  if (!(back > 0) || !(fwd > 0)) return null;

  return {
    backSec: back, fwdSec: fwd, ratio: back / fwd,
    backLenMm: s0 - sTop,
    throughLenMm: isFinite(sMax) ? sMax - s0 : null,
    tTop, tStart
  };
}

/** Full analysis. `frames` are already in mat coordinates. */
export function analyseStroke(frames, opt = {}) {
  const { startWindowMm = 300, faceWindowSec = 0.030, markerless = false } = opt;
  const out = { warnings: [] };

  const dts = [];
  for (let i = 1; i < frames.length; i++) dts.push(frames[i].t - frames[i - 1].t);
  dts.sort((a, b) => a - b);
  const medDt = dts.length ? dts[dts.length >> 1] : null;
  out.fps = medDt ? 1 / medDt : null;
  out.frameCount = frames.length;
  out.faceFrames = frames.filter(f => f.face).length;
  out.ballFrames = frames.filter(f => f.ball).length;

  /* ---- ball: start line + speed ---- */
  const impact = findImpact(frames);
  if (impact) {
    out.impactTime = impact.t;
    const rolling = frames
      .filter(f => f.ball && f.t >= impact.t)
      .map(f => ({ x: f.ball.x - impact.rest.x, y: f.ball.y - impact.rest.y, t: f.t }));
    if (rolling.length >= 4) {
      const sl = fitStartLine(rolling, startWindowMm);
      if (sl) {
        out.startLineDeg = sl.angleDeg;
        out.startLineFrames = sl.n;
        out.startLineRmsMm = sl.rms;
        out.missAt3mCm = 3000 * Math.tan(sl.angleDeg / DEG) / 10;
      }
      out.ballSpeed = fitSpeed(rolling, startWindowMm);
    }
  } else {
    out.warnings.push('Could not find the moment of impact — the ball was never tracked moving.');
  }

  /* ---- putter: face, path, face-to-path ---- */
  if (out.impactTime != null) {
    const face = faceAngleAt(frames, out.impactTime, faceWindowSec);
    const path = pathAngleAt(frames, out.impactTime, faceWindowSec);
    if (face) {
      out.faceDeg = face.deg;
      out.faceRateDegPerSec = face.rateDegPerSec;
      out.faceRateSE = face.rateSE;
      out.faceFitFrames = face.n;
      out.faceFitRmsDeg = face.rms;
      // What one frame of rotation costs you at various capture rates —
      // this is the number that decides whether the web can do this at all.
      out.blurPerFrame = {
        at60: Math.abs(face.rateDegPerSec) / 60,
        at120: Math.abs(face.rateDegPerSec) / 120,
        at240: Math.abs(face.rateDegPerSec) / 240
      };
    }
    if (path) { out.pathDeg = path.deg; out.headSpeed = path.speed; }
    if (face && path) out.faceToPathDeg = face.deg - path.deg;

    // Cross-check: for a putt, the ball starts very close to the face angle
    // (low loft, negligible gear effect). Big disagreement means a bad
    // calibration or a mistracked marker — not a swing insight.
    if (face && out.startLineDeg != null) {
      out.facePredictionErrorDeg = out.startLineDeg - face.deg;
      if (Math.abs(out.facePredictionErrorDeg) > 2.5) {
        out.warnings.push(
          `Ball started ${out.facePredictionErrorDeg.toFixed(1)}° away from the measured face angle. ` +
          `For a putt those should nearly agree — check the mat corners and the marker detection.`);
      }
    }
    if (markerless) {
      out.warnings.push('Markerless mode: face angle is approximate (±1–2°). Use stickers for a real number.');
    }
  }

  /* ---- tempo ---- */
  if (out.impactTime != null) {
    const tempo = tempoAndLength(frames, out.impactTime);
    if (tempo) {
      out.tempoRatio = tempo.ratio;
      out.backSec = tempo.backSec; out.fwdSec = tempo.fwdSec;
      out.backLenMm = tempo.backLenMm; out.throughLenMm = tempo.throughLenMm;
      out.tTop = tempo.tTop; out.tStart = tempo.tStart;
    }
  }

  /* ---- series for charts ---- */
  out.faceSeries = (() => {
    const pts = frames.filter(f => f.face)
      .map(f => ({ t: f.t, ang: faceAngleFromVector(f.face.b.x - f.face.a.x, f.face.b.y - f.face.a.y) }));
    if (!pts.length) return [];
    const un = unwrapAngles(pts.map(p => foldFaceAngle(p.ang)));
    return pts.map((p, i) => ({ t: p.t, deg: un[i] }));
  })();
  out.headPath = frames.filter(f => f.head).map(f => ({ x: f.head.x, y: f.head.y, t: f.t }));
  out.ballPath = frames.filter(f => f.ball).map(f => ({ x: f.ball.x, y: f.ball.y, t: f.t }));

  /* ---- data-quality warnings ---- */
  if (out.fps && out.fps < 100 && out.faceDeg != null) {
    out.warnings.push(
      `Only ${out.fps.toFixed(0)} fps. The face rotates ${(out.blurPerFrame?.at60 || 0).toFixed(2)}° ` +
      `per frame at this rate — face angle here is indicative, not a measurement. Shoot at 240.`);
  }
  if (out.faceFrames && out.faceFrames < out.frameCount * 0.5) {
    out.warnings.push(`Markers were only found in ${out.faceFrames} of ${out.frameCount} frames.`);
  }
  return out;
}
