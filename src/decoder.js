/* =====================================================================
   WebCodecs decode pipeline.

   This is the piece that gets around the browser's 60 fps live-capture
   ceiling. You cannot CAPTURE at 240 fps on the web. You can DECODE at
   240 fps — the phone's own camera app already recorded the frames, and
   VideoDecoder hands them over one at a time with exact timestamps.

   Frames are processed and closed inside the output callback. Never
   accumulate VideoFrames: they hold GPU memory and a 240 fps clip will
   exhaust it in about a second.
   ===================================================================== */

import { demuxMp4, sampleBytes } from './mp4.js';

export function webCodecsSupported() {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

/**
 * Decode every frame of an MP4/MOV, calling onFrame(frame, tSeconds, index).
 * The callback must NOT retain `frame` — it is closed immediately after.
 *
 * @param {ArrayBuffer} buffer
 * @param {object} opts
 *   onFrame(VideoFrame, tSec, i)   per-frame work; do the CV here
 *   onProgress(done, total)
 *   timeScale                      multiply timestamps (see below)
 *   signal                         AbortSignal
 */
export async function decodeAll(buffer, opts = {}) {
  const { onFrame, onProgress, timeScale = 1, signal } = opts;
  if (!webCodecsSupported()) throw new Error('This browser has no WebCodecs VideoDecoder.');

  const info = demuxMp4(buffer);
  // `description` must be absent, not null — VP9/AV1 bitstreams are
  // self-describing and passing null throws a TypeError.
  const config = {
    codec: info.config.codec,
    codedWidth: info.width,
    codedHeight: info.height
  };
  if (info.config.description) config.description = info.config.description;

  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error(`This browser cannot decode ${info.config.codec}. ` +
      `Chromium builds without proprietary codecs lack H.264/HEVC; Safari and ` +
      `mobile Chrome have them.`);
  }

  let decoded = 0;
  let fatal = null;

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const t = (frame.timestamp / 1e6) * timeScale;
        if (onFrame) onFrame(frame, t, decoded);
      } catch (e) {
        fatal = fatal || e;
      } finally {
        frame.close();                       // non-negotiable
        decoded++;
        if (onProgress && (decoded & 7) === 0) onProgress(decoded, info.samples.length);
      }
    },
    error: (e) => { fatal = fatal || e; }
  });

  decoder.configure({ ...config, optimizeForLatency: false });

  for (const s of info.samples) {
    if (signal?.aborted) break;
    if (fatal) break;
    // Backpressure: without this a 240 fps clip queues faster than it decodes
    // and the tab dies.
    while (decoder.decodeQueueSize > 24) {
      await new Promise(r => setTimeout(r, 0));
      if (fatal || signal?.aborted) break;
    }
    decoder.decode(new EncodedVideoChunk({
      type: s.key ? 'key' : 'delta',
      timestamp: Math.round(s.cts / info.timescale * 1e6),   // microseconds
      duration: undefined,
      data: sampleBytes(buffer, s)
    }));
  }

  if (!fatal && !signal?.aborted) await decoder.flush();
  try { decoder.close(); } catch (_) {}
  if (fatal) throw fatal;
  if (onProgress) onProgress(decoded, info.samples.length);

  return { info, framesDecoded: decoded };
}

/**
 * Decode just enough to hand back one frame as an ImageBitmap.
 * Used for the calibration still: the user needs a picture to tap on
 * before we spend seconds decoding the whole clip.
 */
export async function grabFrame(buffer, index = 0) {
  const info = demuxMp4(buffer);
  const config = { codec: info.config.codec, codedWidth: info.width, codedHeight: info.height };
  if (info.config.description) config.description = info.config.description;
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`This browser cannot decode ${info.config.codec}.`);

  let seen = 0, bitmap = null, done = false, err = null;
  const ready = new Promise(resolve => {
    const decoder = new VideoDecoder({
      output: async (frame) => {
        if (!done && seen++ >= index) {
          done = true;
          try { bitmap = await createImageBitmap(frame); } catch (e) { err = e; }
          frame.close();
          try { decoder.close(); } catch (_) {}
          resolve();
          return;
        }
        frame.close();
      },
      error: (e) => { err = err || e; done = true; resolve(); }
    });
    decoder.configure(config);
    (async () => {
      // Feed from the start; index 0 is a keyframe so this is cheap.
      for (const s of info.samples) {
        if (done) break;
        decoder.decode(new EncodedVideoChunk({
          type: s.key ? 'key' : 'delta',
          timestamp: Math.round(s.cts / info.timescale * 1e6),
          data: sampleBytes(buffer, s)
        }));
        if (seen > index) break;
        await new Promise(r => setTimeout(r, 0));
      }
      if (!done) { try { await decoder.flush(); } catch (_) {} resolve(); }
    })();
  });
  await ready;
  if (err && !bitmap) throw err;
  return { bitmap, info };
}

/**
 * Work out the real capture rate.
 *
 * The trap: a phone's slow-motion clip may reach you two ways. Either the
 * container holds true 240 fps timestamps (real time, speeds correct), or
 * the slow-motion has already been *rendered* — all 240 frames present but
 * stretched over 8× the duration, so every speed reads 8× too slow.
 * You cannot tell these apart from the container alone. So: detect what we
 * can, and give the user an explicit override.
 */
export function analyseTiming(info, statedCaptureFps) {
  const containerFps = info.nominalFps;
  const looksRendered = containerFps > 0 && containerFps < 90;
  const captureFps = statedCaptureFps || containerFps;
  const timeScale = captureFps > 0 ? containerFps / captureFps : 1;
  return {
    containerFps,
    captureFps,
    timeScale,                        // multiply decoded timestamps by this
    isStretched: Math.abs(timeScale - 1) > 0.02,
    looksRendered,
    frameCount: info.samples.length,
    durationSec: info.durationSec,
    note: looksRendered
      ? `Container reports ${containerFps.toFixed(1)} fps. If you shot this in slow motion, ` +
        `set the capture rate — otherwise every speed will read low by that factor.`
      : `Container reports ${containerFps.toFixed(1)} fps — high enough to be true slow-motion timing.`
  };
}
