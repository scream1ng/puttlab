/* =====================================================================
   PuttLab Pro — landscape app.
   file -> demux -> WebCodecs decode -> per-frame CV -> metrics -> scrub.

   The analysis engine (mp4/decoder/geom/detect/track/analyse) is untouched
   by this file; everything here is presentation and interaction.
   ===================================================================== */

import { demuxMp4 } from './mp4.js';
import { decodeAll, grabFrame, analyseTiming, webCodecsSupported } from './decoder.js';
import { computeHomography, invert3, applyH } from './geom.js';
import { createTracker } from './track.js';
import { analyseStroke, sessionStats } from './analyse.js';
import { sampleHue, detectTargetLine, detectMarkers } from './detect.js';
import { dispersionChart } from './charts.js';
import { drawTimeline } from './timeline.js';

const $ = id => document.getElementById(id);
const fmt = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d);
const sgn = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d);

const PREVIEW_W = 480;         // stored scrub frames
const PREVIEW_CAP = 150;       // hard cap on retained bitmaps

const S = {
  buffer: null, info: null, timing: null,
  calBmp: null, calImg: null,
  corners: [], H: null, Hinv: null,
  matW: 400, matL: 3000,
  hue: 322, tapMode: 'corners',
  frames: null, result: null,
  previews: [], previewScale: 1,
  playT: null, tlMap: null,
  history: [], selected: -1, db: null
};

/* Settings the user already chose once. Without this every upload resets to
   "tap 4 corners" + "stickers", which is wrong for a top-down clip, and the
   capture rate silently reverts to a value that makes speed twice what it is. */
const PREF_IDS = ['calMode', 'mode', 'capFps', 'vBall'];
let calModeChosen = false;      // did the user pick a calibration mode themselves?
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('puttlab.prefs') || '{}');
    for (const id of PREF_IDS) if (p[id] != null && $(id)) $(id).value = p[id];
    calModeChosen = p.calMode != null;
  } catch (e) { /* corrupt prefs must never block the app */ }
}
function savePrefs() {
  try {
    const p = {};
    for (const id of PREF_IDS) if ($(id)) p[id] = $(id).value;
    localStorage.setItem('puttlab.prefs', JSON.stringify(p));
  } catch (e) { /* private mode */ }
}

/* ============================ chrome ============================ */
function msg(text, kind = 'warn', ms = 0) {
  const box = $('msgs');
  if (!text) { box.innerHTML = ''; return; }
  const d = document.createElement('div');
  d.className = 'msg ' + kind;
  d.innerHTML = text;
  box.innerHTML = '';
  box.appendChild(d);
  if (ms) setTimeout(() => { if (d.parentNode) d.remove(); }, ms);
}

// Local detection failed (decode, calibration, or impact). The server's
// pipeline is a different, stronger detector (OpenCV, not a hue threshold) —
// worth a second try before telling the user the clip is unmeasurable. It only
// helps for a printed-line mat (no tap-4-corners support server-side), but
// that is not knowable in advance, so the offer is unconditional and the
// server itself says why if it can't.
//
// Rendered into #srcInfo (the file-status box), not the floating #msgs
// toast: this has a button on it and needs to stay up until acted on, and a
// fixed-position toast sitting on top of the very panel it's about ended up
// covering the "Mat + markers" heading and pushing the fps/mode selects
// down behind the tab bar. #srcInfo already lives in the document flow right
// where the load-a-clip status belongs.
function errRetry(text) {
  $('srcErr').innerHTML =
    `<div class="msg err">${text}` +
    // Solid, not .sec: this is the one actionable next step in a red panel,
    // not a secondary option — a transparent button here just took on the
    // panel's own red tint and read as part of the error, not a way out of it.
    `<button class="btn" id="btnServerRetry" style="margin-top:10px">Try server-side detection</button>` +
    `<div class="bar hidden" id="serverProgWrap"><i id="serverProg"></i></div></div>`;
  $('btnServerRetry').onclick = analyseOnServer;
}

const VIEWS = ['setup', 'analyze', 'session'];
// Two nav sets share one view: the desktop rail and the mobile tab bar, both
// marked up with the same data-view attribute rather than duplicate ids.
const navBtns = name => document.querySelectorAll(`[data-view="${name}"]`);
function view(name) {
  for (const v of VIEWS) {
    $('view-' + v).classList.toggle('hidden', v !== name);
    $('side-' + v).classList.toggle('hidden', v !== name);
    navBtns(v).forEach(b => b.classList.toggle('on', v === name));
  }
  if (name === 'analyze') requestAnimationFrame(() => { renderTimeline(); renderPlayhead(); });
  if (name === 'session') dispersionChart($('chDisp'), S.history);
}
for (const v of VIEWS) navBtns(v).forEach(b => b.onclick = () => view(v));

/* ============================ load ============================ */
async function loadBuffer(buffer, name) {
  msg('');
  $('srcErr').innerHTML = '';
  S.buffer = buffer; S.fileName = name;
  try { S.info = demuxMp4(buffer); }
  catch (e) { return errRetry(`Could not read that file: ${e.message}`); }
  S.timing = analyseTiming(S.info, null);

  const hi = S.info.nominalFps >= 100;
  // The full technical dump (resolution/codec/frame count/container fps) is
  // debugging detail nobody asked for — only the actionable line (capture-rate
  // ambiguous, set it or speed reads wrong) belongs at a glance. Rest goes
  // behind the same <details> disclosure pattern as "Detector tuning" below.
  $('srcInfo').innerHTML =
    // Filename in --ink, not the message's own warn/ok colour: it's the
    // clip's name, not part of the warning, and coloured the same as the
    // warning it went muddy and unreadable. "change clip" is a real chip
    // (border + background), not underlined text the same colour as the
    // panel it sat on — that read as inert, not tappable.
    `<div class="msg ${hi ? 'ok' : 'warn'}">` +
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">` +
    `<b style="color:var(--ink)">${name}</b>` +
    `<button id="btnChangeClip" class="chipbtn">change clip</button></div>` +
    (S.timing.looksRendered ? `<br>${S.timing.note}` : '') +
    `<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--muted);font-size:10px">Technical details</summary>` +
    `<div style="margin-top:4px">${S.info.width}×${S.info.height} · ${S.info.config.codec} · ${S.info.samples.length} frames · ` +
    `container <b>${fmt(S.info.nominalFps, 1)} fps</b>` +
    (S.info.hasBFrames ? ' · B-frames reordered' : '') + `</div></details></div>`;
  $('btnChangeClip').onclick = resetClip;
  if (S.info.nominalFps < 100) $('capFps').value = '240';

  try { S.calBmp = (await grabFrame(buffer, 0)).bitmap; }
  catch (e) { return errRetry(`This browser cannot decode that clip: ${e.message}`); }

  drawCal();
  S.corners = []; S.H = null;

  // If the mat's printed line is there to be found, this clip needs no taps —
  // so stop making the user discover that by trying the wrong mode first.
  const d = S.calImg;
  const line = detectTargetLine(d.data, d.width, d.height,
    { x0: 0, y0: 0, x1: d.width - 1, y1: d.height - 1 }, null);
  S.lineFound = !!(line && line.n > 300);
  // Stickers is the default face mode, but a putter either has them or it does
  // not, and that is checkable rather than something to make the user discover
  // by getting no face angle out of a run.
  const marks = detectMarkers(d.data, d.width, d.height,
    { x0: 0, y0: 0, x1: d.width - 1, y1: d.height - 1 },
    { hue: S.hue, hueTol: 32, sMin: 0.40, vMin: 0.22, minPx: 5 });
  S.markersFound = !!marks;

  if (S.lineFound && !calModeChosen && $('calMode').value !== 'topdown') {
    $('calMode').value = 'topdown';
    if (!S.markersFound) $('mode').value = 'markerless';
    savePrefs();
    msg('Found the line printed down the mat, so this clip needs no corner taps — ' +
        'switched to top-down' +
        (S.markersFound ? '.' : ', and to no-stickers since none were found on the putter.') +
        ' Both are changeable under Mat + markers.', 'ok', 9000);
  }
  updateCal();
}

// Upload/demo have done their job once a clip is loaded — the same slot runs
// it. "change clip" (in srcInfo, once a name is showing) is the way back.
function resetClip() {
  S.buffer = null; S.info = null; S.calBmp = null; S.calImg = null;
  S.corners = []; S.H = null; S.Hinv = null; S.topDown = false;
  $('cvCal').getContext('2d').clearRect(0, 0, $('cvCal').width, $('cvCal').height);
  $('srcInfo').innerHTML = '';
  $('srcErr').innerHTML = '';
  $('setupStage').classList.add('empty');
  $('stageEmptyMsg').classList.remove('hidden');
  $('btnFile').classList.remove('hidden');
  $('btnDemo').classList.remove('hidden');
  $('btnRun').classList.add('hidden');
  $('fileIn').value = '';
  updateCal();
}

$('btnFile').onclick = () => $('fileIn').click();
$('fileIn').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  msg('Reading file…', 'info');
  await loadBuffer(await f.arrayBuffer(), f.name);
};

// The bundler rewrites this to an inline data: URL so the single-file build
// works with no server and no sibling files.
const DEMO_URL = 'fixtures/stroke_vp9.mp4';

$('btnDemo').onclick = async () => {
  msg('Loading the demo clip…', 'info');
  try {
    const r = await fetch(DEMO_URL);
    if (!r.ok) throw new Error('demo clip not found next to the app');
    await loadBuffer(await r.arrayBuffer(), 'demo — synthetic stroke, known truth');
    S.corners = [{ x: 300, y: 660 }, { x: 980, y: 660 }, { x: 760, y: 150 }, { x: 520, y: 150 }];
    S.hue = 322;
    updateCal();
    msg('Demo loaded, mat corners pre-set. Truth: face <b>+1.20°</b> · path <b>−2.00°</b> · ' +
        'face→path <b>+3.20°</b> · start <b>+1.10°</b> · <b>1.60 m/s</b> · tempo <b>1.97</b>.', 'ok');
  } catch (e) { msg(`Demo unavailable: ${e.message}`, 'err'); }
};

/* ============================ calibration ============================ */
function drawCal() {
  const c = $('cvCal');
  c.width = S.calBmp.width; c.height = S.calBmp.height;
  const g = c.getContext('2d');
  g.drawImage(S.calBmp, 0, 0);
  S.calImg = g.getImageData(0, 0, c.width, c.height);
  // A frame is finally on screen — the small placeholder box (nothing to show
  // before this) can grow to its real working size.
  $('setupStage').classList.remove('empty');
  $('stageEmptyMsg').classList.add('hidden');
  // Upload/demo turn into the single Analyse button once a clip is on screen —
  // "change clip" in srcInfo (see loadBuffer) is the way back to these.
  $('btnFile').classList.add('hidden');
  $('btnDemo').classList.add('hidden');
  $('btnRun').classList.remove('hidden');
  redrawCal();
}

/* Native px per CSS px. Corner discs and the grab radius both need to read as a
   constant ON-SCREEN size — the old `c.width / 1280` guess assumed the canvas is
   always displayed close to its native resolution, which held on the ~650px-wide
   desktop stage but not on a ~350px mobile one: same k, same drawn size in native
   px, but the CSS box showing it is smaller, so the apparent target shrinks. */
function cssScale(c) {
  const r = c.getBoundingClientRect();
  return r.width ? c.width / r.width : 1;
}

function redrawCal() {
  if (!S.calBmp) return;
  const c = $('cvCal'), g = c.getContext('2d');
  g.drawImage(S.calBmp, 0, 0);
  const k = cssScale(c);

  S.corners.forEach((p, i) => {
    g.lineWidth = 3 * k; g.strokeStyle = '#3987e5'; g.fillStyle = 'rgba(57,135,229,.25)';
    g.beginPath(); g.arc(p.x, p.y, 14 * k, 0, 7); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.font = `${13 * k}px system-ui`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(i + 1, p.x, p.y);
  });
  if (S.corners.length > 1) {
    g.strokeStyle = 'rgba(57,135,229,.75)'; g.lineWidth = 2 * k;
    g.beginPath(); g.moveTo(S.corners[0].x, S.corners[0].y);
    S.corners.slice(1).forEach(p => g.lineTo(p.x, p.y));
    if (S.corners.length === 4) g.closePath();
    g.stroke();
  }
  if (S.H && S.Hinv) {
    g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 1.5 * k;
    for (let y = 0; y <= S.matL; y += 250) {
      const a = applyH(S.Hinv, 0, y), b = applyH(S.Hinv, S.matW, y);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    const t0 = applyH(S.Hinv, S.matW / 2, 0), t1 = applyH(S.Hinv, S.matW / 2, S.matL);
    g.strokeStyle = 'rgba(232,98,42,.9)'; g.lineWidth = 2.5 * k;
    g.beginPath(); g.moveTo(t0.x, t0.y); g.lineTo(t1.x, t1.y); g.stroke();
  }
}

/* Client coords -> canvas coords. The canvas is drawn at the clip's native
   size and CSS-scaled to fit the stage, so the two differ. */
function calXY(ev) {
  const c = $('cvCal'), r = c.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / r.width * c.width,
           y: (ev.clientY - r.top) / r.height * c.height };
}

/* Index of the corner under a point, or -1. The centre line only appears once
   the homography exists, so the four taps are always placed blind — nudging
   afterwards is how they get right. Dragging moves a corner in place: it never
   reorders them and never adds a fifth, because the near-left → near-right →
   far-right → far-left order is what makes every angle mean anything. */
let dragCorner = -1;
function cornerUnder(x, y) {
  const grab = 22 * cssScale($('cvCal'));   // 22 CSS px hit target, drawn radius is 14*k — thumbs need more than a cursor
  let best = -1, bd = grab;
  S.corners.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= bd) { bd = d; best = i; }
  });
  return best;
}

$('cvCal').addEventListener('pointerdown', ev => {
  if (!S.calBmp) return;
  const c = $('cvCal');
  const { x, y } = calXY(ev);

  if (S.tapMode === 'hue') {
    const h = sampleHue(S.calImg.data, c.width, c.height, Math.round(x), Math.round(y), 7);
    S.tapMode = 'corners'; $('btnHue').classList.remove('on');
    if (!h) return msg('No strong colour there — tap the middle of a sticker.', 'warn', 4000);
    S.hue = h.hue;
    $('hueChip').classList.remove('hidden');
    $('hueChip').innerHTML = `sticker hue ${h.hue.toFixed(0)}°`;
    $('hueChip').style.background = `hsl(${h.hue} 70% 45% / .85)`;
    msg('', 'ok');
    return updateCal();
  }
  if (S.corners.length >= 4) {
    dragCorner = cornerUnder(x, y);
    if (dragCorner >= 0) { c.setPointerCapture?.(ev.pointerId); ev.preventDefault(); }
    return;
  }
  S.corners.push({ x, y });
  updateCal();
});

$('cvCal').addEventListener('pointermove', ev => {
  if (dragCorner < 0 || dragCorner >= S.corners.length) return;
  // setPointerCapture is guarded with ?. and can silently not take, in which case
  // the pointerup lands outside the canvas and never reaches us — without this the
  // next hover, no button down, would drag the corner around.
  if (ev.buttons === 0) { dragCorner = -1; return; }
  ev.preventDefault();
  S.corners[dragCorner] = calXY(ev);
  updateCal();          // recomputes the same homography as before, live under the finger
});
const endCornerDrag = () => { dragCorner = -1; };
$('cvCal').addEventListener('pointerup', endCornerDrag);
$('cvCal').addEventListener('pointercancel', endCornerDrag);

const LABELS = ['near-left', 'near-right', 'far-right', 'far-left'];

/* Four points always yield a homography, so a quad tapped around the wrong
   thing calibrates silently and skews every angle after it. One case is
   checkable: when the tapped sides do NOT converge, the camera was square-on to
   the mat, there is no foreshortening, and the on-screen aspect has to match the
   declared one. When the sides do converge, foreshortening is real and the two
   legitimately differ — so the check stays quiet rather than cry wolf.
   Catches "tapped the video frame instead of the mat". */
function aspectWarning(c, matW, matL) {
  if (c.length !== 4 || !matW || !matL) return null;
  const len = (a, b) => Math.hypot(c[a].x - c[b].x, c[a].y - c[b].y);
  const near = len(0, 1), far = len(3, 2);        // across the mat, near and far
  const left = len(0, 3), right = len(1, 2);      // down the mat
  if (!near || !far || !left || !right) return null;
  if (Math.max(near, far) / Math.min(near, far) > 1.15) return null;   // real perspective
  const seen = ((left + right) / 2) / ((near + far) / 2);
  const declared = matL / matW;
  const off = Math.max(seen, declared) / Math.min(seen, declared);
  return off > 1.35 ? { seen, declared, suggestCm: Math.round(matW * seen) / 10 } : null;
}
let aspectWarned = false;

function updateCal() {
  // Leave the width blank and the ball becomes the ruler: a golf ball is
  // 42.7 mm, so its size on screen fixes the absolute scale. The number still
  // typed here only ever sets the mat's SHAPE, and shape is what angles depend
  // on — the ball can replace the tape measure, not the proportions.
  // Top-down needs nothing tapped and nothing measured: the line printed down
  // the mat gives direction, the ball gives scale, both found per frame.
  S.topDown = $('calMode').value === 'topdown';
  const wRaw = $('matW').value.trim();
  S.autoScale = wRaw === '';
  S.matW = (S.autoScale ? 40 : (+wRaw || 40)) * 10;
  S.matL = (+$('matL').value || 300) * 10;
  const n = S.corners.length;

  $('calHint').innerHTML = !S.calBmp ? 'Load a clip first.'
    : S.topDown ? 'Nothing to tap. The line printed down the mat sets direction, the ball sets scale — both read fresh every frame, so a drifting camera cannot spoil them.'
    : S.tapMode === 'hue' ? 'Tap the centre of one sticker.'
    : n < 4 ? `Tap the <b style="color:var(--ink2)">${LABELS[n]}</b> corner (${n}/4). This turns pixels into millimetres.`
    : 'Calibrated. Drag any numbered corner to line the orange centre line up with the mat, then run.';

  if (n === 4) {
    S.H = computeHomography(S.corners, [
      { x: 0, y: 0 }, { x: S.matW, y: 0 }, { x: S.matW, y: S.matL }, { x: 0, y: S.matL }]);
    S.Hinv = S.H ? invert3(S.H) : null;
    if (!S.H) msg('Those four points are degenerate — undo and re-tap.', 'err');
  } else { S.H = null; S.Hinv = null; }

  // Not while auto-scaling: S.matW is then a 400 mm placeholder the user
  // deliberately left blank, so "the length should be about X cm" would be
  // advice derived from a number nobody supplied.
  const aw = (S.H && !S.autoScale) ? aspectWarning(S.corners, S.matW, S.matL) : null;
  // Edge-triggered: updateCal runs on every pointermove while a corner is dragged.
  if (aw && !aspectWarned) {
    msg(`Those corners look ${aw.seen.toFixed(1)}:1 on screen but you declared ` +
        `${aw.declared.toFixed(1)}:1, and the sides do not converge — so there is no ` +
        `perspective to explain the difference. Either the corners are not the mat's, ` +
        `or the length should be about ${aw.suggestCm} cm. Angles will be skewed until ` +
        `this agrees.`, 'warn', 10000);
  }
  aspectWarned = !!aw;

  $('calChip').textContent = !S.calBmp ? 'No clip loaded'
    : S.topDown ? 'top-down · no taps needed'
    : (S.H ? `mat ${S.matW / 10}×${S.matL / 10} cm · ${aw ? 'dimensions look wrong' : 'calibrated'}`
           : `${n}/4 corners`);
  // Top-down needs no taps, but it still needs a clip. Without the S.info guard
  // the button un-disables the moment the mode is chosen, and running then
  // throws on a null clip AFTER the handler has already disabled the button and
  // relabelled it "Decoding…" — leaving it stuck until the page is reloaded.
  $('btnRun').disabled = !S.info || (!S.H && !S.topDown);
  // While corners are still being tapped, give the stage the most screen it
  // can get, and offer the rotate hint — once calibrated there's nothing
  // left to protect.
  const tapping = !!S.calBmp && !S.topDown && n < 4;
  $('setupStage').classList.toggle('calibrating', tapping);
  $('rotHint').classList.toggle('hidden', !tapping);
  // Undo corner and Tap a sticker are dead controls, not just inert ones,
  // whenever there's nothing they could act on — top-down has no corners to
  // undo, markerless has no sticker hue to register — so hide rather than
  // merely disable them. Runs here (not only on their own onchange
  // handlers) because loadBuffer's auto-topdown/markerless switch sets
  // S.topDown / #mode.value directly, without firing a change event.
  $('btnUndo').classList.toggle('hidden', S.topDown);
  $('btnHue').classList.toggle('hidden', $('mode').value === 'markerless');
  redrawCal();
}

['matW', 'matL'].forEach(id => $(id).oninput = updateCal);
$('calMode').onchange = () => { calModeChosen = true; savePrefs(); updateCal(); };
for (const id of ['mode', 'capFps', 'vBall']) $(id).addEventListener('change', savePrefs);
loadPrefs();
$('btnUndo').onclick = () => { dragCorner = -1; S.corners.pop(); updateCal(); };
$('btnHue').onclick = () => {
  S.tapMode = S.tapMode === 'hue' ? 'corners' : 'hue';
  $('btnHue').classList.toggle('on', S.tapMode === 'hue');
  updateCal();
};
$('mode').onchange = () => {
  if ($('mode').value === 'markerless') {
    msg('Markerless reads the dark putter head\'s principal axis. Expect ±1–2° on face angle.', 'warn', 7000);
    // A pending "tap a sticker" doesn't survive the switch to a mode with no
    // sticker to tap — left as-is, the next canvas tap silently reads as a
    // failed hue sample instead of the corner it should be.
    S.tapMode = 'corners'; $('btnHue').classList.remove('on');
  }
  updateCal();   // shows/hides Tap a sticker to match the new mode
};
[['hueTol', 'htLab', 0], ['sMin', 'smLab', 2], ['vBall', 'vbLab', 2], ['detW', 'dwLab', 0]]
  .forEach(([id, lab, d]) => $(id).oninput = e => $(lab).textContent = (+e.target.value).toFixed(d));

/* ============================ run ============================ */
$('btnRun').onclick = async () => {
  if (!S.H && !S.topDown) return;
  const btn = $('btnRun');
  btn.disabled = true; btn.textContent = 'Decoding…';
  $('progWrap').classList.remove('hidden');
  msg('');

  S.timing = analyseTiming(S.info, +$('capFps').value || null);
  const markerless = $('mode').value === 'markerless';
  const tracker = createTracker({
    H: S.H, quad: S.corners, matW: S.matW,
    srcWidth: S.info.width, srcHeight: S.info.height,
    opt: {
      detWidth: +$('detW').value, markerless, topDown: S.topDown,
      scaleKnown: !S.autoScale,
      marker: { hue: S.hue, hueTol: +$('hueTol').value, sMin: +$('sMin').value },
      ball: { vThr: +$('vBall').value }
    }
  });

  // release the previous clip's GPU-backed frames before allocating more
  for (const p of S.previews) p.bmp.close?.();
  S.previews = [];

  const total = S.info.samples.length;
  const stride = Math.max(1, Math.ceil(total / PREVIEW_CAP));
  const pw = PREVIEW_W, ph = Math.round(S.info.height * PREVIEW_W / S.info.width);
  S.previewScale = pw / S.info.width;
  const pv = new OffscreenCanvas(pw, ph), pvx = pv.getContext('2d');

  const work = new OffscreenCanvas(tracker.detW, tracker.detH);
  const wctx = work.getContext('2d', { willReadFrequently: true });
  const frames = [];
  const t0 = performance.now();

  try {
    await decodeAll(S.buffer, {
      timeScale: S.timing.timeScale,
      onProgress: (d, t) => { $('prog').style.width = (100 * d / t) + '%'; },
      onFrame: (frame, t, i) => {
        wctx.drawImage(frame, 0, 0, tracker.detW, tracker.detH);
        frames.push(tracker.process(wctx.getImageData(0, 0, tracker.detW, tracker.detH).data, t));
        if (i % stride === 0) {
          pvx.drawImage(frame, 0, 0, pw, ph);
          // transferToImageBitmap is synchronous — the async createImageBitmap
          // would need the VideoFrame to outlive this callback, and it must not.
          S.previews.push({ t, bmp: pv.transferToImageBitmap() });
        }
      }
    });
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Analyse the stroke';
    $('progWrap').classList.add('hidden');
    return errRetry(`Decode failed: ${e.message}`);
  }

  // Re-pick the ball now the whole clip is in: per-frame detection cannot tell a
  // golf ball from a target circle printed on the mat, but only one of them moves.
  const ballFix = tracker.finish(frames, { scaleFromBall: S.autoScale });
  // finishTopDown knows exactly why it gave up; without this the user gets
  // findImpact's downstream "the ball was tracked in 0 frames" instead, which
  // names the symptom and hides the cause.
  if (ballFix.ok === false) {
    btn.disabled = false; btn.textContent = 'Analyse the stroke';
    $('progWrap').classList.add('hidden');
    return errRetry(`Top-down calibration failed — ${ballFix.reason}.`);
  }
  const res = analyseStroke(frames, { markerless });
  res.ballWidthPx = ballFix.ballWidthPx;
  res.matWidthMm = ballFix.matWidthMm;
  S.scaleK = ballFix.scaleK || 1;
  if (ballFix.scaleFromBall) {
    res.warnings.push(
      `Scale measured from the ball (42.7 mm), not a typed mat width — that makes the mat ` +
      `${(ballFix.matWidthMm / 10).toFixed(0)} cm across. Angles are unaffected either way; ` +
      `speed and distances carry a few percent more uncertainty than a tape measure would.`);
  }
  const dec = res.ballDecelMs2;
  if (dec != null && (dec < 0.2 || dec > 4)) {
    const cur = +$('capFps').value || res.fps || 240;
    const implied = cur / Math.sqrt(dec / 1.5);          // 1.5 m/s²: a normal surface
    const near = [30, 60, 120, 240].reduce((b, f) =>
      Math.abs(f - implied) < Math.abs(b - implied) ? f : b);
    res.warnings.push(
      `The ball slows at ${dec.toFixed(1)} m/s²; a putting surface takes off about 1–2. ` +
      `Deceleration scales with the square of the capture rate, so this points at ` +
      `<b>${near} fps</b> rather than ${cur}. Speed and tempo are affected — angles are not.`);
  }
  res.elapsed = (performance.now() - t0) / 1000;
  S.frames = frames; S.result = res;

  btn.disabled = false; btn.textContent = 'Analyse the stroke';
  $('progWrap').classList.add('hidden');

  if (res.impactTime == null) {
    // Say which cause fired. The old text named the mat corners and the ball
    // brightness floor every time, including the many times both were fine.
    return errRetry(res.impactReason || 'Could not find impact.');
  }
  finishAnalysis(res, { hasClip: true, renderUrl: null });
};

/* Shared by the local run above and analyseOnServer() below: both produce the
   same analyseStroke() shape, just from a different detector, so everything
   past that point — implausibility handling, history, the Analyze view — is
   one path. `extra.hasClip` says whether S.previews has this putt's bitmaps
   (only the local run decodes any); `extra.renderUrl`, when set, is the
   server's own rendered picture, shown in place of the video stage. */
function finishAnalysis(res, extra) {
  // Impact was found, but the face-vs-start-line geometry says the putter
  // measurement describes something other than the putter. Blanking only those
  // metrics beats refusing the whole putt: the ball was tracked, so impact,
  // start line and speed stand on their own and are worth showing. The blanked
  // fields stay null all the way into the session row, and both the dispersion
  // chart and sessionStats already skip nulls, so nothing false is averaged in.
  if (res.implausible) {
    res.faceDeg = null; res.pathDeg = null; res.faceToPathDeg = null;
    res.faceRateDegPerSec = null; res.faceSeries = null; res.headPath = null;
    res.backLenMm = null; res.tempoRatio = null;
    // These come off the same discredited putter track. tStart/tTop in
    // particular drive the timeline's takeaway and top markers, so leaving them
    // draws stroke phases for a stroke we just said we could not measure.
    res.headSpeed = null; res.blurPerFrame = null; res.faceFitRmsDeg = null;
    res.throughLenMm = null; res.tStart = null; res.tTop = null;
    res.warnings.unshift(res.implausible);
  }

  const rec = {
    t: new Date().toISOString(),
    faceDeg: res.faceDeg, pathDeg: res.pathDeg, faceToPathDeg: res.faceToPathDeg,
    startLineDeg: res.startLineDeg, ballSpeed: res.ballSpeed, tempoRatio: res.tempoRatio,
    fps: res.fps, backLenMm: res.backLenMm, missAt3mCm: res.missAt3mCm,
    faceSeries: res.faceSeries, headPath: res.headPath, ballPath: res.ballPath,
    impactTime: res.impactTime, tStart: res.tStart, tTop: res.tTop,
    hasClip: !!extra.hasClip, renderUrl: extra.renderUrl || null,
    implausible: res.implausible || null
  };
  for (const h of S.history) h.hasClip = false;      // only the newest keeps its frames
  S.history.push(rec);
  S.selected = S.history.length - 1;
  saveHistory();

  navBtns('analyze').forEach(b => b.disabled = false);
  S.playT = res.impactTime;
  showPutt(S.selected);
  view('analyze');

  for (const w of res.warnings) msg(w, 'warn');
  if (!res.warnings.length) {
    msg(`Impact at ${(res.impactTime * 1000).toFixed(1)} ms · ${fmt(res.fps, 0)} fps · ` +
        `processed in ${fmt(res.elapsed, 1)} s`, 'ok', 6000);
  }
}

/* ============================ server-assisted ============================ */
// Same file, sent to /api/analyse instead of decoded locally. The server runs
// its own OpenCV detector (server/vision.py) and hands back {t, ball, face,
// head} per frame — the exact shape analyseStroke() already consumes, so the
// tested arithmetic runs unchanged; only where the observations came from
// differs. Only wired as a fallback (see errRetry) — it needs a server
// reachable at this origin, which a plain `python3 -m http.server` never is,
// and it only understands a printed centre-line mat, not tapped corners.
const SERVER_LABEL = { queued: 'Queued on the server…', decoding: 'Decoding on the server…',
                        analysing: 'Finding the ball, club and mat line…', drawing: 'Drawing the result…' };

// The button itself is the loading indicator — a toast alone left the retry
// button sitting there looking clickable (and unclicked) with no sign
// anything was happening. Same disable+relabel pattern as #btnRun.
function serverBusy(disabled, text) {
  const btn = $('btnServerRetry');
  if (!btn) return;                 // srcInfo may have moved on (new file picked)
  btn.disabled = disabled;
  btn.textContent = text;
  $('serverProgWrap')?.classList.toggle('hidden', !disabled);
}

async function analyseOnServer() {
  if (!S.buffer) return;
  serverBusy(true, 'Uploading…');

  const fd = new FormData();
  fd.append('file', new Blob([S.buffer]), S.fileName || 'clip.mov');
  if ($('capFps').value) fd.append('capture_fps', $('capFps').value);

  let id;
  try {
    const r = await fetch('/api/analyse', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`server rejected the upload (${r.status})`);
    ({ id } = await r.json());
    if (!id) throw new Error('server accepted the upload but returned no job');
  } catch (e) {
    serverBusy(false, 'Try server-side detection');
    return msg(`No server available for a second pass: ${e.message}`, 'err', 9000);
  }

  // A dropped poll is not a dead job — the work carries on server-side, so
  // retry a few times before giving up.
  let misses = 0;
  while (true) {
    await new Promise(res => setTimeout(res, 700));
    let s;
    try {
      const r = await fetch(`/api/analyse/${id}`);
      if (!r.ok) {
        serverBusy(false, 'Try server-side detection');
        return msg(r.status === 404 ? 'The server forgot this job — try again.'
                                     : `The server returned ${r.status}.`, 'err', 9000);
      }
      s = await r.json();
      misses = 0;
    } catch (e) {
      if (++misses > 20) {
        serverBusy(false, 'Try server-side detection');
        return msg('Lost contact with the server.', 'err', 9000);
      }
      continue;
    }
    if (s.state === 'failed') {
      serverBusy(false, 'Try server-side detection');
      return msg(`Server analysis failed: ${s.error}`, 'err', 12000);
    }
    if (s.state === 'done') return handleServerResult(s, id);
    serverBusy(true, SERVER_LABEL[s.state] || s.state);
    if (s.state === 'analysing') $('serverProg').style.width = (s.progress || 0) + '%';
  }
}

function handleServerResult(s, id) {
  const r = s.result;
  // Always markerless: server/vision.py finds the head by shape and brightness,
  // not by hue-matching a sticker — the local mode dropdown describes the
  // local detector, not this one, and following it here mislabels the result.
  const res = analyseStroke(r.observations, { markerless: true });
  res.elapsed = 0;
  res.warnings = res.warnings || [];
  res.warnings.push(`Server detection: ball tracked in ${r.ballFrames} of ${r.frames} frames · ` +
    `mat line in ${r.lineFrames} · club in ${r.headFrames}.`);
  if (res.impactTime == null) {
    // No local corners to fall back to and no third detector to try — say so
    // plainly rather than looping the same retry button. Reset it too, or it
    // sits disabled reading "Drawing the result…" with nothing left to do.
    serverBusy(false, 'Try server-side detection');
    return msg(res.impactReason || 'The server could not find impact either.', 'err', 12000);
  }
  serverBusy(false, 'Try server-side detection');
  finishAnalysis(res, { hasClip: false, renderUrl: s.hasRender ? `/api/render/${id}` : null });
}

/* ============================ analyze view ============================ */
function showPutt(i) {
  const r = S.history[i];
  if (!r) return;
  S.selected = i;

  $('puttNo').textContent = `Putt ${i + 1}`;
  $('puttOf').textContent = `of ${S.history.length}`;
  $('pills').innerHTML = S.history.map((_, k) =>
    `<button data-i="${k}" class="${k === i ? 'on' : ''}">${k + 1}</button>`).join('');
  $('pills').querySelectorAll('button').forEach(b =>
    b.onclick = () => { S.playT = S.history[+b.dataset.i].impactTime; showPutt(+b.dataset.i); });

  $('rF2P').textContent = sgn(r.faceToPathDeg);
  $('rStart').textContent = sgn(r.startLineDeg);
  $('rStartU').textContent = r.missAt3mCm != null
    ? `deg · ${fmt(Math.abs(r.missAt3mCm), 1)} cm at 3 m` : 'deg';
  $('rFace').textContent = sgn(r.faceDeg);
  $('rPath').textContent = sgn(r.pathDeg);
  $('rPathU').textContent = r.pathDeg == null ? 'deg' : (r.pathDeg > 0 ? 'deg · in-to-out' : 'deg · out-to-in');
  $('rSpeed').textContent = fmt(r.ballSpeed, 2);
  $('rTempo').textContent = fmt(r.tempoRatio, 2);
  $('rTempoU').textContent = 'back : through';

  const fsd = sessionStats(S.history.map(h => h.faceToPathDeg)).sd;
  const ssd = sessionStats(S.history.map(h => h.startLineDeg)).sd;
  $('rFaceSD').textContent = fsd == null ? '—' : fsd.toFixed(2);
  $('rFaceSDU').textContent = `deg · ${S.history.length} putt${S.history.length > 1 ? 's' : ''}`;
  $('rStartSD').textContent = ssd == null ? '—' : ssd.toFixed(2);
  $('rStartSDU').textContent = `deg · ${S.history.length} putt${S.history.length > 1 ? 's' : ''}`;

  if (S.playT == null) S.playT = r.impactTime;
  renderTimeline(); renderTicks(); renderPlayhead();
  renderTable();
}

function currentRes() { return S.history[S.selected] || null; }

function renderTimeline() {
  const r = currentRes();
  if (!r) return;
  S.tlMap = drawTimeline($('cvTl'), r, S.playT);
}

function renderTicks() {
  const r = currentRes();
  if (!r || !S.tlMap) return;
  const { t0, t1 } = S.tlMap;
  const pc = t => ((t - t0) / (t1 - t0) * 100).toFixed(1) + '%';
  $('ticks').innerHTML =
    `<span style="left:0;transform:none">${t0.toFixed(2)}</span>` +
    (r.tTop != null ? `<span style="left:${pc(r.tTop)}">top</span>` : '') +
    (r.impactTime != null ? `<span class="imp" style="left:${pc(r.impactTime)}">IMPACT</span>` : '') +
    `<span style="right:0;left:auto;transform:none">${t1.toFixed(2)} s</span>`;
}

function nearest(arr, t, key = 't') {
  if (!arr || !arr.length) return null;
  let best = arr[0], bd = Infinity;
  for (const a of arr) { const d = Math.abs(a[key] - t); if (d < bd) { bd = d; best = a; } }
  return best;
}

function renderPlayhead() {
  const r = currentRes();
  const c = $('cvPlay');
  if (!r || !S.tlMap) return;

  // A server-assisted putt has no locally-decoded preview bitmaps and no
  // homography (the server does its own printed-line calibration, not the
  // tapped corners) — so there is nothing to scrub a canvas overlay over.
  // Show the server's own rendered picture instead of the usual video stage.
  if (r.renderUrl) {
    $('vidwrap').classList.add('hidden');
    $('renderShot').src = r.renderUrl;
    $('renderShot').classList.remove('hidden');
    $('liveChip').textContent = '—';
    return;
  }
  $('renderShot').classList.add('hidden');
  $('vidwrap').classList.remove('hidden');

  const t = S.playT ?? r.impactTime;

  const hasClip = r.hasClip && S.previews.length;
  const pv = hasClip ? nearest(S.previews, t) : null;

  const W = pv ? pv.bmp.width : 640;
  const Hh = pv ? pv.bmp.height : 360;
  if (c.width !== W || c.height !== Hh) {
    c.width = W; c.height = Hh;
    // Drive the wrapper's aspect from the clip so the overlay layer is exactly
    // the size of the picture.
    $('vidwrap').style.aspectRatio = `${W} / ${Hh}`;
  }
  const g = c.getContext('2d');

  if (pv) g.drawImage(pv.bmp, 0, 0);
  else {
    g.fillStyle = '#141414'; g.fillRect(0, 0, W, Hh);
    g.fillStyle = '#7e7d78'; g.font = '15px system-ui'; g.textAlign = 'center';
    g.fillText('Clip not retained for this putt — numbers and timeline only', W / 2, Hh / 2);
  }

  // Overlays need this putt's homography. Only the live clip has one that
  // matches its own frames, so skip drawing on a stale putt.
  if (!pv || !S.Hinv) return;
  const k = S.previewScale;
  // Undo the ball-derived rescale before projecting. finish() multiplies every
  // mat coordinate by scaleK, but S.Hinv is still the nominal-width homography,
  // so without this the ball circle, its path and the head arc are all drawn at
  // scaleK times their true position — visibly off the ball in the preview.
  const sk = S.scaleK || 1;
  const toPx = m => {
    const p = applyH(S.Hinv, m.x / sk + S.matW / 2, m.y / sk);
    return { x: p.x * k, y: p.y * k };
  };
  const kk = W / 640;

  // target line down the mat
  const a = toPx({ x: 0, y: 0 }), b = toPx({ x: 0, y: S.matL });
  g.strokeStyle = '#e8622a'; g.lineWidth = 3 * kk; g.lineCap = 'round';
  g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();

  // putter head arc, traced up to the playhead
  const head = (r.headPath || []).filter(p => p.t <= t);
  if (head.length > 1) {
    g.strokeStyle = '#22c55e'; g.lineWidth = 3 * kk; g.beginPath();
    head.forEach((p, i) => { const q = toPx(p); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
    g.stroke();
  }

  // ball path after impact, up to the playhead
  const ball = (r.ballPath || []).filter(p => p.t >= (r.impactTime ?? 0) && p.t <= t);
  if (ball.length > 1) {
    g.strokeStyle = '#fff'; g.lineWidth = 2.4 * kk; g.setLineDash([9 * kk, 6 * kk]);
    g.beginPath();
    ball.forEach((p, i) => { const q = toPx(p); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
    g.stroke(); g.setLineDash([]);
  }
  const bnow = nearest(r.ballPath, t);
  if (bnow) {
    const q = toPx(bnow);
    g.strokeStyle = '#fff'; g.lineWidth = 2.4 * kk;
    g.beginPath(); g.arc(q.x, q.y, 15 * kk, 0, 7); g.stroke();
  }

  // face line at the playhead, from the tracked frame
  const fr = S.frames ? nearest(S.frames.filter(f => f.face), t) : null;
  if (fr) {
    const p1 = toPx(fr.face.a), p2 = toPx(fr.face.b);
    g.strokeStyle = '#3987e5'; g.lineWidth = 5 * kk; g.lineCap = 'round';
    g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke();
  }

  const fs = nearest(r.faceSeries, t);
  $('liveChip').textContent = fs ? `FACE ${sgn(fs.deg)}°` : '—';
  const fi = S.previews.length ? S.previews.indexOf(pv) : 0;
  $('playChip').textContent = `${t.toFixed(3)} s · preview ${fi + 1}/${S.previews.length}` +
    (Math.abs(t - (r.impactTime ?? -9)) < 1e-6 ? ' · impact' : '');

  // scrub UI
  const { t0, t1 } = S.tlMap;
  const pct = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  $('trackFill').style.width = (pct * 100) + '%';
  $('trackKnob').style.left = (pct * 100) + '%';
}

function setPlay(t) {
  if (!S.tlMap) return;
  S.playT = Math.max(S.tlMap.t0, Math.min(S.tlMap.t1, t));
  renderTimeline(); renderPlayhead();
}

/* drag on the scrub track */
function dragHandler(el, toTime) {
  let active = false;
  const move = ev => { if (active) { ev.preventDefault(); setPlay(toTime(ev)); } };
  el.addEventListener('pointerdown', ev => {
    active = true; el.setPointerCapture?.(ev.pointerId); setPlay(toTime(ev));
  });
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', () => { active = false; });
  el.addEventListener('pointercancel', () => { active = false; });
}
dragHandler($('track'), ev => {
  const r = $('track').getBoundingClientRect();
  const p = (ev.clientX - r.left) / r.width;
  return S.tlMap.t0 + p * (S.tlMap.t1 - S.tlMap.t0);
});
dragHandler($('cvTl'), ev => {
  const r = $('cvTl').getBoundingClientRect();
  return S.tlMap.timeAtX(Math.max(0, Math.min(r.width, ev.clientX - r.left)) * ($('cvTl').clientWidth / r.width));
});

/* arrow keys step one preview frame */
window.addEventListener('keydown', ev => {
  if (!S.tlMap || $('view-analyze').classList.contains('hidden')) return;
  const step = (S.tlMap.t1 - S.tlMap.t0) / Math.max(1, S.previews.length - 1);
  if (ev.key === 'ArrowRight') { setPlay((S.playT ?? 0) + step); ev.preventDefault(); }
  if (ev.key === 'ArrowLeft') { setPlay((S.playT ?? 0) - step); ev.preventDefault(); }
  if (ev.key === 'i') setPlay(currentRes()?.impactTime ?? 0);
});

let rz;
window.addEventListener('resize', () => {
  clearTimeout(rz);
  rz = setTimeout(() => { if (!$('view-analyze').classList.contains('hidden')) { renderTimeline(); renderTicks(); renderPlayhead(); } }, 120);
});

/* ============================ session ============================ */
function renderTable() {
  const h = [...S.history].reverse().slice(0, 14);
  if (!h.length) return $('histTable').innerHTML = '';
  let t = '<thead><tr><th>#</th><th>Face</th><th>Path</th><th>F→P</th><th>Start</th><th>Speed</th></tr></thead><tbody>';
  h.forEach((r, i) => {
    const hi = S.history.length - 1 - i;   // renderTable's list is newest-first; S.history is not
    t += `<tr class="row hrow${hi === S.selected ? ' sel' : ''}" data-i="${hi}">` +
         `<td>${hi + 1}</td><td>${sgn(r.faceDeg)}</td><td>${sgn(r.pathDeg)}</td>` +
         `<td>${sgn(r.faceToPathDeg)}</td><td>${sgn(r.startLineDeg)}</td><td>${fmt(r.ballSpeed, 2)}</td></tr>`;
  });
  $('histTable').innerHTML = t + '</tbody>';
  $('histTable').querySelectorAll('tr[data-i]').forEach(tr =>
    tr.onclick = () => { S.playT = S.history[+tr.dataset.i].impactTime; showPutt(+tr.dataset.i); view('analyze'); });
}

function openDB() {
  return new Promise(res => {
    const rq = indexedDB.open('puttlabpro', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
  });
}
async function saveHistory() {
  S.db = S.db || await openDB(); if (!S.db) return;
  // strip the per-frame series before persisting — they are large and only
  // useful while the clip is loaded
  const slim = S.history.map(({ faceSeries, headPath, ballPath, ...rest }) => rest);
  S.db.transaction('kv', 'readwrite').objectStore('kv').put(slim, 'history');
}
async function loadHistory() {
  S.db = S.db || await openDB(); if (!S.db) return;
  const rq = S.db.transaction('kv', 'readonly').objectStore('kv').get('history');
  rq.onsuccess = () => {
    if (Array.isArray(rq.result) && rq.result.length) {
      S.history = rq.result.map(r => ({ ...r, hasClip: false }));
      renderTable(); dispersionChart($('chDisp'), S.history);
    }
  };
}

$('btnCsv').onclick = () => {
  const cols = ['t', 'faceDeg', 'pathDeg', 'faceToPathDeg', 'startLineDeg', 'ballSpeed', 'tempoRatio', 'fps', 'backLenMm'];
  const rows = [['#', ...cols].join(',')];
  S.history.forEach((r, i) => rows.push([i + 1, ...cols.map(c =>
    typeof r[c] === 'number' ? r[c].toFixed(4) : (r[c] ?? ''))].join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  a.download = 'puttlab-session.csv'; a.click();
};
$('btnClear').onclick = () => {
  S.history = []; S.selected = -1; saveHistory();
  renderTable(); dispersionChart($('chDisp'), S.history);
  navBtns('analyze').forEach(b => b.disabled = true); view('setup');
};

/* ============================ boot ============================ */
if (!webCodecsSupported()) {
  msg('This browser has no WebCodecs <code>VideoDecoder</code> — that is what makes 240 fps analysis ' +
      'possible. Use Safari 16.4+, Chrome 94+, or a recent Android Chrome.', 'err');
  $('btnFile').disabled = true; $('btnDemo').disabled = true;
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
loadHistory();
updateCal();

window.PuttLabApp = { S, view, setPlay, showPutt };
