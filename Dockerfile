FROM node:22-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy the rest of the application code
COPY . .

# Hugging Face Spaces requires port 7860
EXPOSE 7860
ENV PORT=7860

CMD ["node", "master-proxy.js"]
