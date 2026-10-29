# Built with the repo root as context (a pnpm workspace), e.g.:
#   docker build -f mcp-server/Dockerfile -t mcp-server .
FROM node:26-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY mcp-server/package.json mcp-server/
RUN pnpm install --frozen-lockfile
COPY mcp-server mcp-server/
RUN pnpm --filter mcp-server build

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY mcp-server/package.json mcp-server/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/mcp-server/dist mcp-server/dist
WORKDIR /app/mcp-server
CMD ["node", "dist/http.js"]
