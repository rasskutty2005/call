# Deployment

## HTTPS is a functional requirement

`getUserMedia()` only works in a secure context. Over plain HTTP — anything other
than `http://localhost`, which browsers exempt — the microphone request is
rejected outright and **no call can be placed**. TLS here is not hardening; the
product does not work without it.

---

## Environment

`.env` is generated on the first `npm run` with a random `JWT_SECRET` and a local
SQLite path. For production set at minimum:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | A `file:` path on persistent storage, e.g. `file:/var/lib/sonder/sonder.db`. **Not** the default `file:./dev.db`, which lives inside the checkout. |
| `JWT_SECRET` | ≥32 chars. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `CORS_ORIGINS` | Comma-separated. Exact origins — no wildcard. |
| `COOKIE_SECURE` | `true` in production |
| `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SOCKET_URL` | Inlined at build time. Leave unset unless the API is on a different origin than the web app. |
| `TURN_SERVER`, `TURN_SECRET`, `TURN_REALM` | See below |

`env.ts` validates everything with Zod at boot and **refuses to start** on a bad
config, listing exactly which variables are wrong. In production it also warns if
`COOKIE_SECURE` is false or TURN is unconfigured.

`scripts/ensure-env.mjs` never overwrites a value that is present and valid, so a
production `.env` is safe from it. It does replace a `JWT_SECRET` that is missing,
under 32 characters, or one of the placeholders that appear in this repository —
a secret published in source control is worse than no secret at all.

Values are **unquoted** before validation. A `.env` file writes `FOO="bar"` and
every parser strips those quotes, but a hosting panel does not: paste
`JWT_ACCESS_TTL="15m"` out of `.env.example` into one and the value is five
characters, quotes included. That produced HTTP 500 on register, login and
refresh — `jsonwebtoken` throws on a malformed `expiresIn`, and the throw is per
request, so the process starts fine and `/health/ready` still answers
`database: up`. `env.ts` now strips one layer of matching quotes from every
value, so the same text means the same thing in both places, and
`JWT_ACCESS_TTL` is checked against a timespan at boot rather than at the moment
someone tries to log in.

The CORS loopback exemption does **not** relax in production — it is
development-only (`isAllowedOrigin` in `apps/server/src/env.ts`).

`DATABASE_URL` must be a `file:` URL; anything else is rejected at boot with that
reason, so a leftover `mysql://…` fails in one clear line rather than deep inside
a Prisma engine error. A relative path is resolved by Prisma against
`apps/server/prisma/`, so **use an absolute path in production** — and make sure
the process user can write both the file and its directory, since WAL mode creates
`-wal` and `-shm` files alongside it.

Migrations are applied automatically: preflight (and the server container's
entrypoint) runs `prisma migrate deploy`, which only ever applies migrations
already committed to the repo. It never resets or drops anything.

`NEXT_PUBLIC_*` values are **inlined at build time**, so changing the API URL
means rebuilding the web app, not restarting it. `next.config.mjs` reads the
repo-root `.env` explicitly, because Next only auto-loads `.env` from its own
directory — without that, a root-level `NEXT_PUBLIC_API_URL` would be silently
ignored.

Unset is the right answer for every topology here, and the fallback is chosen by
build type: `http://localhost:4000` in a development build (where `npm run dev`
really does split the ports) and **same-origin relative URLs** in a production
build. Both Nginx and `scripts/serve.mjs` serve the app and API from one origin,
so relative is correct.

That fallback used to be `http://localhost:4000` in production too, and it caused
a live bug: a deploy with the variable unset shipped a bundle that sent every
visitor's browser to *its own machine*, which presents as "the server is down".
Neither `.env.example` nor `docker-compose.yml` carries a localhost default any
more, for the same reason.

---

## Single-port hosts (Railway, Render, Fly)

These platforms route **one port per service**, but Sonder is two processes. Left
alone, whichever process claimed `$PORT` won and the other was unreachable — the
public URL answered with API JSON instead of the app.

[`scripts/serve.mjs`](../scripts/serve.mjs) is the entry point for that shape, and
is what plain `npm start` runs. It binds `$PORT`, keeps both children on
loopback, and applies the same routing Nginx does:

```
Railway $PORT ──► scripts/serve.mjs ──┬── /api, /socket.io, /health ──► API  127.0.0.1:4000
                                      └── everything else ────────────► Next 127.0.0.1:3000
```

It also handles the HTTP **upgrade** to a WebSocket. That is not optional
polish: Socket.IO carries all messaging and call signalling, and an HTTP-only
proxy drops upgrades silently — pages would load while every message and call
failed.

[`railway.json`](../railway.json) sets the start command and points the health
check at `/health/ready`, so the deploy config lives in the repo rather than in a
dashboard nobody can diff.

### What to set in Railway

| Variable | Value | Why |
| --- | --- | --- |
| `JWT_SECRET` | 48 random bytes | Without it preflight generates one per boot, and every session dies on each deploy. |
| `DATABASE_URL` | `file:/data/sonder.db` | The volume path below. |
| `TURN_SERVER`, `TURN_SECRET` | your TURN service | Otherwise calls fail on most mobile networks. |
| `SEED_DEMO_DATA` | `true`, only if you want it | Production start does not seed. Setting this creates the twelve demo accounts whose password the login page publishes. |

And **add a volume**: Railway → service → Settings → Volumes, mount path `/data`.
Without it the container filesystem is ephemeral and every deploy resets all
accounts, messages and call history.

`CORS_ORIGINS` and `NEXT_PUBLIC_API_URL` are deliberately **not** in that list:

- `serve.mjs` adds the platform's public origin to `CORS_ORIGINS` itself, reading
  `RAILWAY_PUBLIC_DOMAIN` (or `PUBLIC_URL` elsewhere) and logging what it added.
  Anything you set is kept; the origin is only ever appended.
- `NEXT_PUBLIC_API_URL` unset means same-origin relative URLs in a production
  build, which is correct here. Set it only when the API is on a different host.

### The public origin is discovered, not configured

Browsers send `Origin` even on same-origin POSTs, so the API's allow-list has to
contain the public URL or every login is refused. `serve.mjs` reads it from
whichever variable the platform publishes:

| Variable | Platform | Shape |
| --- | --- | --- |
| `PUBLIC_URL` | any | full URL — the manual override |
| `RENDER_EXTERNAL_URL` | Render | full URL |
| `RENDER_EXTERNAL_HOSTNAME` | Render | hostname |
| `RAILWAY_PUBLIC_DOMAIN` | Railway | hostname |
| `HEROKU_APP_NAME` | Heroku | app name |
| `FLY_APP_NAME` | Fly.io | app name |

Anything set in `CORS_ORIGINS` is kept; a discovered origin is only ever
appended, and what was added is logged.

Only Railway's variable was read at first, on the assumption that everywhere else
could use `PUBLIC_URL`. A Render deploy then logged `CORS_ORIGINS is empty and no
public origin was discovered`, kept the allow-list at `http://localhost:3000`, and
answered **HTTP 500** on register, login and refresh while reporting itself live.
The same signal drives secure cookies, so `COOKIE_SECURE` was off at the same
time.

A refused origin now returns **403 `CORS_ORIGIN_NOT_ALLOWED`** naming the origin
and the variable. It used to be a bare `Error`, which the handler turned into
`500 Something went wrong on our end` — a configuration problem wearing the
costume of a crash, which is the hardest kind to find.

### Two proxies, not one

`trust proxy` is a hop count, and single-port hosting adds a hop: the platform
edge forwards to `serve.mjs`, which forwards to the API. Express trusts the last
N addresses in `X-Forwarded-For` and calls the next one the client, so a count
of 1 where there are 2 makes `req.ip` the *edge's* address:

```
client 203.0.113.9 -> railway edge 100.64.0.1 -> serve.mjs 127.0.0.1 -> api
  trust proxy = 1 -> req.ip = 100.64.0.1     every visitor, one bucket
  trust proxy = 2 -> req.ip = 203.0.113.9    correct
```

Undercounting does not fail, it just merges everyone into a single rate-limit
bucket, so `AUTH_RATE_LIMIT_MAX=20` silently becomes twenty logins per minute for
the whole site. `serve.mjs` sets `TRUST_PROXY_HOPS=2` when it detects an edge in
front of it and `env.ts` defaults to 1 for Nginx, so this needs setting by hand
only in an unusual topology.

Overcounting is the worse direction: a client can then forge `X-Forwarded-For`
and claim any address it likes. Do not raise it "just in case".

### A healthy log behind a 502

`Application failed to respond` (with `x-railway-fallback: true`) while the deploy
log shows both children up and the database open means the edge could not open a
TCP connection to the container at all. Nothing crashed — the edge is knocking on
a door nobody is behind. Two causes, and the log looks identical for both:

- **The domain's target port is not the port we bound.** Railway fixes a target
  port when the domain is created and does not follow later changes to `PORT`.
  Check service → Settings → Networking and make it the port the log reports.
  This is why `serve.mjs` now says whether `PORT` came from the platform or from
  its own default — the number alone cannot tell you.
- **An IPv4-only listener.** `listen(port, '0.0.0.0')` refuses IPv6 connections
  with `ECONNREFUSED` immediately, and platform-internal networks are frequently
  IPv6. `serve.mjs` passes no host, so Node binds `::` dual-stack and accepts
  both families. Do not narrow it back to `0.0.0.0`.

The timing separates these from a real fault: a 502 in well under a second is a
refused connection, and one that arrives at your `healthcheckTimeout` is a process
that is listening but not answering — a different problem, usually visible in the
logs.

### Do not set `NODE_ENV`

It is the one variable that breaks this deployment in two different ways, and
both failures point somewhere else entirely:

- **`NODE_ENV=development`** makes `next build` abort with
  `<Html> should not be imported outside of pages/_document` while prerendering
  the error page — an App Router project pointed at the Pages Router, for a file
  that does not exist. This is a real failure that happened on this project.
- **`NODE_ENV=production`** makes `npm install` omit devDependencies, and `tsc`,
  `next` and the Prisma CLI all live there, so the build fails for lack of tools.

Leave it unset. Every runtime sets the right value itself:
`scripts/next-web.mjs` forces `development` for `next dev` and `production` for
`next build`/`next start`, and `serve.mjs` starts the API with
`NODE_ENV=production`. Nothing is inherited from the host.

---

## Docker

There is no database service — SQLite means the database is a file on the
`sonder-data` volume, so `npm run dev` needs none of this.

```bash
# coturn only
docker compose -f docker/docker-compose.yml --profile turn up -d

# Everything behind Nginx
docker compose -f docker/docker-compose.yml --profile full up -d --build
```

Put certificates in `certs/fullchain.pem` and `certs/privkey.pem`; the Nginx
container mounts that directory read-only.

`Dockerfile.web` sets `BUILD_STANDALONE=true`, which is what makes `next build`
emit `.next/standalone` for the runtime stage to copy. It is opt-in because Next
refuses to serve a standalone build through `next start`, so leaving it on
unconditionally made a plain local `npm run build && npm start` print a warning
claiming the app was broken when it was not.

For a real certificate:

```bash
certbot certonly --webroot -w ./certbot -d sonder.example.com
cp /etc/letsencrypt/live/sonder.example.com/{fullchain,privkey}.pem certs/
```

For local HTTPS testing, [`mkcert`](https://github.com/FiloSottile/mkcert) is the
least painful option.

---

## Nginx

[`docker/nginx/sonder.conf`](../docker/nginx/sonder.conf) terminates TLS and puts
the web app and API on **one origin**, which also removes the cross-site cookie
problem — the refresh cookie can stay `SameSite=Lax`.

Three details there are load-bearing:

- **`/socket.io/` gets a 3600 s read timeout.** A quiet WebSocket on a silent
  call must not be reaped mid-conversation.
- **`X-Forwarded-For` is set by the proxy**, and the server sets
  `trust proxy` in production. Without both, every client looks like `127.0.0.1`
  and rate limiting becomes global.
- **`/worklets/` is `no-cache, must-revalidate`.** The AudioWorklet bundle is not
  content-hashed, so a stale DSP build would otherwise keep running after a
  deploy. `/_next/static/` is hashed and cached immutably.

---

## coturn

Without TURN, calls fail for peers behind symmetric NAT — a large share of mobile
networks.

The compose service uses **REST-API credentials** (`--use-auth-secret`): the
server mints short-lived HMAC usernames per user rather than handing out a static
password. `TURN_SECRET` must match on both sides.

Two things people get wrong:

1. **`--external-ip` must be the address peers can actually reach.** On a cloud
   host behind NAT, set `EXTERNAL_IP` to the public address or relaying silently
   fails.
2. **Open the ports.** 3478 TCP+UDP, 5349 TCP (TLS), and the UDP relay range
   (49160–49200 as configured). The service uses host networking because
   publishing thousands of UDP ports through the Docker proxy is slow and
   unreliable.

The config denies relaying to loopback, multicast and RFC1918 ranges. An open
relay is found and abused quickly.

Verify with the [Trickle ICE tool](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/):
paste your TURN URL and a credential pair, and confirm a `relay` candidate
appears. If only `host` and `srflx` appear, TURN is not working.

---

## Without Docker

```bash
npm ci
# set DATABASE_URL, JWT_SECRET, CORS_ORIGINS, COOKIE_SECURE, TURN_* in .env first
npm run build
npm run db:migrate:deploy
pm2 start ecosystem.config.cjs --env production
pm2 save && pm2 startup
```

`npm run build` runs preflight with `--no-seed`, so it will compile the shared
package and the worklet and check the database is reachable, but never insert
demo content into a production database.

**The API runs as a single `fork` process, and that is deliberate.** Presence and
the call registry are in-process maps, so a second instance would have its own
copy: users on different workers would see each other as permanently offline and
could never connect a call. The reasoning is written into
`ecosystem.config.cjs` so nobody "optimises" it later by switching to cluster
mode.

The Next.js app has no such state and runs clustered.

### Scaling past one API instance

In order:

1. Presence → Redis (per-user socket-count set).
2. Call registry → Redis, including its ring/reconnect timers.
3. Socket.IO Redis adapter, so `io.to(room)` crosses instances.
4. `rate-limit-redis` instead of the in-memory store.
5. **The database off SQLite**, since a file cannot be shared between hosts.
   Switch `provider` in the schema, regenerate the migration for that dialect,
   and re-add native types. Application code is unaffected — it avoids Prisma
   enum types and provider-specific query options for exactly this reason.
   See [database.md](database.md#when-to-move-off-it).

Until all five are done, keep one instance and scale vertically. Note the order:
items 1–4 bite long before the database does.

---

## Health checks

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. Process is up. |
| `GET /health/ready` | Readiness. Runs `SELECT 1`; reports database and TURN status. 503 when the database is unreachable. |

Point your load balancer at `/health/ready`, not `/health` — a process that is up
but cannot open its database should not receive traffic.

---

## Production checklist

- [ ] `DATABASE_URL` is an **absolute** `file:` path on persistent storage, not `file:./dev.db`
- [ ] `JWT_SECRET` is random and ≥32 chars, and not the example value
- [ ] `COOKIE_SECURE=true`, real TLS certificate installed
- [ ] `CORS_ORIGINS` lists exact origins, no wildcards
- [ ] The database file and its directory are writable by the service user, and not inside the deployed checkout
- [ ] `TURN_SERVER` + `TURN_SECRET` set and verified with Trickle ICE
- [ ] `EXTERNAL_IP` on coturn is the public address
- [ ] Firewall opens 80/443 plus the TURN ports
- [ ] The public domain's target port matches the port in the `listening on …` log line
- [ ] `prisma migrate deploy` runs before traffic is served
- [ ] Backups scheduled with `sqlite3 .backup` (or Litestream) and a restore tested
- [ ] Logs shipped somewhere (production output is single-line JSON)
- [ ] `/health/ready` wired to the load balancer
- [ ] `SMOKE_API_URL=https://… npm run smoke -- --api-only` passes against it
