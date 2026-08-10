/* Verification for PuttLab Pro.
   Runs the real pipeline — demux, WebCodecs decode, per-frame CV, metrics —
   against a synthetic stroke whose ground truth was rendered in, not guessed.
   node test/verify.mjs
*/
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.json': 'application/json', '.mp4': 'video/mp4', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const p = path.join(ROOT, rel === '/' ? '/index.html' : rel);
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(8111);

const R = [];
const check = (name, pass, detail) => R.push({ name, pass, detail });
const near = (got, want, tol) => got != null && Math.abs(got - want) <= tol;

const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/stroke_truth.json'), 'utf8'));
const truthF2P = truth.faceToPathDeg;

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
page.on('pageerror', e => console.log('  [pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error') console.log('  [console]', m.text()); });
await page.goto('http://localhost:8111/test/harness.html');
await page.waitForFunction(() => window.PL_READY, null, { timeout: 20000 });

// The fixture's tempo truth and analyse.js's takeaway detection are two independent
// literals (Python and JS) that happen to both say 0.05 — CLAUDE.md claims the fixture
// "evaluates the same rule," but nothing enforced that. Pin it.
const takeawayFractionLinked = await page.evaluate(() => window.PL.TAKEAWAY_FRACTION);
check('Fixture takeawayFraction matches analyse.js TAKEAWAY_FRACTION',
  truth.takeawayFraction === takeawayFractionLinked,
  `fixture ${truth.takeawayFraction}, analyse.js ${takeawayFractionLinked}`);

/* ---------- A. demuxer vs ffprobe, all codecs ---------- */
for (const f of ['h264', 'hevc', 'vp9']) {
  const packets = JSON.parse(execSync(
    `ffprobe -v error -select_streams v:0 -show_packets -of json ${ROOT}/fixtures/${f}.mp4`).toString())
    .packets;
  const truthPts = packets.map(p => +p.pts).sort((a, b) => a - b);
  // Packet order IS decode order (that's what "packet" means in a bitstream) — unsorted,
  // this is the sequence VideoDecoder.decode() must see. For a B-frame clip it differs
  // from presentation order.
  const truthDecodeDts = packets.map(p => +p.dts);
  const mine = await page.evaluate(async (name) => {
    const buf = await (await fetch(`/fixtures/${name}.mp4`)).arrayBuffer();
    const i = window.PL.demuxMp4(buf);
    return { pts: i.samples.map(s => s.cts), dts: i.samples.map(s => s.dts),
             codec: i.config.codec, b: i.hasBFrames };
  }, f);
  const shift = truthPts[0];
  const minePtsSorted = [...mine.pts].sort((a, b) => a - b);   // samples are in decode order now; compare as a set
  const ok = minePtsSorted.length === truthPts.length &&
             minePtsSorted.every((v, i) => v === truthPts[i] - shift);
  check(`Demux ${f}: timestamps match ffprobe`, ok,
    `${mine.pts.length} samples, codec ${mine.codec}, B-frames ${mine.b}`);

  // Compare deltas from each side's own first sample — mp4.js normalises its shift off
  // the earliest *presented* cts, ffprobe's dts is container-relative, so the absolute
  // bases differ; the decode-order sequence shape must not.
  const mineRel = mine.dts.map(v => v - mine.dts[0]);
  const truthRel = truthDecodeDts.map(v => v - truthDecodeDts[0]);
  const decodeOrderOk = mineRel.length === truthRel.length &&
             mineRel.every((v, i) => v === truthRel[i]);
  check(`Demux ${f}: samples kept in decode order (not resorted to presentation order)`,
    decodeOrderOk, decodeOrderOk ? 'matches ffprobe packet order' :
      `mismatch at first diff index ${mineRel.findIndex((v, i) => v !== truthRel[i])}`);
}

/* fixtures/elst.mp4: an h264 clip trimmed with `ffmpeg -ss 0.1 -c copy`, which writes a
   real edit list (moov/trak/edts/elst) with a nonzero media_time instead of re-encoding.
   The two Section-A checks above normalise both sides to their own first sample, so they
   pass identically whether or not elst is parsed at all — this is the one that actually
   exercises it: the edit list's first-frame count/deltas must be untouched, and the elst
   media_time (not a same-value coincidence) must be what zeroes the first sample's cts. */
{
  const packets = JSON.parse(execSync(
    `ffprobe -v error -select_streams v:0 -show_packets -of json ${ROOT}/fixtures/elst.mp4`).toString())
    .packets;
  const mine = await page.evaluate(async () => {
    const buf = await (await fetch('/fixtures/elst.mp4')).arrayBuffer();
    const i = window.PL.demuxMp4(buf);
    return { cts: i.samples.map(s => s.cts) };
  });
  const firstIsZero = mine.cts[0] === 0;
  const countAndDeltasUnchanged = mine.cts.length === packets.length &&
    mine.cts.every((v, i) => i === 0 || (v - mine.cts[i - 1]) === (+packets[i].pts - +packets[i - 1].pts));
  check('Edit list (elst) normalises the first frame to t=0 without disturbing sample count/deltas',
    firstIsZero && countAndDeltasUnchanged,
    `first cts ${mine.cts[0]}, ${mine.cts.length} samples (ffprobe ${packets.length})`);
}

/* ---------- B. angle folding / unwrapping ---------- */
const angles = await page.evaluate(() => {
  const { foldFaceAngle, unwrapAngles, bearingDeg } = window.PL;
  return {
    fold: [0, 45, 90, 91, 179, 180, -1, -91].map(foldFaceAngle),
    // a face rotating through the wrap point must come out continuous
    unwrap: unwrapAngles([85, 88, 89.5, -89, -86, -83]),
    bearing: [bearingDeg(0, 1), bearingDeg(1, 1), bearingDeg(-1, 1)]
  };
});
const uw = angles.unwrap;
const monotonic = uw.every((v, i) => i === 0 || v > uw[i - 1]);
check('Face angle folds to (−90,90] and unwraps continuously',
  monotonic && Math.abs(angles.fold[2] - 90) < 1e-9 && Math.abs(angles.fold[3] - (-89)) < 1e-9,
  `fold: ${angles.fold.map(v => v.toFixed(0)).join(',')} · unwrap monotonic: ${monotonic}`);

/* ---------- B2. homography / linear algebra primitives ----------
   geom.js is the single highest-consequence module in the repo — CLAUDE.md's own
   trap table says a wrong pivot here yields silent all-NaN homographies — and until
   now it was only exercised transitively, through the full pipeline, on one known-
   good quad. Test it directly. */
const geo = await page.evaluate((truthArg) => {
  const { computeHomography, invert3, applyH, solveLinear } = window.PL;
  const src = truthArg.quad.map(([x, y]) => ({ x, y }));
  const dst = [{ x: 0, y: 0 }, { x: truthArg.matW, y: 0 },
               { x: truthArg.matW, y: truthArg.matL }, { x: 0, y: truthArg.matL }];
  const H = computeHomography(src, dst);
  const roundTrip = H && src.map((p, i) => {
    const mapped = applyH(H, p.x, p.y);
    return Math.hypot(mapped.x - dst[i].x, mapped.y - dst[i].y);
  });
  const invH = H && invert3(H);
  const invRoundTrip = invH && dst.map((p, i) => {
    const back = applyH(invH, p.x, p.y);
    return Math.hypot(back.x - src[i].x, back.y - src[i].y);
  });
  // Three collinear source points -> the DLT system is singular -> null, not NaN.
  const degenerate = computeHomography(
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 100 }], dst);
  // Known 3x3 system: 2x+y-z=8, -3x-y+2z=-11, -2x+y+2z=-3 -> x=2, y=3, z=-1.
  const solved = solveLinear([[2, 1, -1], [-3, -1, 2], [-2, 1, 2]], [8, -11, -3]);
  return { roundTrip, invRoundTrip, degenerate, solved };
}, { quad: truth.quad, matW: truth.matW, matL: truth.matL });

check('Homography maps its own 4 corners to the mat rectangle (round trip)',
  geo.roundTrip && geo.roundTrip.every(e => e < 1e-6),
  `max corner error ${geo.roundTrip ? Math.max(...geo.roundTrip).toExponential(2) : 'H was null'}`);
check('invert3(H) undoes the homography (inverse round trip)',
  geo.invRoundTrip && geo.invRoundTrip.every(e => e < 1e-6),
  `max corner error ${geo.invRoundTrip ? Math.max(...geo.invRoundTrip).toExponential(2) : 'invH was null'}`);
check('Degenerate (collinear) quad returns null, not NaN',
  geo.degenerate === null, geo.degenerate === null ? 'null as expected' : `got ${JSON.stringify(geo.degenerate)}`);
check('solveLinear matches a hand-computed 3x3 system',
  geo.solved && near(geo.solved[0], 2, 1e-9) && near(geo.solved[1], 3, 1e-9) && near(geo.solved[2], -1, 1e-9),
  `[${geo.solved ? geo.solved.map(v => v.toFixed(4)).join(', ') : 'null'}]`);

/* ---------- C. FULL PIPELINE on the synthetic stroke ---------- */
const run = await page.evaluate(async (t) =>
  window.PL.runFixture('/fixtures/stroke_vp9.mp4', t), truth);

check('Decoded every frame of the 240 fps clip',
  run.frameCount === truth.frames,
  `${run.frameCount}/${truth.frames} frames · ${run.info.codec} · container ${run.info.nominalFps.toFixed(1)} fps · ${(run.elapsedMs / 1000).toFixed(1)} s to process`);

check('Markers found in nearly every frame',
  run.faceFound > truth.frames * 0.97,
  `${run.faceFound}/${truth.frames} frames with a face line · ball in ${run.ballFound}`);

const r = run.result;
check('Detected frame rate is the true capture rate',
  near(r.fps, truth.fps, 2), `${r.fps?.toFixed(1)} fps (truth ${truth.fps})`);

check('Impact instant recovered sub-frame',
  near(r.impactTime, truth.impactTime, 1 / truth.fps),
  `${r.impactTime?.toFixed(5)} s vs truth ${truth.impactTime.toFixed(5)} s ` +
  `(err ${((r.impactTime - truth.impactTime) * 1000).toFixed(2)} ms, one frame = ${(1000 / truth.fps).toFixed(2)} ms)`);

check('FACE ANGLE at impact within 0.30°',
  near(r.faceDeg, truth.faceDeg, 0.30),
  `${r.faceDeg?.toFixed(3)}° vs truth ${truth.faceDeg}° (err ${Math.abs(r.faceDeg - truth.faceDeg).toFixed(3)}°)`);

check('PUTTER PATH at impact within 0.40°',
  near(r.pathDeg, truth.pathDeg, 0.40),
  `${r.pathDeg?.toFixed(3)}° vs truth ${truth.pathDeg}° (err ${Math.abs(r.pathDeg - truth.pathDeg).toFixed(3)}°)`);

check('FACE-TO-PATH (Arc-To-Face) within 0.50°',
  near(r.faceToPathDeg, truth.faceToPathDeg, 0.50),
  `${r.faceToPathDeg?.toFixed(3)}° vs truth ${truth.faceToPathDeg}° (err ${Math.abs(r.faceToPathDeg - truth.faceToPathDeg).toFixed(3)}°)`);

check('Face rotation rate within 8%',
  r.faceRateDegPerSec != null &&
  Math.abs(r.faceRateDegPerSec - truth.faceRateDegPerSec) / Math.abs(truth.faceRateDegPerSec) < 0.08,
  `${r.faceRateDegPerSec?.toFixed(1)}°/s vs truth ${truth.faceRateDegPerSec.toFixed(1)}°/s`);

check('Ball start line within 0.30°',
  near(r.startLineDeg, truth.startLineDeg, 0.30),
  `${r.startLineDeg?.toFixed(3)}° vs truth ${truth.startLineDeg}° (err ${Math.abs(r.startLineDeg - truth.startLineDeg).toFixed(3)}°)`);

check('Ball speed within 3%',
  r.ballSpeed != null && Math.abs(r.ballSpeed - truth.ballSpeed) / truth.ballSpeed < 0.03,
  `${r.ballSpeed?.toFixed(3)} m/s vs truth ${truth.ballSpeed} (${((r.ballSpeed / truth.ballSpeed - 1) * 100).toFixed(1)}%)`);

check('Tempo ratio within 5%',
  r.tempoRatio != null && Math.abs(r.tempoRatio - truth.tempoRatio) / truth.tempoRatio < 0.05,
  `${r.tempoRatio?.toFixed(3)} vs truth ${truth.tempoRatio.toFixed(3)} (back ${r.backSec?.toFixed(3)}s / fwd ${r.fwdSec?.toFixed(3)}s)`);

check('Backswing length within 8 mm',
  near(r.backLenMm, truth.backLenMm, 8),
  `${r.backLenMm?.toFixed(1)} mm vs truth ${truth.backLenMm} mm`);

check('Face-vs-start-line cross-check agrees',
  r.facePredictionErrorDeg != null && Math.abs(r.facePredictionErrorDeg) < 0.5,
  `ball started ${r.facePredictionErrorDeg?.toFixed(3)}° off the face (truth ${(truth.startLineDeg - truth.faceDeg).toFixed(2)}°)`);

/* ---------- D. the 60 fps claim, tested ---------- */
// blurPerFrame is arithmetic on faceRateDegPerSec (rate/60 vs rate/240) — it needs no
// extra pipeline run. Reuse Section C's `r`; running the fixture again here proved
// nothing beyond what check 8 (Face rotation rate) already proved, at the cost of a
// second full 5 s decode.
check('60 fps would blur the face by more than PerfectLine\'s claimed resolution',
  r.blurPerFrame && r.blurPerFrame.at60 > 0.3 && r.blurPerFrame.at240 < 0.3,
  `at 60 fps: ${r.blurPerFrame.at60.toFixed(3)}°/frame · at 240 fps: ${r.blurPerFrame.at240.toFixed(3)}°/frame ` +
  `(rotation ${Math.abs(r.faceRateDegPerSec).toFixed(0)}°/s)`);

/* ---------- E. markerless fallback is honest about being worse ---------- */
const ml = await page.evaluate(async (t) =>
  window.PL.runFixture('/fixtures/stroke_vp9.mp4', t, { opt: { markerless: true } }), truth);
// Bounded, not just "produced a number": CLAUDE.md and README both quote a specific
// 1.14° markerless error. Wide enough not to be brittle, tight enough that a regression
// to ~5° or a silent improvement to ~0.2° (which would mean the published number is
// stale either way) fails this instead of sailing through.
const mlErr = ml.result.faceDeg != null ? Math.abs(ml.result.faceDeg - truth.faceDeg) : null;
check('Markerless mode produces a face angle and flags itself approximate',
  ml.result.faceDeg != null && ml.result.warnings.some(w => /approximate/i.test(w)) &&
  mlErr > 0.5 && mlErr < 3.0,
  `markerless face ${ml.result.faceDeg?.toFixed(2)}° vs truth ${truth.faceDeg}° ` +
  `(err ${mlErr != null ? mlErr.toFixed(2) : '—'}°, expect 0.5–3.0°) — marker mode err ` +
  `${Math.abs(r.faceDeg - truth.faceDeg).toFixed(2)}°`);

/* ---------- F. the rendered-slow-mo trap ----------
   Same 324 frames, but muxed at 30 fps over 10.8 s — exactly what a phone
   hands you when the slow motion has already been baked in. Untreated,
   every speed reads 8× low. Stating the true capture rate must fix it. */
const naive = await page.evaluate(async (t) =>
  window.PL.runFixture('/fixtures/stroke_slowmo30.mp4', t), truth);
check('A rendered slow-mo clip reads 8× slow if you trust the container',
  naive.result.ballSpeed != null &&
  Math.abs(naive.result.ballSpeed - truth.ballSpeed / 8) / (truth.ballSpeed / 8) < 0.05,
  `container says ${naive.timing.containerFps.toFixed(1)} fps -> measured ` +
  `${naive.result.ballSpeed?.toFixed(3)} m/s (truth ${truth.ballSpeed}); flagged: ${naive.timing.looksRendered}`);

const fixed = await page.evaluate(async (t) =>
  window.PL.runFixture('/fixtures/stroke_slowmo30.mp4', t, { captureFps: 240 }), truth);
check('Stating the true capture rate recovers real-world speed and tempo',
  fixed.result.ballSpeed != null &&
  Math.abs(fixed.result.ballSpeed - truth.ballSpeed) / truth.ballSpeed < 0.03 &&
  Math.abs(fixed.result.tempoRatio - truth.tempoRatio) / truth.tempoRatio < 0.05,
  `${fixed.result.ballSpeed?.toFixed(3)} m/s (truth ${truth.ballSpeed}), ` +
  `tempo ${fixed.result.tempoRatio?.toFixed(3)} (truth ${truth.tempoRatio.toFixed(3)}), ` +
  `face ${fixed.result.faceDeg?.toFixed(3)}° — angles are scale-free so they never moved`);

/* ---------- G. the actual app UI, driven end to end ---------- */
const ui = await browser.newPage({ viewport: { width: 1180, height: 545 } });
const uiErrors = [];
ui.on('pageerror', e => uiErrors.push(e.message));
ui.on('console', m => { if (m.type() === 'error') uiErrors.push(m.text()); });
await ui.goto('http://localhost:8111/index.html');
await ui.waitForFunction(() => window.PuttLabApp, null, { timeout: 15000 });
await ui.click('#btnDemo');
await ui.waitForFunction(() => window.PuttLabApp.S.H != null, null, { timeout: 30000 });
await ui.click('#btnRun');
await ui.waitForFunction(
  () => window.PuttLabApp.S.result && document.querySelectorAll('#pills button').length > 0,
  null, { timeout: 180000 });

const uiRes = await ui.evaluate(() => {
  const r = window.PuttLabApp.S.result;
  return {
    face: r.faceDeg, f2p: document.getElementById('rF2P').textContent.trim(),
    start: document.getElementById('rStart').textContent.trim(),
    previews: window.PuttLabApp.S.previews.length,
    onAnalyze: !document.getElementById('view-analyze').classList.contains('hidden'),
    playCanvas: document.getElementById('cvPlay').width,
    tlCanvas: document.getElementById('cvTl').width,
    ticks: document.querySelectorAll('#ticks span').length
  };
});
check('Landscape UI runs the pipeline and lands on Analyze',
  uiRes.onAnalyze && Math.abs(uiRes.face - truth.faceDeg) < 0.3 && uiRes.previews > 20,
  `face ${uiRes.face?.toFixed(3)}° · tiles read F→P ${uiRes.f2p} / start ${uiRes.start} · ` +
  `${uiRes.previews} scrub frames retained`);

check('Video canvas, timeline canvas and phase ticks all rendered',
  uiRes.playCanvas > 100 && uiRes.tlCanvas > 100 && uiRes.ticks >= 3,
  `play ${uiRes.playCanvas}px · timeline ${uiRes.tlCanvas}px · ${uiRes.ticks} ticks`);

/* scrubbing must move the playhead and redraw without throwing */
const scrub = await ui.evaluate(() => {
  const A = window.PuttLabApp, before = A.S.playT;
  A.setPlay(A.S.tlMap.t0 + (A.S.tlMap.t1 - A.S.tlMap.t0) * 0.25);
  const mid = A.S.playT;
  A.setPlay(-999); const clampedLo = A.S.playT;
  A.setPlay(999);  const clampedHi = A.S.playT;
  return { before, mid, clampedLo, clampedHi, t0: A.S.tlMap.t0, t1: A.S.tlMap.t1,
           chip: document.getElementById('liveChip').textContent };
});
check('Scrubbing moves the playhead, clamps to the clip, and updates the live readout',
  scrub.mid !== scrub.before && Math.abs(scrub.clampedLo - scrub.t0) < 1e-9 &&
  Math.abs(scrub.clampedHi - scrub.t1) < 1e-9 && /FACE/.test(scrub.chip),
  `impact ${scrub.before?.toFixed(3)}s -> 25% ${scrub.mid.toFixed(3)}s · clamps [${scrub.t0.toFixed(2)}, ${scrub.t1.toFixed(2)}] · chip "${scrub.chip}"`);

check('No page errors during the UI run', uiErrors.length === 0,
  uiErrors.length ? uiErrors.slice(0, 3).join(' | ') : 'clean');
await ui.screenshot({ path: 'test/shot-analyze.png' });
await ui.evaluate(() => window.PuttLabApp.view('session'));
await ui.screenshot({ path: 'test/shot-session.png' });

/* ---------- H. the single-file bundle, served from nothing ---------- */
execSync('node build.mjs', { cwd: ROOT });   // force a fresh dist/ — nothing else in this
                                              // suite rebuilds it, so a stale bundle used
                                              // to be able to pass this indefinitely
const solo = await browser.newPage({ viewport: { width: 1180, height: 545 } });
const soloErr = [];
solo.on('pageerror', e => soloErr.push(e.message));
await solo.goto('http://localhost:8111/dist/puttlab-pro.html');
await solo.waitForFunction(() => window.PuttLabApp, null, { timeout: 15000 });
await solo.click('#btnDemo');
await solo.waitForFunction(() => window.PuttLabApp.S.H != null, null, { timeout: 30000 });
await solo.click('#btnRun');
await solo.waitForFunction(
  () => window.PuttLabApp.S.result != null && document.querySelectorAll('#pills button').length > 0,
  null, { timeout: 180000 });
const soloRes = await solo.evaluate(() => window.PuttLabApp.S.result.faceToPathDeg);
check('Single-file bundle works standalone with the demo inlined',
  Math.abs(soloRes - truthF2P) < 0.5 && soloErr.length === 0,
  `face-to-path ${soloRes?.toFixed(3)}° from a self-contained HTML file, ${soloErr.length} errors` +
  (soloErr.length ? ' — ' + soloErr.slice(0, 2).join(' | ') : ''));
await solo.close();

/* ---------- report ---------- */
console.log('\n  PuttLab Pro — verification\n  ' + '─'.repeat(76));
for (const x of R) console.log(`  ${x.pass ? 'PASS' : 'FAIL'}  ${x.name}\n        ${x.detail}`);
const failed = R.filter(x => !x.pass).length;
console.log('  ' + '─'.repeat(76));
console.log(`  ${R.length - failed}/${R.length} passed\n`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
