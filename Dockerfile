FROM node:18-alpine AS verificacao

WORKDIR /app
COPY . .

RUN node --check server.mjs \
    && node --check sw.js \
    && for arquivo in js/*.js; do node --check "$arquivo"; done

FROM node:18-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

COPY --from=verificacao --chown=node:node /app /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "server.mjs"]
