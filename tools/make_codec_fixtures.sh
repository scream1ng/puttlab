#!/bin/sh
# Tiny multi-codec clips used to validate the demuxer against ffprobe.
# Regenerate with: sh tools/make_codec_fixtures.sh
set -e
mkdir -p fixtures
for enc in libx264:h264 libx265:hevc libvpx-vp9:vp9; do
  e=${enc%%:*}; n=${enc##*:}
  ffmpeg -v error -y -f lavfi -i testsrc2=size=320x180:rate=60:duration=1 \
    -c:v "$e" -pix_fmt yuv420p "fixtures/$n.mp4"
done

# A clip with a real edit list (moov/trak/edts/elst): short GOP so a keyframe lands
# exactly on the -ss cut point, then `-c copy` trims at the container level instead of
# re-encoding, which is what actually produces an elst with a nonzero media_time.
ffmpeg -v error -y -f lavfi -i testsrc2=size=320x180:rate=60:duration=1 \
  -c:v libx264 -g 6 -keyint_min 6 -pix_fmt yuv420p fixtures/elst_src.mp4
ffmpeg -v error -y -i fixtures/elst_src.mp4 -ss 0.1 -c copy fixtures/elst.mp4
rm fixtures/elst_src.mp4


# A clip whose ctts box has negative version-0 composition offsets — spec says v0 is
# unsigned, but real iPhone HEVC clips write v0 with negatives anyway. ffmpeg always
# shifts v0 offsets non-negative, so this can't be produced by encoding; patch a copy
# of h264.mp4 in place instead (fixed entry count/box size, no offset recalculation).
python3 - <<'PYEOF'
import struct, shutil

shutil.copy('fixtures/h264.mp4', 'fixtures/ctts_negative.mp4')

def find(data, start, end, path):
    for t in path:
        p = start
        found = None
        while p + 8 <= end:
            size = struct.unpack('>I', data[p:p+4])[0]
            typ = data[p+4:p+8].decode('latin1')
            if size == 0: size = end - p
            if typ == t:
                found = (p + 8, p + size)
                break
            p += size
        if not found: return None
        start, end = found
    return start, end

with open('fixtures/ctts_negative.mp4', 'r+b') as f:
    data = bytearray(f.read())
    moov = find(data, 0, len(data), ['moov'])
    stbl = find(data, *moov, ['trak', 'mdia', 'minf', 'stbl'])
    ctts = find(data, *stbl, ['ctts'])
    s = ctts[0]
    assert data[s:s+4] == b'\x00\x00\x00\x00', 'expected ctts version 0'
    n = struct.unpack('>I', data[s+4:s+8])[0]
    p = s + 8
    for i in range(n):
        off = struct.unpack('>i', data[p+4:p+8])[0]
        if off > 0 and i % 2 == 0:          # negate every other positive entry
            struct.pack_into('>i', data, p + 4, -off)
        p += 8
    f.seek(0)
    f.write(data)
PYEOF

echo "wrote fixtures/{h264,hevc,vp9,elst,ctts_negative}.mp4"
