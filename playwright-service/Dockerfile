FROM mcr.microsoft.com/playwright:v1.50.1-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

# Playwright ブラウザ（Chromiumのみ）
RUN npx playwright install chromium --with-deps

COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
