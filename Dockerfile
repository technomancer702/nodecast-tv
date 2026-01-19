# NodeCast TV Docker Image
#
# Uses system FFmpeg with hardware acceleration drivers installed.
#
# Hardware acceleration:
#   - VAAPI (Intel/AMD): Mount /dev/dri and add video/render groups
#   - NVIDIA NVENC: Requires nvidia-container-toolkit on host + --gpus flag
#   - Intel QSV: Mount /dev/dri
#
# Build: docker compose build
# Run with VAAPI: docker run --device /dev/dri:/dev/dri --group-add video ...
# Run with NVENC: docker run --gpus all ...

FROM node:20-slim

# Install FFmpeg, build dependencies, and hardware acceleration drivers
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    # FFmpeg with full codec support
    ffmpeg \
    # Build dependencies for better-sqlite3
    python3 \
    make \
    g++ \
    # VAAPI runtime libraries (AMD/Intel)
    libva2 \
    libva-drm2 \
    libvdpau1 \
    mesa-va-drivers \
    # Intel VAAPI/QSV drivers
    intel-media-va-driver \
    i965-va-driver \
    # VA-API utilities for debugging
    vainfo \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installed and show version
RUN ffmpeg -version && ffmpeg -encoders 2>/dev/null | grep -E "vaapi|nvenc|qsv|libx264" | head -10

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create data and cache directories
RUN mkdir -p /app/data /app/transcode-cache && chmod 777 /app/transcode-cache

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server/index.js"]
