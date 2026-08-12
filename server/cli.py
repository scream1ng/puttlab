"""Run detection on a clip from the command line — no browser, no upload."""
import sys, json, math
sys.path.insert(0, '/app')
from server.analyse import observations

path = sys.argv[1]
fps = float(sys.argv[2]) if len(sys.argv) > 2 else None
r = observations(path, capture_fps=fps)
if 'error' in r:
    print(f"FAIL: {r['error']}"); sys.exit(1)
obs = r['observations']
nb = sum(1 for o in obs if o['ball'])
nf = sum(1 for o in obs if o['face'])
print(f"{path}")
print(f"  {r['width']}x{r['height']} · {r['frames']} frames · container {r['containerFps']:.1f} fps · capture {r['captureFps']:.0f}")
print(f"  ball diameter {r['ballDiameterPx']:.1f}px -> {r['mmPerPx']:.3f} mm/px")
print(f"  ball tracked {nb}/{r['frames']} · line {r['lineFrames']} · face {nf}")
bs = [o for o in obs if o['ball']]
if bs:
    a, b = bs[0]['ball'], bs[-1]['ball']
    print(f"  ball path: ({a['x']:.0f},{a['y']:.0f}) -> ({b['x']:.0f},{b['y']:.0f}) mm")
import os
if os.environ.get('DUMP'):
    with open(os.environ['DUMP'],'w') as fh: json.dump(r, fh)
    print(f"  wrote {os.environ['DUMP']}")
fs = [o for o in obs if o['face']]
if fs:
    def ang(o):
        d = o['face']['b']['x']-o['face']['a']['x'], o['face']['b']['y']-o['face']['a']['y']
        return math.degrees(math.atan2(d[1], d[0]))
    print(f"  face angle range: {min(ang(o) for o in fs):.1f}° .. {max(ang(o) for o in fs):.1f}°")
