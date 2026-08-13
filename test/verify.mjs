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

/* fixtures/ctts_negative.mp4: fixtures/h264.mp4 with some of its ctts composition offsets
   negated in place. ISO 14496-12 says version-0 ctts offsets are unsigned, but real iPhone
   HEVC clips write version-0 boxes with negative offsets anyway — mp4.js used to trust the
   spec (`getUint32` for version 0) and those offsets wrapped to ~4.29e9, poisoning every
   downstream timestamp. The reference below reads offsets as signed unconditionally, which
   is the only interpretation that matches what real devices put in the box. */
{
  const mine = await page.evaluate(async () => {
    const buf = await (await fetch('/fixtures/ctts_negative.mp4')).arrayBuffer();
    const dv = new DataView(buf);

    function* boxes(start, end) {
      let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p);
        const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
        if (size === 0) size = end - p;
        yield { type, start: p + 8, end: p + size };
        p += size;
      }
    }
    function findPath(start, end, path) {
      let cur = { start, end };
      for (const t of path) {
        let found = null;
        for (const b of boxes(cur.start, cur.end)) if (b.type === t) { found = b; break; }
        if (!found) return null;
        cur = found;
      }
      return cur;
    }

    const moov = findPath(0, dv.byteLength, ['moov']);
    const stbl = findPath(moov.start, moov.end, ['trak', 'mdia', 'minf', 'stbl']);
    const stts = findPath(stbl.start, stbl.end, ['stts']);
    const ctts = findPath(stbl.start, stbl.end, ['ctts']);
    const elst = findPath(moov.start, moov.end, ['trak', 'edts', 'elst']);

    const deltas = [];
    { const n = dv.getUint32(stts.start + 4); let p = stts.start + 8;
      for (let i = 0; i < n; i++, p += 8) { const c = dv.getUint32(p), d = dv.getUint32(p + 4);
        for (let k = 0; k < c; k++) deltas.push(d); } }
    const offs = [];
    { const n = dv.getUint32(ctts.start + 4); let p = ctts.start + 8;
      for (let i = 0; i < n; i++, p += 8) { const c = dv.getUint32(p), o = dv.getInt32(p + 4);   // always signed
        for (let k = 0; k < c; k++) offs.push(o); } }
    const mediaTime = dv.getInt32(elst.start + 12);   // version/flags(4) + entry_count(4) + duration(4), then media_time

    let dts = 0; const cts = [];
    for (let i = 0; i < deltas.length; i++) { cts.push(dts + (offs[i] || 0)); dts += deltas[i]; }
    const shift = mediaTime;
    const expected = cts.map(v => v - shift);

    const i = window.PL.demuxMp4(buf);
    return { expected, actual: i.samples.map(s => s.cts), negativeOffsets: offs.filter(o => o < 0).length };
  });
  const ok = mine.negativeOffsets > 0 && mine.actual.length === mine.expected.length &&
    mine.actual.every((v, i) => v === mine.expected[i]);
  check('ctts version-0 negative composition offsets are read as signed, not wrapped unsigned',
    ok, ok ? `${mine.negativeOffsets} negative offsets, all matched` :
      `mismatch at index ${mine.actual.findIndex((v, i) => v !== mine.expected[i])}: got ${mine.actual[0]}, want ${mine.expected[0]}`);
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

/* ---------- B3. the ball detector must be able to say "nothing here" ----------
   The stroke fixture's ball never leaves the mat (it stops at ~1135 mm of 3000),
   so nothing in section C exercises the case that broke on a real clip: the ball
   is struck, rolls out of shot, and every remaining frame still reports a ball.
   detectBall used to return the intensity-weighted centroid of every qualifying
   pixel in the ROI, so a scatter of carpet blemishes summed into a confident
   phantom, the tracker locked onto it, and analyseStroke reported "the ball was
   never tracked moving". Two synthetic rasters, no video needed. */
const ballDet = await page.evaluate(() => {
  const W = 640, Hh = 360;
  const blank = () => {
    const p = new Uint8ClampedArray(W * Hh * 4);
    for (let i = 0; i < p.length; i += 4) { p[i] = 30; p[i + 1] = 70; p[i + 2] = 40; p[i + 3] = 255; }
    return p;
  };
  const put = (p, x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= Hh) return;
    const i = ((y | 0) * W + (x | 0)) * 4; p[i] = r; p[i + 1] = g; p[i + 2] = b;
  };
  // 60 isolated bright desaturated pixels on a coarse grid — no two 4-connected.
  // Well over minPx (6) in total, so the old summing detector happily returned
  // their centre of mass.
  const speckle = p => { for (let k = 0; k < 60; k++) put(p, 110 + 13 * (k % 16), 90 + 13 * ((k / 16) | 0), 205, 205, 200); };
  const ellipse = (p, cx, cy, rx, ry) => {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) put(p, x, y, 250, 250, 248);
      }
  };
  // A 4-connected plus of two 20×2 bars: n≈76 (well over minPx), one component,
  // fill≈0.19 of its 20×20 bbox. This is the shape a shadow edge or a felt seam
  // makes, and connectivity alone will not reject it — only the fill floor does.
  const smear = p => {
    for (let x = 290; x <= 309; x++) { put(p, x, 200, 205, 205, 200); put(p, x, 201, 205, 205, 200); }
    for (let y = 190; y <= 209; y++) { put(p, 299, y, 205, 205, 200); put(p, 300, y, 205, 205, 200); }
  };
  const full = { x0: 0, y0: 0, x1: W - 1, y1: Hh - 1 };
  const run = draw => { const p = blank(); draw(p); return window.PL.detectBall(p, W, Hh, full, {}); };

  return {
    phantom: run(speckle),                                     // must be null
    smear:   run(smear),                                       // must be null
    clean:   run(p => ellipse(p, 300, 200, 7, 7)),             // a still ball
    blurred: run(p => { speckle(p); ellipse(p, 300, 200, 5, 12); }),  // motion-smeared, noise present
    clipped: run(p => ellipse(p, 636, 200, 7, 7))              // half outside the raster
  };
});
const shown = b => b ? `a ball at ${b.x.toFixed(1)}, ${b.y.toFixed(1)} (n=${b.n})` : 'null';
check('detectBall rejects noise — a speckle field and a low-fill smear — instead of a phantom centroid',
  ballDet.phantom === null && ballDet.smear === null,
  `60-px speckle field -> ${shown(ballDet.phantom)} · 76-px low-fill smear -> ${shown(ballDet.smear)}`);
check('detectBall still finds a real ball: still, motion-blurred, and clipped by the frame edge',
  ballDet.clean && Math.hypot(ballDet.clean.x - 300, ballDet.clean.y - 200) < 1.5 &&
  ballDet.blurred && Math.hypot(ballDet.blurred.x - 300, ballDet.blurred.y - 200) < 1.5 &&
  ballDet.clipped && Math.abs(ballDet.clipped.y - 200) < 1.5,
  `clean ${ballDet.clean ? `n=${ballDet.clean.n} fill=${ballDet.clean.fill?.toFixed(2) ?? '—'}` : 'MISSED'} · ` +
  `blurred ${ballDet.blurred ? `n=${ballDet.blurred.n} fill=${ballDet.blurred.fill?.toFixed(2) ?? '—'}` : 'MISSED'} · ` +
  `clipped ${ballDet.clipped ? `n=${ballDet.clipped.n} fill=${ballDet.clipped.fill?.toFixed(2) ?? '—'}` : 'MISSED'}`);

/* The tracker half: the ball must stop being reported once it leaves shot, and
   stay unreported past the six-miss reset that turns the primary search back
   into a full-mat one. */
const ballGone = await page.evaluate(() => {
  const W = 640, Hh = 360, PRESENT = 15, ABSENT = 15;
  const quad = [{ x: 60, y: 352 }, { x: 580, y: 352 }, { x: 460, y: 40 }, { x: 180, y: 40 }];
  const H = window.PL.computeHomography(quad,
    [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 3000 }, { x: 0, y: 3000 }]);
  const tracker = window.PL.createTracker({ H, quad, matW: 400, srcWidth: W, srcHeight: Hh });
  const found = [];
  for (let f = 0; f < PRESENT + ABSENT; f++) {
    const p = new Uint8ClampedArray(W * Hh * 4);
    for (let i = 0; i < p.length; i += 4) { p[i] = 30; p[i + 1] = 70; p[i + 2] = 40; p[i + 3] = 255; }
    const put = (x, y, r, g, b) => { const i = ((y | 0) * W + (x | 0)) * 4; p[i] = r; p[i + 1] = g; p[i + 2] = b; };
    for (let k = 0; k < 60; k++) put(110 + 13 * (k % 16), 90 + 13 * ((k / 16) | 0), 205, 205, 200);
    if (f < PRESENT) {                       // ball rolls up the mat, then leaves shot
      // Radius is tied to this quad's scale: 400 mm spans 520 px at the near
      // edge and 280 px at the far one, so a 42.7 mm ball images 55 px across
      // down here and 30 px up there. The tracker now gates on that geometry,
      // so a ball drawn off-scale is correctly refused.
      const cx = 320, cy = 300 - f * 12;
      for (let y = cy - 16; y <= cy + 16; y++)
        for (let x = cx - 16; x <= cx + 16; x++)
          if ((x - cx) ** 2 + (y - cy) ** 2 <= 256) put(x, y, 250, 250, 248);
    }
    found.push(tracker.process(p, f / 240).ball != null);
  }
  return { present: found.slice(0, PRESENT).filter(Boolean).length,
           absent: found.slice(PRESENT).filter(Boolean).length, PRESENT, ABSENT };
});
check('Tracker reports no ball once the ball leaves shot (no phantom lock past the miss reset)',
  ballGone.present === ballGone.PRESENT && ballGone.absent === 0,
  `${ballGone.present}/${ballGone.PRESENT} frames with the ball drawn · ` +
  `${ballGone.absent}/${ballGone.ABSENT} frames after it left (want 0)`);

/* ---------- B4. a light putter head must not be mistaken for the ball ----------
   Found on a real clip: markerless mode reported a ball in 325/325 frames and
   every one of them was the putter head. detectBall picks the first blob that
   clears minFill from a list components() sorted by intensity weight, so the
   biggest bright desaturated thing wins — and a white mallet head is bigger
   than the ball, just as bright, and being rectangular fills its bounding box
   BETTER than a disc's π/4 ≈ 0.79. It outscores the ball on every test applied.
   track.js then gated re-acquisition on `ballSize`, which starts at 0 and is
   seeded from the first blob accepted — so frame 0 chose the head and the gate
   defended that choice for the rest of the clip.

   The size gate has to live inside detectBall's loop, not after it: rejecting
   the head from outside yields null, never falling through to the ball. */
const headVsBall = await page.evaluate(() => {
  const W = 640, Hh = 360;
  const blank = () => {
    const p = new Uint8ClampedArray(W * Hh * 4);
    for (let i = 0; i < p.length; i += 4) { p[i] = 30; p[i + 1] = 70; p[i + 2] = 40; p[i + 3] = 255; }
    return p;
  };
  const put = (p, x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= Hh) return;
    const i = ((y | 0) * W + (x | 0)) * 4; p[i] = 250; p[i + 1] = 250; p[i + 2] = 248;
  };
  const disc = (p, cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(p, x, y);
  };
  const rect = (p, cx, cy, hw, hh) => {
    for (let y = cy - hh; y <= cy + hh; y++)
      for (let x = cx - hw; x <= cx + hw; x++) put(p, x, y);
  };
  // Ball 27 px radius, head 140x70 — the real clip's ratio (head ≈ 4x the ball's
  // area). Head sits below the ball exactly as it does at address.
  const BALL = { x: 320, y: 150, r: 27 };
  const scene = p => { disc(p, BALL.x, BALL.y, BALL.r); rect(p, 320, 250, 70, 35); };
  const full = { x0: 0, y0: 0, x1: W - 1, y1: Hh - 1 };

  const nBall = Math.PI * BALL.r * BALL.r;
  const p1 = blank(); scene(p1);
  const p2 = blank(); scene(p2);
  return {
    ungated: window.PL.detectBall(p1, W, Hh, full, {}),
    gated: window.PL.detectBall(p2, W, Hh, full,
      { nMin: nBall * 0.3, nMax: nBall * 2.5 }),
    ball: BALL
  };
});
const onBall = b => b && Math.hypot(b.x - headVsBall.ball.x, b.y - headVsBall.ball.y) < 3;
check('detectBall with a size gate picks the ball, not the larger putter head',
  onBall(headVsBall.gated),
  `ungated -> ${shown(headVsBall.ungated)} (the head, as expected) · ` +
  `gated -> ${shown(headVsBall.gated)}, want the ball at ${headVsBall.ball.x}, ${headVsBall.ball.y}`);

/* The tracker half: with no ball ever drawn small enough to beat the head on
   weight, frame 0 must still land on the ball — the gate has to come from the
   homography (a ball is 42.7 mm and the mat scale is known), not from whatever
   blob happened to be accepted first. */
const headLock = await page.evaluate(() => {
  const W = 640, Hh = 360;
  const quad = [{ x: 60, y: 352 }, { x: 580, y: 352 }, { x: 460, y: 40 }, { x: 180, y: 40 }];
  const H = window.PL.computeHomography(quad,
    [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 3000 }, { x: 0, y: 3000 }]);
  const tracker = window.PL.createTracker({ H, quad, matW: 400, srcWidth: W, srcHeight: Hh });
  const seen = [];
  for (let f = 0; f < 12; f++) {
    const p = new Uint8ClampedArray(W * Hh * 4);
    for (let i = 0; i < p.length; i += 4) { p[i] = 30; p[i + 1] = 70; p[i + 2] = 40; p[i + 3] = 255; }
    const put = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= Hh) return;
      const i = ((y | 0) * W + (x | 0)) * 4; p[i] = 250; p[i + 1] = 250; p[i + 2] = 248;
    };
    const bx = 320, by = 220;                     // ball, still at address
    for (let y = by - 27; y <= by + 27; y++)
      for (let x = bx - 27; x <= bx + 27; x++)
        if ((x - bx) ** 2 + (y - by) ** 2 <= 729) put(x, y);
    for (let y = 300 - 35; y <= 300 + 35; y++)   // putter head, below the ball
      for (let x = 320 - 70; x <= 320 + 70; x++) put(x, y);
    const r = tracker.process(p, f / 240).raw.ball;
    seen.push(r ? { x: +r.x.toFixed(1), y: +r.y.toFixed(1), n: r.n } : null);
  }
  return { first: seen[0], last: seen[seen.length - 1], ballAt: { x: 320, y: 220 } };
});
check('Tracker locks the ball, not the putter head, from the very first frame',
  headLock.first && Math.hypot(headLock.first.x - 320, headLock.first.y - 220) < 4 &&
  headLock.last && Math.hypot(headLock.last.x - 320, headLock.last.y - 220) < 4,
  `frame 0 -> ${headLock.first ? `${headLock.first.x}, ${headLock.first.y} (n=${headLock.first.n})` : 'null'} · ` +
  `frame 11 -> ${headLock.last ? `${headLock.last.x}, ${headLock.last.y} (n=${headLock.last.n})` : 'null'} · ` +
  `ball drawn at 320, 220 (head at 320, 300)`);

/* ---------- B5. impact on a clip trimmed close to the stroke ----------
   findImpact used to take rest as the median of the first quarter of sightings.
   On a clip that starts a few frames before impact the ball has left and come to
   a stop well inside that quarter, so the median landed between the two
   positions, frame 0 was already >4 mm from it, and `iMove < 1` returned a bare
   null — surfaced as "the ball was never tracked moving", which is the opposite
   of what happened. Rest is now the EARLIEST run of near-stationary sightings:
   not the first quarter, and not the longest run either, since a ball stays
   stopped far longer than it sits at address. No video needed. */
const trimmed = await page.evaluate(() => {
  const FPS = 240, dt = 1 / FPS, T_IMPACT = 4.5 * dt, SPEED = 1600;   // mm/s
  const REST = { x: 200, y: 415 }, DEG = Math.PI / 180, ANG = 1.1 * DEG;
  const frames = [];
  // 4 frames at address, then the roll, then 100 frames stopped — the long
  // still stretch that a "longest run" rule would wrongly prefer.
  for (let i = 0; i < 140; i++) {
    const t = i * dt;
    let d = 0;
    if (t > T_IMPACT) d = Math.min((t - T_IMPACT) * SPEED, 36 * dt * SPEED);
    frames.push({ t, ball: { x: REST.x + d * Math.sin(ANG), y: REST.y + d * Math.cos(ANG) },
                  face: null, head: null });
  }
  const got = window.PL.findImpact(frames);
  return { t: got.t, reason: got.reason, want: T_IMPACT, rest: got.rest, restWant: REST };
});
check('Impact still found when the clip starts only 4 frames before the stroke',
  trimmed.t != null && Math.abs(trimmed.t - trimmed.want) < 1 / 240 &&
  trimmed.rest && Math.hypot(trimmed.rest.x - trimmed.restWant.x, trimmed.rest.y - trimmed.restWant.y) < 1,
  trimmed.t != null
    ? `impact ${trimmed.t.toFixed(5)} s vs ${trimmed.want.toFixed(5)} s · rest ${trimmed.rest.x.toFixed(1)}, ${trimmed.rest.y.toFixed(1)} (want ${trimmed.restWant.x}, ${trimmed.restWant.y})`
    : `returned no impact: ${trimmed.reason}`);

/* ---------- B5b. impact on a DECELERATING roll ----------
   The fixture's ball rolls at constant velocity (make_fixture.py writes
   d = (t - T_IMPACT) * BALL_MS), so a straight-line fit to it is exact no matter
   which frame it starts from — the whole suite was blind to where iMove lands.
   Three separate movement-bar bugs shipped green through it.

   A real ball decelerates, and then a fit that starts late reads it as slower
   than it left. Measured on this series, a bar that put iMove 31 frames into the
   roll cost 8.9% of launch speed and 17 ms of impact — both outside the
   tolerances the suite enforces on the fixture itself. No video needed. */
const decel = await page.evaluate(() => {
  const FPS = 120, dt = 1 / FPS, LAUNCH = 240, V0 = 1.6, DEC = 0.4;   // m/s, m/s²
  let s = 1;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  const frames = [];
  for (let i = 0; i < 400; i++) {
    const t = i * dt;
    let d = 0;
    if (i >= LAUNCH) { const u = t - LAUNCH * dt; d = (V0 * u - 0.5 * DEC * u * u) * 1000; }
    frames.push({ t, ball: { x: rnd(), y: d + rnd() }, face: null, head: null });
  }
  const got = window.PL.findImpact(frames);
  return { t: got.t, reason: got.reason, iMove: got.iMove, speed: got.launchSpeed,
           wantT: LAUNCH * dt, wantV: V0 };
});
check('Impact and launch speed survive a decelerating roll (fixture rolls at constant speed)',
  decel.t != null && Math.abs(decel.t - decel.wantT) < 0.005 &&
  Math.abs(decel.speed - decel.wantV) / decel.wantV < 0.03,
  decel.t != null
    ? `iMove ${decel.iMove} (launch 240) · impact ${((decel.t - decel.wantT) * 1000).toFixed(2)} ms off · ` +
      `speed ${(100 * (decel.speed - decel.wantV) / decel.wantV).toFixed(2)}% off`
    : `returned no impact: ${decel.reason}`);

/* A failure has to say which cause fired, so the UI can stop blaming the mat
   corners and the brightness floor on every miss. */
const reasons = await page.evaluate(() => {
  const still = n => Array.from({ length: n }, (_, i) => ({ t: i / 240, ball: { x: 200, y: 415 } }));
  return {
    tooFew: window.PL.findImpact(still(4)).reason,
    neverMoves: window.PL.findImpact(still(40)).reason,
    noRest: window.PL.findImpact(Array.from({ length: 40 }, (_, i) =>
      ({ t: i / 240, ball: { x: 200 + i * 7, y: 415 + i * 7 } }))).reason,
    // Still, then DRIFTING TOWARD rest before moving off: the distance-vs-time
    // fit extrapolates the zero crossing to before the clip. A real clip solved
    // to -0.26 s this way and banked it as a putt.
    outsideClip: (() => {
      // Still for 6 frames, then already 300 mm away and rolling at 1.6 m/s.
      // Extrapolating that back to zero distance lands 0.19 s before the clip.
      const f = [];
      for (let i = 0; i < 60; i++) {
        const t = i / 240;
        f.push({ t, ball: { x: 200, y: 415 + (i < 6 ? 0 : 300 + (i - 6) / 240 * 1600) } });
      }
      return window.PL.findImpact(f).reason;
    })()
  };
});
check('findImpact reports a distinct, accurate reason for each way it can fail',
  /only 4 frames/.test(reasons.tooFew || '') &&
  /never moves more than/.test(reasons.neverMoves || '') &&
  /never still/.test(reasons.noRest || '') &&
  new Set([reasons.tooFew, reasons.neverMoves, reasons.noRest]).size === 3,
  `too few -> "${(reasons.tooFew || '').slice(0, 40)}…" · ` +
  `never moves -> "${(reasons.neverMoves || '').slice(0, 40)}…" · ` +
  `no rest -> "${(reasons.noRest || '').slice(0, 40)}…"`);

check('An impact solved outside the clip is refused, not reported as a putt',
  /outside the clip/.test(reasons.outsideClip || ''),
  `-> ${reasons.outsideClip ? `"${reasons.outsideClip.slice(0, 70)}…"` : 'accepted as a real impact'}`);

/* ---------- B6. a physically impossible putt must not reach the session ----------
   On a real clip the tracker followed a printed target circle instead of the
   ball. analyseStroke warned that the start line sat 118° off the face angle —
   and then the run was still banked into session history, dispersion chart and
   CSV, where it looks like data. A number that survives its own impossibility
   check is worse than a visible failure. */
const implausible = await page.evaluate(() => {
  // Ball leaves at ~90° to where the face points: impossible for a putt.
  const FPS = 240, dt = 1 / FPS, T = 6 * dt, SPEED = 1600;
  const frames = [];
  for (let i = 0; i < 120; i++) {
    const t = i * dt;
    const d = t > T ? (t - T) * SPEED : 0;
    frames.push({
      t,
      ball: { x: 200, y: 415 + d },                    // rolls straight down the mat: start line ~0°
      // Face line running DOWN the mat, not across it: vector (0,1) is 90° by
      // faceAngleFromVector. No putt starts 90° from its own face.
      face: { a: { x: 160, y: 300 }, b: { x: 160, y: 340 } },
      head: { x: 160, y: 320 + d * 0.01 }
    });
  }
  const r = window.PL.analyseStroke(frames, { markerless: false });
  return { implausible: r.implausible || null, err: r.facePredictionErrorDeg, impact: r.impactTime };
});
check('An impossible face-vs-start-line disagreement is marked unrecordable',
  implausible.impact != null && !!implausible.implausible,
  implausible.impact == null
    ? 'no impact found, so the guard was never reached'
    : `start line vs face off by ${implausible.err?.toFixed(0)}° -> ` +
      (implausible.implausible ? 'flagged unrecordable' : 'NOT FLAGGED — would enter the session'));

/* ---------- B7. the ball is the candidate that MOVES ----------
   A target circle printed on the mat is ball-sized, round, bright and
   desaturated — every test detectBall applies, it passes. On a real clip one
   outweighed the ball and was tracked for all 325 frames, and the run still
   produced angles. Nothing in a single frame separates them; only motion does.
   resolveBallTrack chains candidates across the clip and picks the one that
   went somewhere. */
const chooseMover = await page.evaluate(() => {
  const perFrame = [];
  for (let f = 0; f < 80; f++) {
    // Two printed rings that never move, listed FIRST and heavier — exactly the
    // order that beat the ball before.
    const cands = [
      { x: 300, y: 120, n: 1600 },
      { x: 300, y: 900, n: 1580 }
    ];
    // A putter head: swings back and through, travelling FURTHER than the ball
    // and returning past its own start. "Moves most" picks this one — and did.
    cands.push({ x: 250, y: 560 + Math.sin(f / 79 * Math.PI * 2) * 420, n: 1500 });
    // The ball: still at address for 20 frames, then struck up the mat.
    const y = f < 20 ? 500 : 500 - (f - 20) * 6;
    cands.push({ x: 302, y, n: 1200 });
    perFrame.push(cands);
  }
  const r = window.PL.resolveBallTrack(perFrame);
  return {
    first: r.track[0], mid: r.track[40], last: r.track[79],
    spanPx: Math.round(r.spanPx)
  };
});
check('resolveBallTrack follows the ball, not the printed targets or the swinging putter',
  chooseMover.first && Math.abs(chooseMover.first.y - 500) < 2 &&
  chooseMover.last && Math.abs(chooseMover.last.y - (500 - 59 * 6)) < 2 &&
  chooseMover.spanPx > 300,
  `frame 0 -> y=${chooseMover.first?.y} (ball at 500) · ` +
  `frame 79 -> y=${chooseMover.last?.y} (ball at ${500 - 59 * 6}) · ` +
  `span ${chooseMover.spanPx} px (static rings would score 0)`);

/* ---------- B8. find the mat's printed target line, with no taps ----------
   A top-down clip never shows the mat's corners, so the four-corner tap cannot
   run on it — but a putting mat has its own reference printed down the middle.
   Detect that and the direction reference is free, per frame, which also means
   it follows a drifting handheld camera instead of going stale like a tap does.

   The fit has to survive two things that are true of a real mat: the ball and
   putter BREAK the line into segments, so the biggest fragment is not the whole
   line; and there are other printed marks in the same colour off to the side,
   which must not drag the angle. */
const targetLine = await page.evaluate(() => {
  const W = 640, H = 900;
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 120; px[i+1] = 122; px[i+2] = 120; px[i+3] = 255; }
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = ((y|0) * W + (x|0)) * 4; px[i] = r; px[i+1] = g; px[i+2] = b;
  };
  // The line: 2.0 deg off vertical, drawn as three segments with gaps where the
  // ball and the putter head sit on it.
  const TRUE_DEG = 2.0, t = TRUE_DEG * Math.PI / 180;
  const gaps = [[300, 380], [520, 600]];
  for (let y = 40; y < H - 40; y++) {
    if (gaps.some(([a, b]) => y >= a && y <= b)) continue;
    const x = 320 + Math.tan(t) * (y - H / 2);
    for (let d = -4; d <= 4; d++) put(x + d, y, 235, 205, 40);      // yellow
  }
  // Decoys in the SAME yellow, well off to the side: a dotted rule and ticks.
  for (let y = 200; y < 700; y += 12)
    for (let d = -3; d <= 3; d++) { put(560 + d, y, 235, 205, 40); put(560 + d, y + 1, 235, 205, 40); }
  for (let x = 530; x < 590; x++) { put(x, 200, 235, 205, 40); put(x, 700, 235, 205, 40); }

  const roi = { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };
  const line = window.PL.detectTargetLine(px, W, H, roi, {});
  return { line, trueDeg: TRUE_DEG };
});
const tl = targetLine.line;
// detectTargetLine reports the axis measured from +x, so a line running down
// the frame reads ~90°. The mat quantity of interest is its TILT off vertical,
// which is what a target line drawn 2° open means.
const fold = d => { let a = d % 180; if (a > 90) a -= 180; if (a <= -90) a += 180; return a; };
const tiltFromVertical = tl ? fold(90 - fold(tl.deg)) : null;
check('detectTargetLine finds the printed line through gaps, ignoring side markings',
  tl && Math.abs(tiltFromVertical - targetLine.trueDeg) < 0.25,
  tl ? `tilt ${tiltFromVertical.toFixed(2)}° vs true ${targetLine.trueDeg}° ` +
       `(err ${Math.abs(tiltFromVertical - targetLine.trueDeg).toFixed(2)}°) · ` +
       `${tl.n} px fitted · rms ${tl.rms?.toFixed(2)} px`
     : 'no line found');

/* ---------- B9. face angle from the head's EDGE, not its blob axis ----------
   Markerless mode read the face off the head blob's principal axis and measured
   1.14° against 0.03° for stickers. The reason is geometric, not a tuning
   miss: a mallet images about 102x74 px, a long/short ratio of 1.38, and the
   axis of a near-square blob swings on tiny changes in shape. The face is a
   straight ~100 px edge, and a line fitted to it is far better conditioned —
   provided the wings hanging off the BACK of a mallet are excluded, which is
   what makes the ball-facing boundary the right thing to fit. */
const faceEdge = await page.evaluate(() => {
  const W = 420, Hh = 320;
  const results = [];
  for (const TRUE_DEG of [0, 1.5, -2.5]) {
    const px = new Uint8ClampedArray(W * Hh * 4);
    for (let i = 0; i < px.length; i += 4) { px[i]=70; px[i+1]=110; px[i+2]=70; px[i+3]=255; }
    const put = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= Hh) return;
      const i = ((y|0)*W + (x|0))*4; px[i]=245; px[i+1]=245; px[i+2]=240;
    };
    // Head: 102 wide x 74 deep, rotated by TRUE_DEG. Face is its TOP edge
    // (ball sits above). Two wings hang off the BACK — they must not matter.
    // Rasterise by scanning DESTINATION pixels and inverse-rotating, so the
    // shape is solid. Stamping rotated source coords leaves holes that break
    // connectivity and ragged the edge — a fixture artefact, not a real one.
    const t = TRUE_DEG * Math.PI/180, ct = Math.cos(t), st = Math.sin(t);
    const cx = 210, cy = 190;
    const inHead = (u, v) => u >= -51 && u <= 51 && v >= -37 && v <= 37;
    const inWing = (u, v) => v >= 38 && v <= 70 &&
                             ((u >= -46 && u <= -20) || (u >= 20 && u <= 46));
    for (let y = cy - 110; y <= cy + 110; y++) {
      for (let x = cx - 110; x <= cx + 110; x++) {
        const px_ = x - cx, py_ = y - cy;
        const u = px_ * ct + py_ * st, v = -px_ * st + py_ * ct;
        if (inHead(u, v) || inWing(u, v)) put(x, y);
      }
    }
    const seed = { x: cx, y: cy };
    const ball = { x: cx, y: cy - 120 };                        // ball above the head
    const roi = { x0: cx-120, y0: cy-120, x1: cx+120, y1: cy+120 };
    const e = window.PL.detectFaceEdge(px, W, Hh, roi, seed, ball, {});
    results.push({ TRUE_DEG, deg: e ? e.deg : null, n: e ? e.n : 0, rms: e ? e.rms : null });
  }
  return results;
});
const fold2 = d => { let a = d % 180; if (a > 90) a -= 180; if (a <= -90) a += 180; return a; };
const faceErrs = faceEdge.map(r => r.deg == null ? 99 : Math.abs(fold2(r.deg) - r.TRUE_DEG));
check('detectFaceEdge reads face angle off the leading edge, ignoring the wings',
  faceErrs.every(e => e < 0.30),
  faceEdge.map((r, i) => `${r.TRUE_DEG}° -> ${r.deg == null ? 'null' : fold2(r.deg).toFixed(2) + '°'} ` +
    `(err ${faceErrs[i].toFixed(2)}°, ${r.n}px, rms ${r.rms?.toFixed(2)})`).join(' · '));

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

/* ---------- F2. top-down + STICKERS must still produce a face ----------
   Only the markerless path fits face edges, so top-down + markers produced
   face: null on every frame — no face, path, face-to-path or tempo, and no
   warning saying why. Markers is the DEFAULT face mode, so switching only the
   calibration mode landed here. Synthetic raster: a yellow mat line for
   direction, a white ball that sits then is struck, two magenta stickers. */
const topDownMarkers = await page.evaluate(() => {
  const W = 640, H = 1138;
  const tracker = window.PL.createTracker({
    srcWidth: W, srcHeight: H,
    opt: { topDown: true, markerless: false, marker: { hue: 322 } }
  });
  const frames = [];
  for (let f = 0; f < 34; f++) {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < px.length; i += 4) { px[i]=118; px[i+1]=120; px[i+2]=118; px[i+3]=255; }
    const put = (x, y, r, g, b) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = ((y|0)*W + (x|0))*4; px[i]=r; px[i+1]=g; px[i+2]=b;
    };
    for (let y = 0; y < H; y++) for (let d = -4; d <= 4; d++) put(320+d, y, 235, 205, 40);
    // ball: still, then struck up the mat well past the 6%-of-diagonal bar
    const by = f < 10 ? 700 : 700 - (f - 10) * 12;
    for (let y = by-19; y <= by+19; y++) for (let x = 301; x <= 339; x++)
      if ((x-320)**2 + (y-by)**2 <= 361) put(x, y, 250, 250, 248);
    // two magenta stickers on the face line, below the ball
    const hy = 780 - (f < 10 ? 0 : (f - 10) * 4);
    for (const mx of [286, 354])
      for (let y = hy-6; y <= hy+6; y++) for (let x = mx-6; x <= mx+6; x++)
        if ((x-mx)**2 + (y-hy)**2 <= 36) put(x, y, 214, 32, 132);
    frames.push(tracker.process(px, f / 240));
  }
  const fix = tracker.finish(frames, {});
  return { ok: fix.ok, reason: fix.reason || null, headFrames: fix.headFrames || 0,
           faceFrames: frames.filter(f => f.face).length, total: frames.length };
});
check('Top-down with stickers still yields a face line (not silently nothing)',
  topDownMarkers.ok !== false && topDownMarkers.faceFrames > 0,
  topDownMarkers.ok === false
    ? `top-down gave up: ${topDownMarkers.reason}`
    : `face in ${topDownMarkers.faceFrames}/${topDownMarkers.total} frames`);

/* ---------- G. the actual app UI, driven end to end ---------- */
const ui = await browser.newPage({ viewport: { width: 1180, height: 545 } });
const uiErrors = [];
ui.on('pageerror', e => uiErrors.push(e.message));
ui.on('console', m => { if (m.type() === 'error') uiErrors.push(m.text()); });
await ui.goto('http://localhost:8111/index.html');
await ui.waitForFunction(() => window.PuttLabApp, null, { timeout: 15000 });

/* Choosing top-down before loading a clip used to enable Run, and clicking it
   threw on a null clip AFTER the handler had disabled the button and relabelled
   it "Decoding…" — wedging it until reload, with an empty message box. */
const guard = await ui.evaluate(() => {
  const sel = document.getElementById('calMode'), btn = document.getElementById('btnRun');
  const before = btn.disabled;
  sel.value = 'topdown'; sel.dispatchEvent(new Event('change'));
  const after = btn.disabled;
  sel.value = 'corners'; sel.dispatchEvent(new Event('change'));
  return { before, after };
});
check('Run stays disabled with no clip loaded, even in top-down mode',
  guard.before === true && guard.after === true,
  `disabled before ${guard.before}, after choosing top-down ${guard.after}`);

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

/* ---------- G2. calibration corners are adjustable after they are placed ----------
   The orange centre line only exists once a homography does, so all four corners
   are tapped blind; without a nudge the only correction is Undo, which pops the
   whole stack. Its own page — dragging a corner changes S.H, and every assertion
   in section G is measured against the demo's pre-set corners. */
const cal = await browser.newPage({ viewport: { width: 1180, height: 545 } });
const calErrors = [];
cal.on('pageerror', e => calErrors.push(e.message));
cal.on('console', m => { if (m.type() === 'error') calErrors.push(m.text()); });
await cal.goto('http://localhost:8111/index.html');
await cal.waitForFunction(() => window.PuttLabApp, null, { timeout: 15000 });
await cal.click('#btnDemo');
await cal.waitForFunction(() => window.PuttLabApp.S.H != null, null, { timeout: 30000 });

const calBox = await cal.evaluate(() => {
  const c = document.getElementById('cvCal'), r = c.getBoundingClientRect();
  return { left: r.left, top: r.top, kx: r.width / c.width, ky: r.height / c.height,
           corner: { ...window.PuttLabApp.S.corners[0] }, H: [...window.PuttLabApp.S.H] };
});
const toClient = p => ({ x: calBox.left + p.x * calBox.kx, y: calBox.top + p.y * calBox.ky });
const DX = 30, DY = -20;
const grab = toClient(calBox.corner);
const drop = toClient({ x: calBox.corner.x + DX, y: calBox.corner.y + DY });
// real mouse, not a fabricated PointerEvent: setPointerCapture throws NotFoundError
// on a synthetic pointerId, which is why the app guards it with `?.`
await cal.mouse.move(grab.x, grab.y);
await cal.mouse.down();
await cal.mouse.move(drop.x, drop.y, { steps: 6 });
await cal.mouse.up();
// a press nowhere near a corner must not append a fifth one
await cal.mouse.click(toClient({ x: 140, y: 400 }).x, toClient({ x: 140, y: 400 }).y);

const calRes = await cal.evaluate(() => ({
  n: window.PuttLabApp.S.corners.length,
  c0: { ...window.PuttLabApp.S.corners[0] },
  H: window.PuttLabApp.S.H ? [...window.PuttLabApp.S.H] : null
}));
const movedX = calRes.c0.x - calBox.corner.x, movedY = calRes.c0.y - calBox.corner.y;
check('A placed calibration corner can be dragged, recomputing the homography live',
  calRes.n === 4 && near(movedX, DX, 2) && near(movedY, DY, 2) && calRes.H &&
  calRes.H.some((v, i) => Math.abs(v - calBox.H[i]) > 1e-9) && calErrors.length === 0,
  `corner 1 moved (${movedX.toFixed(1)}, ${movedY.toFixed(1)}) px, wanted (${DX}, ${DY}) · ` +
  `${calRes.n} corners (no fifth from the stray click) · H ${calRes.H ? 'recomputed' : 'NULL'}` +
  (calErrors.length ? ' — ' + calErrors.slice(0, 2).join(' | ') : ''));
await cal.close();

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
