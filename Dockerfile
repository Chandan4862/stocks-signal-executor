# syntax=docker/dockerfile:1

# Build stage: compile TypeScript to dist
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm i

# Copy source
COPY tsconfig.json ./
COPY src ./src
COPY db ./db
COPY .env.example ./

# Build
RUN npm run build

# Runtime stage: run compiled JS with production deps
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy package.json + node_modules from builder, then prune dev deps
COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev

# Copy build output and migration files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/db ./db

# Default command
CMD ["node", "dist/index.js"]
