FROM node:20-alpine

RUN apk add --no-cache curl ca-certificates bash gnupg docker-cli

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY . .

CMD ["node", "server.js"]
