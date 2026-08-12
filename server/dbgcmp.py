"""What render.py draws vs what analyse.py measures, on the same clip.

The user judged the picture and the picture is drawn by a second, unguarded copy
of the pipeline. This prints both so the divergence is a number, not a guess.
"""
import sys, math
sys.path.insert(0, "/app")
from server import vision, analyse

path = sys.argv[1]
r = analyse.observations(path)
print("clip", path.split("/")[-1])
for k in ("frames", "containerFps", "captureFps", "ballDiameterPx", "mmPerPx",
          "ballFrames", "lineFrames", "headFrames",
          "faceOutliersDropped", "headOutliersDropped"):
    print(f"  {k:22s} {r[k]}")

obs = r["observations"]
kept = [(i, o) for i, o in enumerate(obs) if o["head"]]
print(f"  kept head+face frames  {len(kept)}  span {kept[0][0]}..{kept[-1][0]}")
xs = [o["head"]["x"] for _, o in kept]
ys = [o["head"]["y"] for _, o in kept]
print(f"  head across span {max(xs)-min(xs):.0f} mm   along span {max(ys)-min(ys):.0f} mm")
bx = [o["ball"]["x"] for o in obs if o["ball"]]
print(f"  ball across span {max(bx)-min(bx):.0f} mm")

# face angle relative to the mat line, per kept frame, degrees
print("  frame  faceDeg  headX(mm)  headY(mm)")
for i, o in kept:
    d = (o["face"]["b"]["x"] - o["face"]["a"]["x"], o["face"]["b"]["y"] - o["face"]["a"]["y"])
    a = math.degrees(math.atan2(d[1], d[0]))
    a = (a + 90) % 180 - 90
    print(f"  {i:5d}  {a:7.2f}  {o['head']['x']:8.1f}  {o['head']['y']:9.1f}")
