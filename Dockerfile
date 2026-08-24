FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY server ./server
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM --platform=$BUILDPLATFORM golang:1.26.6-alpine@sha256:3889b425f035be855a72fb4755265311293b6d414521f0a519d819df32222d83 AS rclone
ARG TARGETOS
ARG TARGETARCH
ARG RCLONE_VERSION=1.75.0
ARG RCLONE_SOURCE_SHA256=4e08746025d989a4bb1c9a51a7fbdb927e9df61216c9172fd344823aa6a8acd8
ARG RCLONE_VENDOR_SHA256=c2027ee060ba86e338f81be46ef4a98fdaa02256b4acb72c1b8c48be7c825981
ARG RCLONE_X_IMAGE_VERSION=v0.45.0
RUN apk add --no-cache ca-certificates curl \
  && curl --proto '=https' --tlsv1.2 -fsSLo /tmp/rclone-source.tar.gz "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}.tar.gz" \
  && curl --proto '=https' --tlsv1.2 -fsSLo /tmp/rclone-vendor.tar.gz "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-vendor.tar.gz" \
  && echo "${RCLONE_SOURCE_SHA256}  /tmp/rclone-source.tar.gz" | sha256sum -c - \
  && echo "${RCLONE_VENDOR_SHA256}  /tmp/rclone-vendor.tar.gz" | sha256sum -c - \
  && mkdir /src && tar -xzf /tmp/rclone-source.tar.gz -C /src --strip-components=1 \
  && tar -xzf /tmp/rclone-vendor.tar.gz -C /src
WORKDIR /src
RUN GOFLAGS=-mod=mod go get golang.org/x/image@${RCLONE_X_IMAGE_VERSION} && go mod vendor
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -mod=vendor -trimpath \
  -ldflags="-s -w -X github.com/rclone/rclone/fs.Version=v${RCLONE_VERSION}" -o /usr/local/bin/rclone .

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data BACKUP_ROOT=/backups
WORKDIR /app
RUN apk add --no-cache git ca-certificates tini tar zstd
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY package.json ./
RUN mkdir -p /data /backups/.tmp && chown -R node:node /data /backups /app
EXPOSE 8787
VOLUME ["/data"]
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist-server/index.js"]
