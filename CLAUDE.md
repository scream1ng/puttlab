# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Browser putting analyser. Decodes a 240 fps phone clip with WebCodecs, tracks the ball and
two putter-head markers, and reports face angle at impact, putter path, face-to-path, ball
start line, speed and tempo. No server, no build step, no runtime dependencies.

**Core constraint driving the design:** you cannot capture at 240 fps in a browser, only
decode at 240 fps. `getUserMedia` caps at 60 and iOS exposes no high-frame-rate mode. The
phone's own Camera app records the frames; `VideoDecoder` hands them back with exact
timestamps. Do not add a live-camera analysis path or try to raise the `getUserMedia` frame
rate — it's a platform ceiling, not a bug.

## Commands

```bash
python3 -m http.server 8080                # run (WebCodecs needs a secure context)
npm i playwright && node test/verify.mjs    # 26 checks — run before claiming anything works
node build.mjs                              # -> dist/puttlab-pro.html (single-file, demo inlined)
python3 tools/make_fixture.py               # regenerate the ground-truth stroke video (PIL + ffmpeg)
sh tools/make_codec_fixtures.sh             # regenerate tiny h264/hevc/vp9 demuxer fixtures
```

`node test/verify.mjs` must pass at 26/26 before any change is considered done. It's not a
smoke test — it checks measured values against a stroke whose truth was rendered in
(`tools/make_fixture.py` writes both the video and the truth JSON from the same analytic
model, so the fixture doubles as ground truth).

No `package.json`; Playwright is the only dev dependency, installed ad hoc for `verify.mjs`.

## Architecture

Vanilla ES modules under `src/`, no framework, no bundler beyond `build.mjs`.

| Layer | Files | Rule |
|---|---|---|
| Engine | `geom.js` `detect.js` `mp4.js` `decoder.js` `track.js` `analyse.js` | Tested against ground truth. Change only with a failing test first. |
| Presentation | `charts.js` `timeline.js` `app.js` `index.html` | Free to restyle. Must not compute metrics. |

Data flow, one direction:

```
File -> demuxMp4 -> decodeAll(onFrame) -> tracker.process(pixels) -> analyseStroke(frames) -> UI
```

`track.js` is deliberately DOM-free and WebCodecs-free so it can move into a Worker without
edits — that move is the next real task (see Roadmap).

`build.mjs` concatenates `src/` modules in a hand-maintained `ORDER` (dependency order,
not alphabetical), strips `import`/`export`, inlines the demo clip as base64, and fails the
build on any top-level name collision across modules (flattening into one scope means two
files each declaring e.g. `const css` is a silent runtime `SyntaxError` otherwise). **When
adding a module, add it to `ORDER` before `app.js`, and keep top-level names unique across
all modules.**

## Invariants — do not violate

### Coordinate frame
Mat millimetres. `x` = across the mat, **+ right**. `y` = down the mat, **+ away from the
golfer**. Origin on the target line (`track.js` subtracts `matW/2`).

### Angle conventions — these were got wrong once and cost an afternoon

```js
bearingDeg(dx, dy)          = atan2(dx, dy)   // direction of TRAVEL from the target line
faceAngleFromVector(dx, dy) = atan2(dy, dx)   // orientation of the FACE line
```

They are **transposed on purpose**. A square face has its face line running across the mat
(`+x`), so its vector is `(1, 0)` and its angle is 0. Swapping them yields a face angle near
90° — obviously wrong, which is the only mercy.

Face angle is a **line, not a vector**: fold to `(−90, 90]` with `foldFaceAngle`, and
`unwrapAngles` before fitting. Sign convention throughout: **positive = right / open / push**.

### Homography
Four mat corners, tapped in order **near-left → near-right → far-right → far-left**, map to
`(0,0) (matW,0) (matW,matL) (0,matL)`. Without it no angle means anything. Never introduce a
"skip calibration" path.

### Sub-frame estimation
Impact is found by extrapolating the ball's motion back to its rest position, not by picking
the nearest frame. Face angle is a local quadratic fit evaluated at that instant. Angle and
rate use **different windows** on purpose (±30 ms vs ±60 ms) — see the comment in
`faceAngleAt`. Don't unify them.

## Traps already hit — do not re-introduce

| Trap | What happens | Fix in place |
|---|---|---|
| Gauss-Jordan `row[i][i]` | Returns all-NaN homographies, silently | `row[i]` is the pivot |
| VP9 codec string in hex | `vp09.00.1f.08` rejected as unsupported; VP9 uses **decimal** fields, H.264 uses hex | `d2()` in `mp4.js` |
| `description: null` | `isConfigSupported` throws TypeError; VP9/AV1 need the key **absent** | conditional spread in `decoder.js` |
| Edit lists ignored | Every timestamp off by a constant | `elst` parsed, timestamps normalised |
| `createImageBitmap` in `onFrame` | Async — the `VideoFrame` must not outlive the callback | `OffscreenCanvas.transferToImageBitmap()`, synchronous |
| Retaining `VideoFrame`s | GPU memory exhausted in ~1 s at 240 fps | closed in `finally`, always |
| Two modules declaring `const css` | Bundle is one scope → runtime `SyntaxError` | `build.mjs` fails the build on top-level name collisions |
| `.tl` meaning both "timeline" and "top-left" | Later rule won; every overlay chip silently lost `position:absolute` | `.timeline` and `.chip.pos-tl` |

## The slow-mo timing trap

A phone slow-mo clip arrives one of two ways and the container cannot tell you which:

- true 240 fps timestamps → speeds correct
- **already-rendered** slow motion — all 240 frames stretched over 8× the duration → every
  speed reads **8× slow**

`analyseTiming()` flags the suspicious case and the UI exposes a capture-rate override.
Angles are scale-free and never affected; **speed and tempo are**. Both branches are tested.

## Verification philosophy

The fixture (`tools/make_fixture.py`) renders a stroke from an analytic model, so every
number is known before measurement:

| | truth |
|---|---|
| face at impact | +1.20° |
| putter path | −2.00° |
| face-to-path | +3.20° |
| ball start line | +1.10° |
| ball speed | 1.60 m/s |
| impact | 0.900 s |
| tempo | 1.968 : 1 |

Current accuracy: face **0.031°**, path **0.034°**, face-to-path **0.065°**, speed **0.2%**,
impact **0.07 ms** (a frame is 4.17 ms).

If you change the stroke model, regenerate the fixture *and* the truth JSON together — they
are written by the same script for exactly this reason.

**Definition-sensitive metrics** get their truth computed analytically under the *same*
definition the estimator uses. Tempo depends on where "takeaway" starts; we use 5% of peak
backswing speed (`TAKEAWAY_FRACTION`) and the fixture evaluates the same rule on the exact
model. A tempo ratio quoted without its threshold is not comparable to anyone else's.

## Known gaps

- **H.264/HEVC decode is untested here.** Playwright's Chromium ships without proprietary
  codecs, so CI proves the demuxer's H.264 *parsing* against `ffprobe` but never decodes a
  real H.264 bitstream. Device-only.
- **~5 s per 324-frame clip** at 640 px detection width on desktop. Unusable on a phone until
  the tracker moves to a Worker.
- Fragmented MP4 (`moof` without `moov`) is rejected with a clear message, not parsed.
- Only the newest putt retains scrub frames (150 previews at 480 px, ~25 MB). Older putts
  show numbers and timeline with "clip not retained".
- Markerless face mode measured **1.14° off** where marker mode was 0.03°. It's a trend
  indicator, and labels itself as such. Don't promote it to a measurement.

## Phase 0 — before writing any new code

Everything above is verified on a **synthetic** clip. Nothing has ever seen real footage.
Answer these four before building anything further:

1. **Does Safari's WebCodecs decode your actual clip?** Load an iPhone `.MOV`. If
   `isConfigSupported` returns false for `hvc1`, that is the whole project's critical path.
2. **True 240 fps timestamps, or pre-rendered slow-mo?** Check the reported container fps
   against frame count ÷ duration. Set the capture-rate override accordingly.
3. **Do the markers survive real motion blur, shadows and reflections?** Tune via the
   detector panel; if hue thresholding fails outright, that's a real algorithm change.
4. **Rolling shutter.** The two markers sit on different sensor rows and are therefore
   sampled at different times. Rough estimate: ~1 ms apart × 1.5 m/s ≈ 1.5 mm relative shift
   on a 76 mm baseline ≈ **1.1° of false face angle** — 3× the precision target.

   **Test:** film the same putt with the phone rotated 90°. If face angle changes, it's
   rolling shutter, not the stroke. Correction needs the sensor readout time, which can only
   be measured on the device.

Do not skip this. If markers don't survive real video, the architecture changes.

## Roadmap

1. **Phase 0 above.** Nothing else matters until it passes.
2. **Worker + OffscreenCanvas** for the tracker. `track.js` is already DOM-free; move it,
   transfer `ImageBitmap`s in, post observations back.
3. Rolling-shutter correction, if phase 0 shows it matters.
4. Auto-calibration — ArUco markers at the mat corners, or colour segmentation of the mat
   edge, to kill the four taps.
5. Aim vs stroke separation — let the user set an aim point so *aim error* and *stroke error*
   are distinguishable. They are different fixes for the golfer.
6. Strokes Gained — map dispersion to make-probability by distance. This is where a physics
   readout becomes coaching.

Not worth doing: a live 240 fps capture path (impossible), or rebuilding the Cafe24
storefront as a PWA (their conversion problem isn't install-ability).

## Style

Comments explain **why**, especially where a naive implementation would be wrong — those
comments are load-bearing. Two-space indent. Keep `index.html` self-contained (styles
inline).

Charts follow the dataviz palette in `charts.js` / `timeline.js`: `--series-1` blue,
`--series-2` orange, `--series-3` green; entity colour, never rank. Single-series charts get
no legend box.

---

*Independent study project. Not affiliated with, endorsed by, or connected to PerfectLine or
Linematics Co., Ltd. No code or asset of theirs was examined or reused.*
