"""
Draw what was measured back onto the video.

This exists because numbers hide mistakes and pictures do not. A face angle of
-1.7 degrees looks perfectly reasonable on a readout whether it came off the
putter face or off a shadow; drawn on the frame, the difference is instant.

It draws from analyse.observations() and detects nothing itself. It used to run
its own copy of the pipeline, which had none of the gates the measurement
applies, so the picture showed face fits and head positions that had already
been rejected — and the picture was what got judged. One pipeline, one answer.
"""

import sys, math
import numpy as np
import cv2

sys.path.insert(0, "/app")
from server import vision

BALL = (90, 220, 90)
HEAD = (250, 190, 60)
FACE = (60, 120, 250)
LINE = (60, 220, 250)


def render(path, out_dir, result=None):
    """Draw the four key frames and the arc. `result` comes from observations()."""
    if result is None or not result.get("image"):
        from server import analyse
        result = analyse.observations(path, want_image=True)
    img = result["image"]
    if not img or not img["geom"]:
        print("nothing measured to draw")
        return

    geom = {int(k): v for k, v in img["geom"].items()}
    balls = {int(k): v for k, v in img["ball"].items()}
    mm = img["mmPerPx"]
    ball_d = img["ballDiameterPx"]
    tux, tuy = img["toward"]
    want = vision.HEAD_MM / mm

    keys = sorted(geom)
    # Where the ball leaves: the first frame it is far from address.
    bk = sorted(balls)
    x0, y0 = balls[bk[0]]
    strike = next((i for i in bk
                   if math.hypot(balls[i][0] - x0, balls[i][1] - y0) > ball_d * 1.2), bk[-1])

    # THE ARC — the path of the point that strikes the ball, not of the head's
    # blob centre. The centre sits half a head behind the face, so an arc drawn
    # through it can never pass through the ball; this one does, by construction,
    # at the moment of contact. Camera drift is taken out before fitting and put
    # back per frame when drawing, otherwise a panning camera smears the curve.
    #
    # The contact point itself is built in analyse.py, so the curve drawn here is
    # made of the same points PUTTER PATH is measured from. Building it twice is
    # how the drawing and the readout came to disagree in the first place.
    pts = []
    for i in keys:
        cx_, cy_ = geom[i]["contact"]
        sx, sy = geom[i]["shift"]
        pts.append((cx_ - sx, cy_ - sy))
    line_rad = geom[keys[len(keys) // 2]]["line"][0]
    arc, _ = vision.fit_arc(pts, line_rad)
    base_arc = vision.arc_polyline(arc) if arc else []
    if arc:
        print(f"arc fit kept {arc['kept']}/{arc['total']} contact points")

    frames, _times = vision.decode(path)
    h, w = frames[0].shape[:2]
    trail = [(int(balls[i][0]), int(balls[i][1])) for i in bk]

    shown = [max(0, strike - 40), max(0, strike - 12), strike,
             min(len(frames) - 1, strike + 12)]
    panels = []
    for n in shown:
        im = frames[n].copy()
        g = geom.get(n)
        sx, sy = g["shift"] if g else (0.0, 0.0)

        ref = g or geom[min(keys, key=lambda k: abs(k - n))]
        lr, lx, ly = ref["line"]
        ux, uy = math.cos(lr), math.sin(lr)
        cv2.line(im, (int(lx - ux * 3000), int(ly - uy * 3000)),
                     (int(lx + ux * 3000), int(ly + uy * 3000)), LINE, 2, cv2.LINE_AA)

        for k in range(1, len(trail)):
            cv2.line(im, trail[k - 1], trail[k], BALL, 1, cv2.LINE_AA)

        pl = [(int(x + sx), int(y + sy)) for x, y in base_arc]
        for k in range(1, len(pl)):
            cv2.line(im, pl[k - 1], pl[k], (30, 30, 30), 9, cv2.LINE_AA)
        for k in range(1, len(pl)):
            cv2.line(im, pl[k - 1], pl[k], HEAD, 5, cv2.LINE_AA)

        if n in balls:
            cv2.circle(im, (int(balls[n][0]), int(balls[n][1])), int(ball_d / 2),
                       BALL, 4, cv2.LINE_AA)
        if g:
            fx, fy, rad = g["face"]
            L2 = want * 0.55                       # draw the face at club scale
            dx, dy = math.cos(rad) * L2, math.sin(rad) * L2
            cv2.line(im, (int(fx - dx), int(fy - dy)), (int(fx + dx), int(fy + dy)),
                     FACE, 5, cv2.LINE_AA)
            cv2.circle(im, (int(g["head"][0]), int(g["head"][1])), 8, HEAD, -1, cv2.LINE_AA)

        tag = {shown[0]: "before", shown[1]: "approach",
               strike: "STRIKE", shown[3]: "after"}.get(n, "")
        cv2.rectangle(im, (0, 0), (w, 34), (20, 20, 20), -1)
        cv2.putText(im, f"frame {n}  {tag}{'' if g else '  (no fit this frame)'}",
                    (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255, 255, 255), 2, cv2.LINE_AA)
        panels.append(im)

    grid = np.vstack([np.hstack(panels[:2]), np.hstack(panels[2:])])
    name = path.split("/")[-1].split(".")[0]
    cv2.imwrite(f"{out_dir}/{name}-frames.png", grid)

    # The arc on its own axes: across the mat against down the mat.
    # Rotated into the mat's own frame, so the axes mean what they are labelled.
    plot = np.full((520, 760, 3), 24, np.uint8)
    lux, luy = math.cos(line_rad), math.sin(line_rad)
    al = [p[0] * lux + p[1] * luy for p in pts]
    ac = [-p[0] * luy + p[1] * lux for p in pts]
    mnl, mxl, mnc, mxc = min(al), max(al), min(ac), max(ac)
    sl = 700 / max(1.0, mxl - mnl); sc = 460 / max(1.0, mxc - mnc)
    for k in range(1, len(pts)):
        a = (int(30 + (al[k - 1] - mnl) * sl), int(30 + (ac[k - 1] - mnc) * sc))
        b = (int(30 + (al[k] - mnl) * sl), int(30 + (ac[k] - mnc) * sc))
        cv2.line(plot, a, b, HEAD, 2, cv2.LINE_AA)
    cv2.putText(plot, f"contact point path  -  {len(pts)} frames", (30, 500),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1, cv2.LINE_AA)
    cv2.putText(plot, f"along {(mxl - mnl) * mm:.0f} mm   across {(mxc - mnc) * mm:.0f} mm",
                (30, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1, cv2.LINE_AA)
    cv2.imwrite(f"{out_dir}/{name}-arc.png", plot)
    print(f"strike frame {strike} · ball {len(bk)} · fits {len(keys)} · "
          f"wrote {name}-frames.png, {name}-arc.png")


if __name__ == "__main__":
    render(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "/out")
