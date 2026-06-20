FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY src/ ./src/
COPY .env .env
CMD ["node", "src/index.js"]