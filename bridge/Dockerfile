# GreenUtilityLog HomeWizard bridge — zero-dependency, tiny image.
# Run with host networking so mDNS discovery can see your HomeWizard:
#   docker build -t gul-bridge ./bridge
#   docker run -d --name gul-bridge --network host -e GUL_TOKEN=<token> gul-bridge
FROM node:20-alpine
WORKDIR /app
COPY index.js package.json ./
USER node
CMD ["node", "index.js"]
