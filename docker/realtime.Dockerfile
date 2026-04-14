FROM node:22-alpine
WORKDIR /app
COPY services/realtime/package.json services/realtime/tsconfig.json ./
COPY services/realtime/src ./src
RUN npm install
ENV NODE_ENV=production
EXPOSE 4102
CMD ["npx", "tsx", "src/index.ts"]
