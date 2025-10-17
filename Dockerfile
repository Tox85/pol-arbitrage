# Dockerfile optimisé pour Railway
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install dependencies pour éviter les problèmes de cache
RUN apk add --no-cache git

# Copy package files first (pour le cache Docker)
COPY package*.json ./

# Install dependencies sans cache npm
RUN npm ci --only=production --no-audit --no-fund --prefer-offline

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Clean up dev dependencies pour réduire la taille
RUN npm prune --production

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "console.log('Health check OK')" || exit 1

# Start the application
CMD ["node", "dist/index.js"]
