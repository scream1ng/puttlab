import sys, math, numpy as np, cv2
sys.path.insert(0,'/app')
from server import vision

frames,times = vision.decode(sys.argv[1])
cands = vision.ball_candidates_at_rest(frames)
best=None;bt=None;bd=0
for c in cands:
    tr=vision.track_ball(frames,c)
    if len(tr)<8: continue
    dep=math.hypot(tr[-1]['x']-tr[0]['x'],tr[-1]['y']-tr[0]['y'])
    pk=max(math.hypot(p['x']-tr[0]['x'],p['y']-tr[0]['y']) for p in tr)
    if pk<0.06*math.hypot(*frames[0].shape[:2][::-1]): continue
    if dep<0.6*pk: continue
    if dep>bd: best,bt,bd=c,tr,dep
byi={t['i']:t for t in bt}
bg=vision.background(frames)
print(f"ball d={best['d']:.1f}px  track {len(bt)} frames")
for i in (0,60,120,160,180,200,220,240,260):
    b=byi.get(i)
    if not b: print(f" f{i}: no ball"); continue
    h=vision.find_head(frames[i],(b['x'],b['y']),best['d'],best['d']*0.9,bg,vision.BALL_MM/best['d'])
    if not h: print(f" f{i}: ball({b['x']:.0f},{b['y']:.0f}) NO HEAD"); continue
    x,y,wd,ht=cv2.boundingRect(h['contour'])
    f=vision.face_line(frames[i],h,(b['x'],b['y']), vision.HEAD_MM/(vision.BALL_MM/best['d']))
    print(f" f{i}: ball({b['x']:.0f},{b['y']:.0f}) head({h['x']:.0f},{h['y']:.0f}) a={h['area']:.0f} bbox={wd}x{ht} face={'rms %.1f deg %.1f'%(f['rms'],math.degrees(f['rad'])) if f else 'None'}")
