FROM --platform=$BUILDPLATFORM node:16.17.0-slim as build

WORKDIR /workdir

RUN apt-get update && apt-get install -y default-jre

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:16.17.0-alpine

WORKDIR /workdir

COPY --from=build /workdir/dist/app.js ./

CMD ["node", "app.js"]
