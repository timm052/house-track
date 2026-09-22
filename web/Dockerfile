FROM node:24-slim AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Plain HTTP on :80. HTTPS is terminated by the Tailscale sidecar (PLAN.md D5).
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /web/dist /srv/web
