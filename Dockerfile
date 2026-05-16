# syntax=docker/dockerfile:1

# Debian slim (glibc) — sharp ships prebuilt binaries for linux x64/arm64,
# so no apt/libvips/build tools are needed.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    CACHE_DIR=/data

WORKDIR /app

# Install deps first for better layer caching. Only runtime deps are declared
# in package.json (express, proj4, sharp) so --omit=dev is just belt-and-braces.
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
