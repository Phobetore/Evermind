# Build context is the REPOSITORY ROOT (needs library/). Build from repo root:
#   docker build -f backend/Dockerfile -t evermind-backend .
# Semantic memory (sentence-transformers/torch, ~2-3 GB) is opt-in:
#   docker build -f backend/Dockerfile --build-arg SEMANTIC=true -t evermind-backend .
FROM python:3.13-slim

# Docker rebuilds its base images on its own schedule, so one can carry Debian
# packages that have had a security update for weeks. Right now it ships the
# util-linux from before Debian's, which is 36 findings the image scan reports
# as fixable and which no amount of rebuilding here would clear. Take the
# updates from Debian directly rather than wait for the base image.
RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/pyproject.toml backend/README.md ./
COPY backend/app ./app
COPY backend/migrations ./migrations

ARG SEMANTIC=false
RUN pip install --no-cache-dir -e . \
    && if [ "$SEMANTIC" = "true" ]; then pip install --no-cache-dir -e ".[semantic]"; fi

COPY library ./library

ENV EVERMIND_DATA_DIR=/data
ENV EVERMIND_LIBRARY_DIR=/app/library
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
