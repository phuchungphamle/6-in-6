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

Install Docker Compose, copy `.env.example` to `.env`, and replace both example secrets with private random values. Set `NODE_ENV=production` and `DOMAIN` to a DNS name pointing to your server. Then run:

```sh
docker compose up --build -d
```

The Compose stack includes Caddy for automatic HTTPS and keeps the SQLite database, review photos, and TLS certificates in named volumes. Point the domain's DNS to the host before starting the stack. Allow inbound TCP ports 80 and 443 (and UDP 443 for HTTP/3) in the host firewall, restrict SSH (port 22) to trusted addresses, and do not expose app port 3000 publicly. `TRUST_PROXY=1` is set so secure cookies and same-origin checks recognize Caddy's HTTPS connection.

### Small VPS deployment

For a small school challenge (about 600 accounts, around 30 concurrent users, and up to 20 GB of app data), start with a shared VPS with 2 vCPU, 4 GB RAM, and a 40 GB SSD in a nearby region. For users in Southeast Asia, Singapore is a suitable location. Hetzner offers a Singapore location; its live price depends on server plan, IPv4, backups, and taxes, so confirm the checkout total before creating the server. Budget roughly US$7–10/month for the server and IPv4, before optional backups or taxes; this is an estimate, not a guaranteed quote. If reliable capacity for 30 simultaneous users is essential, load-test the deployment and resize if needed.

1. Create an Ubuntu 24.04 server with the above resources, a public IPv4 address, and your SSH public key. Enable provider backups if they fit your budget.
2. Create a DNS name (a free DuckDNS subdomain is enough) and point its A record to the server's public IPv4 address.
3. In the provider firewall, allow TCP 80 and 443 from the internet, and TCP 22 only from your own trusted IP. Do not open port 3000.
4. SSH into the server, install Docker Engine and the Compose plugin using Docker's [Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/), then install Git with `sudo apt install -y git`.
5. Clone the deployment branch and create the private environment file:

   ```sh
   sudo git clone --branch phuchungphamle-improved-reading-challenge-app https://github.com/phuchungphamle/6-in-6.git /opt/6-in-6
   sudo chown -R "$USER":"$USER" /opt/6-in-6
   cd /opt/6-in-6
   cp .env.example .env
   openssl rand -hex 32
   nano .env
   ```

   In `.env`, set `DOMAIN` to your DNS name, `NODE_ENV=production`, `TEACHER_PASSWORD` to a unique private password of at least 12 characters, and `SESSION_SECRET` to the output of `openssl rand -hex 32`. Keep `.env` private and never commit it.
6. From the repository directory, run `docker compose up --build -d`. The Compose stack starts the app and Caddy; Caddy obtains and renews the HTTPS certificate once DNS has propagated.
7. Check `https://your-domain/api/health`, then open the site and test student account creation, photo submission, and teacher approval. Share only the HTTPS URL.
8. Back up the persistent Docker data volume (database and photos) off the VPS regularly using a SQLite-consistent backup method, monitor free disk space, and keep OS/Docker security updates current. The 2 MB per-photo upload limit means six maximum-size submissions from 600 students could use about 7.2 GB; repeated submissions can increase that, so monitor actual usage.

This is a practical starting configuration, not an uptime or concurrency guarantee. A VPS provider's service terms and backups do not replace tested off-site backups.

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
