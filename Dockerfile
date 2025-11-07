FROM node:22-bookworm AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-bookworm
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/frontend ./src/frontend
COPY package*.json ./
RUN npm install --omit=dev
RUN mkdir -p /app/data
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "dist/backend.js"]
