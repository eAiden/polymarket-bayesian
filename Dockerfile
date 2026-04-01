FROM node:22-slim

WORKDIR /app

# Install all deps (tsx is a runtime dep for TS execution)
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "--import", "tsx/esm", "server/index.ts"]
