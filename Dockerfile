FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 GEOIP_DB=/data/geoip.mmdb
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts/download-geoip.mjs ./scripts/download-geoip.mjs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
# Fetch / refresh the GeoIP database (monthly), then start. Migrations run on start.
CMD ["sh", "-c", "node scripts/download-geoip.mjs --if-missing; exec node build/server.js"]
