# Build native Node dependencies separately so compilers are not present in the
# runtime image that processes untrusted IPTV media.
FROM node:24-trixie-slim AS dependencies

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ \
    make \
    python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force


FROM node:24-trixie-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

RUN mkdir -p /app/data /app/transcode-cache \
    && chown -R node:node /app/data /app/transcode-cache

# The official image's unprivileged user prevents Node.js and FFmpeg from
# running as root inside the container.
USER node

EXPOSE 3000

CMD ["node", "server/index.js"]
