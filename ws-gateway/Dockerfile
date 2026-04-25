# ---- Build ----
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ linux-headers && corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
# Copy scripts before install so the postinstall hook can find fix-pty-helper.js.
COPY scripts ./scripts
RUN yarn install --immutable
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

# ---- Runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tmux libstdc++ && corepack enable
COPY --from=build /app/package.json /app/yarn.lock /app/.yarnrc.yml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/index.js"]
