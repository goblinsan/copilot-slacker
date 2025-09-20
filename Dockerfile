# syntax=docker/dockerfile:1.7
# Multi-stage build for copilot-slacker approval service
###############################
# Stage 1: Build (Debian slim)
###############################
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
COPY .agent ./
RUN npm run build --if-present || npx tsc

###############################
# Stage 2: Production deps (pruned)
###############################
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && rm -rf /var/lib/apt/lists/*

########################################
# Stage 3: Distroless final runtime
########################################
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
# Copy node_modules from prod-deps and application dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY .agent ./.agent
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/nodejs/bin/node","dist/server.js"]

########################################
# Optional: Alpine debug image (tools)
########################################
FROM node:20-alpine AS debug
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY .agent ./.agent
EXPOSE 8080
CMD ["node","dist/server.js"]
