FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache openssh-client

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

# No profiles file is baked in: the server starts and lists its tools without one, and a run
# that connects anywhere mounts its own and points SSH_PROFILES_FILE at it
USER node

ENTRYPOINT ["node", "dist/index.js"]
