FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @repo/server build
RUN pnpm --filter @repo/db build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app /app
RUN pnpm add -g tsx
WORKDIR /app/apps/server
EXPOSE 4000
CMD ["tsx", "src/index.ts"]
