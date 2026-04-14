FROM node:22-alpine
WORKDIR /app
COPY services/skills-registry/package.json services/skills-registry/tsconfig.json ./
COPY services/skills-registry/src ./src
RUN npm install
ENV NODE_ENV=production
EXPOSE 4103
CMD ["npx", "tsx", "src/index.ts"]
