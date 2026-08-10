/* =====================================================================
   Phase-banded stroke timeline, drawn to a canvas so the playhead can be
   dragged at 60 Hz without rebuilding an SVG each frame.

   Two stacked scales sharing one time axis:
     upper — putter head displacement across the mat (mm)
     lower — face angle and path angle (deg)

   The phase bands are the point. Backswing / downswing / follow-through
   are legible as colour before you read a single curve, which is what
   lets someone glance at this mid-session.
   ===================================================================== */

const BANDS = {
  back:   '#2b3570',
  down:   '#6b2b2f',
  follow: '#1f5638'
};

// Named cssVar, not css: the bundler concatenates modules into one scope
// and charts.js already owns `css`.
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function niceRange(vals, minSpan) {
  if (!vals.length) return { lo: -1, hi: 1 };
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const mid = (lo + hi) / 2;
  let span = Math.max(hi - lo, minSpan);
  span *= 1.18;
  return { lo: mid - span / 2, hi: mid + span / 2 };
}

/**
 * @param canvas   target <canvas>
 * @param res      analyseStroke() output
 * @param playT    current playhead time (seconds), or null
 */
export function drawTimeline(canvas, res, playT) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth || 600, H = canvas.clientHeight || 200;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#0e0e0e';
  g.fillRect(0, 0, W, H);

  const face = res.faceSeries || [];
  const head = res.headPath || [];
  if (face.length < 3 && head.length < 3) return null;

  const all = face.length ? face : head.map(p => ({ t: p.t }));
  const t0 = all[0].t, t1 = all[all.length - 1].t;
  if (!(t1 > t0)) return null;
  const X = t => (t - t0) / (t1 - t0) * W;

  /* ---------- phase bands ---------- */
  const tStart = res.tStart ?? t0;
  const tTop = res.tTop ?? (t0 + (t1 - t0) * 0.4);
  const tImp = res.impactTime ?? (t0 + (t1 - t0) * 0.65);
  const segs = [
    { x0: 0, x1: X(tTop), c: BANDS.back, label: 'backswing' },
    { x0: X(tTop), x1: X(tImp), c: BANDS.down, label: 'downswing' },
    { x0: X(tImp), x1: W, c: BANDS.follow, label: 'follow through' }
  ];
  for (const s of segs) {
    g.fillStyle = s.c;
    g.fillRect(s.x0, 0, Math.max(0, s.x1 - s.x0), H);
  }
  g.font = '10px ' + (cssVar('--f') || 'system-ui');
  g.textAlign = 'center'; g.textBaseline = 'top';
  g.fillStyle = 'rgba(255,255,255,.62)';
  for (const s of segs) {
    if (s.x1 - s.x0 < 62) continue;
    g.fillText(s.label.toUpperCase(), (s.x0 + s.x1) / 2, 5);
  }

  /* ---------- gridlines ---------- */
  g.strokeStyle = 'rgba(255,255,255,.15)';
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    g.beginPath(); g.moveTo(0, H * i / 4 + .5); g.lineTo(W, H * i / 4 + .5); g.stroke();
  }

  /* ---------- upper: head displacement across the mat ---------- */
  const pad = 18;
  const upTop = pad, upBot = H * 0.5;
  const dispVals = head.map(p => p.x);
  const dr = niceRange(dispVals, 10);
  const Yd = v => upBot - (v - dr.lo) / (dr.hi - dr.lo) * (upBot - upTop);

  if (head.length > 2) {
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.lineJoin = 'round';
    g.beginPath();
    head.forEach((p, i) => { const x = X(p.t), y = Yd(p.x); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }

  /* ---------- lower: face + path angle ---------- */
  const loTop = H * 0.52, loBot = H - 14;
  const angVals = face.map(p => p.deg);
  const ar = niceRange(angVals, 4);
  const Ya = v => loBot - (v - ar.lo) / (ar.hi - ar.lo) * (loBot - loTop);

  if (face.length > 2) {
    g.strokeStyle = '#22c55e'; g.lineWidth = 2.4;
    g.beginPath();
    face.forEach((p, i) => { const x = X(p.t), y = Ya(p.deg); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }
  // square-face reference
  if (ar.lo < 0 && ar.hi > 0) {
    g.strokeStyle = 'rgba(255,255,255,.34)'; g.lineWidth = 1; g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(0, Ya(0)); g.lineTo(W, Ya(0)); g.stroke(); g.setLineDash([]);
  }

  /* ---------- scale chips on the right edge ---------- */
  const chip = (text, y) => {
    g.font = '9px system-ui'; g.textAlign = 'right'; g.textBaseline = 'middle';
    const w = g.measureText(text).width + 10;
    g.fillStyle = 'rgba(0,0,0,.62)';
    g.beginPath(); g.roundRect(W - w - 5, y - 7, w, 14, 4); g.fill();
    g.fillStyle = '#fff';
    g.fillText(text, W - 10, y);
  };
  chip(`${(dr.hi / 10).toFixed(1)} cm`, Yd(dr.hi) + 9);
  chip(`${(dr.lo / 10).toFixed(1)} cm`, Yd(dr.lo) - 9);
  chip(`${ar.hi > 0 ? '+' : ''}${ar.hi.toFixed(1)}°`, Ya(ar.hi) + 9);
  chip(`${ar.lo.toFixed(1)}°`, Ya(ar.lo) - 9);

  /* ---------- impact line + playhead ---------- */
  g.strokeStyle = '#fff'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(X(tImp), 0); g.lineTo(X(tImp), H); g.stroke();

  if (playT != null) {
    const px = X(playT);
    g.strokeStyle = '#f0a020'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
    g.fillStyle = '#f0a020';
    g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.closePath(); g.fill();
  }

  return { t0, t1, X, timeAtX: x => t0 + (x / W) * (t1 - t0) };
}
