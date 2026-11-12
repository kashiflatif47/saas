# TableSaaS — single production image: builds the React SPA and the API, then serves both from one Node
# process (API + Socket.IO + uploads + SPA via CLIENT_DIST_DIR). Works on Railway, Render, Fly, any VPS with Docker.
#
#   docker build --build-arg VITE_ROOT_DOMAIN=example.com -t tablesaas .
#   docker run -p 4000:4000 --env-file server/.env -v tablesaas-uploads:/data/uploads tablesaas
#
# VITE_ROOT_DOMAIN is compiled into the SPA, so it must be supplied at BUILD time (Railway passes service
# variables to declared build args automatically).

ARG NODE_VERSION=24-alpine

# ---------- build the client ----------
FROM node:${NODE_VERSION} AS client
WORKDIR /app/client
ARG VITE_ROOT_DOMAIN
ARG VITE_API_URL=""
RUN test -n "$VITE_ROOT_DOMAIN" || (echo "ERROR: build arg VITE_ROOT_DOMAIN is required (e.g. example.com)" && exit 1)
ENV VITE_ROOT_DOMAIN=$VITE_ROOT_DOMAIN VITE_API_URL=$VITE_API_URL
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---------- build the server ----------
FROM node:${NODE_VERSION} AS server
WORKDIR /app/server
# Dev dependencies include mongodb-memory-server (tests only): never download a MongoDB binary in the image.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    CLIENT_DIST_DIR=/app/client/dist \
    UPLOAD_DIR=/data/uploads
WORKDIR /app/server
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/package.json ./package.json
COPY --from=client /app/client/dist /app/client/dist
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
