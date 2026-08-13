"""
Per-frame observations in mat millimetres — the exact shape analyse.js consumes.

The metrics themselves are deliberately NOT computed here. analyse.js and
geom.js already pass 51 checks against a fixture whose truth was rendered in
(face +1.20 deg, path -2.00, impact 0.900 s), and that is the only part of this
project with ground truth behind it. Porting it to Python would mean rewriting
the one trustworthy piece and re-earning that from scratch. So Python does the
part that was actually broken — finding things in the picture — and hands over
a list of {t, ball, face, head} for the tested arithmetic to consume unchanged.
"""

import math, os
import numpy as np
from . import vision

USE_SHIFT = os.environ.get('NOSHIFT') != '1'


def observations(path, capture_fps=None, progress=None, want_image=False):
    frames, times = vision.decode(path)
    if len(frames) < 8:
        return {"error": "clip too short to analyse"}

    h, w = frames[0].shape[:2]

    # Timing. A phone renders slow motion into a normal-rate container, so the
    # container's frame rate says nothing about how fast the ball really moved.
    span = times[-1] - times[0] if len(times) > 1 else 0
    container_fps = (len(times) - 1) / span if span > 0 else 30.0
    fps = capture_fps or container_fps
    scale_t = container_fps / fps if fps else 1.0

    cands = vision.ball_candidates_at_rest(frames)
    if not cands:
        return {"error": "could not find a still, ball-shaped object near the start of the clip"}

    # Track every candidate and keep the one that LEAVES. The ball is struck and
    # never comes back; a printed ring never moves and the putter swings back
    # through its own start. Appearance cannot tell them apart — this can.
    best, best_track, best_depart = None, None, 0.0
    for c in cands:
        tr = vision.track_ball(frames, c)
        if len(tr) < 8:
            continue
        dep = math.hypot(tr[-1]["x"] - tr[0]["x"], tr[-1]["y"] - tr[0]["y"])
        peak = max(math.hypot(p["x"] - tr[0]["x"], p["y"] - tr[0]["y"]) for p in tr)
        if peak < 0.06 * math.hypot(w, h):      # never went anywhere
            continue
        if dep < 0.6 * peak:                    # came back: a swing, not a strike
            continue
        if dep > best_depart:
            best, best_track, best_depart = c, tr, dep
    if best_track is None:
        return {"error": "no ball-shaped object travelled far enough to have been struck"}
    seed, track = best, best_track

    by_i = {t["i"]: t for t in track}
    mm_per_px = vision.BALL_MM / max(1.0, seed["d"])

    # Which way is "away": where the ball ended up relative to where it started.
    tx = track[-1]["x"] - track[0]["x"]
    ty = track[-1]["y"] - track[0]["y"]
    tn = math.hypot(tx, ty) or 1.0
    tux, tuy = tx / tn, ty / tn

    bg = vision.background(frames)
    shift = vision.camera_shift(frames, bg)
    obs, lines, heads = [], 0, 0
    # The same geometry in image pixels, so the picture can be drawn from the
    # measurement instead of from a second, ungated copy of this pipeline. The
    # two disagreed: the render showed face fits and head positions that the
    # gates below had already thrown away, which is what was being judged.
    img_geom = {}
    # The head must move CONTINUOUSLY. Re-detecting it independently every frame
    # let it jump between the club, a reflection and a shoe, which showed up as
    # 320 mm of arc where a putting stroke has 10-50. A club head cannot teleport.
    last_head, last_hi, hvx, hvy = None, -1, 0.0, 0.0
    cx0, cy0 = w / 2.0, h / 2.0
    for i, fr in enumerate(frames):
        L = vision.find_line(fr)
        rec = {"t": times[i] * scale_t, "ball": None, "face": None, "head": None}

        if L:
            lines += 1
            ux, uy = math.cos(L[0]), math.sin(L[0])
            if tx * ux + ty * uy < 0:
                ux, uy = -ux, -uy
            rx, ry = -uy, ux                    # image y runs down: right is u turned +90

            sx, sy = shift[i]

            def to_mat(p):
                # ACROSS the mat the line is the origin — that is what it is for,
                # and perpendicular distance to a line is well defined whichever
                # part of it is visible. ALONG the mat it is not: the line has no
                # features down its length, so its detected centroid slides as the
                # ball and putter occlude it. Use a fixed image point there.
                return {
                    "x": ((p[0] - L[1][0]) * rx + (p[1] - L[1][1]) * ry) * mm_per_px,
                    # Camera pan removed here: without it a drifting camera is
                    # indistinguishable from a rolling ball on this axis.
                    "y": ((p[0] - (sx if USE_SHIFT else 0) - cx0) * ux + (p[1] - (sy if USE_SHIFT else 0) - cy0) * uy) * mm_per_px,
                }

            b = by_i.get(i)
            if b:
                rec["ball"] = to_mat((b["x"], b["y"]))
                head = vision.find_head(fr, (b["x"], b["y"]), seed["d"], seed["d"] * 0.9,
                                        bg, mm_per_px, shift[i])

                # Continuity, against a PREDICTED position rather than the last
                # one. A head at impact covers a lot of ground per frame, so
                # gating on "near where it was" either rejects the real club or,
                # opened up enough to admit it, lets a reflection or a shoe in —
                # which is how the arc came out 183 mm wide when a stroke's is
                # nearer 40.
                if head is not None and last_head is not None:
                    gap = max(1, i - last_hi)
                    px = last_head[0] + hvx * gap
                    py = last_head[1] + hvy * gap
                    reach = (vision.HEAD_MM / mm_per_px) * (0.7 + 0.25 * gap)
                    if math.hypot(head["x"] - px, head["y"] - py) > reach:
                        head = None

                if head is not None:
                    # Which side of the head is the face: from the direction the
                    # ball DEPARTS, not from the head-to-ball vector. At impact
                    # the two touch, so that vector shrinks to noise and the fit
                    # flips onto the top edge of the club — at exactly the frame
                    # the face angle is read from.
                    f = vision.face_line(fr, head,
                                         (head["x"] + tux * 1000, head["y"] + tuy * 1000),
                                         vision.HEAD_MM / mm_per_px)
                    # A smeared edge reads tens of degrees out — the head is at
                    # peak speed just after impact. Drop it, do not average it.
                    # Quality gate in MILLIMETRES, not pixels. A fixed pixel bar
                    # means something different at every resolution — raising the
                    # working raster to 1920 made the same physical edge scatter
                    # twice as many pixels and threw away 95% of good fits.
                    if f and f["rms"] * mm_per_px <= 2.5:
                        if last_head is not None:
                            g = max(1, i - last_hi)
                            hvx = 0.6 * ((head["x"] - last_head[0]) / g) + 0.4 * hvx
                            hvy = 0.6 * ((head["y"] - last_head[1]) / g) + 0.4 * hvy
                        last_head, last_hi = (head["x"], head["y"]), i
                        hx, hy = math.cos(f["rad"]) * 20, math.sin(f["rad"]) * 20
                        rec["face"] = {"a": to_mat((f["x"] - hx, f["y"] - hy)),
                                       "b": to_mat((f["x"] + hx, f["y"] + hy))}
                        rec["head"] = to_mat((head["x"], head["y"]))
                        img_geom[i] = {
                            "ball": [b["x"], b["y"]],
                            "head": [head["x"], head["y"]],
                            "face": [f["x"], f["y"], f["rad"]],
                            "shift": [sx, sy],
                            "line": [L[0], L[1][0], L[1][1]],
                        }
                        heads += 1
        obs.append(rec)
        if progress and i % 25 == 0:
            progress(i, len(frames))

    # Move the measured point from the head's blob centre to the point that
    # actually STRIKES the ball.
    #
    # The centre sits half a head behind the face, so a path through it cannot
    # pass through the ball — the render showed exactly that, an arc that missed
    # both ball and putter. The striking point is the head centre stepped forward
    # onto the face plane and one ball radius beyond.
    #
    # The step is taken along a SMOOTHED face orientation, and that is the whole
    # difficulty. Taken along each frame's own face normal, the offset rotates as
    # fast as the face does through impact, so the face's rotation arrives in the
    # head's POSITION as translation: putter path went 2.81 -> 5.92 deg and tempo
    # 2.49 -> 4.23 on IMG_3882, both away from the truth. A club head is rigid, so
    # the offset between its centre and its striking point must be rigid too —
    # face orientation varies slowly and smoothly, and only its per-frame noise
    # was corrupting the position.
    #
    # Position ALONG the face comes from the head centre, never from the face fit:
    # cv2.fitLine returns an arbitrary point on the line that slides with whatever
    # slice of edge was sampled, and sliding along the face is moving across the
    # mat — the very axis path is measured on. That alone put 108 mm of scatter
    # into a 37 mm stroke.
    # The distance from the detected centre to the face is rigid too, and must be
    # measured once for the clip rather than per frame. Per frame it breathes:
    # the head blurs at speed, the mask shrinks, its centre slides backwards and
    # the offset grows to follow. Near impact that direction is roughly ALONG the
    # mat, which is the axis tempo is read from — it came out 4.23 against a
    # putting stroke's 2:1.
    geom_i = sorted(img_geom)
    steps = []
    for i in geom_i:
        g = img_geom[i]
        nx, ny = -math.sin(g["face"][2]), math.cos(g["face"][2])
        if nx * tux + ny * tuy < 0:
            nx, ny = -nx, -ny
        steps.append((g["face"][0] - g["head"][0]) * nx
                     + (g["face"][1] - g["head"][1]) * ny)
    depth = float(np.median(steps)) if steps else 0.0

    for pos, i in enumerate(geom_i):
        near = [img_geom[j]["face"][2] for j in geom_i[max(0, pos - 6):pos + 7]]
        # Circular mean in the doubled-angle plane: a face is a LINE, so it wraps
        # at 180 degrees, and a plain mean straddling the wrap points backwards.
        rad = 0.5 * math.atan2(float(np.mean([math.sin(2 * a) for a in near])),
                               float(np.mean([math.cos(2 * a) for a in near])))
        g = img_geom[i]
        hx_, hy_ = g["head"]
        nx, ny = -math.sin(rad), math.cos(rad)
        if nx * tux + ny * tuy < 0:                  # point it at the ball
            nx, ny = -nx, -ny
        step = depth + seed["d"] / 2.0
        cpt = (hx_ + nx * step, hy_ + ny * step)
        g["contact"] = [cpt[0], cpt[1]]

        lr, lx_, ly_ = g["line"]
        ux, uy = math.cos(lr), math.sin(lr)
        if tx * ux + ty * uy < 0:
            ux, uy = -ux, -uy
        rx, ry = -uy, ux
        sx_, sy_ = g["shift"] if USE_SHIFT else (0.0, 0.0)
        obs[i]["head"] = {
            "x": ((cpt[0] - lx_) * rx + (cpt[1] - ly_) * ry) * mm_per_px,
            "y": ((cpt[0] - sx_ - cx0) * ux + (cpt[1] - sy_ - cy0) * uy) * mm_per_px,
        }

    # Throw out face readings that cannot be real.
    #
    # A club face does not rotate 70 degrees between two frames at 120 fps, but
    # the edge fit does occasionally grab a SIDE edge instead of the face —
    # always just after impact, where the head is at peak speed and smeared. The
    # fit is internally clean when that happens, so its own residual cannot
    # catch it; only its disagreement with the frames either side can. One such
    # frame inside the impact window dragged face angle from ~0 to -10.7 deg.
    angs = []
    for k, o in enumerate(obs):
        if not o["face"]:
            angs.append(None)
            continue
        d = (o["face"]["b"]["x"] - o["face"]["a"]["x"],
             o["face"]["b"]["y"] - o["face"]["a"]["y"])
        a_ = math.degrees(math.atan2(d[1], d[0])) % 180.0
        angs.append(a_)

    def circ_med(vals):                      # median on a 180-degree wrap
        best, bs = None, None
        for c in vals:
            s = sum(min(abs(v - c), 180 - abs(v - c)) for v in vals)
            if bs is None or s < bs:
                best, bs = c, s
        return best

    def local_median(vals, k, half=6):
        near = [v for v in vals[max(0, k - half):k + half + 1] if v is not None]
        if len(near) < 4:
            return None
        near.sort()
        return near[len(near) // 2]

    # The same treatment for head POSITION as for face angle, and for the same
    # reason: in both clips the middle half of the head track is a real arc
    # (9-24 mm across, which is what a putting stroke looks like) while a
    # minority of frames sit 160-205 mm away. A club head cannot be in two
    # places; those frames are a reflection, a shoe or the shaft, and they were
    # dragging putter path by ten degrees and the arc to four times its width.
    # Reject head positions on the ACROSS-mat axis against a GLOBAL centre.
    #
    # A local median cannot work here: the bad frames arrive in runs, so the
    # window's own median is an outlier too and nothing gets dropped. But across
    # the mat a putting stroke IS bounded — that is what an arc is, a few tens of
    # millimetres either side of the line — so the whole clip's median is a valid
    # reference. Along the mat it is not: the head genuinely travels from
    # backswing to follow-through, so that axis is left alone.
    #
    # In both clips the honest half of the track spans 9-24 mm while a minority
    # sit 160-205 mm out. Those are a reflection, a shoe or the shaft.
    hx = [o["head"]["x"] if o["head"] else None for o in obs]
    seen = sorted(v for v in hx if v is not None)
    pos_dropped = 0
    if len(seen) >= 8:
        med = seen[len(seen) // 2]
        iqr = seen[int(len(seen) * 0.75)] - seen[int(len(seen) * 0.25)]
        tol = max(45.0, 4.0 * iqr)
        for k in range(len(obs)):
            if obs[k]["head"] is None:
                continue
            if abs(hx[k] - med) > tol:
                obs[k]["head"] = None
                obs[k]["face"] = None
                pos_dropped += 1
    # Continuity along the mat. Across is bounded by the arc and handled above;
    # along is not — the head genuinely travels — so it needs a speed limit
    # rather than a range. A club head does not cross 300 mm between two frames
    # at 120 fps; that is two different objects being called the same thing.
    last_i, last_y = None, None
    for k in range(len(obs)):
        if obs[k]["head"] is None:
            continue
        y = obs[k]["head"]["y"]
        if last_y is not None:
            gap = max(1, k - last_i)
            if abs(y - last_y) > 60.0 * gap:
                obs[k]["head"] = None
                obs[k]["face"] = None
                pos_dropped += 1
                continue
        last_i, last_y = k, y
    heads -= pos_dropped

    dropped = 0
    for k, a_ in enumerate(angs):
        if a_ is None:
            continue
        # angs was built before the head-position filters ran, so a frame they
        # already discarded still has an angle here and would be counted a second
        # time. Both counts are subtracted from `heads`: hit zero and the clip
        # reports "found the ball but never the putter head" after measuring
        # fine, overshoot and the page prints "club found in -3".
        if obs[k]["face"] is None:
            continue
        near = [x for x in angs[max(0, k - 6):k + 7] if x is not None]
        if len(near) < 4:
            continue
        m = circ_med(near)
        off = min(abs(a_ - m), 180 - abs(a_ - m))
        if off > 12.0:
            obs[k]["face"] = None
            obs[k]["head"] = None
            dropped += 1
    heads -= dropped

    # Work out the real capture rate from the ball's own physics.
    #
    # A phone renders slow motion into a normal-rate container, so the container
    # says 30 fps for footage shot at 120 or 240 and every speed reads low by
    # that factor. Worse, the face-angle window is measured in milliseconds — at
    # the wrong rate it spans about one frame, too few to fit, and face angle
    # comes back empty rather than wrong.
    #
    # Deceleration settles it. Get the rate wrong by k and speed is wrong by k
    # but deceleration by k SQUARED, so it is the sensitive one: a putting
    # surface takes 1-2 m/s off a ball, and nothing else does.
    if capture_fps is None:
        roll = [(o["t"], o["ball"]) for o in obs if o["ball"]]
        best = None
        for cand in (30.0, 60.0, 120.0, 240.0):
            if cand < container_fps - 1:
                continue
            k = cand / container_fps
            xs, ys = [], []
            for t, b in roll:
                xs.append(t / k)
                ys.append(math.hypot(b["x"], b["y"]))
            if len(xs) < 12:
                continue
            # crude deceleration over the rolling half of the clip
            n0 = len(xs) // 2
            try:
                c = np.polyfit(xs[n0:], ys[n0:], 2)
            except Exception:
                continue
            dec = abs(2 * c[0]) / 1000.0
            err = abs(dec - 1.5)
            if best is None or err < best[0]:
                best = (err, cand, dec)
        if best:
            _, cand, dec = best
            k = cand / container_fps
            for o in obs:
                o["t"] /= k
            fps = cand
            scale_t = 1.0 / k

    # Fail loudly. Without the mat's line there is no direction to measure
    # against, so every angle is undefined — but the clip still decodes, the ball
    # still tracks, and the result came back full of nulls that the page rendered
    # as blanks. A blank reads as a bug in the page, not as "this clip cannot be
    # measured", and it sent an afternoon after the wrong fault.
    if lines == 0:
        return {"error": "no target line found on the mat. PuttLab reads angles "
                         "against the line printed down the mat — without it there "
                         "is nothing to measure an angle from."}
    if heads == 0:
        return {"error": "found the ball but never the putter head. It may be out "
                         "of frame, or too dim to separate from the mat."}

    out_img = None
    if want_image:
        # Only the frames that survived every gate above. Drawing these is what
        # makes the picture an account of the measurement rather than a second
        # opinion about it.
        out_img = {
            "geom": {i: g for i, g in img_geom.items() if obs[i]["head"] is not None},
            "ball": {t["i"]: [t["x"], t["y"]] for t in track},
            "ballDiameterPx": seed["d"],
            "mmPerPx": mm_per_px,
            "toward": [tux, tuy],
        }

    return {
        "image": out_img,
        "faceOutliersDropped": dropped,
        "headOutliersDropped": pos_dropped,
        "frames": len(frames),
        "width": w, "height": h,
        "containerFps": container_fps,
        "captureFps": fps,
        "ballDiameterPx": seed["d"],
        "mmPerPx": mm_per_px,
        "ballFrames": len(track),
        "lineFrames": lines,
        "headFrames": heads,
        "observations": obs,
    }
