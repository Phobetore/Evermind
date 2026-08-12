# Build context is the REPOSITORY ROOT (needs library/). Build from repo root:
#   docker build -f backend/Dockerfile -t evermind-backend .
# Semantic memory (sentence-transformers/torch, ~2-3 GB) is opt-in:
#   docker build -f backend/Dockerfile --build-arg SEMANTIC=true -t evermind-backend .
FROM python:3.13-slim
WORKDIR /app

COPY backend/pyproject.toml backend/README.md ./
COPY backend/app ./app
COPY backend/migrations ./migrations

ARG SEMANTIC=false
# The base image ships setuptools 70.3.0, which carries CVE-2025-47273. It is
# build tooling rather than anything the running app touches, but it stays in
# the image and there is no reason to ship a known-vulnerable copy of it.
RUN pip install --no-cache-dir --upgrade pip setuptools \
    && pip install --no-cache-dir -e . \
    && if [ "$SEMANTIC" = "true" ]; then pip install --no-cache-dir -e ".[semantic]"; fi

COPY library ./library

ENV EVERMIND_DATA_DIR=/data
ENV EVERMIND_LIBRARY_DIR=/app/library
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
