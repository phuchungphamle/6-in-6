FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000

WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
