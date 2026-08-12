import sys, math, numpy as np, cv2
sys.path.insert(0,'/app')
from server import vision

frames, times = vision.decode(sys.argv[1])
print(f"{len(frames)} frames  {frames[0].shape[1]}x{frames[0].shape[0]}")

seed = vision.find_ball_at_rest(frames)
print("seed:", seed)

# what does the yellow mask actually look like?
f = frames[0]
hsv = cv2.cvtColor(f, cv2.COLOR_BGR2HSV)
for hue,tol,s,v in ((30,18,70,70),(30,25,50,50),(25,25,40,40)):
    lo=np.array([max(0,hue-tol),s,v],np.uint8); hi=np.array([min(179,hue+tol),255,255],np.uint8)
    m=cv2.inRange(hsv,lo,hi)
    n,_,st,_=cv2.connectedComponentsWithStats(m,8)
    spans=sorted([max(st[i,cv2.CC_STAT_WIDTH],st[i,cv2.CC_STAT_HEIGHT]) for i in range(1,n) if st[i,cv2.CC_STAT_AREA]>=120], reverse=True)[:3]
    print(f"  hue{hue}±{tol} s>{s} v>{v}: {cv2.countNonZero(m)} px, top spans {spans} (need >{0.25*max(m.shape):.0f})")

L = vision.find_line(frames[0])
print("line:", L)

# template match scores over the first frames
if seed:
    r=max(6,int(round(seed['d']*0.75)))
    g0=cv2.cvtColor(frames[0],cv2.COLOR_BGR2GRAY)
    x0,y0=int(round(seed['x']-r)),int(round(seed['y']-r))
    tmpl=g0[y0:y0+2*r, x0:x0+2*r]
    print(f"  template {tmpl.shape} at ({seed['x']:.0f},{seed['y']:.0f}) r={r}")
    cx,cy=seed['x'],seed['y']
    for i in range(1,9):
        g=cv2.cvtColor(frames[i],cv2.COLOR_BGR2GRAY)
        rad=int(round(r*3))
        a,b=max(0,int(cx-rad)),max(0,int(cy-rad))
        c,d=min(g.shape[1],int(cx+rad)),min(g.shape[0],int(cy+rad))
        res=cv2.matchTemplate(g[b:d,a:c],tmpl,cv2.TM_CCOEFF_NORMED)
        _,mx,_,loc=cv2.minMaxLoc(res)
        nx=a+loc[0]+tmpl.shape[1]/2; ny=b+loc[1]+tmpl.shape[0]/2
        print(f"   f{i}: score {mx:.2f} -> ({nx:.0f},{ny:.0f})")
        cx,cy=nx,ny
