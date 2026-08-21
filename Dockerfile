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

# Placeholder profile: the server refuses to start without a usable one, and nothing connects until a call names it
RUN printf '{"profiles":{"example":{"host":"example.invalid","username":"mcp"}}}' > /app/profiles.json
ENV SSH_PROFILES_FILE=/app/profiles.json

USER node

ENTRYPOINT ["node", "dist/index.js"]
