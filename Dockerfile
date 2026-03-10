FROM node:20-alpine

WORKDIR /app

# Alpine uses 'apk' instead of 'apt'. 
# 'build-base' includes g++, make, and gcc.
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    build-base

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

RUN mkdir -p /app/data
ENV NODE_ENV=development
EXPOSE 3000

CMD ["node", "dist/src/server.js"]