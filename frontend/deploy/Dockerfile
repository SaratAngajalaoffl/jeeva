FROM node:20-slim AS builder
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY frontend/package.json frontend/package.json
# Two copies of esbuild get installed here (0.21.5 via vite, 0.28.2 via tsx),
# and each postinstall hardlinks its platform binary and then execs it. On some
# builders (BuildKit/overlayfs on CI) that exec intermittently fails with
# ETXTBSY because the freshly written file still has an open write handle,
# which aborts the whole install. Retry once to absorb the race.
RUN npm ci --workspace=frontend --include-workspace-root \
 || npm ci --workspace=frontend --include-workspace-root
COPY frontend ./frontend
# NEXT_PUBLIC_* vars are inlined into the client bundle at build time, so
# the publicly reachable api URL must be supplied here, not at container
# runtime.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build --workspace=frontend

FROM node:20-slim
WORKDIR /repo/frontend
COPY --from=builder /repo/frontend/.next ./.next
COPY --from=builder /repo/frontend/public ./public
COPY --from=builder /repo/frontend/package.json ./package.json
COPY --from=builder /repo/node_modules ../node_modules
COPY --from=builder /repo/frontend/node_modules ./node_modules
EXPOSE 3000
CMD ["npm", "run", "start"]
