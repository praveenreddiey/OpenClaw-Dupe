FROM node:20-alpine

WORKDIR /app

# Alpine uses 'apk' instead of 'apt'. 
# 'build-base' includes g++, make, and gcc.
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    build-base

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN mkdir -p /app/workspace

RUN mkdir -p /app/data
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV NODE_ENV=development
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
