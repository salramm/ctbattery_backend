# CT Battery Solutions backend — multi-stage production image.
# Build context is apps/backend (see .github/workflows + docker-compose).

# ---- Stage 1: build ---------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache dumb-init openssl libc6-compat \
  && addgroup -g 1001 -S nodejs \
  && adduser -S apiuser -u 1001

# Production deps only, then (re)generate the Prisma client for this image's
# fresh node_modules. prisma is a runtime dependency so this works offline.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

COPY --from=builder /app/dist ./dist
# Runtime geo asset for in-memory point-in-polygon. The large source data
# (usurdb.json, full territories.geojson, SQLite) is NOT shipped in the image.
COPY data/territories-simple.geojson ./data/territories-simple.geojson
# ESS underserved-geography layers (EJ block groups, distressed munis).
COPY data/ess ./data/ess

RUN chown -R apiuser:nodejs /app
USER apiuser

EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
