"""The head detector alternates between two objects at address. Show both.

Frames 6 and 7 of IMG_3882 put the head 60 mm apart with the club not moving,
which is not a stroke — it is two different blobs winning on alternate frames.
"""
import sys, math
import numpy as np, cv2
sys.path.insert(0, "/app")
from server import vision

path, out = sys.argv[1], sys.argv[2]
want_frames = [int(a) for a in sys.argv[3:]] or [6, 7]

frames, times = vision.decode(path)
h, w = frames[0].shape[:2]
cands = vision.ball_candidates_at_rest(frames)
bt = None; bd = 0.0; seed = None
for c in cands:
    tr = vision.track_ball(frames, c)
    if len(tr) < 8:
        continue
    dep = math.hypot(tr[-1]["x"] - tr[0]["x"], tr[-1]["y"] - tr[0]["y"])
    pk = max(math.hypot(p["x"] - tr[0]["x"], p["y"] - tr[0]["y"]) for p in tr)
    if pk < 0.06 * math.hypot(w, h) or dep < 0.6 * pk:
        continue
    if dep > bd:
        bt, bd, seed = tr, dep, c
byi = {t["i"]: t for t in bt}
bg = vision.background(frames)
shifts = vision.camera_shift(frames, bg)
mm = vision.BALL_MM / seed["d"]
want = vision.HEAD_MM / mm
print(f"ball d={seed['d']:.1f}px  mm/px={mm:.3f}  head want={want:.0f}px")

rows = []
for n in want_frames:
    fr = frames[n]
    gray = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
    sh = shifts[n]
    M = np.float32([[1, 0, sh[0]], [0, 1, sh[1]]])
    ref = cv2.warpAffine(bg, M, (bg.shape[1], bg.shape[0]),
                         flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    m = ((cv2.absdiff(gray, ref) > 24) & (gray > 150)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    k = max(3, int(round(want * 0.17)) | 1)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    b = byi.get(n)
    vis = fr.copy()
    print(f"\nframe {n}: ball ({b['x']:.0f},{b['y']:.0f})  {len(cnts)} blobs")
    scored = []
    for c in cnts:
        a = cv2.contourArea(c)
        x, y, bw, bh = cv2.boundingRect(c)
        span = max(bw, bh)
        (cx, cy), _ = cv2.minEnclosingCircle(c)
        d = math.hypot(cx - b["x"], cy - b["y"])
        ok = a >= (want * 0.25) ** 2 and want * 0.45 <= span <= want * 3.0 \
            and seed["d"] * 0.9 <= d <= want * 3.5
        width_err = abs(min(bw, bh) - want * 0.62) / want
        near = d / (want * 3.5)
        solid = a / max(1.0, bw * bh)
        score = solid * 1.6 - width_err - near * 0.5
        scored.append((score if ok else -99, c, cx, cy, a, bw, bh, d, ok, solid, width_err, near))
    scored.sort(key=lambda s: -s[0])
    for s in scored[:6]:
        sc, c, cx, cy, a, bw, bh, d, ok, solid, we, nr = s
        print(f"   a={a:7.0f} bbox={bw:3d}x{bh:3d} at({cx:6.0f},{cy:6.0f}) dist={d:5.0f} "
              f"solid={solid:.2f} werr={we:.2f} near={nr:.2f} score={sc:6.2f} {'ACCEPT' if ok else 'reject'}")
        cv2.drawContours(vis, [c], -1, (60, 220, 60) if ok else (60, 60, 220), 2)
    win = scored[0]
    cv2.circle(vis, (int(win[2]), int(win[3])), 10, (250, 190, 60), -1)
    cv2.circle(vis, (int(b["x"]), int(b["y"])), int(seed["d"] / 2), (90, 220, 90), 2)
    cv2.putText(vis, f"frame {n}  gold=winner  green=accepted  red=rejected", (10, 26),
                cv2.FONT_HERSHEY_SIMPLEX, .6, (255, 255, 255), 2, cv2.LINE_AA)
    rows.append(np.hstack([vis, cv2.cvtColor(m, cv2.COLOR_GRAY2BGR)]))

cv2.imwrite(f"{out}/headflip.png", np.vstack(rows))
print(f"\nwrote {out}/headflip.png")
