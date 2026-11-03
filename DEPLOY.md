# Deployment

## VPS / server

```bash
npm ci
npm run build
TELEGRAM_BOT_TOKEN="your_bot_token" npm run start
```

By default the production server listens on `0.0.0.0:5175`.

Optional environment variables:

```bash
PORT=5175
TELEGRAM_ALLOWED_CHAT_ID=123456789
BRIDGE_COMMAND_TOKEN=long-random-command-token
FLOP_CLUB_TG_API_URL=http://api:4000
FLOP_CLUB_TG_PARTICIPANTS_URL=http://api:4000/api/clock/participants
FLOP_CLUB_TG_TOKEN=admin-jwt-token
FLOP_CLUB_TG_TOURNAMENT_ID=
```

The production server serves the React app from `dist` and exposes the Telegram bridge on the same origin:

- `GET /events`
- `POST /state`
- `POST /command`
- `GET /participants`

If `BRIDGE_COMMAND_TOKEN` is set, `POST /command` requires:

```http
Authorization: Bearer long-random-command-token
```

## Docker

```bash
docker build -t flop-clock .
docker run -p 5175:5175 -e TELEGRAM_BOT_TOKEN="your_bot_token" flop-clock
```

Open:

```text
http://server-ip:5175
```

## Together with `flop-club-tg`

Recommended production layout:

- `flop-club-tg` stays on the main domain.
- blind clock is routed by Caddy under `/clock/*`.
- the blind clock container talks to the mini app API through Docker Compose DNS: `http://api:4000`.

Add a `blind-clock` service to `flop-club-tg/docker-compose.prod.yml`:

```yaml
  blind-clock:
    build:
      context: ../flop-club-blind
      dockerfile: Dockerfile
      args:
        VITE_BASE_PATH: /clock/
        VITE_BOT_BRIDGE_URL: /clock
    restart: unless-stopped
    environment:
      NODE_ENV: production
      SERVE_STATIC: "true"
      HOST: 0.0.0.0
      PORT: 5175
      TELEGRAM_BOT_TOKEN: ${BLIND_TELEGRAM_BOT_TOKEN:-}
      TELEGRAM_ALLOWED_CHAT_ID: ${BLIND_TELEGRAM_ALLOWED_CHAT_ID:-}
      BRIDGE_COMMAND_TOKEN: ${BLIND_BRIDGE_COMMAND_TOKEN}
      FLOP_CLUB_TG_PARTICIPANTS_URL: http://api:4000/api/clock/participants
      FLOP_CLUB_TG_TOKEN: ${CLOCK_API_TOKEN}
      FLOP_CLUB_TG_TOURNAMENT_ID: ${BLIND_FLOP_CLUB_TG_TOURNAMENT_ID:-}
      PARTICIPANTS_CACHE_MS: 10000
    depends_on:
      - api
```

Add to `flop-club-tg/deploy/Caddyfile` before the final `handle`:

```caddyfile
  handle_path /clock/* {
    reverse_proxy blind-clock:5175
  }
```

Then open:

```text
https://your-domain/clock/
```
