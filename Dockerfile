FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache font-noto-cjk
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8780 CONTENT_AGENT_DATA_DIR=/data
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/agent-core/dist ./packages/agent-core/dist
COPY --from=build /app/packages/agent-core/package.json ./packages/agent-core/package.json
VOLUME ["/data"]
EXPOSE 8780
CMD ["node", "apps/api/dist/main.js"]
