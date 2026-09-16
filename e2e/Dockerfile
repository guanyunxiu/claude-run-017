# Playwright's official image ships browsers + OS dependencies.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY playwright.config.ts ./
COPY tests ./tests

# The compose stack waits for frontend/backend healthchecks before starting us.
CMD ["npx", "playwright", "test", "--reporter=list"]
