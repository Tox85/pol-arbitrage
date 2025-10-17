# Railway Dockerfile - Contourne Nixpacks pour éviter EBUSY
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install dependencies WITHOUT cache operations
RUN npm ci --no-audit --no-fund

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Expose port (Railway will set PORT env var)
EXPOSE 3000

# Start the application
CMD ["node", "dist/index.js"]
