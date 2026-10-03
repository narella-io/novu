FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# narella: apk upgrade picks up the current openssl/curl fixes; npm is removed once the
# production deps are installed, because the npm bundled in the base image carries its own
# tar / pacote / sigstore / brace-expansion / picomatch / ip-address that the server never uses.
RUN apk upgrade --no-cache && \
    npm ci --omit=dev && \
    npm cache clean --force && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY src ./src
USER node
EXPOSE 3006
CMD ["node", "src/index.js"]
