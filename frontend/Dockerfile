# Build from repo root:  docker build -f frontend/Dockerfile -t evermind-frontend .
FROM node:24-slim AS builder
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Compile-time: the /api rewrite target. In compose the backend service is named "backend".
ARG EVERMIND_BACKEND_URL=http://backend:8000
ENV EVERMIND_BACKEND_URL=$EVERMIND_BACKEND_URL
RUN npm run build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# The runtime only ever runs `node server.js`. npm ships vendored copies of tar,
# undici and brace-expansion, which are the last fixable CVEs a scanner finds
# here and which nothing in this image executes. Dropping npm removes them
# outright instead of waiting for the base image to catch up.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
