# footVSball — server Colyseus + client statico su un'unica porta
FROM node:22-alpine

WORKDIR /app

# Install deps (dev deps incluse: il server gira via tsx)
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=2567
EXPOSE 2567

CMD ["npm", "start"]
