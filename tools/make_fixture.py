#!/usr/bin/env python3
"""
Render a synthetic putting stroke with exactly known ground truth, then
encode it. This is the backbone of verification: every metric the app
reports can be checked against a number that was *put in* rather than
eyeballed out.

Model (all in mat millimetres; x across, +right; y down the mat, +away):

  head position along target line
    backswing   t in [0, TB]:      s = s0 - LB*(1 - cos(pi*u))/2,  u = t/TB
    downswing+  v = t - TB:        s = s0 - LB*cos(pi*v/(2*TF))
  head across            x = x0 + tan(PATH)*(s-s0) - (s-s0)^2/(2*R_ARC)
  face angle             phi = FACE - (s - s0)/R_FACE  (radians -> deg)
  ball                   still until impact, then straight at START angle

At v = TF the head is back at s0 -> that instant IS impact, by construction.
"""
import json, math, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter

# ------------------------------ ground truth ------------------------------
FPS        = 240.0
W, H       = 1280, 720
MAT_W      = 400.0          # mm
MAT_L      = 3000.0         # mm

FACE_DEG   = 1.20           # face angle at impact, + = open/right
PATH_DEG   = -2.00          # putter path at impact, - = out-to-in / left
START_DEG  = 1.10           # ball departure angle
BALL_MS    = 1.60           # ball speed, m/s
TB         = 0.60           # backswing duration, s
TF         = 0.30           # downswing duration, s  -> tempo 2.00
LB         = 200.0          # backswing length, mm
R_FACE     = 1200.0         # face rotation radius, mm
R_ARC      = 2500.0         # path curvature radius, mm
S0         = 380.0          # head position at address / impact, mm down mat
X0         = MAT_W / 2      # head across-mat position at impact — mat CENTRE
BALL_Y     = 415.0          # ball centre sits just ahead of the face
BALL_R     = 21.33          # golf ball radius, mm
DURATION   = 1.35           # s

# Image-space mat corners: near-left, near-right, far-right, far-left.
QUAD = [(300.0, 660.0), (980.0, 660.0), (760.0, 150.0), (520.0, 150.0)]

MARKER_OFFSET = 38.0        # mm from head centre to each sticker
MARKER_R      = 7.5         # mm
HEAD_HALF_LEN = 50.0        # mm  (face line half-length)
HEAD_HALF_DEP = 13.0        # mm

MARKER_RGB = (232, 30, 168)     # magenta stickers
MAT_RGB    = (31, 107, 57)
BG_RGB     = (18, 50, 28)
HEAD_RGB   = (46, 48, 52)


# ------------------------------ geometry ------------------------------
def solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(M[r][c]))
        if abs(M[piv][c]) < 1e-12:
            raise ValueError('singular')
        M[c], M[piv] = M[piv], M[c]
        for r in range(n):
            if r == c:
                continue
            f = M[r][c] / M[c][c]
            if f:
                for k in range(c, n + 1):
                    M[r][k] -= f * M[c][k]
    return [M[i][n] / M[i][i] for i in range(n)]


def homography(src, dst):
    A, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    h = solve(A, b)
    return h + [1.0]


def inv3(Hm):
    a, b, c, d, e, f, g, h, i = Hm
    A, B, C = e * i - f * h, -(d * i - f * g), d * h - e * g
    det = a * A + b * B + c * C
    idet = 1.0 / det
    return [A * idet, (c * h - b * i) * idet, (b * f - c * e) * idet,
            B * idet, (a * i - c * g) * idet, (c * d - a * f) * idet,
            C * idet, (b * g - a * h) * idet, (a * e - b * d) * idet]


def apply(Hm, x, y):
    d = Hm[6] * x + Hm[7] * y + Hm[8]
    return ((Hm[0] * x + Hm[1] * y + Hm[2]) / d, (Hm[3] * x + Hm[4] * y + Hm[5]) / d)


H_img2mat = homography(QUAD, [(0, 0), (MAT_W, 0), (MAT_W, MAT_L), (0, MAT_L)])
H_mat2img = inv3(H_img2mat)
P = lambda mx, my: apply(H_mat2img, mx, my)


# ------------------------------ stroke model ------------------------------
def head_s(t):
    """Head position along the target line at time t."""
    if t <= TB:
        u = t / TB
        return S0 - LB * (1 - math.cos(math.pi * u)) / 2.0
    v = t - TB
    return S0 - LB * math.cos(math.pi * v / (2 * TF))


def head_ds(t):
    """d(head_s)/dt, analytic."""
    if t <= TB:
        u = t / TB
        return -LB * math.pi * math.sin(math.pi * u) / (2 * TB)
    v = t - TB
    return LB * (math.pi / (2 * TF)) * math.sin(math.pi * v / (2 * TF))


def head_x(s):
    d = s - S0
    return X0 + math.tan(math.radians(PATH_DEG)) * d - d * d / (2 * R_ARC)


def face_deg(s):
    return FACE_DEG - math.degrees((s - S0) / R_FACE)


T_IMPACT = TB + TF


def ball_pos(t):
    if t <= T_IMPACT:
        return (X0, BALL_Y)
    d = (t - T_IMPACT) * BALL_MS * 1000.0
    a = math.radians(START_DEG)
    return (X0 + d * math.sin(a), BALL_Y + d * math.cos(a))


# --------- analytic truth for definition-sensitive quantities ---------
def truth_takeaway_time(fraction=0.05):
    """First instant the head exceeds `fraction` of peak backswing speed —
    the same definition the analyser uses, evaluated on the exact model."""
    peak = max(abs(head_ds(TB * k / 2000.0)) for k in range(2001))
    for k in range(2001):
        t = TB * k / 2000.0
        if abs(head_ds(t)) > fraction * peak:
            return t
    return 0.0


def truth_face_rate():
    """dphi/dt at impact, deg/s."""
    return -math.degrees(head_ds(T_IMPACT) / R_FACE)


# ------------------------------ rendering ------------------------------
def mat_poly_to_img(pts):
    return [P(x, y) for x, y in pts]


def draw_disc(draw, mx, my, r_mm, fill):
    cx, cy = P(mx, my)
    ex, ey = P(mx + r_mm, my)
    r = math.hypot(ex - cx, ey - cy)
    if r < 0.6:
        r = 0.6
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def render(outdir):
    os.makedirs(outdir, exist_ok=True)
    n = int(DURATION * FPS)
    mat_img = mat_poly_to_img([(0, 0), (MAT_W, 0), (MAT_W, MAT_L), (0, MAT_L)])
    for i in range(n):
        t = i / FPS
        img = Image.new('RGB', (W, H), BG_RGB)
        d = ImageDraw.Draw(img)
        d.polygon(mat_img, fill=MAT_RGB)
        for y in range(0, int(MAT_L) + 1, 250):          # felt seams
            d.line([P(0, y), P(MAT_W, y)], fill=(24, 88, 46), width=2)

        s = head_s(t)
        hx = head_x(s)
        phi = math.radians(face_deg(s))
        # face line direction: (cos phi, sin phi) — square face points across
        fx, fy = math.cos(phi), math.sin(phi)
        nx, ny = -math.sin(phi), math.cos(phi)           # face normal
        corners = [
            (hx + fx * HEAD_HALF_LEN + nx * HEAD_HALF_DEP, s + fy * HEAD_HALF_LEN + ny * HEAD_HALF_DEP),
            (hx - fx * HEAD_HALF_LEN + nx * HEAD_HALF_DEP, s - fy * HEAD_HALF_LEN + ny * HEAD_HALF_DEP),
            (hx - fx * HEAD_HALF_LEN - nx * HEAD_HALF_DEP, s - fy * HEAD_HALF_LEN - ny * HEAD_HALF_DEP),
            (hx + fx * HEAD_HALF_LEN - nx * HEAD_HALF_DEP, s + fy * HEAD_HALF_LEN - ny * HEAD_HALF_DEP),
        ]
        d.polygon(mat_poly_to_img(corners), fill=HEAD_RGB)
        for sgn in (+1, -1):
            draw_disc(d, hx + fx * MARKER_OFFSET * sgn, s + fy * MARKER_OFFSET * sgn,
                      MARKER_R, MARKER_RGB)

        bx, by = ball_pos(t)
        if by < MAT_L - 30:
            draw_disc(d, bx, by, BALL_R, (250, 250, 248))

        img = img.filter(ImageFilter.GaussianBlur(0.4))   # mild optical softness
        img.save(os.path.join(outdir, f'f{i:05d}.png'))
    return n


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else 'fixtures/stroke_frames'
    n = render(outdir)

    truth = {
        'fps': FPS, 'width': W, 'height': H, 'frames': n,
        'quad': QUAD, 'matW': MAT_W, 'matL': MAT_L,
        'faceDeg': FACE_DEG, 'pathDeg': PATH_DEG,
        'faceToPathDeg': FACE_DEG - PATH_DEG,
        'startLineDeg': START_DEG, 'ballSpeed': BALL_MS,
        'impactTime': T_IMPACT,
        'tempoRatio': (TB - truth_takeaway_time()) / TF,
        'takeawayTime': truth_takeaway_time(),
        'takeawayFraction': 0.05,  # must equal analyse.js's TAKEAWAY_FRACTION — verify.mjs checks this
        'backLenMm': LB, 'faceRateDegPerSec': truth_face_rate(),
        'markerHue': 322.0,
        'note': 'tempoRatio uses the 5%-of-peak takeaway definition, '
                'evaluated analytically on the same model the video renders.'
    }
    with open('fixtures/stroke_truth.json', 'w') as f:
        json.dump(truth, f, indent=1)

    src = os.path.join(outdir, 'f%05d.png')
    # VP9 for local headless testing (Playwright Chromium has no H.264),
    # H.264 for what a real phone actually produces.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(int(FPS)), '-i', src,
                    '-c:v', 'libvpx-vp9', '-b:v', '3M', '-pix_fmt', 'yuv420p',
                    '-r', str(int(FPS)), 'fixtures/stroke_vp9.mp4'], check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(int(FPS)), '-i', src,
                    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
                    '-r', str(int(FPS)), 'fixtures/stroke_h264.mp4'], check=True)
    print(json.dumps(truth, indent=1))
    print(f'rendered {n} frames -> fixtures/stroke_vp9.mp4, fixtures/stroke_h264.mp4')


if __name__ == '__main__':
    main()
