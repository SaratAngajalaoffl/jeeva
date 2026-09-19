FROM node:20-slim AS builder
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace=frontend --include-workspace-root
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
