FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production

# Build the Next.js app
RUN npm run build

# Railway injects PORT automatically
EXPOSE 3000

CMD ["npm", "start"]
