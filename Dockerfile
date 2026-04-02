FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production

# Railway injects PORT automatically
EXPOSE 3000

CMD ["npm", "start"]
