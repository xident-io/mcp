# Runtime MCP server.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/mcp packages/mcp
RUN pnpm --filter @xident/mcp-shared build && pnpm --filter @xident/mcp build
RUN pnpm --filter @xident/mcp --prod deploy /out

FROM node:22-alpine
WORKDIR /app
# Non-root: this process is reachable from the public internet and holds
# bearer tokens in memory.
RUN addgroup -S xident && adduser -S xident -G xident
COPY --from=build --chown=xident:xident /out /app
USER xident
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
