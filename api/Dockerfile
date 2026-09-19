FROM node:20-slim AS builder
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY api/package.json api/package.json
RUN npm ci --workspace=api --include-workspace-root
COPY api ./api
RUN npm run build --workspace=api

FROM node:20-slim
WORKDIR /repo
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/api/node_modules ./api/node_modules
COPY --from=builder /repo/api/dist ./api/dist
COPY --from=builder /repo/api/package.json ./api/package.json
WORKDIR /repo/api
EXPOSE 4000
CMD ["node", "dist/index.js"]
