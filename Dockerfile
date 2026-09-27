FROM node:22-slim AS build
WORKDIR /app
COPY server/package*.json server/
COPY web/package*.json web/
RUN npm --prefix server ci && npm --prefix web ci
COPY server server
COPY web web
RUN npm --prefix web run build && npm --prefix server run build && npm --prefix server prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    HALEY_DB_PATH=/data/haley.db \
    HALEY_WEB_DIST=/app/web/dist \
    PORT=8787
WORKDIR /app
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "--enable-source-maps", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
