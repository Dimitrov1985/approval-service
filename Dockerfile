FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
ENV PORT=3000 DATABASE_PATH=/data/approval.db
CMD ["node", "src/server.js"]
