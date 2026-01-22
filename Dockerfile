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

# Start the server (don't use npm start which hardcodes NODE_ENV=production)
CMD ["node", "dist/index.cjs"]
