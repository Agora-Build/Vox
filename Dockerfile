# Vox Service Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Expose port
EXPOSE 5000

# Run migrations then start the server
CMD ["sh", "-c", "npx drizzle-kit migrate && node dist/index.cjs"]
