FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY services/orchestrator/package.json services/orchestrator/tsconfig.json ./
COPY services/orchestrator/src ./src
COPY services/orchestrator/prisma ./prisma
RUN npm install && npx prisma generate
ENV NODE_ENV=production
EXPOSE 4100
CMD ["npx", "tsx", "src/index.ts"]
