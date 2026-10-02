FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs ./
COPY public ./public
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 5200
CMD ["node", "server.mjs"]
