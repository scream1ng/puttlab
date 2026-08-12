"""
Ball, putter and mat-line detection from a phone clip.

Why this is server-side: the browser version spent its time losing fights that
ffmpeg settles for free — HEVC decoding, `rotation=-90` metadata, variable frame
rate, and a 90-second main-thread lockup on a 371-frame clip.

The detection strategy is the part worth reading. Two earlier browser attempts
failed the same way, and both were global thresholding:

  * a white ball is brilliant against a dark mat band and invisible against a
    pale one, and no single brightness threshold covers both — lower it enough
    to keep the ball on the pale band and the whole band becomes one blob;
  * a target ring printed on the mat is ball-sized, round and permanent, so it
    outscores the real ball on every static test.

So this does not re-detect the ball every frame. It finds it ONCE while it is
sitting still — which appearance alone can do reliably, on a dark band, before
anything moves — and then TRACKS it by local correlation. Tracking asks "where
did this patch go", not "what is bright here", so a ball crossing onto a pale
stripe stays locked, and a printed ring is never a candidate because it was
never the thing being followed.
"""

import math
import numpy as np
import cv2


BALL_MM = 42.7          # a golf ball, always
HEAD_MM = 110.0         # a mallet head across the face, near enough


# --------------------------------------------------------------------------
# decode
# --------------------------------------------------------------------------

def decode(path, max_width=1920):
    """Frames as BGR arrays plus their timestamps, honouring rotation metadata.

    ffmpeg applies the display matrix, so a clip shot in portrait arrives the
    way you saw it on the phone rather than the way it happens to be stored.
    """
    import av

    container = av.open(path)
    stream = container.streams.video[0]
    stream.thread_type = "AUTO"

    # Every frame is held in memory at once, so a long clip has to come down in
    # resolution or nothing comes back at all: a 692-frame clip at 1920 is 4.3 GB
    # of raw pixels and the process was killed before it could even report why.
    # Detection ran at 1280 for most of this project's life, so the cost is small
    # and it is only paid by clips that would otherwise fail outright.
    n_frames = getattr(stream, "frames", 0) or 0
    if n_frames > 420:
        max_width = min(max_width, 1280)

    frames, times = [], []
    tb = float(stream.time_base) if stream.time_base else 1 / 30.0
    for f in container.decode(stream):
        img = f.to_ndarray(format="bgr24")
        if img.shape[1] > max_width:
            s = max_width / img.shape[1]
            img = cv2.resize(img, (max_width, int(round(img.shape[0] * s))),
                             interpolation=cv2.INTER_AREA)
        frames.append(img)
        times.append((f.pts * tb) if f.pts is not None else len(frames) * tb)
    container.close()

    t0 = times[0] if times else 0.0
    return frames, [t - t0 for t in times]


# --------------------------------------------------------------------------
# the mat's printed line — direction reference, found per frame
# --------------------------------------------------------------------------

def find_line(bgr, hue=30, hue_tol=25, s_min=50, v_min=50):
    """The coloured line printed down the mat, as (angle_rad, point).

    Per frame on purpose: a tap is frozen at the moment it was made, and a
    handheld camera rotated ~1.15 deg over ten seconds on a real clip. Measured
    fresh each frame, impact is read against the line as it is AT impact.

    Hue is OpenCV's 0-179 scale, so yellow sits near 30, not 55.
    """
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    lo = np.array([max(0, hue - hue_tol), s_min, v_min], np.uint8)
    hi = np.array([min(179, hue + hue_tol), 255, 255], np.uint8)
    mask = cv2.inRange(hsv, lo, hi)
    if cv2.countNonZero(mask) < 200:
        return None

    n, _, stats, cents = cv2.connectedComponentsWithStats(mask, 8)
    best, best_len = None, 0
    for i in range(1, n):
        w, h, area = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT], stats[i, cv2.CC_STAT_AREA]
        if area < 120 * (mask.shape[1] / 960.0):
            continue
        span = max(w, h)
        if span < 0.25 * max(mask.shape):      # a line crosses much of the frame
            continue
        if span > best_len:
            best_len, best = span, i
    if best is None:
        return None

    # Fit every masked pixel lying along that component, so the fit spans the
    # line's whole length rather than the largest fragment the ball and putter
    # happen to leave behind.
    ys, xs = np.nonzero(mask)
    cx, cy = cents[best]
    pts = np.stack([xs, ys], 1).astype(np.float32)
    vx, vy, px, py = cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    # keep only points near that first fit, then refit — kills the dotted rules
    # and tick marks a mat prints in the same colour off to the side
    d = np.abs((pts[:, 0] - px) * vy - (pts[:, 1] - py) * vx)
    keep = pts[d < 12 * (w_scale := mask.shape[1] / 960.0)]
    if len(keep) >= 100:
        vx, vy, px, py = cv2.fitLine(keep, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    return float(math.atan2(vy, vx)), (float(px), float(py))


# --------------------------------------------------------------------------
# the ball: find it still, then follow it
# --------------------------------------------------------------------------

def ball_candidates_at_rest(frames, search=40, top=6):
    """Where the ball sits before it is struck, and how big it is.

    Uses the frames' own stillness: a ball at address does not move, so the
    median of the opening frames is a clean picture of it. Bright, round and
    compact is enough to find it THERE, where it is on a dark band and nothing
    is smeared — the part appearance cannot do is follow it afterwards.
    """
    n = min(search, len(frames))
    # Area bounds are the only absolute pixel figures here, so scale them with
    # the raster — otherwise raising the working resolution silently rejects
    # every real ball for being "too big".
    k = (frames[0].shape[1] / 960.0) ** 2
    med = np.median(np.stack(frames[:n]), 0).astype(np.uint8)
    gray = cv2.cvtColor(med, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (7, 7), 1.5)

    found = []
    for thr in (215, 200, 185, 170, 155):
        _, m = cv2.threshold(blur, thr, 255, cv2.THRESH_BINARY)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            a = cv2.contourArea(c)
            if a < 60 * k or a > 6000 * k:
                continue
            per = cv2.arcLength(c, True)
            if per <= 0:
                continue
            circ = 4 * math.pi * a / (per * per)
            if circ < 0.62:                     # a ball is round; a ring is not solid
                continue
            (x, y), r = cv2.minEnclosingCircle(c)
            fill = a / (math.pi * r * r + 1e-6)
            if fill < 0.60:                     # solid disc, not an annulus
                continue
            # Deliberately NOT scored by size. A target ring printed on the mat
            # is rounder and BIGGER than the ball, so "most ball-like" picks the
            # ring every time — it did, at (813,296) on a real clip. Size cannot
            # separate them and neither can roundness. Only motion can, so hand
            # back every plausible candidate and let the tracker decide.
            if not any(math.hypot(x - f["x"], y - f["y"]) < r for f in found):
                found.append({"x": float(x), "y": float(y), "d": float(r * 2),
                              "score": circ * fill})
        if len(found) >= 2:
            break
    found.sort(key=lambda f: -f["score"])
    return found[:top]


def track_ball(frames, seed, max_lost=8):
    """Follow the ball from its address position by local correlation.

    This is the piece both browser attempts lacked. Matching a patch against the
    next frame asks "where did this go", which survives the ball rolling from a
    dark band onto a pale one — the very transition where a brightness threshold
    loses it completely. A printed ring never enters the running, because the
    tracker only ever looks near where the ball actually was.
    """
    h, w = frames[0].shape[:2]
    r = max(6, int(round(seed["d"] * 0.75)))
    cx, cy = seed["x"], seed["y"]

    def patch(img, x, y, rad):
        x0, y0 = int(round(x - rad)), int(round(y - rad))
        x1, y1 = x0 + 2 * rad, y0 + 2 * rad
        if x0 < 0 or y0 < 0 or x1 > img.shape[1] or y1 > img.shape[0]:
            return None
        return img[y0:y1, x0:x1]

    tmpl = patch(cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY), cx, cy, r)
    if tmpl is None:
        return []

    out = [{"i": 0, "x": cx, "y": cy, "d": seed["d"]}]
    vx = vy = 0.0
    lost = 0
    for i in range(1, len(frames)):
        gray = cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY)
        px, py = cx + vx, cy + vy
        # search window grows with speed and with how long we have been guessing
        rad = int(round(r * 3 + math.hypot(vx, vy) * 1.6 + lost * 4))
        x0, y0 = max(0, int(px - rad)), max(0, int(py - rad))
        x1, y1 = min(w, int(px + rad)), min(h, int(py + rad))
        if x1 - x0 < tmpl.shape[1] + 2 or y1 - y0 < tmpl.shape[0] + 2:
            break
        res = cv2.matchTemplate(gray[y0:y1, x0:x1], tmpl, cv2.TM_CCOEFF_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(res)
        if mx < 0.55:
            lost += 1
            if lost > max_lost:
                break
            cx, cy = px, py                     # coast on the prediction
            continue
        lost = 0
        nx = x0 + loc[0] + tmpl.shape[1] / 2.0
        ny = y0 + loc[1] + tmpl.shape[0] / 2.0
        step = math.hypot(nx - cx, ny - cy)
        # A ball at address is STILL. Correlation wanders a pixel either way, and
        # feeding that into the velocity estimate let the search window creep
        # until it locked onto the putter sweeping past — 16 mm of phantom travel
        # over the address, which fired the impact detector 130 frames early.
        if step < 1.2:
            vx = vy = 0.0
        else:
            vx, vy = 0.7 * (nx - cx), 0.7 * (ny - cy)
        cx, cy = nx, ny
        out.append({"i": i, "x": cx, "y": cy, "d": seed["d"]})
    return out


# --------------------------------------------------------------------------
# the putter head and its face
# --------------------------------------------------------------------------

def camera_shift(frames, bg):
    """How far the camera moved, per frame, against the static mat.

    Needed because the mat line pins only the ACROSS-mat axis — perpendicular
    distance to a line is well defined, but a line has no features along its
    length. Uncompensated, a panning camera is indistinguishable from a rolling
    ball on that axis: it produced 14.5 mm of phantom travel while the ball sat
    at address, against 1.5 mm on the line-anchored axis.

    Feature matching with RANSAC rather than phase correlation, because the
    putter sweeping through the frame biases a whole-image correlation but is
    simply an outlier to a robust fit.
    """
    orb = cv2.ORB_create(1200)
    kb, db = orb.detectAndCompute(bg, None)
    shifts = [(0.0, 0.0)] * len(frames)
    if db is None or len(kb) < 12:
        return shifts
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    last = (0.0, 0.0)
    for i, fr in enumerate(frames):
        g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        kf, df = orb.detectAndCompute(g, None)
        if df is None or len(kf) < 12:
            shifts[i] = last
            continue
        m = matcher.match(db, df)
        if len(m) < 12:
            shifts[i] = last
            continue
        src = np.float32([kb[x.queryIdx].pt for x in m]).reshape(-1, 1, 2)
        dst = np.float32([kf[x.trainIdx].pt for x in m]).reshape(-1, 1, 2)
        M, _ = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,
                                           ransacReprojThreshold=3.0)
        if M is None:
            shifts[i] = last
            continue
        last = (float(M[0, 2]), float(M[1, 2]))
        shifts[i] = last
    return shifts


def background(frames, sample=60):
    """A still picture of the mat, from the clip's own frames.

    The mat, its printed rings, its dots and its lines never move; the ball and
    the putter do. A per-pixel median over frames spread across the clip keeps
    the former and erases the latter, so subtracting it leaves exactly the two
    things worth finding — and does it without caring whether the putter happens
    to be over a dark band or a pale one, which is what defeated thresholding.
    """
    idx = np.linspace(0, len(frames) - 1, min(sample, len(frames))).astype(int)
    stack = np.stack([cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY) for i in idx])
    return np.median(stack, 0).astype(np.uint8)


def find_head(bgr, ball, ball_d, exclude_r, bg=None, mm_per_px=None, shift=None):
    """The putter head: bright AND moving AND the right physical size.

    All three are needed, and each was learned the hard way.

    Brightness alone fails because a white mallet over a pale mat band cannot be
    thresholded apart from the band. Motion alone fails worse: differencing
    against the static mat catches the shaft, the player and the shadow too, and
    they merge into one blob 540 px tall — a whole frame's height — from which no
    face edge can be fitted. Bright AND moving keeps the head and drops the dark
    shaft and darker shadow.

    Size then settles it. A mallet head is about 110 mm across, and the ball has
    already told us how many millimetres a pixel is worth, so the head's width in
    pixels is known before anything is measured.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if bg is not None:
        # Slide the background to where the camera is NOW before differencing.
        # Without this every static edge ghosts — the mat's printed rings showed
        # up in a "moving" mask purely because the camera drifted, and one of
        # those ghosts outranked the real club head.
        ref = bg
        if shift is not None and (abs(shift[0]) > 0.3 or abs(shift[1]) > 0.3):
            M = np.float32([[1, 0, shift[0]], [0, 1, shift[1]]])
            ref = cv2.warpAffine(bg, M, (bg.shape[1], bg.shape[0]),
                                 flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        moved = cv2.absdiff(gray, ref) > 24
        bright = gray > 150
        m = (moved & bright).astype(np.uint8) * 255
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    else:
        _, m = cv2.threshold(gray, 175, 255, cv2.THRESH_BINARY)
    want = (HEAD_MM / mm_per_px) if mm_per_px else (ball_d * 2.6)

    # Erode away the shaft. It is bright and it moves, so it joins the head's
    # blob, and the face fit then lands on the SHAFT instead of the face — which
    # is exactly what the render showed at frames 204 and 256. A shaft is thin
    # and a head is thick, so an opening wider than the shaft keeps one and
    # deletes the other. Sized from the head, so it holds at any zoom.
    k = max(3, int(round(want * 0.17)) | 1)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN,
                         cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Reassemble the head before judging it.
    #
    # A fang mallet is two prongs around a dark cavity, and the cavity fails the
    # brightness test, so the mask holds two blobs where there is one club. Each
    # is head-shaped enough to be accepted and they score within 0.03 of each
    # other, so the winner alternated frame to frame with the club standing
    # still — 60 mm of phantom travel across the mat, which is why the fitted arc
    # sat between the prongs instead of on either, and why the face was fitted to
    # one lobe's curved front instead of across the whole face.
    #
    # A club head is one object of a known size, so fragments that fall inside a
    # head-sized window are the same head. Union them and take the hull: for a
    # fang mallet that hull's leading edge IS the face, spanning both prongs,
    # which is a longer and truer baseline than either prong alone.
    frag = [c for c in cnts if cv2.contourArea(c) >= (want * 0.12) ** 2]
    cen = [cv2.minEnclosingCircle(c)[0] for c in frag]
    group = list(range(len(frag)))

    def root(a):
        while group[a] != a:
            group[a] = group[group[a]]
            a = group[a]
        return a

    for a in range(len(frag)):
        for b in range(a + 1, len(frag)):
            if math.hypot(cen[a][0] - cen[b][0], cen[a][1] - cen[b][1]) <= want * 0.8:
                group[root(a)] = root(b)
    merged = {}
    for a in range(len(frag)):
        merged.setdefault(root(a), []).append(frag[a])
    # Every boundary point is kept, and the hull is used only to measure the
    # group. Hulling the points themselves left about fifteen of them, so the
    # face fit's leading slice held three and it bailed on two frames in three.
    cnts = [np.vstack(v) for v in merged.values()]

    best = None
    for c in cnts:
        a = cv2.contourArea(cv2.convexHull(c))
        if a < (want * 0.25) ** 2:
            continue
        x, y, bw, bh = cv2.boundingRect(c)
        span = max(bw, bh)
        # Room for the head and its shaft, and for the frame at impact where the
        # ball touches the face and the two merge into one blob — that frame was
        # being REJECTED, which is the one frame the face angle depends on.
        if span < want * 0.45 or span > want * 3.0:
            continue
        (cx, cy), _ = cv2.minEnclosingCircle(c)
        d = math.hypot(cx - ball[0], cy - ball[1])
        # Through a putting stroke the head stays near the ball — backswing and
        # follow-through are tens of centimetres, not metres. 8 head-widths let
        # in objects 300 mm away along the mat, which read as the head
        # teleporting between adjacent frames.
        if d < exclude_r or d > want * 3.5:
            continue
        # Score by resemblance to a club head, NOT by size. Picking the largest
        # blob handed the frame to a drift ghost around a printed ring, which
        # was bigger than the putter.
        width_err = abs(min(bw, bh) - want * 0.62) / want      # head depth ~ 0.6 of width
        near = d / (want * 3.5)
        solid = a / max(1.0, bw * bh)                          # a club is a solid mass
        score = solid * 1.6 - width_err - near * 0.5
        if best is None or score > best[0]:
            best = (score, c, cx, cy, a)
    if best is None:
        return None
    return {"contour": best[1], "x": best[2], "y": best[3], "area": best[4]}


def face_line(bgr, head, toward, want=None):
    """Face angle from the head's ball-facing edge, located to sub-pixel.

    The blob's principal axis is useless here — a mallet images roughly 100x70,
    a ratio near 1.4, and the axis of a near-square shape swings wildly on small
    changes. So the face is measured as an EDGE.

    But a thresholded outline is a poor edge: it is quantised to whole pixels and
    it MOVES when lighting or blur shifts the threshold, which is a systematic
    error, not noise. The face is a strong brightness step, so instead of
    thresholding, this walks a line of samples straight across it and finds where
    the gradient peaks, refined between pixels by fitting a parabola to the three
    samples around the maximum. That is independent of any threshold and good to
    a fraction of a pixel.

    The thresholded contour is still used, but only to say roughly where to look.
    """
    pts = head["contour"].reshape(-1, 2).astype(np.float32)
    if len(pts) < 12:
        return None
    dx, dy = toward[0] - head["x"], toward[1] - head["y"]
    n = math.hypot(dx, dy) or 1.0
    dx, dy = dx / n, dy / n
    ex, ey = -dy, dx

    depth = (pts[:, 0] - head["x"]) * dx + (pts[:, 1] - head["y"]) * dy
    lead = pts[depth > np.percentile(depth, 78)]
    if len(lead) < 10:
        return None
    along = (lead[:, 0] - head["x"]) * ex + (lead[:, 1] - head["y"]) * ey
    mid = float(np.median(along))
    half = (want * 0.55) if want else (np.percentile(np.abs(along - mid), 85) + 1)
    edge = lead[np.abs(along - mid) <= half]
    if len(edge) < 10:
        return None

    vx, vy, px, py = cv2.fitLine(edge, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()

    # --- sub-pixel refinement against the raw greyscale -------------------
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    L = (want * 0.55) if want else 40.0
    REACH, STEP = 7.0, 0.5                       # how far across the edge, how finely
    ts = np.arange(-L, L + 1e-6, 1.0, np.float32)          # along the face
    ss = np.arange(-REACH, REACH + 1e-6, STEP, np.float32)  # across it
    bx = px + ts * vx
    by = py + ts * vy
    mapx = (bx[:, None] + ss[None, :] * dx).astype(np.float32)
    mapy = (by[:, None] + ss[None, :] * dy).astype(np.float32)
    prof = cv2.remap(gray, mapx, mapy, cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_REPLICATE)
    g = np.abs(np.gradient(prof, axis=1))
    j = np.argmax(g, axis=1)
    ok = (j > 0) & (j < g.shape[1] - 1) & (g[np.arange(len(j)), j] > 2.0)
    if ok.sum() < 8:
        rms = float(np.sqrt(np.mean(((edge[:, 0] - px) * vy - (edge[:, 1] - py) * vx) ** 2)))
        return {"rad": float(math.atan2(vy, vx)), "x": float(px), "y": float(py),
                "rms": rms, "n": int(len(edge)), "sub": False}

    idx = np.arange(len(j))[ok]
    jj = j[ok]
    a0 = g[idx, jj - 1]; a1 = g[idx, jj]; a2 = g[idx, jj + 1]
    denom = (a0 - 2 * a1 + a2)
    delta = np.where(np.abs(denom) > 1e-6, 0.5 * (a0 - a2) / np.where(denom == 0, 1e-6, denom), 0.0)
    delta = np.clip(delta, -1.0, 1.0)
    s_hat = ss[jj] + delta * STEP
    P = np.stack([bx[idx] + s_hat * dx, by[idx] + s_hat * dy], 1).astype(np.float32)

    vx, vy, px, py = cv2.fitLine(P, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    for _ in range(2):
        d = np.abs((P[:, 0] - px) * vy - (P[:, 1] - py) * vx)
        keep = P[d <= max(0.8, 2.0 * float(np.median(d)))]
        if len(keep) < 8 or len(keep) == len(P):
            break
        P = keep
        vx, vy, px, py = cv2.fitLine(P, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    rms = float(np.sqrt(np.mean(((P[:, 0] - px) * vy - (P[:, 1] - py) * vx) ** 2)))
    return {"rad": float(math.atan2(vy, vx)), "x": float(px), "y": float(py),
            "rms": rms, "n": int(len(P)), "sub": True}


def smooth_track(items, key_i="i", win=9, reject_px=None):
    """A club head moves smoothly. Fit that, and drop what does not belong.

    Detection is per frame and independent, so its errors are per frame and
    independent too — the head jitters as different parts of the club fall in
    and out of the mask, and occasionally it lands on something else entirely.
    A stroke is a smooth curve in time, so fitting one and rejecting the points
    that disagree separates real motion from detection noise, which no
    single-frame test can do.

    Returns (kept, curve) where curve is the smoothed position per kept frame.
    """
    if len(items) < 5:
        return items, [(p["x"], p["y"]) for p in items]

    idx = np.array([p[key_i] for p in items], np.float64)
    xs = np.array([p["x"] for p in items], np.float64)
    ys = np.array([p["y"] for p in items], np.float64)

    def med_filter(a, k):
        out = a.copy()
        h = k // 2
        for j in range(len(a)):
            lo, hi = max(0, j - h), min(len(a), j + h + 1)
            out[j] = np.median(a[lo:hi])
        return out

    sx, sy = med_filter(xs, win), med_filter(ys, win)
    resid = np.hypot(xs - sx, ys - sy)
    bar = reject_px if reject_px else max(6.0, 3.0 * float(np.median(resid)))
    keep = resid <= bar
    if keep.sum() < 5:
        return items, list(zip(sx, sy))

    kept = [p for p, k in zip(items, keep) if k]
    sx2 = med_filter(np.array([p["x"] for p in kept], np.float64), win)
    sy2 = med_filter(np.array([p["y"] for p in kept], np.float64), win)
    return kept, list(zip(sx2, sy2))


def fit_arc(points, line_rad, trim=2.0, rounds=3):
    """Fit the stroke's arc as a curve, not as a smoothed scatter.

    A putter swings around the shoulders, so its head traces an arc: furthest
    from the golfer near impact, curving back in at both ends of the stroke.
    Across-the-mat position is therefore a smooth function of along-the-mat
    position — a shallow parabola — and the head passes along it twice, back
    and through.

    Fitting that shape directly beats smoothing the raw points. Local smoothing
    keeps whatever nonsense a run of bad frames agrees on, which is why the
    drawn path still had loops a club head could not physically make. A curve
    fitted to the whole stroke has no way to represent a loop, so bad frames
    can only show up as residuals — and residuals can be rejected.

    Returns (coefficients, kept points) in the along/across frame.
    """
    if len(points) < 8:
        return None, points
    ux, uy = math.cos(line_rad), math.sin(line_rad)
    rx, ry = -uy, ux
    P = np.asarray(points, np.float64)
    along = P[:, 0] * ux + P[:, 1] * uy
    across = P[:, 0] * rx + P[:, 1] * ry

    keep = np.ones(len(P), bool)
    coef = None
    for _ in range(rounds):
        if keep.sum() < 6:
            break
        coef = np.polyfit(along[keep], across[keep], 2)
        resid = np.abs(np.polyval(coef, along) - across)
        s = float(np.median(resid[keep])) or 1.0
        nk = resid <= max(2.0, trim * s)
        if nk.sum() < 6 or (nk == keep).all():
            keep = nk
            break
        keep = nk
    if coef is None:
        return None, points
    return {"coef": coef, "ux": ux, "uy": uy, "rx": rx, "ry": ry,
            "lo": float(along[keep].min()), "hi": float(along[keep].max()),
            "kept": int(keep.sum()), "total": len(P)}, [p for p, k in zip(points, keep) if k]


def arc_polyline(arc, n=140):
    """The fitted arc as image points, ready to draw."""
    if not arc:
        return []
    ts = np.linspace(arc["lo"], arc["hi"], n)
    cs = np.polyval(arc["coef"], ts)
    return [(float(t * arc["ux"] + c * arc["rx"]),
             float(t * arc["uy"] + c * arc["ry"])) for t, c in zip(ts, cs)]
