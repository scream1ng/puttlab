FROM python:3.11-slim

# ffmpeg for decoding whatever a phone produces — HEVC, rotation metadata,
# variable frame rate. Fighting those in a browser cost a full day.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ /app/server/
COPY src/ /app/src/
COPY index.html /app/index.html

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000"]
