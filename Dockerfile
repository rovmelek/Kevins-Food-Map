# Kevin's Food Map: the app in a container. Used by docker/compose.yml,
# which also runs Caddy in front of it. See README, "Running with Docker".
#
# Node 24 (24.7 or newer stores the password with Argon2id). The app has no
# npm dependencies, so the image is just Node plus the source code.
FROM node:24-alpine

WORKDIR /app
# The code belongs to root and is read-only for the app, which runs as an
# ordinary user (set in docker/compose.yml).
COPY . .
# Readable by everyone even if the files were cloned with a strict umask.
RUN chmod -R a+rX /app
# Even without compose's user: setting, never root (node is uid 1000).
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_FILE=/data/restaurants.json \
    ENV_FILE=/config/.env

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server.js"]
