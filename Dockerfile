# Quantum Sentinel: API + built operator console in one image (local / demo use).
FROM node:24.20.0-bookworm-slim

RUN npm install -g pnpm@12.15.0
WORKDIR /app

# Install dependencies first (cached unless manifests change).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/airwallex/package.json packages/airwallex/
COPY packages/policy/package.json packages/policy/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build:web

ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
EXPOSE 4000
USER node
CMD ["pnpm", "--filter", "@sentinel/api", "start"]
