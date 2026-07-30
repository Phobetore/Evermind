# Build from repo root:  docker build -f frontend/Dockerfile -t evermind-frontend .
FROM node:20-slim AS builder
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/patches ./patches
RUN npm ci
COPY frontend/ ./
# Compile-time: the /api rewrite target. In compose the backend service is named "backend".
ARG EVERMIND_BACKEND_URL=http://backend:8000
ENV EVERMIND_BACKEND_URL=$EVERMIND_BACKEND_URL
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
