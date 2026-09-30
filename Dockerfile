# One image, three commands: web (default), worker, migrate.
#   docker run IMAGE                      -> web on :3000
#   docker run IMAGE npm run worker       -> background worker
#   docker run IMAGE npm run db:migrate   -> apply migrations (release step)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
RUN groupadd --system app && useradd --system --gid app --home /app app
COPY --from=build --chown=app:app /app/package.json /app/package-lock.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/public ./public
RUN mkdir -p /app/.data/blobs && chown -R app:app /app/.data
USER app
EXPOSE 3000
# Checks the web process on $PORT. The worker and migrate commands disable it (see docker-compose.yml).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
