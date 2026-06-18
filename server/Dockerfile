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
EXPOSE 8787

CMD ["npm", "start"]
