#!/usr/bin/env node
/**
 * Serves the whole app on ONE port.
 *
 * WHY THIS EXISTS
 * Sonder is two processes — the Express/Socket.IO API and the Next web app — and
 * `npm start` binds them to two ports. That is fine behind Nginx (see
 * docker/nginx/sonder.conf) but not on a platform that routes exactly one port
 * per service, like Railway, Render or Fly. There, whichever process claimed
 * $PORT won and the other was simply unreachable: the public URL answered with
 * API JSON instead of the app.
 *
 * So this binds $PORT itself, keeps both children on loopback, and routes:
 *
 *      Railway $PORT
 *            │
 *      ┌─────▼───────────┐
 *      │   this script   │
 *      └──┬───────────┬──┘
 *   /api  │           │  everything else
 *  /socket.io         │  (pages, /_next, /media)
 *  /health            │
 *         ▼           ▼
 *     API :auto    Next :auto       ← 127.0.0.1 only, never exposed
 *
 * It is the same split Nginx does, so there is one routing rule to reason about
 * rather than two that can drift.
 *
 * A side benefit that matters: everything is same-origin, so there is no CORS
 * preflight and the refresh cookie can stay SameSite=Lax.
 *
 * THE PART THAT IS EASY TO GET WRONG
 * Socket.IO upgrades to a WebSocket, and an HTTP-only proxy drops that silently
 * — messaging and every call would fail while pages loaded fine. The 'upgrade'
 * handler below replays the handshake over a raw socket and pipes both
 * directions, which is what makes signalling work.
 *
 *   node scripts/serve.mjs [--skip-preflight]
 */
import { spawn } from 'node:child_process';
import { connect, createServer as createProbeServer } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvIntoProcess } from './ensure-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const PUBLIC_PORT = Number(process.env.PORT ?? 8080);
const HOST = '127.0.0.1';

/** Prefixes that belong to the API. Everything else is the web app's. */
const API_PREFIXES = ['/api', '/socket.io', '/health'];

const log = (message) => console.log(`[serve] ${message}`);
const fail = (message) => console.error(`[serve] ${message}`);

const children = [];
let shuttingDown = false;

function spawnChild(name, argv, env) {
  const child = spawn(process.execPath, argv, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  children.push({ name, child });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    // One half of the app dying means the app is down. Exit so the platform
    // restarts the container rather than leaving half of it serving errors.
    fail(`${name} exited (${signal ?? `code ${code}`}); shutting down`);
    // Always non-zero, whatever the child's own code was. A restart policy of
    // ON_FAILURE reads exit 0 as "it meant to stop" and leaves the container
    // down permanently, so a child that exits 0 unexpectedly would turn one
    // uncaught exception into an outage that never recovers.
    shutdown(code === 0 || code === null || code === undefined ? 1 : code);
  });
  child.on('error', (error) => {
    fail(`${name} failed to start: ${error.message}`);
    shutdown(1);
  });
  return child;
}

/**
 * How long children get to finish in-flight work before being killed outright.
 * Railway sends SIGTERM and then SIGKILLs after its own grace period, so this
 * stays comfortably inside that.
 */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 8000);

/** Assigned once the public server exists; null before that. */
let publicServer = null;

/**
 * Drain rather than guillotine.
 *
 * The first version sent SIGTERM and called process.exit after a flat 400 ms,
 * which is not enough for a request to finish or for the API to close the
 * database, and on a redeploy that lands on anyone mid-call. Now: stop accepting
 * new connections, signal the children, and actually wait for them to exit —
 * falling back to SIGKILL only if they overstay the grace period.
 */
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;

  // Stop accepting new connections first, so the platform's edge sees this
  // instance go away instead of handing it requests it is about to drop.
  publicServer?.close();

  const alive = children.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  const exits = alive.map(
    ({ child }) => new Promise((resolveExit) => child.once('exit', resolveExit)),
  );
  for (const { child } of alive) child.kill('SIGTERM');

  let timer;
  await Promise.race([
    Promise.all(exits),
    new Promise((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, SHUTDOWN_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);

  for (const { name, child } of alive) {
    if (child.exitCode === null && child.signalCode === null) {
      fail(`${name} did not exit within ${SHUTDOWN_GRACE_MS}ms; killing`);
      child.kill('SIGKILL');
    }
  }
  process.exit(code);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal} received`);
    shutdown(0);
  });
}

/* -- 1. Bring the checkout up to date ------------------------------------- */
/* Self-sufficient on purpose: `node scripts/serve.mjs` is a complete start
 * command, so a platform's start hook does not also have to remember preflight. */

if (!process.argv.includes('--skip-preflight')) {
  await new Promise((resolvePreflight) => {
    /*
     * --no-seed unless asked, because this is the production entry point.
     *
     * preflight seeds when the user table is empty, and `npm run build` already
     * passes --no-seed while this path did not — so a production boot on an empty
     * database created twelve demo accounts whose password the login page
     * publishes. That is fine for the demo it was written for and wrong as a
     * default for somebody's deployment, so it is now a choice: set
     * SEED_DEMO_DATA=true to get the populated demo.
     */
    const seedDemoData = process.env.SEED_DEMO_DATA === 'true' || process.env.SEED_DEMO_DATA === '1';
    if (seedDemoData) log('SEED_DEMO_DATA is set: an empty database will get the demo accounts');
    const preflightArgs = [resolve(here, 'preflight.mjs'), '--quiet'];
    if (!seedDemoData) preflightArgs.push('--no-seed');
    const child = spawn(process.execPath, preflightArgs, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        fail('preflight failed; not starting');
        process.exit(code ?? 1);
      }
      resolvePreflight();
    });
  });
}

/*
 * Read .env into this process, now that preflight has guaranteed it exists.
 *
 * This script used to see only the real environment, so every check it makes
 * about configuration was blind to the file the app actually runs on — the
 * relative-DATABASE_URL warning below read an empty string and could never fire.
 * Values already in the environment always win, so a platform's variables still
 * outrank the file, and the children load the same file themselves regardless.
 */
loadEnvIntoProcess();

/* -- 2. Choose loopback ports that cannot collide with the public one ------ */

/**
 * Pick the children's ports at runtime instead of hard-coding them.
 *
 * This exists because hard-coding them broke a deploy. The internal default for
 * the API was 4000 — the same number this project documents for the API — and
 * the platform set `PORT=4000` too. The proxy bound 0.0.0.0:4000, handed the API
 * child 127.0.0.1:4000, and the child died with EADDRINUSE on a restart loop.
 * 0.0.0.0 covers loopback, so "public port" and "internal port" can never be the
 * same number, and *any* fixed default is one unlucky $PORT away from collision.
 *
 * So: prefer the conventional port, but treat it as a hint. If it is the public
 * port or already in use, ask the OS for a free one. The chosen ports are logged,
 * because "the API is on some port I picked" is only acceptable if you can see
 * which.
 */
function probePort(port) {
  return new Promise((resolveProbe) => {
    const probe = createProbeServer();
    probe.once('error', () => resolveProbe(null));
    probe.once('listening', () => {
      const { port: actual } = probe.address();
      probe.close(() => resolveProbe(actual));
    });
    probe.listen(port, HOST);
  });
}

async function pickPort(name, preferred, taken) {
  if (preferred && !taken.has(preferred)) {
    const got = await probePort(preferred);
    if (got) return got;
    log(`${name}: port ${preferred} is busy, asking the OS for another`);
  } else if (preferred) {
    log(`${name}: port ${preferred} is the public port, asking the OS for another`);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const got = await probePort(0);
    if (got && !taken.has(got)) return got;
  }
  fail(`could not find a free loopback port for ${name}`);
  process.exit(1);
}

const taken = new Set([PUBLIC_PORT]);
const API_PORT = await pickPort('api', Number(process.env.API_INTERNAL_PORT ?? 4000), taken);
taken.add(API_PORT);
const WEB_PORT = await pickPort('web', Number(process.env.WEB_INTERNAL_PORT ?? 3000), taken);
taken.add(WEB_PORT);

/* -- 3. Start both children on loopback ----------------------------------- */

/**
 * Teach the API which public origin it is behind.
 *
 * Same-origin is not a free pass: browsers still send `Origin` on same-origin
 * POSTs, so the API's allow-list has to contain the public URL or every login
 * is rejected as a CORS failure — and the dev-only loopback exemption is off in
 * production, which is correct and means this cannot be papered over.
 *
 * Rather than making that one more variable to get right, derive it from what
 * the platform already provides and log the result. Explicit beats magic, so an
 * origin only ever gets *added*; anything set in CORS_ORIGINS is kept.
 */
/**
 * Every platform announces its public address under a different name, and in a
 * different shape: some a whole URL, some a bare hostname, some only an app name.
 *
 * This read Railway's variable and nothing else, assuming anywhere else could use
 * PUBLIC_URL. That assumption cost a deploy. On Render the log said
 * "CORS_ORIGINS is empty and no public origin was discovered", the allow-list
 * stayed at http://localhost:3000, and the browser's real Origin was refused, so
 * register, login and refresh all answered HTTP 500 while the service reported
 * itself live. The same signal decides secure cookies, so the refresh cookie lost
 * its Secure flag at the same moment.
 *
 * Add a platform by adding a row. PUBLIC_URL stays first, as the manual override.
 */
const PUBLIC_ORIGIN_VARS = [
  'PUBLIC_URL', // manual override, any host
  'RENDER_EXTERNAL_URL', // Render, full URL
  'RENDER_EXTERNAL_HOSTNAME', // Render, hostname only
  'RAILWAY_PUBLIC_DOMAIN', // Railway, hostname only
  'HEROKU_APP_NAME', // Heroku, app name only
  'FLY_APP_NAME', // Fly.io, app name only
];

/** Hosts that publish an app name rather than an address. */
const APP_NAME_DOMAINS = { HEROKU_APP_NAME: 'herokuapp.com', FLY_APP_NAME: 'fly.dev' };

function toOrigin(name, rawValue) {
  let value = rawValue.trim();
  while (value.endsWith('/')) value = value.slice(0, -1);
  if (!value) return null;
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  const domain = APP_NAME_DOMAINS[name];
  return domain ? `https://${value}.${domain}` : `https://${value}`;
}

function publicOrigins() {
  const found = [];
  for (const name of PUBLIC_ORIGIN_VARS) {
    const value = process.env[name];
    if (!value) continue;
    const origin = toOrigin(name, value);
    if (origin && !found.includes(origin)) found.push(origin);
  }
  return found;
}

const configuredOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const platformOrigins = publicOrigins();
const discovered = platformOrigins.filter((origin) => !configuredOrigins.includes(origin));
const corsOrigins = [...configuredOrigins, ...discovered];

if (discovered.length > 0) {
  log(`added public origin(s) to CORS_ORIGINS: ${discovered.join(', ')}`);
} else if (configuredOrigins.length > 0) {
  log(`CORS_ORIGINS: ${configuredOrigins.join(', ')}`);
} else {
  fail('CORS_ORIGINS is empty and no public origin was discovered.');
  fail('Set CORS_ORIGINS (or PUBLIC_URL) to the address browsers use, or logins will fail.');
}

/*
 * NODE_ENV=production is forced here rather than asked of the host, because
 * setting it as a platform variable breaks the build instead: `npm install` then
 * omits devDependencies, and tsc, next and the Prisma CLI all live there. This
 * script *is* the production entry point, so it can simply assert it — the API
 * gets secure cookies and `trust proxy` (needed for per-client rate limiting
 * behind the platform's edge) without anyone configuring NODE_ENV anywhere.
 */
/*
 * Secure cookies, when we can prove we are behind TLS.
 *
 * The platform terminates HTTPS at its edge and forwards plain HTTP to us, so the
 * API sees an insecure connection and left the refresh cookie without `Secure` —
 * it logged "COOKIE_SECURE=false in production" and meant it. The browser's
 * connection *is* HTTPS, so the flag belongs on.
 *
 * Gated on having discovered a public origin rather than set unconditionally:
 * that is the signal that a platform edge is in front of us. Running this script
 * on plain HTTP locally therefore changes nothing. An explicit COOKIE_SECURE
 * always wins.
 */
// Every origin the platform announced, not just the ones missing from
// CORS_ORIGINS: listing the public origin by hand must not quietly switch secure
// cookies back off. https specifically, since that is the claim being made.
const behindTlsEdge = platformOrigins.some((origin) => origin.startsWith('https://'));
const cookieSecure = process.env.COOKIE_SECURE ?? (behindTlsEdge ? 'true' : undefined);
if (behindTlsEdge && process.env.COOKIE_SECURE === undefined) {
  log('behind a TLS edge: setting COOKIE_SECURE=true');
} else if (behindTlsEdge && cookieSecure !== 'true' && cookieSecure !== '1') {
  // Deliberately not overridden — an explicit setting is respected. But say so,
  // because the usual cause is COOKIE_SECURE=false copied out of .env.example.
  fail(`COOKIE_SECURE=${cookieSecure} but this is served over HTTPS.`);
  fail('Remove COOKIE_SECURE from your host variables to let it default to true.');
}

/*
 * On a platform, a relative SQLite path is data you are going to lose.
 *
 * `file:./dev.db` resolves against apps/server/prisma/ — inside the container
 * image. Everything works: preflight reports the database up to date,
 * /health/ready answers database:up, the healthcheck passes. And every deploy
 * and every restart begins again from the empty file baked into the build,
 * taking all accounts, messages and call history with it. Nothing anywhere
 * fails, which is precisely why this has to be said out loud.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
if (behindTlsEdge && databaseUrl.startsWith('file:') && !databaseUrl.slice('file:'.length).startsWith('/')) {
  fail(`DATABASE_URL is a relative path (${databaseUrl}), so the database lives inside`);
  fail('the container. Every deploy and every restart erases all accounts, messages');
  fail('and call history, with no error anywhere. Mount a volume and point');
  fail('DATABASE_URL at it, e.g. file:/data/sonder.db.');
}

spawnChild('api', [resolve(repoRoot, 'apps/server/dist/index.js')], {
  NODE_ENV: 'production',
  PORT: String(API_PORT),
  HOST,
  // Two proxies when a platform edge fronts this script, one when it stands
  // alone. Undercounting makes req.ip the nearest proxy, which quietly turns
  // per-client rate limiting into a single site-wide bucket.
  TRUST_PROXY_HOPS: String(process.env.TRUST_PROXY_HOPS ?? (behindTlsEdge ? 2 : 1)),
  ...(corsOrigins.length > 0 ? { CORS_ORIGINS: corsOrigins.join(',') } : {}),
  ...(cookieSecure !== undefined ? { COOKIE_SECURE: cookieSecure } : {}),
});

// next-web.mjs forces NODE_ENV=production for `start` itself.
spawnChild('web', [resolve(here, 'next-web.mjs'), 'start', '-H', HOST], {
  WEB_PORT: String(WEB_PORT),
});

/* -- 4. Proxy ------------------------------------------------------------- */

const targetFor = (url) =>
  API_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`))
    ? { port: API_PORT, name: 'api' }
    : { port: WEB_PORT, name: 'web' };

/**
 * Standard proxy hygiene. `x-forwarded-for` must be *appended* to, not replaced:
 * the server runs with Express `trust proxy: 1`, which walks the list from the
 * right and skips one hop — so appending the address we received from is what
 * makes `req.ip` the real client, and rate limiting per-client instead of global.
 */
function forwardedHeaders(req) {
  const existing = req.headers['x-forwarded-for'];
  const hop = req.socket.remoteAddress ?? '';
  return {
    ...req.headers,
    'x-forwarded-for': [existing, hop].filter(Boolean).join(', '),
    'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'http',
    'x-forwarded-host': req.headers['x-forwarded-host'] ?? req.headers.host ?? '',
  };
}

const server = createServer((req, res) => {
  const target = targetFor(req.url ?? '/');

  // A client that vanishes mid-exchange must not be able to take the whole
  // container down with it. pipe() forwards data but never 'error', and an
  // 'error' event with no listener is an uncaught exception, so every stream in
  // the chain gets one. Aborts are ordinary traffic - a reload, a closed tab, an
  // edge giving up - and which of these streams surfaces one differs between
  // Node versions, which on a platform is not a version we choose.
  req.on('error', () => res.destroy());
  res.on('error', () => req.destroy());

  const upstream = httpRequest(
    { host: HOST, port: target.port, method: req.method, path: req.url, headers: forwardedHeaders(req) },
    (upstreamRes) => {
      upstreamRes.on('error', () => res.destroy());
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    // ECONNREFUSED here almost always means a child is still booting. Say which
    // one, because "502" alone sends people looking in the wrong process.
    // Nothing to report if the response is already gone: ending it a second
    // time is itself an error event.
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '2' });
    }
    res.end(`${target.name} is not ready yet (${error.code ?? error.message})\n`);
  });

  req.pipe(upstream);
});

/* WebSocket upgrades — Socket.IO, and therefore all messaging and call
 * signalling, depend entirely on this path. */
server.on('upgrade', (req, clientSocket, head) => {
  const target = targetFor(req.url ?? '/');
  const upstream = connect(target.port, HOST, () => {
    const headers = forwardedHeaders(req);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        if (one !== undefined) lines.push(`${key}: ${one}`);
      }
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const drop = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on('error', drop);
  clientSocket.on('error', drop);
});

// Expose it to shutdown() so draining can stop accepting connections.
publicServer = server;

/*
 * No host argument, on purpose.
 *
 * Node then binds `::` dual-stack and accepts IPv6 *and* IPv4-mapped
 * connections, falling back to 0.0.0.0 by itself where IPv6 is unavailable.
 *
 * This was an explicit '0.0.0.0', which is IPv4-only, and several platforms
 * (Railway among them) carry internal traffic over IPv6. An IPv4-only listener
 * refuses the edge's connection immediately, and the symptom is a container that
 * booted perfectly sitting behind a 502 "Application failed to respond" — it
 * reads as a crash and is not one. Binding both is strictly more permissive and
 * costs nothing, so there is no reason to narrow it.
 */
server.listen(PUBLIC_PORT, () => {
  const { address, family } = server.address();
  const shown = family === 'IPv6' ? `[${address}]` : address;
  log(`listening on ${shown}:${PUBLIC_PORT} (${family}${family === 'IPv6' ? ' dual-stack, IPv4 included' : ''})`);
  log(`  ${API_PREFIXES.join(', ')} -> api  ${HOST}:${API_PORT}`);
  log(`  everything else          -> web  ${HOST}:${WEB_PORT}`);
  if (process.env.PORT === undefined) {
    log(`PORT is unset, so this is the built-in default (${PUBLIC_PORT}).`);
    log('If a platform edge fronts this, the port it forwards to must be that number.');
    log('A mismatch answers every request with 502 "Application failed to respond"');
    log('while these logs look completely healthy.');
  }
});

server.on('error', (error) => {
  fail(`cannot bind ${PUBLIC_PORT}: ${error.message}`);
  shutdown(1);
});
