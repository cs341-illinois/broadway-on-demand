FROM node:lts-slim
RUN apt-get update -y && apt-get install -y openssl
WORKDIR /usr/src/app
COPY . .
RUN yarn
RUN yarn build
EXPOSE 3000
CMD ["node", "dist/server.js"]
