FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

RUN mkdir -p /var/lib/aifios-gateway \
  && chown node:node /var/lib/aifios-gateway \
  && chmod 700 /var/lib/aifios-gateway

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.mjs"]
