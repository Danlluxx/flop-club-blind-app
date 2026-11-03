FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_BASE_PATH=/
ARG VITE_BOT_BRIDGE_URL=
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
ENV VITE_BOT_BRIDGE_URL=${VITE_BOT_BRIDGE_URL}
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV SERVE_STATIC=true
ENV HOST=0.0.0.0
ENV PORT=5175
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
EXPOSE 5175
CMD ["node", "scripts/telegram-bot.mjs"]
