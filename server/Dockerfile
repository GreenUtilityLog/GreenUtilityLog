# Reward-distributor service — container image.
# Build context is the /server folder.
FROM node:20-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source.
COPY . .

# The service honours $PORT (set automatically by most hosts); default 8787.
ENV PORT=8787
# Outside Render-behind-Cloudflare nothing overwrites a CF-Connecting-IP the
# caller sends, so it would let anyone pick their own rate-limit bucket. Use the
# connection's address; set your proxy's client-IP header here if there is one.
ENV CLIENT_IP_HEADER=none
EXPOSE 8787

CMD ["npm", "start"]
