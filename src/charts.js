/* =====================================================================
   SVG charts. Every chart here is a single series, so none carries a
   legend box — the title names what is plotted. Colour follows the
   entity, never the rank.
   ===================================================================== */

import { sessionStats } from './analyse.js';

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const nice = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d);

function frame(w, h) {
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="display:block" role="img" preserveAspectRatio="xMidYMid meet">`
    + `<rect width="${w}" height="${h}" fill="${css('--surface-1')}" rx="8"/>`;
}

/* ---------------- face angle through the stroke ---------------- */
export function faceAngleChart(el, res) {
  const S = res.faceSeries || [];
  if (S.length < 3) { el.innerHTML = ''; return; }
  const W = 680, H = 300, pad = { l: 48, r: 16, t: 28, b: 34 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  const t0 = S[0].t, t1 = S[S.length - 1].t;
  let lo = Math.min(...S.map(p => p.deg)), hi = Math.max(...S.map(p => p.deg));
  const padY = Math.max(0.6, (hi - lo) * 0.15); lo -= padY; hi += padY;
  const X = t => pad.l + (t - t0) / (t1 - t0) * iw;
  const Y = a => H - pad.b - (a - lo) / (hi - lo) * ih;

  let s = frame(W, H);
  const step = Math.max(1, Math.round((hi - lo) / 5));
  for (let a = Math.ceil(lo / step) * step; a <= hi; a += step) {
    s += `<line x1="${pad.l}" y1="${Y(a)}" x2="${W - pad.r}" y2="${Y(a)}" stroke="${css('--grid')}" stroke-width="1"/>`;
    s += `<text x="${pad.l - 8}" y="${Y(a) + 4}" fill="${css('--ink-muted')}" font-size="10" text-anchor="end">${a > 0 ? '+' : ''}${a}°</text>`;
  }
  // square-face reference
  if (lo < 0 && hi > 0) {
    s += `<line x1="${pad.l}" y1="${Y(0)}" x2="${W - pad.r}" y2="${Y(0)}" stroke="${css('--axis')}" stroke-width="2" stroke-dasharray="6 5"/>`;
    s += `<text x="${W - pad.r - 4}" y="${Y(0) - 6}" fill="${css('--ink-muted')}" font-size="10" text-anchor="end">square</text>`;
  }

  // phase markers
  const mark = (t, label, color) => {
    if (t == null || t < t0 || t > t1) return '';
    return `<line x1="${X(t)}" y1="${pad.t - 6}" x2="${X(t)}" y2="${H - pad.b}" stroke="${color}" stroke-width="1.5" stroke-dasharray="3 3" opacity=".8"/>`
      + `<text x="${X(t)}" y="${pad.t - 11}" fill="${css('--ink-muted')}" font-size="10" text-anchor="middle">${label}</text>`;
  };
  s += mark(res.tStart, 'takeaway', css('--axis'));
  s += mark(res.tTop, 'top', css('--axis'));
  s += mark(res.impactTime, 'impact', css('--series-2'));

  const d = S.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)} ${Y(p.deg).toFixed(1)}`).join(' ');
  s += `<path d="${d}" fill="none" stroke="${css('--series-1')}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

  if (res.impactTime != null && res.faceDeg != null) {
    s += `<circle cx="${X(res.impactTime)}" cy="${Y(res.faceDeg)}" r="5.5" fill="${css('--series-1')}" stroke="${css('--surface-1')}" stroke-width="2"/>`;
    s += `<text x="${X(res.impactTime) + 9}" y="${Y(res.faceDeg) - 8}" fill="${css('--ink-1')}" font-size="12" font-weight="600">${res.faceDeg > 0 ? '+' : ''}${nice(res.faceDeg, 2)}°</text>`;
  }
  // No y-axis caption: the tick labels already carry degree signs, and a
  // caption here collides with the "takeaway" phase marker.
  s += `<text x="${W - pad.r}" y="${H - 9}" fill="${css('--ink-muted')}" font-size="10" text-anchor="end">seconds</text>`;
  s += `<text x="${pad.l}" y="${H - 9}" fill="${css('--ink-muted')}" font-size="10">${nice(t0, 2)}s</text>`;
  s += '</svg>';
  el.innerHTML = s;
}

/* ---------------- top-down stroke: head arc + ball ---------------- */
export function strokeArcChart(el, res) {
  const head = res.headPath || [], ball = res.ballPath || [];
  if (head.length < 3) { el.innerHTML = ''; return; }
  const W = 680, H = 340, pad = { l: 46, r: 16, t: 26, b: 34 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  const all = head.concat(ball);
  let xlo = Math.min(...all.map(p => p.x)), xhi = Math.max(...all.map(p => p.x));
  let ylo = Math.min(...all.map(p => p.y)), yhi = Math.max(...all.map(p => p.y));
  const cx = (xlo + xhi) / 2;
  const halfX = Math.max(30, (xhi - xlo) / 2 * 1.35);
  ylo -= 25; yhi += 25;

  const X = x => pad.l + (x - (cx - halfX)) / (2 * halfX) * iw;
  const Y = y => H - pad.b - (y - ylo) / (yhi - ylo) * ih;
  const exag = ((yhi - ylo) / ih) / ((2 * halfX) / iw);

  let s = frame(W, H);
  for (let y = Math.ceil(ylo / 100) * 100; y <= yhi; y += 100) {
    s += `<line x1="${pad.l}" y1="${Y(y)}" x2="${W - pad.r}" y2="${Y(y)}" stroke="${css('--grid')}" stroke-width="1"/>`;
  }
  // target line through the ball's rest position
  const bx0 = ball.length ? ball[0].x : cx;
  s += `<line x1="${X(bx0)}" y1="${Y(ylo)}" x2="${X(bx0)}" y2="${Y(yhi)}" stroke="${css('--axis')}" stroke-width="2" stroke-dasharray="6 5"/>`;

  // head arc
  const dh = head.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`).join(' ');
  s += `<path d="${dh}" fill="none" stroke="${css('--series-3')}" stroke-width="2" stroke-linejoin="round"/>`;
  // ball path
  if (ball.length > 2) {
    const db = ball.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`).join(' ');
    s += `<path d="${db}" fill="none" stroke="${css('--series-1')}" stroke-width="2.5" stroke-linejoin="round"/>`;
  }

  // face line drawn at impact, to scale
  if (res.impactTime != null && res.faceDeg != null) {
    let near = null, best = Infinity;
    for (const p of head) { const d = Math.abs(p.t - res.impactTime); if (d < best) { best = d; near = p; } }
    if (near) {
      const L = 45, a = res.faceDeg * Math.PI / 180;
      const ax = near.x - Math.cos(a) * L, ay = near.y - Math.sin(a) * L;
      const bx = near.x + Math.cos(a) * L, by = near.y + Math.sin(a) * L;
      // Clamp the DRAWN length. The direction stays true; only the extent is
      // capped, because the across-mat axis is exaggerated ~30x and an honest
      // 90 mm face line would otherwise stretch across the whole panel.
      let p1 = { x: X(ax), y: Y(ay) }, p2 = { x: X(bx), y: Y(by) };
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y), CAP = 80;
      if (len > CAP) {
        const f = CAP / len;
        p1 = { x: mx + (p1.x - mx) * f, y: my + (p1.y - my) * f };
        p2 = { x: mx + (p2.x - mx) * f, y: my + (p2.y - my) * f };
      }
      s += `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${css('--series-2')}" stroke-width="3" stroke-linecap="round"/>`;
      s += `<circle cx="${X(near.x)}" cy="${Y(near.y)}" r="4" fill="${css('--series-2')}" stroke="${css('--surface-1')}" stroke-width="1.5"/>`;
    }
  }

  s += `<text x="10" y="14" fill="${css('--ink-muted')}" font-size="10">mm down mat</text>`;
  s += `<text x="${W - pad.r}" y="14" fill="${css('--ink-muted')}" font-size="10" text-anchor="end">across-mat scale ×${exag.toFixed(0)}</text>`;
  s += `<text x="${pad.l}" y="${H - 9}" fill="${css('--series-3')}" font-size="10">■</text>`
    +  `<text x="${pad.l + 12}" y="${H - 9}" fill="${css('--ink-muted')}" font-size="10">putter head</text>`
    +  `<text x="${pad.l + 92}" y="${H - 9}" fill="${css('--series-1')}" font-size="10">■</text>`
    +  `<text x="${pad.l + 104}" y="${H - 9}" fill="${css('--ink-muted')}" font-size="10">ball</text>`
    +  `<text x="${pad.l + 145}" y="${H - 9}" fill="${css('--series-2')}" font-size="10">■</text>`
    +  `<text x="${pad.l + 157}" y="${H - 9}" fill="${css('--ink-muted')}" font-size="10">face at impact</text>`;
  s += '</svg>';
  el.innerHTML = s;
}

/* ---------------- session dispersion ---------------- */
export function dispersionChart(el, history, key = 'faceToPathDeg', label = 'face-to-path') {
  const rows = history.filter(r => r[key] != null);
  if (!rows.length) { el.innerHTML = ''; return; }
  // Width follows the container, not a fixed 680: at width:100% in a narrow mobile
  // column a fixed viewBox scales its 10px SVG labels down to the point of being
  // unreadable, while text set in the viewBox's own units stays legible at any width.
  const W = Math.max(280, Math.round(el.clientWidth) || 680), H = Math.max(120, 52 + rows.length * 22), pad = { l: 16, r: 16, t: 36, b: 28 };
  const lim = Math.max(1, Math.max(...rows.map(r => Math.abs(r[key]))) * 1.25);
  const iw = W - pad.l - pad.r;
  const X = d => pad.l + (d + lim) / (2 * lim) * iw;
  const { mean, sd } = sessionStats(rows.map(r => r[key]));

  let s = frame(W, H);
  if (rows.length > 1) {
    s += `<rect x="${X(mean - sd)}" y="${pad.t - 10}" width="${Math.max(1, X(mean + sd) - X(mean - sd))}" height="${H - pad.t - pad.b + 14}" fill="${css('--series-1')}" opacity=".10" rx="3"/>`;
    s += `<line x1="${X(mean)}" y1="${pad.t - 10}" x2="${X(mean)}" y2="${H - pad.b + 6}" stroke="${css('--series-1')}" stroke-width="1.5"/>`;
  }
  s += `<line x1="${X(0)}" y1="${pad.t - 14}" x2="${X(0)}" y2="${H - pad.b + 6}" stroke="${css('--axis')}" stroke-width="2" stroke-dasharray="5 4"/>`;
  s += `<text x="${X(0)}" y="16" fill="${css('--ink-muted')}" font-size="10" text-anchor="middle">zero</text>`;
  s += `<text x="${pad.l}" y="16" fill="${css('--ink-muted')}" font-size="10">${(-lim).toFixed(1)}°</text>`;
  s += `<text x="${W - pad.r}" y="16" fill="${css('--ink-muted')}" font-size="10" text-anchor="end">+${lim.toFixed(1)}°</text>`;
  rows.forEach((r, i) => {
    const y = pad.t + 6 + i * 22;
    s += `<line x1="${X(0)}" y1="${y}" x2="${X(r[key])}" y2="${y}" stroke="${css('--grid')}" stroke-width="1.5"/>`;
    s += `<circle cx="${X(r[key])}" cy="${y}" r="5.5" fill="${css('--series-1')}" stroke="${css('--surface-1')}" stroke-width="2"/>`;
  });
  if (rows.length > 1) {
    s += `<text x="${X(mean)}" y="${H - 8}" fill="${css('--ink-2')}" font-size="10" text-anchor="middle">${esc(label)} mean ${mean > 0 ? '+' : ''}${mean.toFixed(2)}° · σ ${sd.toFixed(2)}°</text>`;
  }
  s += '</svg>';
  el.innerHTML = s;
}

/* ---------------- tempo ---------------- */
export function tempoChart(el, res) {
  if (res.backSec == null || res.fwdSec == null) { el.innerHTML = ''; return; }
  const W = 680, H = 96, pad = { l: 16, r: 16, t: 30, b: 26 };
  const total = res.backSec + res.fwdSec, iw = W - pad.l - pad.r;
  const bw = iw * res.backSec / total;
  let s = frame(W, H);
  s += `<rect x="${pad.l}" y="${pad.t}" width="${(bw - 1).toFixed(1)}" height="26" fill="${css('--series-1')}" rx="4"/>`;
  s += `<rect x="${(pad.l + bw + 1).toFixed(1)}" y="${pad.t}" width="${(iw - bw - 1).toFixed(1)}" height="26" fill="${css('--series-3')}" rx="4"/>`;
  s += `<text x="${pad.l + 8}" y="${pad.t + 18}" fill="#fff" font-size="12" font-weight="600">back ${(res.backSec * 1000).toFixed(0)} ms</text>`;
  s += `<text x="${W - pad.r - 8}" y="${pad.t + 18}" fill="#fff" font-size="12" font-weight="600" text-anchor="end">through ${(res.fwdSec * 1000).toFixed(0)} ms</text>`;
  s += `<text x="10" y="18" fill="${css('--ink-muted')}" font-size="10">tempo ratio ${nice(res.tempoRatio, 2)} : 1 (takeaway at 5% of peak speed)</text>`;
  s += `<text x="${pad.l + bw}" y="${H - 8}" fill="${css('--ink-muted')}" font-size="10" text-anchor="middle">top</text>`;
  s += '</svg>';
  el.innerHTML = s;
}
