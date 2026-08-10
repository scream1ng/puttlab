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

echo "wrote fixtures/{h264,hevc,vp9,elst}.mp4"
