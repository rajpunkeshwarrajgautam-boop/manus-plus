FROM node:22-alpine
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json* ./
RUN npm install
COPY apps/web .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
