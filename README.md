# PuttLab Pro

A browser putting analyser that measures **the same metric set PerfectLine sells at
$199/yr** — face angle at impact, putter path, face-to-path (Arc-To-Face), ball start
line, ball speed, tempo — from a 240 fps clip your phone's own Camera app already
records.

No server, no build step, no dependencies, no upload. The video never leaves the browser.

**Accuracy against a synthetic stroke with rendered-in ground truth:**

| Metric | Truth | Measured | Error |
|---|---|---|---|
| Face angle at impact | +1.20° | +1.231° | **0.031°** |
| Putter path | −2.00° | −2.034° | **0.034°** |
| Face-to-path | +3.20° | +3.265° | **0.065°** |
| Ball start line | +1.10° | +1.060° | **0.040°** |
| Ball speed | 1.600 m/s | 1.603 m/s | **0.2%** |
| Impact instant | 0.90000 s | 0.90007 s | **0.07 ms** (frame = 4.17 ms) |
| Tempo ratio | 1.968 : 1 | 1.931 : 1 | **1.9%** |

## The idea

You cannot **capture** at 240 fps in a browser — `getUserMedia` caps at 60 and iOS
exposes no high-frame-rate mode. You *can* **decode** at 240 fps. The phone's Camera
app already recorded the frames; `WebCodecs VideoDecoder` hands them over one at a
time with exact timestamps.

That single substitution — record natively, analyse on the web — turns a browser from
"start line only" into full stroke analysis.

## The UI

Landscape, video-first. The footage is the subject and the measurement is drawn on top of it —
target line, putter arc, face line, ball departure — so you verify the tracking and read the
result in one glance. Under it, a phase-banded timeline (backswing / downswing / follow-through)
you can drag to scrub. The stat rail is pinned and never scrolls away.

Scrub by dragging the bar under the video or anywhere on the timeline. Arrow keys step one
frame; `i` jumps back to impact.

Views: **Setup** (load + calibrate), **Analyze** (scrub + numbers), **Session** (dispersion,
table, CSV).

## Run it

```bash
python3 -m http.server 8080      # then open http://localhost:8080
```

Or open `dist/puttlab-pro.html` directly — one self-contained file, demo clip inlined,
works from `file://`.

Press **Load the demo clip**: a synthetic stroke rendered at a known +1.20° face,
−2.00° path, 1.60 m/s. Its mat corners are pre-set, so you can go straight to analyse
and compare against truth.

## Using it with a real putter

1. Put **two stickers of the same bright colour** on the putter head, one near the toe
   and one near the heel, as far apart as they'll go. Same colour on both is correct —
   a face line is an orientation, not a direction, so there's nothing to disambiguate.
2. Record at **240 fps slow motion** in your phone's Camera app, framed from behind
   the ball with the whole mat visible.
3. Load the clip, tap the four mat corners, tap one sticker to sample its colour, analyse.

Markerless mode exists and needs no stickers — it reads the principal axis of the dark
putter head. It measured **1.14° off** on the same clip where marker mode was 0.03° off.
It will show you a trend; it will not give you a number.

### Why stickers

Markerless sub-degree face measurement from a phone video is a research problem.
Two stickers turn it into arithmetic. That's the same trade PerfectLine makes by
milling their mat to ±0.1 mm: put the precision in the physical setup so the software
can make a claim it can actually defend.

## The slow-mo timing trap

A phone slow-mo clip reaches you one of two ways, and you cannot tell which from the
container alone:

- true 240 fps timestamps → speeds correct
- **already-rendered** slow motion — all 240 frames, stretched over 8× the duration →
  every speed reads **8× too slow**

The app detects the suspicious case, warns, and gives you a capture-rate override.
Both branches are covered by tests. Angles are scale-free and never affected; speed and
tempo are.

## Verify

```bash
npm i playwright && node test/verify.mjs
```

26 checks. The demuxer is validated against `ffprobe` on H.264, HEVC (with B-frame
reordering) and VP9; the full pipeline runs against a rendered stroke with known truth;
the app UI is driven by real clicks including scrubbing and clamping; the single-file bundle
is checked standalone.

Regenerate the fixture with `python3 tools/make_fixture.py` (needs PIL + ffmpeg).

## Files

```
index.html            shell + styles
src/mp4.js            MP4/MOV demuxer — boxes, sample table, edit lists, codec configs
src/decoder.js        WebCodecs pipeline, backpressure, capture-rate handling
src/geom.js           homography, least squares, angle conventions
src/detect.js         ball / marker / markerless blob detection
src/track.js          per-frame tracker: pixels in, mat millimetres out
src/analyse.js        impact instant, face, path, tempo — the metrics
src/charts.js         session dispersion chart
src/timeline.js       phase-banded scrub timeline (canvas)
src/app.js            wiring, scrubbing, overlays
tools/make_fixture.py renders the ground-truth stroke video
test/verify.mjs       26 checks
build.mjs             -> dist/puttlab-pro.html (single file)
```

## Known limits

- Fragmented MP4 (`moof` without `moov`) is rejected with a clear message rather than
  mis-parsed.
- Processing is ~5 s for 324 frames at 640 px detection width on desktop. Move the
  detector to a Worker + `OffscreenCanvas` before shipping this to phones.
- H.264 decode can't be tested in this repo's CI — Playwright's Chromium ships without
  proprietary codecs. The demuxer's H.264 parsing *is* tested against ffprobe; only the
  bitstream decode is device-only.
- The tempo ratio depends on where you say the takeaway starts. This uses 5% of peak
  backswing speed and says so; a ratio quoted without its threshold isn't comparable.

---

Independent study project. Not affiliated with, endorsed by, or connected to PerfectLine
or Linematics Co., Ltd. No code or asset of theirs was examined or reused. MIT licensed.
