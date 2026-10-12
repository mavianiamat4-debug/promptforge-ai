FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# Hugging Face Spaces expects the app on port 7860
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
