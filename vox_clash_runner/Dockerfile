# vox_clash_runner - Clash Runner for AI Agent Voice Duels
#
# Launches two headless Chromium browsers (via Playwright), each visiting
# a different AI agent's web URL. PipeWire cross-routes audio so the agents
# hear each other. An observer records the conversation and computes metrics.
#
# Build:
#   docker build -t vox_clash_runner .
#
# Run:
#   docker run -e RUNNER_TOKEN=xxx -e VOX_SERVER=http://host.docker.internal:5000 vox_clash_runner

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 20, PipeWire, and Chromium system deps
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y \
    nodejs \
    dbus \
    pipewire \
    pipewire-pulse \
    wireplumber \
    pulseaudio-utils \
    libspa-0.2-modules \
    pipewire-audio-client-libraries \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-freefont-ttf \
    libxss1 \
    libxtst6 \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2t64 \
    libxdamage1 \
    libxrandr2 \
    libxcomposite1 \
    libxfixes3 \
    libcups2t64 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0t64 \
    sox \
    g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download and extract Agora Server Gateway SDK
RUN curl -fsSL https://download.agora.io/rtsasdk/release/Agora-RTC-x86_64-linux-gnu-v4.4.32-20250425_144419-675648.tgz \
    -o /tmp/agora-sdk.tgz \
    && tar xzf /tmp/agora-sdk.tgz -C /opt \
    && rm /tmp/agora-sdk.tgz

# Install Playwright Chromium
RUN npx playwright install --with-deps chromium

# Copy application files
COPY package.json /app/
RUN npm install

COPY audio/ /app/audio/
COPY *.ts /app/

# Common SDK source files for C++ builds
ENV AGORA_COMMON="/opt/agora_rtc_sdk/example/common"

# Compile agora-broadcaster (publishes PCM to Agora channel)
RUN g++ -std=c++17 -O2 \
    -I/opt/agora_rtc_sdk/agora_sdk/include \
    -I/opt/agora_rtc_sdk/example \
    -L/opt/agora_rtc_sdk/agora_sdk \
    -o /app/agora-broadcaster \
    /app/audio/agora-broadcaster.cpp \
    $AGORA_COMMON/sample_common.cpp $AGORA_COMMON/sample_event.cpp \
    $AGORA_COMMON/helper.cpp $AGORA_COMMON/opt_parser.cpp \
    $AGORA_COMMON/sample_connection_observer.cpp \
    -lagora_rtc_sdk -lpthread \
    -Wl,-rpath=/opt/agora_rtc_sdk/agora_sdk

# Patch SDK sample: add missing #include <string> for sample_local_user_observer
RUN sed -i '1i #include <string>' /opt/agora_rtc_sdk/example/common/sample_local_user_observer.cpp

# Compile agora-receiver (subscribes to Agora channel, writes PCM to stdout)
RUN g++ -std=c++17 -O2 \
    -I/opt/agora_rtc_sdk/agora_sdk/include \
    -I/opt/agora_rtc_sdk/example \
    -L/opt/agora_rtc_sdk/agora_sdk \
    -o /app/agora-receiver \
    /app/audio/agora-receiver.cpp \
    $AGORA_COMMON/sample_common.cpp $AGORA_COMMON/sample_event.cpp \
    $AGORA_COMMON/helper.cpp $AGORA_COMMON/opt_parser.cpp \
    $AGORA_COMMON/sample_connection_observer.cpp \
    $AGORA_COMMON/sample_local_user_observer.cpp \
    -lagora_rtc_sdk -lpthread \
    -Wl,-rpath=/opt/agora_rtc_sdk/agora_sdk

# Compile TS → JS
RUN npx esbuild clash-runner.ts --bundle --platform=node --format=esm --outfile=clash-runner.js \
    --external:playwright-core --external:ws --external:child_process --external:fs --external:os --external:path --external:url

# Make PipeWire setup script executable
RUN chmod +x /app/audio/pipewire-setup.sh

# Build metadata (injected at build time via --build-arg)
ARG BUILD_TAG=dev
ARG BUILD_DATE=unknown
ENV BUILD_TAG=${BUILD_TAG}
ENV BUILD_DATE=${BUILD_DATE}

ENV VOX_SERVER=http://localhost:5000
ENV XDG_RUNTIME_DIR=/tmp/pipewire-run
ENV PIPEWIRE_RUNTIME_DIR=/tmp/pipewire-run
ENV LD_LIBRARY_PATH=/opt/agora_rtc_sdk/agora_sdk

VOLUME /app/output

CMD ["node", "clash-runner.js"]
