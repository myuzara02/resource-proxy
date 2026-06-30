FROM node:22-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy the rest of the application code
COPY . .

# Let the hosting provider (Render) set the PORT environment variable dynamically
CMD ["node", "master-proxy.js"]
