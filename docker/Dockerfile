FROM debian:bookworm-slim

# Install dependencies for Chrome
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg2 \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libdrm2 \
    libgbm1 \
    libxkbcommon0 \
    xdg-utils \
    unzip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Chromium (multi-arch: works on both amd64 and arm64)
RUN apt-get update && apt-get install -y --no-install-recommends chromium \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Build UI
COPY ui/ ui/
RUN cd ui && bun install --frozen-lockfile && bun run build

ENTRYPOINT ["bun", "run", "src/index.ts"]
