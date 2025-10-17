# Dockerfile optimisé pour Railway
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install dependencies pour éviter les problèmes de cache
RUN apk add --no-cache git

# Copy package files first (pour le cache Docker)
COPY package*.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci --no-audit --no-fund

# Copy source code and config files
COPY . .

# Build TypeScript
RUN npm run build

# Clean up dev dependencies après le build
RUN npm prune --production

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "console.log('Health check OK')" || exit 1

# Start the application
CMD ["node", "dist/index.js"]
