# Build stage
FROM node:20-slim@sha256:1e85773c98c31d4fe5b545e4cb17379e617b348832fb3738b22a08f68dec30f3 AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev for tsc)
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Production stage
FROM node:20-slim@sha256:1e85773c98c31d4fe5b545e4cb17379e617b348832fb3738b22a08f68dec30f3

WORKDIR /app

# Create non-root user
RUN groupadd --gid 1001 nestapp && \
    useradd --uid 1001 --gid nestapp --shell /bin/false --create-home nestapp

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built files and static assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Switch to non-root user
USER nestapp

# Expose port
EXPOSE 3000

# Start the server
CMD ["node", "dist/index.js"]
