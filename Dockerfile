FROM node:22-slim

WORKDIR /app

# Install all deps (tsx is a runtime dep for TS execution)
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Ensure data dir exists (pipeline writes JSON here at runtime)
RUN mkdir -p data

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["npx", "tsx", "server/index.ts"]
