FROM mcr.microsoft.com/playwright:v1.50.1-noble
WORKDIR /app
COPY services/browser-operator/package.json services/browser-operator/tsconfig.json ./
COPY services/browser-operator/src ./src
RUN npm install
ENV NODE_ENV=production
EXPOSE 4101
CMD ["npx", "tsx", "src/index.ts"]
