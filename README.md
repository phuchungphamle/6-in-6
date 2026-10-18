# 6 in 6 — Reading Challenge

A hostable reading-challenge web app with server-backed student accounts, teacher review, persistent progress, and the complete 154-book catalog.

## Run locally

Requirements: Node.js 22.13 or newer.

1. Copy `.env.example` to `.env`.
2. Set `TEACHER_PASSWORD` to a private password (at least 12 characters) and `SESSION_SECRET` to a random secret of at least 32 characters. Generate a secret with:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```
3. Set `NODE_ENV=development`, `DATA_DIR=./data`, and `PORT=3000`.
4. Start the server:

   ```sh
   npm start
   ```
5. Open `http://localhost:3000`.

The server creates the SQLite database, seeds its catalog from `catalog.js`, and stores review photos in `DATA_DIR`. Back up the whole data directory.

## Deploy with Docker Compose

Install Docker Compose, copy `.env.example` to `.env`, and replace both example secrets with private random values. Set `NODE_ENV=production` in `.env`, then run:

```sh
docker compose up --build -d
```

Compose keeps the SQLite database and review photos in a named volume. The app binds only to `127.0.0.1:3000`; put it behind a trusted HTTPS reverse proxy such as Caddy and do not expose port 3000 publicly. For Caddy, point your domain's DNS to the host and use a site block like `reading.example.com { reverse_proxy 127.0.0.1:3000 }`. Allow inbound TCP ports 80 and 443 for HTTPS, and restrict SSH (port 22) to trusted addresses. `TRUST_PROXY=1` is set in Compose so secure cookies and same-origin checks recognize the proxy's HTTPS connection. Do not expose an unencrypted production deployment to the public internet.

## Deploy to Render

The included `render.yaml` is a Render Blueprint for the Docker app and a persistent disk mounted at `/app/data`. Create the service from the repository Blueprint, set the requested `TEACHER_PASSWORD` secret in Render's dashboard to a private password with at least 12 characters, and deploy. Render generates `SESSION_SECRET`; the service health check is `/api/health`. Persistent disks require a paid Render web-service plan and retain the database and review photos across deploys. Keep regular backups of that disk.

Other container hosts can use the included `Dockerfile`. Provide `NODE_ENV=production`, a private `TEACHER_PASSWORD` (12+ characters), a random `SESSION_SECRET` (32+ characters), `DATA_DIR=/app/data`, and persistent writable storage mounted there. Configure trusted proxy handling only when your host's HTTPS proxy supplies sanitized forwarding headers.

## Accounts and data

- Students create accounts using a unique username and a password of at least 12 characters. Passwords are scrypt-hashed and salted on the server.
- Login uses an HTTP-only, SameSite=Strict session cookie; only a keyed hash of each random session token is persisted. Sessions expire after 12 hours.
- Teachers sign into the review queue with the `TEACHER_PASSWORD` environment secret. The secret is never sent to the browser or stored in the database.
- Registration and sign-in endpoints are rate-limited. Mutating requests require a same-origin `Origin` header.
- Review images are validated, size-limited, and stored outside the public web root; only their student and authenticated teachers can view them.
- Approved reviews are counted on the server. Students cannot approve their own reviews or change leaderboard scores.
- The leaderboard shows student display name and class, not usernames.

The challenge catalog is seeded into SQLite from the exact records in `catalog.js` on first startup. The listed EPUB filenames are catalog metadata; ebook files are not included or served by this app. Student review-photo uploads are part of the separate review approval process.

## Checks

```sh
npm test
npm run check
```
