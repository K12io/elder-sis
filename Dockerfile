# Elder (elder-sis) production image — plain Node 26, Express + EJS + PostgreSQL.
# No build step; the app runs server-rendered. Migrations in db/migrations apply
# on boot (idempotent), so the container needs db/migrations at runtime.
FROM node:26-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

# Dependencies first for layer caching (lockfile required by npm ci)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code + migrations + static assets (public/css — express.static serves it)
COPY src ./src
COPY db ./db
COPY public ./public

USER node
EXPOSE 3000

# Alpine has no curl — probe /healthz with node fetch; requires db:up to pass
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>r.json()).then(j=>process.exit(j.ok===true&&j.db==='up'?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/app.js"]