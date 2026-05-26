FROM node:22-alpine AS deps

WORKDIR /app/apps/web
COPY apps/web/package*.json ./
RUN npm ci

FROM node:22-alpine AS builder

WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/apps/web/node_modules ./node_modules
COPY apps/web ./
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app/apps/web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/data ./data
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./.next/static

EXPOSE 3000

CMD ["node", "server.js"]
