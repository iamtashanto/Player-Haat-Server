# Deploying PlayerHaat API on an Ubuntu VPS (Nginx + PM2)

Tested path: Ubuntu 22.04/24.04, 2 vCPU / 2 GB RAM is plenty for launch. Everything below is a plain
command you can read before running. Replace `api.example.com` and the passwords.

> **What was verified, and what wasn't.** The PM2 config (cluster of 4 workers, `wait_ready`, graceful
> shutdown, zero-downtime `pm2 reload` under load), the production boot validation, the backup script and the
> migrations were all run for real. The **Nginx config and the Ubuntu steps were not** — Nginx isn't
> installed on the development machine, so run `sudo nginx -t` before reloading and read the first
> deploy over once.

## 1. Server basics

```bash
sudo apt update && sudo apt -y upgrade
sudo adduser --disabled-password --gecos "" playerhaat
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

Node 22 LTS, PostgreSQL, Nginx, certbot:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs postgresql nginx certbot python3-certbot-nginx
sudo npm i -g pm2
```

## 2. PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE USER playerhaat WITH PASSWORD 'CHANGE-ME-LONG-RANDOM';
CREATE DATABASE playerhaat OWNER playerhaat;
-- a runaway query must never be able to pin a connection forever
ALTER ROLE playerhaat SET statement_timeout = '15s';
ALTER ROLE playerhaat SET idle_in_transaction_session_timeout = '30s';
SQL
```

Postgres listens on localhost only by default — leave it that way. **Size the connection pool deliberately:** each
PM2 worker opens its own pool (`connection_limit` in `DATABASE_URL`; Prisma's default is 21). Keep the *total*
(`WEB_CONCURRENCY × connection_limit`) around 2–3× the database's CPU cores and far below `max_connections`
— in the load test, 4 workers × 21 connections was *slower* at the tail than a single process, while 4 × 6 nearly doubled
throughput (see `docs/PERFORMANCE.md`). The example `.env` uses 5 per worker (2 workers = 10 connections).

## 3. The app

```bash
sudo -iu playerhaat
git clone <your repo> /srv/playerhaat && cd /srv/playerhaat/server   # or rsync a build
cp .env.example .env && chmod 600 .env && nano .env
npm ci                       # prisma + tsx are runtime deps, so this also gives you migrate/seed/admin tools
npm run build
npx prisma migrate deploy
npm run db:seed              # locations (full national dataset), sports, default config — idempotent
```

`.env` for production — the server **refuses to start** if any of these is wrong (that's deliberate):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgresql://playerhaat:…@localhost:5432/playerhaat?schema=public&connection_limit=5` |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` (never the example value) |
| `CORS_ORIGINS` | your web origin(s), comma-separated |
| `SMTP_HOST` (+`SMTP_*`, `MAIL_FROM`) | your mail provider — required for verification and reset emails |
| `SMS_HTTP_URL_TEMPLATE` | your SMS gateway, for phone sign-in (otherwise phone endpoints answer 503) |
| `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_IDS` | OAuth client ids, or social sign-in answers 503 |
| `CLOUDINARY_*` | image uploads |
| `FIREBASE_SERVICE_ACCOUNT` | path to the service-account JSON (chmod 600), for push |
| `PUBLIC_API_URL` | `https://api.example.com` |

Create the first admin (there's no API for it, on purpose), after that person has registered in the app:

```bash
npm run admin:grant -- you@example.com
```

## 4. Run it under PM2

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup systemd          # run the command it prints (as root), once
pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 20M && pm2 set pm2-logrotate:retain 14
curl -s localhost:4000/health/ready
```

* **Workers:** `WEB_CONCURRENCY=2` by default. Set it to your vCPU count in the shell that runs `pm2 start`.
* **Deploys with no downtime:** `git pull && npm ci && npm run build && npx prisma migrate deploy && pm2 reload playerhaat-api`.
  `reload` restarts workers one at a time and waits for each to report ready. Write migrations so the *old*
  code keeps working against the new schema (add columns/tables first, remove them in a later deploy).
* **Background jobs** (rating reminders, expiring stale requests, purging expired data, sweeping orphan uploads)
  run on worker 0 only; the reminder job also takes a Postgres advisory lock.
* **Logs:** one JSON line per request (with an `X-Request-Id`) in `logs/api.out.log`; pipe to your log service if you have one.

## 5. Nginx + TLS

```bash
sudo cp deploy/nginx/playerhaat-api.conf /etc/nginx/sites-available/playerhaat-api
sudo sed -i 's/api.example.com/YOUR.DOMAIN/g' /etc/nginx/sites-available/playerhaat-api
sudo certbot certonly --nginx -d YOUR.DOMAIN           # obtains the certificate (and sets up auto-renew)
sudo ln -s /etc/nginx/sites-available/playerhaat-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
curl -s https://YOUR.DOMAIN/health
```

The config gives you TLS 1.2/1.3 + HSTS, a shared-memory per-IP rate limit (exact across workers; the in-app
limits are per worker), a stricter limit on `/api/v1/auth/`, 6 MB uploads with long body timeouts, and the real
client IP forwarded (`TRUST_PROXY=1` is set by the PM2 production env).

### Deep links (`https://…/p/{id}`, `/r/{id}`)

Android App Links and iOS Universal Links need two files at `https://YOUR.DOMAIN/.well-known/`. Templates are in
`deploy/well-known/`: put your Play **app-signing SHA-256** in `assetlinks.json` and your **Apple Team ID** in
`apple-app-site-association`, then `sudo mkdir -p /var/www/playerhaat/.well-known && sudo cp deploy/well-known/* /var/www/playerhaat/.well-known/`.
(If the marketing website will own that domain, serve these from the website instead.)

## 6. Backups and monitoring

```bash
sudo mkdir -p /var/backups/playerhaat && sudo chown playerhaat: /var/backups/playerhaat
crontab -e   # as playerhaat:
15 2 * * *  cd /srv/playerhaat/server && set -a && . ./.env && set +a && ./deploy/backup-db.sh >> /var/log/playerhaat-backup.log 2>&1
```

The script writes a verified `pg_dump` (custom format), keeps 14 days, and prints how to restore. **Copy the
dumps off the server** (rclone/rsync to another provider) — a backup on the same disk isn't one. Do a
test restore once into a scratch database.

Point an uptime monitor at `https://YOUR.DOMAIN/health` (liveness, no DB). `/health/ready` checks the database
and is reachable from the box only.

## 7. Checklist before you announce

- [ ] `pm2 status` shows all workers online; `curl localhost:4000/health/ready` is `ok`
- [ ] HTTPS works, HTTP redirects, `sudo certbot renew --dry-run` passes
- [ ] Register by email, sign in with Google/Apple/phone from a real phone; push arrives; photo uploads
- [ ] `npm run admin:grant` done; the admin routes answer 200 for you and 403 for a normal user
- [ ] A backup ran and a restore into a scratch DB worked
- [ ] `DOCS_ENABLED` is unset/false (Swagger off) — or restricted in Nginx
- [ ] Flutter release build points at `https://YOUR.DOMAIN/api/v1`
