# Simple Dockerfile for BeanBee TGBot
FROM mirror.gcr.io/library/node:20.18.0

WORKDIR /app

# Install system dependencies needed for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json yarn.lock ./

# Install dependencies (yarn is already included in the base image)
RUN yarn install

# Copy source code
COPY . .

# Build TypeScript
RUN yarn build

# Clean up dev dependencies
RUN yarn install --production && yarn cache clean

# Expose port
EXPOSE 8080

# Start application
CMD ["node", "dist/index.js"]