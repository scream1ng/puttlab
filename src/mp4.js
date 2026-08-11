/* =====================================================================
   Minimal MP4 / QuickTime demuxer — no dependencies.

   Why hand-roll this: WebCodecs `VideoDecoder` takes EncodedVideoChunks,
   not files. Something has to walk the sample table and hand it each
   frame with its true presentation timestamp. That timestamp is the whole
   point — it is what makes 240 fps analysis possible from a file when
   live capture is capped at 60.

   Handles: non-fragmented MP4/MOV, avc1/avc3 (H.264), hvc1/hev1 (HEVC),
   vp09 (VP9), av01 (AV1). Fragmented MP4 is detected and reported.
   ===================================================================== */

const HANDLER_VIDEO = 0x76696465; // 'vide'

function fourcc(dv, p) {
  return String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
}

/* Walk sibling boxes in [start,end). Yields {type, start, end} where
   start is the first payload byte. */
function* boxes(dv, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = fourcc(dv, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr || p + size > end) return;   // truncated / garbage
    yield { type, start: p + hdr, end: p + size };
    p += size;
  }
}

function findBox(dv, start, end, type) {
  for (const b of boxes(dv, start, end)) if (b.type === type) return b;
  return null;
}

function findPath(dv, start, end, path) {
  let cur = { start, end };
  for (const t of path) {
    const b = findBox(dv, cur.start, cur.end, t);
    if (!b) return null;
    cur = b;
  }
  return cur;
}

const hex2 = n => n.toString(16).padStart(2, '0');

/* --------------------------- codec configs --------------------------- */

// A VisualSampleEntry is 78 bytes of fixed fields after the 8-byte box
// header; child boxes (avcC, hvcC, …) follow.
const VISUAL_ENTRY_HEADER = 78;

function readVisualEntry(dv, entryStart, entryEnd, format) {
  const codedWidth = dv.getUint16(entryStart + 24);
  const codedHeight = dv.getUint16(entryStart + 26);
  const childStart = entryStart + VISUAL_ENTRY_HEADER;
  let codec = null, description = null;

  if (format === 'avc1' || format === 'avc3') {
    const b = findBox(dv, childStart, entryEnd, 'avcC');
    if (b) {
      description = new Uint8Array(dv.buffer, dv.byteOffset + b.start, b.end - b.start).slice();
      codec = `avc1.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`;
    }
  } else if (format === 'hvc1' || format === 'hev1') {
    const b = findBox(dv, childStart, entryEnd, 'hvcC');
    if (b) {
      const d = new Uint8Array(dv.buffer, dv.byteOffset + b.start, b.end - b.start).slice();
      description = d;
      // hvcC: [0]=ver [1]=profile_space(2)|tier(1)|profile_idc(5)
      //       [2..5]=compat flags  [6..11]=constraint  [12]=level_idc
      const space = ['', 'A', 'B', 'C'][(d[1] >> 6) & 3];
      const profile = d[1] & 0x1f;
      const tier = (d[1] >> 5) & 1 ? 'H' : 'L';
      // compatibility flags are stored big-endian but written reversed in the string
      let compat = dv.getUint32(b.start + 2) >>> 0;
      let rev = 0;
      for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
      codec = `${format}.${space}${profile}.${(rev >>> 0).toString(16)}.${tier}${d[12]}.B0`;
    }
  } else if (format === 'vp09' || format === 'vp08') {
    const b = findBox(dv, childStart, entryEnd, 'vpcC');
    if (b) {
      const s = b.start + 4;                                  // skip version+flags
      const profile = dv.getUint8(s), level = dv.getUint8(s + 1);
      const depth = dv.getUint8(s + 2) >> 4;
      // VP9 codec-string fields are two-digit DECIMAL, unlike H.264's hex.
      const d2 = n => String(n).padStart(2, '0');
      codec = `vp09.${d2(profile)}.${d2(level)}.${d2(depth)}`;
      // VP9 needs no description; the bitstream is self-describing.
    }
  } else if (format === 'av01') {
    const b = findBox(dv, childStart, entryEnd, 'av1C');
    if (b) {
      const d = new Uint8Array(dv.buffer, dv.byteOffset + b.start, b.end - b.start).slice();
      description = d;
      const profile = (d[1] >> 5) & 7, level = d[1] & 0x1f, tier = (d[2] >> 7) & 1;
      const depth = ((d[2] >> 6) & 1) ? ((d[2] >> 5) & 1 ? 12 : 10) : 8;
      codec = `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
    }
  }
  return { codec, description, codedWidth, codedHeight, format };
}

/* --------------------------- sample table --------------------------- */

function parseStbl(dv, stbl) {
  const out = {};

  const stsd = findBox(dv, stbl.start, stbl.end, 'stsd');
  if (!stsd) throw new Error('No stsd box — malformed file.');
  {
    const p = stsd.start + 4;                                 // version/flags
    const count = dv.getUint32(p);
    if (!count) throw new Error('Empty sample description.');
    const entryStart = p + 4;
    const entrySize = dv.getUint32(entryStart);
    const format = fourcc(dv, entryStart + 4);
    out.config = readVisualEntry(dv, entryStart + 8, entryStart + entrySize, format);
  }

  // stts — decode-time deltas, run-length encoded
  const stts = findBox(dv, stbl.start, stbl.end, 'stts');
  const deltas = [];
  if (stts) {
    const n = dv.getUint32(stts.start + 4);
    let p = stts.start + 8;
    for (let i = 0; i < n; i++, p += 8) {
      const cnt = dv.getUint32(p), d = dv.getUint32(p + 4);
      for (let k = 0; k < cnt; k++) deltas.push(d);
    }
  }

  // ctts — composition offsets (present when there are B-frames). The spec says version-0
  // offsets are unsigned, but real iPhone HEVC clips write version-0 boxes with negative
  // offsets anyway — read as unsigned they wrap to ~4.29e9 and poison every timestamp
  // downstream. Read signed unconditionally; that's what every real encoder means by it.
  const ctts = findBox(dv, stbl.start, stbl.end, 'ctts');
  const cOffsets = [];
  if (ctts) {
    const n = dv.getUint32(ctts.start + 4);
    let p = ctts.start + 8;
    for (let i = 0; i < n; i++, p += 8) {
      const cnt = dv.getUint32(p);
      const off = dv.getInt32(p + 4);
      for (let k = 0; k < cnt; k++) cOffsets.push(off);
    }
  }

  // stsz — sample sizes
  const stsz = findBox(dv, stbl.start, stbl.end, 'stsz');
  const sizes = [];
  let sampleCount = 0;
  if (stsz) {
    const uniform = dv.getUint32(stsz.start + 4);
    sampleCount = dv.getUint32(stsz.start + 8);
    if (uniform) { for (let i = 0; i < sampleCount; i++) sizes.push(uniform); }
    else { let p = stsz.start + 12; for (let i = 0; i < sampleCount; i++, p += 4) sizes.push(dv.getUint32(p)); }
  }

  // stsc — sample-to-chunk runs
  const stsc = findBox(dv, stbl.start, stbl.end, 'stsc');
  const runs = [];
  if (stsc) {
    const n = dv.getUint32(stsc.start + 4);
    let p = stsc.start + 8;
    for (let i = 0; i < n; i++, p += 12) {
      runs.push({ firstChunk: dv.getUint32(p), perChunk: dv.getUint32(p + 4) });
    }
  }

  // stco / co64 — chunk file offsets
  const stco = findBox(dv, stbl.start, stbl.end, 'stco');
  const co64 = findBox(dv, stbl.start, stbl.end, 'co64');
  const chunkOffsets = [];
  if (stco) {
    const n = dv.getUint32(stco.start + 4);
    let p = stco.start + 8;
    for (let i = 0; i < n; i++, p += 4) chunkOffsets.push(dv.getUint32(p));
  } else if (co64) {
    const n = dv.getUint32(co64.start + 4);
    let p = co64.start + 8;
    for (let i = 0; i < n; i++, p += 8) chunkOffsets.push(Number(dv.getBigUint64(p)));
  }

  // stss — sync (key) samples; absent means every sample is a keyframe
  const stss = findBox(dv, stbl.start, stbl.end, 'stss');
  let sync = null;
  if (stss) {
    sync = new Set();
    const n = dv.getUint32(stss.start + 4);
    let p = stss.start + 8;
    for (let i = 0; i < n; i++, p += 4) sync.add(dv.getUint32(p) - 1);
  }

  // Expand stsc runs into a per-sample (offset) list.
  const offsets = new Array(sampleCount);
  let sample = 0;
  for (let r = 0; r < runs.length && sample < sampleCount; r++) {
    const first = runs[r].firstChunk - 1;
    const last = (r + 1 < runs.length ? runs[r + 1].firstChunk - 1 : chunkOffsets.length);
    for (let ch = first; ch < last && sample < sampleCount; ch++) {
      let off = chunkOffsets[ch];
      if (off == null) break;
      for (let k = 0; k < runs[r].perChunk && sample < sampleCount; k++) {
        offsets[sample] = off;
        off += sizes[sample];
        sample++;
      }
    }
  }

  out.sampleCount = sampleCount;
  out.sizes = sizes; out.offsets = offsets; out.deltas = deltas;
  out.cOffsets = cOffsets; out.sync = sync;
  return out;
}

/* ------------------------------ public ------------------------------ */

/**
 * Parse an MP4/MOV ArrayBuffer into a decodable video track.
 * @returns {{config, samples:Array<{offset,size,dts,cts,key}>, timescale,
 *            width, height, durationSec, nominalFps, hasBFrames}}
 */
export function demuxMp4(buffer) {
  const dv = new DataView(buffer);

  // Reject fragmented MP4 early with a message that tells you what to do.
  let sawMoof = false, moov = null;
  for (const b of boxes(dv, 0, dv.byteLength)) {
    if (b.type === 'moof') sawMoof = true;
    if (b.type === 'moov') moov = b;
  }
  if (!moov) {
    throw new Error(sawMoof
      ? 'Fragmented MP4 (moof) without a moov index — not supported. Re-export or use a normal recording.'
      : 'No moov box found. This does not look like an MP4 or MOV file.');
  }

  // Find the video trak.
  let videoTrak = null;
  for (const trak of boxes(dv, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const hdlr = findPath(dv, trak.start, trak.end, ['mdia', 'hdlr']);
    if (!hdlr) continue;
    if (dv.getUint32(hdlr.start + 8) === HANDLER_VIDEO) { videoTrak = trak; break; }
  }
  if (!videoTrak) throw new Error('No video track in this file.');

  const mdhd = findPath(dv, videoTrak.start, videoTrak.end, ['mdia', 'mdhd']);
  const mdhdVer = dv.getUint8(mdhd.start);
  const timescale = mdhdVer === 1 ? dv.getUint32(mdhd.start + 20) : dv.getUint32(mdhd.start + 12);
  const mediaDuration = mdhdVer === 1
    ? Number(dv.getBigUint64(mdhd.start + 24))
    : dv.getUint32(mdhd.start + 16);

  // Edit list. Players use this to trim/shift a track; ffmpeg applies it so
  // the first presented frame lands at t=0. Without it our timestamps sit at a
  // constant offset — harmless for relative timing, but wrong, and it would
  // desync anything we ever compare against a player's own clock.
  let editMediaTime = null;
  const elst = findPath(dv, videoTrak.start, videoTrak.end, ['edts', 'elst']);
  if (elst) {
    const version = dv.getUint8(elst.start);
    const n = dv.getUint32(elst.start + 4);
    let p = elst.start + 8;
    for (let i = 0; i < n; i++) {
      const mt = version === 1
        ? Number(dv.getBigInt64(p + 8))
        : dv.getInt32(p + 4);
      p += version === 1 ? 20 : 12;
      if (mt >= 0) { editMediaTime = mt; break; }   // -1 is an empty (gap) edit
    }
  }

  const stbl = findPath(dv, videoTrak.start, videoTrak.end, ['mdia', 'minf', 'stbl']);
  if (!stbl) throw new Error('No sample table (stbl) in the video track.');
  const t = parseStbl(dv, stbl);

  if (!t.config.codec) {
    throw new Error(`Unsupported video codec "${t.config.format}" — no decoder config found.`);
  }

  // Build the sample list with real timestamps.
  const samples = [];
  let dts = 0;
  for (let i = 0; i < t.sampleCount; i++) {
    const delta = t.deltas[i] != null ? t.deltas[i] : (t.deltas[t.deltas.length - 1] || 0);
    samples.push({
      offset: t.offsets[i],
      size: t.sizes[i],
      dts,
      cts: dts + (t.cOffsets[i] || 0),
      key: t.sync ? t.sync.has(i) : true
    });
    dts += delta;
  }
  // Samples stay in DECODE order (the loop above already built them that way, straight
  // off the sample table) — VideoDecoder.decode() requires decode order, and a B-frame
  // clip's decode order is not its presentation order. Do not sort by cts here: that
  // was the bug. cts values are still used for scheduling/normalisation below.

  // Normalise to the edit list if there is one, otherwise to the first
  // presented frame. Either way the first frame we hand out is t = 0. With B-frames the
  // earliest *presented* cts isn't necessarily samples[0] (decode order), so scan for it.
  const shift = editMediaTime != null ? editMediaTime :
    (samples.length ? Math.min(...samples.map(s => s.cts)) : 0);
  for (const s of samples) { s.cts -= shift; s.dts -= shift; }

  const durationSec = mediaDuration / timescale;
  const nominalFps = durationSec > 0 ? t.sampleCount / durationSec : 0;

  return {
    config: t.config,
    samples,
    timescale,
    width: t.config.codedWidth,
    height: t.config.codedHeight,
    durationSec,
    nominalFps,
    hasBFrames: t.cOffsets.length > 0
  };
}

/** Slice one sample's bytes out of the file buffer. */
export function sampleBytes(buffer, s) {
  return new Uint8Array(buffer, s.offset, s.size);
}
