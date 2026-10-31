# Evermind in one image: the API and the interface it serves.
#
# Build context is the REPOSITORY ROOT (needs frontend/, backend/ and library/).
# Build from repo root:
#   docker build -t evermind .
# Semantic memory (sentence-transformers/torch, ~2-3 GB) is opt-in:
#   docker build --build-arg SEMANTIC=true -t evermind .

# The interface is compiled in a stage of its own: Node and the npm tree are
# only needed to produce a folder of static files, so none of it ends up in the
# image that runs.
FROM node:24-slim AS ui
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

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
COPY --from=ui /src/frontend/dist ./ui

# Inside the container the server has to listen on every interface, or the
# published port would reach nothing. Which of the host's interfaces actually
# gets that port is decided by docker-compose.yml, not here.
ENV EVERMIND_DATA_DIR=/data \
    EVERMIND_LIBRARY_DIR=/app/library \
    EVERMIND_UI_DIR=/app/ui \
    BIND=0.0.0.0 \
    PORT=8000
EXPOSE 8000
# No settings file: .dockerignore keeps .env out of the image, and a container
# is configured through the environment that docker-compose.yml hands it.
CMD ["python", "-m", "app", "--no-env-file"]
