# syntax=docker/dockerfile:1

# Pure-JS server (express + proj4 only — no native deps), so a tiny base works.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    CACHE_DIR=/data

WORKDIR /app

# Install deps first for better layer caching (express, proj4 only).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source
COPY server.js ./
COPY lib ./lib
COPY public ./public

# Persistent cache lives on a volume; make it writable by the unprivileged user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000
VOLUME ["/data"]

# No curl/wget in slim — use Node's built-in fetch for the healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
