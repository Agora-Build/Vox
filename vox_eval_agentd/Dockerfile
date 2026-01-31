# vox_eval_agentd - Vox Evaluation Agent Daemon
#
# A Docker image that combines voice-agent-tester with Vox API integration
# for running automated voice agent evaluations.
#
# Build:
#   docker build -t vox_eval_agentd .
#
# Run:
#   docker run -e AGENT_TOKEN=xxx -e VOX_SERVER=http://host.docker.internal:5000 vox_eval_agentd

FROM node:20-slim

# Install Chrome dependencies and ca-certificates
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    libxtst6 \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    wget \
    curl \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy voice-agent-tester from build context
COPY voice-agent-tester/ /app/voice-agent-tester/

# Install voice-agent-tester dependencies
WORKDIR /app/voice-agent-tester
RUN npm install

# Copy vox integration files
WORKDIR /app
COPY applications/ /app/applications/
COPY scenarios/ /app/scenarios/
COPY assets/ /app/assets/
COPY vox-agent-daemon.js /app/
COPY package.json /app/

# Install daemon dependencies (none currently, but keep for future)
RUN npm install

# Environment variables (will be overridden at runtime)
ENV VOX_SERVER=http://localhost:5000
ENV VOX_AGENT_NAME="eval-agent"
ENV HEADLESS=true

# Output directory for recordings
VOLUME /app/output

# Run the daemon
CMD ["node", "vox-agent-daemon.js"]
