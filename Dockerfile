# Misinfo Research Platform — container image
# Multi-stage: the build stage compiles the native better-sqlite3 module, the
# runtime stage ships only the app + installed modules (no toolchain).

# ---- build ----
FROM node:20-slim AS build
WORKDIR /app
# Build tools for native modules (better-sqlite3) when no prebuilt binary matches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# ---- runtime ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# Copy the built app (including node_modules with the compiled binary — ABI
# matches because both stages use the same base image).
COPY --from=build /app /app
# Data + uploads should be mounted as volumes so they survive container rebuilds.
VOLUME ["/app/data", "/app/uploads"]
EXPOSE 3000
CMD ["node", "server.js"]
