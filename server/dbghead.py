"""Show the head detector's own masks, so a wrong pick is visible not inferred."""
import sys, math
import numpy as np, cv2
sys.path.insert(0, "/app")
from server import vision

path, out = sys.argv[1], sys.argv[2]
frames, times = vision.decode(path)
h, w = frames[0].shape[:2]

cands = vision.ball_candidates_at_rest(frames)
bt = None; bd = 0
for c in cands:
    tr = vision.track_ball(frames, c)
    if len(tr) < 8: continue
    dep = math.hypot(tr[-1]["x"]-tr[0]["x"], tr[-1]["y"]-tr[0]["y"])
    pk = max(math.hypot(p["x"]-tr[0]["x"], p["y"]-tr[0]["y"]) for p in tr)
    if pk < 0.06*math.hypot(w,h) or dep < 0.6*pk: continue
    if dep > bd: bt, bd, seed = tr, dep, c
byi = {t["i"]: t for t in bt}
bg = vision.background(frames)
mm = vision.BALL_MM / seed["d"]
want = vision.HEAD_MM / mm
print(f"ball d={seed['d']:.1f}px  mm/px={mm:.3f}  expected head width={want:.0f}px")

rows = []
for n in (204, 232, 244):
    fr = frames[n]
    gray = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
    sh = vision.camera_shift(frames, bg)[n]
    M = np.float32([[1,0,sh[0]],[0,1,sh[1]]])
    ref = cv2.warpAffine(bg, M, (bg.shape[1], bg.shape[0]), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    moved = cv2.absdiff(gray, ref) > 24
    bright = gray > 150
    comb = (moved & bright).astype(np.uint8)*255
    comb = cv2.morphologyEx(comb, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(5,5)))
    comb = cv2.morphologyEx(comb, cv2.MORPH_OPEN,  cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(3,3)))

    vis = fr.copy()
    b = byi.get(n)
    cnts,_ = cv2.findContours(comb, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    print(f"\nframe {n}: ball at ({b['x']:.0f},{b['y']:.0f})  {len(cnts)} bright+moving blobs")
    for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:6]:
        a = cv2.contourArea(c)
        x,y,bw,bh = cv2.boundingRect(c)
        (cx,cy),_ = cv2.minEnclosingCircle(c)
        d = math.hypot(cx-b["x"], cy-b["y"])
        span = max(bw,bh)
        ok = (a >= (want*0.25)**2) and (want*0.45 <= span <= want*2.1) and (seed["d"]*0.9 <= d <= want*3.5)
        print(f"   a={a:7.0f} bbox={bw:3d}x{bh:3d} span={span:3d} at({cx:.0f},{cy:.0f}) dist={d:5.0f}  {'ACCEPT' if ok else 'reject'}")
        cv2.drawContours(vis, [c], -1, (60,220,60) if ok else (60,60,220), 2)
    cv2.circle(vis, (int(b["x"]),int(b["y"])), int(seed["d"]/2), (90,220,90), 2)
    mask3 = cv2.cvtColor(comb, cv2.COLOR_GRAY2BGR)
    cv2.putText(vis, f"frame {n}  green=accepted  red=rejected", (10,26),
                cv2.FONT_HERSHEY_SIMPLEX, .6, (255,255,255), 2, cv2.LINE_AA)
    cv2.putText(mask3, "bright AND moving", (10,26),
                cv2.FONT_HERSHEY_SIMPLEX, .6, (255,255,255), 2, cv2.LINE_AA)
    rows.append(np.hstack([vis, mask3]))

cv2.imwrite(f"{out}/headmask.png", np.vstack(rows))
print(f"\nwrote {out}/headmask.png")
