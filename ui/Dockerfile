# ---- Build ----
FROM node:20-alpine AS build
WORKDIR /app
# Enable corepack so the pinned yarn from package.json is fetched automatically.
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable
COPY . .
# NEXT_PUBLIC_* env vars are baked into the client bundle at build time.
# Pass a custom WS port if the host maps ws-gateway to something other than 3001.
ARG NEXT_PUBLIC_WS_PORT
ARG NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_WS_PORT=${NEXT_PUBLIC_WS_PORT}
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}
RUN yarn build

# ---- Runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# tmux for the in-container CLI calls; corepack isn't needed at runtime
# because we invoke `next` directly below.
RUN apk add --no-cache tmux
COPY --from=build /app/package.json /app/yarn.lock /app/.yarnrc.yml ./
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/next.config.ts ./next.config.ts
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
