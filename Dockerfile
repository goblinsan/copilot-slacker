# syntax=docker/dockerfile:1.7
# Multi-stage build for copilot-slacker approval service
# Stage 1: dependencies & build
FROM node:20-alpine AS deps
WORKDIR /app
# Install build toolchain for any native deps (minimized)
RUN apk add --no-cache python3 make g++
COPY package*.json ./
# Use npm ci for reproducible installs
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
COPY .agent ./
# Build TypeScript -> dist
RUN npm run build --if-present || npx tsc
# Prune dev dependencies for production (will re-install cleanly in separate stage)
# We only need the compiled dist output from this stage

# Stage 2: production image with only runtime deps
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev

# Stage 3: final runtime
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
# Create non-root user
RUN addgroup -g 1001 app && adduser -S -D -H -u 1001 -G app app
# Copy production node_modules
COPY --from=prod-deps /app/node_modules ./node_modules
# Copy built dist and necessary runtime assets
COPY --from=deps /app/dist ./dist
COPY .agent ./ .agent
# Copy policy default path (ensure included even if bind mounted later)
# Expose port
EXPOSE 8080
USER app
# Default command (expects dist/server.js export starting server when imported or executed)
CMD ["node","dist/server.js"]
