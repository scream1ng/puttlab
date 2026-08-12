"""Critical check of the fitted arc: is it physically a putting stroke?"""
import sys, math, numpy as np, cv2
sys.path.insert(0,'/app')
from server import vision

frames, times = vision.decode(sys.argv[1])
h,w = frames[0].shape[:2]
cands = vision.ball_candidates_at_rest(frames)
bt=None; bd=0
for c in cands:
    tr=vision.track_ball(frames,c)
    if len(tr)<8: continue
    dep=math.hypot(tr[-1]['x']-tr[0]['x'],tr[-1]['y']-tr[0]['y'])
    pk=max(math.hypot(p['x']-tr[0]['x'],p['y']-tr[0]['y']) for p in tr)
    if pk<0.06*math.hypot(w,h) or dep<0.6*pk: continue
    if dep>bd: bt,bd,seed=tr,dep,c
byi={t['i']:t for t in bt}
bg=vision.background(frames); sh=vision.camera_shift(frames,bg)
mm=vision.BALL_MM/seed['d']; want=vision.HEAD_MM/mm
tx=bt[-1]['x']-bt[0]['x']; ty=bt[-1]['y']-bt[0]['y']
tn=math.hypot(tx,ty) or 1; tux,tuy=tx/tn,ty/tn
x0,y0=bt[0]['x'],bt[0]['y']
strike=next((t['i'] for t in bt if math.hypot(t['x']-x0,t['y']-y0)>seed['d']*1.2), bt[-1]['i'])

heads=[]
for i,fr in enumerate(frames):
    b=byi.get(i)
    if not b: continue
    hd=vision.find_head(fr,(b['x'],b['y']),seed['d'],seed['d']*0.9,bg,mm,sh[i])
    if not hd: continue
    f=vision.face_line(fr,hd,(hd['x']+tux*1000,hd['y']+tuy*1000),want)
    if f and f['rms']*mm<=2.5: heads.append((i,hd['x'],hd['y']))

L0=vision.find_line(frames[max(0,strike-20)]); rad=L0[0] if L0 else 0.0
arc,kept=vision.fit_arc([(x,y) for _,x,y in heads], rad)
ux,uy=math.cos(rad),math.sin(rad); rx,ry=-uy,ux

print(f"scale {mm:.3f} mm/px · head width should be {want:.0f}px · strike frame {strike}")
print(f"head detections {len(heads)} · arc kept {arc['kept']}/{arc['total']}")

al=np.array([x*ux+y*uy for _,x,y in heads]); ac=np.array([x*rx+y*ry for _,x,y in heads])
idx=np.array([i for i,_,_ in heads])
pred=np.polyval(arc['coef'], al)
res=(ac-pred)*mm
print(f"residual to the fitted arc: median {np.median(np.abs(res)):.1f} mm · p90 {np.percentile(np.abs(res),90):.1f} mm")

# arc shape
ts=np.linspace(arc['lo'],arc['hi'],400); cs=np.polyval(arc['coef'],ts)
sag=(cs.max()-cs.min())*mm
apex_along=ts[np.argmax(cs)] if arc['coef'][0]<0 else ts[np.argmin(cs)]
b_s=byi[strike]; ball_along=b_s['x']*ux+b_s['y']*uy
print(f"ARC depth (sagitta) {sag:.1f} mm   <- a putting stroke is ~10-40 mm")
print(f"arc apex is {abs(apex_along-ball_along)*mm:.0f} mm from the ball along the mat  <- should be near 0")
print(f"arc spans {(arc['hi']-arc['lo'])*mm:.0f} mm along the mat")

# where do rejected frames sit in time?
keptset={(round(x,3),round(y,3)) for x,y in kept}
rej=[i for i,x,y in heads if (round(x,3),round(y,3)) not in keptset]
if rej:
    r=np.array(rej)
    print(f"rejected frames: {len(rej)}, from {r.min()} to {r.max()}, "
          f"{100*np.mean((r>strike-30)&(r<strike+30)):.0f}% within 30 frames of the strike")

# is the head centre stable relative to the ball before the stroke?
pre=[(i,x,y) for i,x,y in heads if i<strike-40]
if len(pre)>10:
    pa=np.array([x*rx+y*ry for _,x,y in pre])*mm
    print(f"before the stroke, head across-mat scatter: {pa.std():.1f} mm sd, range {pa.max()-pa.min():.1f} mm")
