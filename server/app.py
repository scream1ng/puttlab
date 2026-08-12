"""
PuttLab server: upload a clip, get the stroke measured.

Split on purpose. Python does the part that was actually broken — finding the
ball, the club and the mat's line in the picture. The metrics themselves stay in
analyse.js, which passes 51 checks against a fixture whose truth was rendered in;
rewriting that here would mean re-earning the only ground truth this project has.

So the API hands back per-frame observations in mat millimetres, and the browser
runs the tested arithmetic on them.
"""

import os, uuid, threading, traceback
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import analyse, render as render_mod

ROOT = Path("/app")
WORK = Path("/tmp/puttlab")
WORK.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="PuttLab")
JOBS = {}


def _run(job_id: str, path: str, fps):
    job = JOBS[job_id]
    try:
        job["state"] = "decoding"

        def progress(done, total):
            job["state"] = "analysing"
            job["progress"] = round(100 * done / max(1, total))

        result = analyse.observations(path, capture_fps=fps, progress=progress,
                                      want_image=True)
        if "error" in result:
            job.update(state="failed", error=result["error"])
            return

        job["state"] = "drawing"
        try:
            render_mod.render(path, str(WORK / job_id), result)
        except Exception:
            job["render_error"] = traceback.format_exc(limit=2)
        # Image-space geometry is the renderer's business, not the browser's.
        result.pop("image", None)
        job["result"] = result
        job["state"] = "done"
    except Exception as e:
        job.update(state="failed", error=f"{type(e).__name__}: {e}")


@app.post("/api/analyse")
async def start(file: UploadFile = File(...), capture_fps: str = Form("")):
    job_id = uuid.uuid4().hex[:12]
    d = WORK / job_id
    d.mkdir(parents=True, exist_ok=True)
    dest = d / (file.filename or "clip.mov")
    with open(dest, "wb") as fh:
        while chunk := await file.read(1 << 20):
            fh.write(chunk)

    fps = None
    try:
        fps = float(capture_fps) if capture_fps else None
    except ValueError:
        fps = None

    JOBS[job_id] = {"state": "queued", "progress": 0, "name": file.filename}
    threading.Thread(target=_run, args=(job_id, str(dest), fps), daemon=True).start()
    return {"id": job_id}


@app.get("/api/analyse/{job_id}")
def status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    out = {k: job.get(k) for k in ("state", "progress", "error", "name")}
    if job.get("state") == "done":
        r = job["result"]
        out["result"] = r
        out["hasRender"] = (WORK / job_id / f"{Path(job['name']).stem}-frames.png").exists()
    return JSONResponse(out)


@app.get("/api/render/{job_id}")
def render_image(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    stem = Path(job.get("name") or "clip").stem
    p = WORK / job_id / f"{stem}-frames.png"
    if not p.exists():
        raise HTTPException(404, "no render")
    return FileResponse(p, media_type="image/png")


# Local clips, when a folder is mounted at /clips. Lets the real file be fed
# through the ordinary upload path instead of being shrunk to fit a tool limit.
if Path("/clips").is_dir():
    app.mount("/clips", StaticFiles(directory="/clips"), name="clips")

# The tested metrics code, served to the browser that will run it.
app.mount("/src", StaticFiles(directory=str(ROOT / "src")), name="src")
app.mount("/", StaticFiles(directory=str(ROOT / "server" / "static"), html=True), name="ui")
