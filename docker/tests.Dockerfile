# Playwright tests (TypeScript) with the bundled Chromium. Version must match @playwright/test in package.json.
FROM mcr.microsoft.com/playwright:v1.65.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci
ENV IN_DOCKER=1 HOME=/tmp
CMD ["npx", "playwright", "test"]
