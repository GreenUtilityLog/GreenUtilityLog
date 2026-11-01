# Reward-distributor service — container image.
# Build context is the /server folder.
# The same major Node line as server/package.json engines.
FROM node:26-slim

WORKDIR /app
# The file backend writes state.json here, as the user below.
RUN chown node:node /app

# Install dependencies first for better layer caching.
# npm ci: exactly the versions in package-lock.json, as tested.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source, owned by the unprivileged user it runs as.
COPY --chown=node:node . .
USER node

# The service honours $PORT (set automatically by most hosts); default 8787.
ENV PORT=8787
# Outside Render-behind-Cloudflare nothing overwrites a CF-Connecting-IP the
# caller sends, so it would let anyone pick their own rate-limit bucket. Use the
# connection's address; set your proxy's client-IP header here if there is one.
ENV CLIENT_IP_HEADER=none
EXPOSE 8787

CMD ["npm", "start"]
