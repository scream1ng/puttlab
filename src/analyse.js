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

// Beyond this, face angle and ball start line cannot both describe the same
// putt — the pipeline is measuring the wrong object, not a bad stroke.
//
// 8°, not 20°: a putt starts within about 85–90% of where the face points, so
// with any real face angle the two agree to a few degrees. 20° let a 13°
// disagreement through as if it were a stroke fault, when the start line — the
// better-measured of the two — plainly said otherwise.
const IMPLAUSIBLE_FACE_ERR_DEG = 8;

/** Where and when the ball left. Returns { t, rest, iMove, launchSpeed, rms } on
    success, or { t: null, reason } — the caller surfaces the reason, so a
    failure has to say which of its several causes actually fired. */
export function findImpact(frames, moveThreshMm = 4) {
  const obs = frames.filter(f => f.ball);
  if (obs.length < 6) {
    return { t: null, reason: `The ball was tracked in only ${obs.length} frames — too few to find impact.` };
  }
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };

  // Rest is the median of the EARLIEST run of near-stationary sightings.
  //
  // Not the first quarter: on a clip trimmed close to impact the ball leaves
  // within a few frames and is stopped again well inside that quarter, so the
  // median lands between the two positions and frame 0 is already "moving" —
  // which reads as "the ball never moved" and loses the stroke entirely.
  //
  // Not the longest run either: once the ball stops it stays stopped for far
  // longer than it ever sat at address.
  const STILL_MM = moveThreshMm / 4;
  const MIN_RUN = 3;
  let rest = null, restStart = -1, restEnd = -1;
  for (let i = 0; i < obs.length && !rest;) {
    let j = i + 1;
    while (j < obs.length &&
           Math.hypot(obs[j].ball.x - obs[j - 1].ball.x,
                      obs[j].ball.y - obs[j - 1].ball.y) <= STILL_MM) j++;
    if (j - i >= MIN_RUN) {
      // The TAIL of the address period, not all of it. A handheld camera drifts,
      // and on a real clip that drift came to ~30 mm over the address — six
      // times the movement threshold — so a median over the whole run sat far
      // from where the ball actually was when it was struck. The last frames
      // before impact are the ones that describe the strike.
      const run = obs.slice(Math.max(i, j - 15), j);
      rest = { x: med(run.map(o => o.ball.x)), y: med(run.map(o => o.ball.y)) };
      restStart = i;
      restEnd = j;
    }
    i = j;
  }
  if (!rest) {
    return { t: null, reason: 'The ball is never still — no run of frames with it at rest, ' +
                              'so there is no address position to measure the strike from. ' +
                              'Start the clip before the stroke.' };
  }

  // Scale the movement bar to how steady the tracking actually is.
  //
  // 4 mm assumes a rock-steady clip. Real footage is not: the mat line anchors
  // the across-mat axis to ~1.5 mm, but nothing anchors the along-mat axis
  // except the camera itself, and residual pan left ~5 mm of wander while the
  // ball sat at address. A fixed 4 mm bar then fired 130 frames before the
  // strike. Measured against the address run's own scatter the strike is
  // unmistakable — it is 279 mm — and the answer stops depending on the
  // constant: 10, 20, 40 and 80 mm all put impact within 1 ms of each other.
  // Measured over the whole ADDRESS — not over the still run, which is not the
  // same thing. The run ends at the first frame that jitters more than a
  // millimetre, so on real footage it is three to five frames long while the
  // ball actually sits there for two hundred. Five frames is too small a sample
  // to say anything about scatter, and both ways of getting it wrong are live:
  // start at frame 0 and a tracker that jumped 177 mm before settling puts the
  // bar at 885 mm, so nothing in the clip ever counts as movement; start at the
  // run and the bar falls to the 4 mm floor, which is under the ball's own
  // jitter, and the strike is "found" 180 frames early.
  //
  // So bound the address by the departure instead. At a quarter of the ball's
  // total travel there is no ambiguity — that is 65 mm against jitter of 5.
  //
  // And take a PERCENTILE, not the maximum. The address here runs 0.3 to 4.4 mm
  // for 240 frames with a single 64 mm outlier in it; a max is that one frame,
  // and the bar it sets misses the strike entirely. At the 95th percentile the
  // answer stops depending on the constant, which is the property the bar needs:
  // three times the scatter and five times it both land on the same frame.
  let maxTravel = 0;
  for (const o of obs) {
    maxTravel = Math.max(maxTravel, Math.hypot(o.ball.x - rest.x, o.ball.y - rest.y));
  }
  let iDepart = obs.length;
  for (let i = restStart; i < obs.length; i++) {
    if (Math.hypot(obs[i].ball.x - rest.x, obs[i].ball.y - rest.y) > 0.25 * maxTravel) {
      iDepart = i; break;
    }
  }
  const addr = [];
  for (let i = restStart; i < iDepart; i++) {
    addr.push(Math.hypot(obs[i].ball.x - rest.x, obs[i].ball.y - rest.y));
  }
  addr.sort((a, b) => a - b);
  // Below a real sample, fall back to the fixed threshold. On a clip trimmed to
  // start four frames before the stroke there is no address to measure: the
  // handful of frames before departure are already moving, their 95th percentile
  // is 56 mm, and five times that is a 283 mm bar the ball never crosses — the
  // stroke is thrown away for lack of a stroke.
  const MIN_ADDRESS = 10;
  const noise = addr.length >= MIN_ADDRESS
    ? addr[Math.min(addr.length - 1, Math.floor(0.95 * addr.length))]
    : 0;
  // And never set a bar the departure cannot clear, whatever the scatter says.
  const moveBar = Math.min(Math.max(moveThreshMm, noise * 5),
                           Math.max(moveThreshMm, 0.25 * maxTravel));

  // Search from the END of the address run. Starting at its beginning means a
  // camera that drifted during the address can put frame 0 over the threshold
  // on its own, which reads as "already moving" and throws the stroke away.
  let iMove = -1;
  for (let i = Math.max(1, restEnd - 1); i < obs.length; i++) {
    if (Math.hypot(obs[i].ball.x - rest.x, obs[i].ball.y - rest.y) > moveBar) { iMove = i; break; }
  }
  if (iMove < 1) {
    return { t: null, reason: `The ball never moves more than ${moveBar.toFixed(0)} mm from where it ` +
                              'started — either it was not struck in this clip, or what is being ' +
                              'tracked is not the ball.' };
  }

  // Fit distance-from-rest vs time over the clean rolling segment, then
  // solve d(t) = 0. That intercept is the launch instant, sub-frame.
  const seg = [];
  for (let i = iMove; i < obs.length && seg.length < 24; i++) {
    const d = Math.hypot(obs[i].ball.x - rest.x, obs[i].ball.y - rest.y);
    seg.push({ x: obs[i].t, y: d });
  }
  if (seg.length < 4) {
    return { t: null, reason: `The ball was tracked in only ${seg.length} frames after it moved — ` +
                              'it needs to roll clear in shot for a few frames to fix the launch instant.' };
  }
  const r = linreg(seg);
  if (!r || Math.abs(r.b) < 1e-6) {
    return { t: null, reason: 'The ball moved but never rolled steadily, so its launch instant ' +
                              'cannot be extrapolated back.' };
  }
  const tImpact = -r.a / r.b;

  // The launch instant is an extrapolation, so it can land anywhere if the fit
  // is garbage — a real clip solved to -0.26 s, a quarter second before its own
  // first frame, and that still counted as an impact. A ball struck inside the
  // clip launches inside the clip; anything else means the thing being tracked
  // is not the ball.
  const dts = [];
  for (let i = 1; i < obs.length; i++) dts.push(obs[i].t - obs[i - 1].t);
  dts.sort((a, b) => a - b);
  const dt = dts[dts.length >> 1] || 0;
  const tFirst = obs[0].t, tLast = obs[obs.length - 1].t;
  if (tImpact < tFirst - 3 * dt || tImpact > tLast) {
    return { t: null, reason:
      `The launch instant solves to ${tImpact.toFixed(3)} s, outside the clip ` +
      `(${tFirst.toFixed(3)}–${tLast.toFixed(3)} s). The tracked motion does not extrapolate back ` +
      `to a standing start, so what is being followed is probably not the ball.` };
  }

  // A struck ball moves AWAY from where it sat, so distance-from-rest rises with
  // time. A negative slope says the fit describes something else — on a clip
  // whose tracker jumped 177 mm onto another object before settling, the "roll"
  // ran backwards and solved to a launch instant comfortably inside the clip,
  // which passed the check above and shipped a putter path of -168 degrees and a
  // tempo of 156. That reads as a measurement. A refusal does not.
  if (r.b <= 0) {
    return { t: null, reason:
      'The tracked object moves back TOWARDS where it started rather than away, ' +
      'so it cannot be a struck ball. Whatever is being followed is not the ball.' };
  }

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
  if (impact.t != null) {
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

      // How hard the ball slows, as a check on the assumed capture rate.
      //
      // Get the rate wrong by a factor k and speed is wrong by k but
      // deceleration by k SQUARED, so deceleration is the sensitive one. A
      // putting surface takes roughly 1–2 m/s² off a ball; a clip read at 240
      // fps when it was shot at 120 reports four times that, which is a ball
      // hitting something rather than rolling. Angles never move either way.
      const dq = quadfit(rolling.map(p => ({ x: p.t - impact.t, y: Math.hypot(p.x, p.y) })));
      if (dq && dq.c < 0) out.ballDecelMs2 = -2 * dq.c / 1000;
    }
  } else {
    out.impactReason = impact.reason;
    out.warnings.push(impact.reason);
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
      // Past a certain disagreement this is not a poor stroke, it is a
      // measurement of the wrong object — the tracker following a printed mat
      // target instead of the ball, or a quad tapped around something that is
      // not the mat. Such a putt must not reach the session: a number that
      // looks like data is worse than a visible failure.
      if (Math.abs(out.facePredictionErrorDeg) > IMPLAUSIBLE_FACE_ERR_DEG) {
        out.implausible =
          `Face angle and ball start line disagree by ${Math.abs(out.facePredictionErrorDeg).toFixed(0)}°, ` +
          `which no putt does. Something other than the ball or the putter is being tracked — ` +
          `check that the mat corners are the mat's, and that nothing ball-sized and white ` +
          `(a printed target, a logo) sits on the mat.`;
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
