FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY server ./server
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM alpine:3.22 AS rclone
ARG TARGETARCH
ARG RCLONE_VERSION=1.75.0
RUN apk add --no-cache ca-certificates curl unzip \
  && case "${TARGETARCH}" in \
    amd64) RCLONE_ARCH=amd64; RCLONE_SHA256=aa2804e08f48250e71009c727124b6341cd0288465804a9a09d14663cabafbaa ;; \
    arm64) RCLONE_ARCH=arm64; RCLONE_SHA256=d0ad88ba4c8e285b7c9efa591e0ab643280a91741e13c27f3a9c0957ccfa5203 ;; \
    *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && RCLONE_ZIP="rclone-v${RCLONE_VERSION}-linux-${RCLONE_ARCH}.zip" \
  && curl --proto '=https' --tlsv1.2 -fsSLo "/tmp/${RCLONE_ZIP}" "https://downloads.rclone.org/v${RCLONE_VERSION}/${RCLONE_ZIP}" \
  && echo "${RCLONE_SHA256}  /tmp/${RCLONE_ZIP}" | sha256sum -c - \
  && unzip -q "/tmp/${RCLONE_ZIP}" -d /tmp/rclone \
  && install -m 0755 "/tmp/rclone/rclone-v${RCLONE_VERSION}-linux-${RCLONE_ARCH}/rclone" /usr/local/bin/rclone

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data BACKUP_ROOT=/backups
WORKDIR /app
RUN apk add --no-cache git ca-certificates tini zstd
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY package.json ./
RUN mkdir -p /data /backups/.tmp
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist-server/index.js"]
