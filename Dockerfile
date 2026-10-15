FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788 CATALOG_CACHE_FILE=/data/catalog-cache.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js catalog.js catalog-store.js catalog.json ./
COPY public ./public
COPY stickers ./stickers
COPY test ./test
COPY scripts ./scripts
RUN npm test && npm run validate:catalog && mkdir -p /data && chown node:node /data
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
