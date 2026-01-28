# syntax=docker/dockerfile:1

# Build stage: compile TypeScript to dist
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

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

# Install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy build output and schema (for reference)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/db ./db

# Default command
CMD ["node", "dist/index.js"]
