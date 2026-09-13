import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/* Load .env before anything reads process.env. Package-local first so a
 * developer can shadow a single value, then the shared repo-root file. */
const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '../..');

for (const file of [resolve(serverRoot, '.env'), resolve(repoRoot, '.env')]) {
  if (existsSync(file)) dotenv.config({ path: file });
}

const csv = (fallback: string[] = []) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : fallback,
    );

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),

  /**
   * How many proxies sit in front of this process, for Express `trust proxy`.
   *
   * This is a count, not a switch, and getting it wrong silently disables
   * per-client rate limiting. Express trusts the last N addresses in
   * X-Forwarded-For and calls the next one the client, so with one hop too few
   * `req.ip` is the nearest proxy: every visitor shares a single bucket and
   * AUTH_RATE_LIMIT_MAX becomes a site-wide limit, which looks like a working
   * app until traffic arrives.
   *
   *   1  one proxy, the default: Nginx, or serve.mjs on its own.
   *   2  two: a platform edge in front of serve.mjs. scripts/serve.mjs sets
   *      this itself when it detects one, so nobody has to count.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  /**
   * A SQLite connection string: `file:` plus a path, resolved by Prisma relative
   * to prisma/schema.prisma. Rejecting other schemes here turns a leftover
   * `mysql://…` URL into one clear line at boot rather than a Prisma engine
   * error later, which is the kind of thing people lose an evening to.
   */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((value) => value.startsWith('file:'), {
      message:
        'DATABASE_URL must be a SQLite path, e.g. file:./dev.db — Sonder uses ' +
        'SQLite (see docs/database.md)',
    }),

  CORS_ORIGINS: csv(['http://localhost:3000']),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'),
  /**
   * A timespan, checked here because it is passed straight to jsonwebtoken.
   *
   * z.string() accepted anything, and jwt.sign() throws on a malformed value —
   * so a typo did not fail at boot, it threw on every token issued: HTTP 500 on
   * register, login and refresh, while /health/ready still answered
   * "database: up" and the deploy looked healthy.
   */
  JWT_ACCESS_TTL: z
    .string()
    .regex(
      /^\d+(\.\d+)?\s*(ms|s|m|h|d|w|y)?$/i,
      'JWT_ACCESS_TTL must be a timespan such as 15m, 2h or 900 (seconds).',
    )
    .default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_DOMAIN: z.string().optional().transform((v) => (v ? v : undefined)),
  COOKIE_SECURE: bool(false),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),

  STUN_SERVERS: csv([
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
  ]),
  TURN_SERVER: z.string().optional().transform((v) => (v ? v : undefined)),
  TURN_USERNAME: z.string().optional().transform((v) => (v ? v : undefined)),
  TURN_PASSWORD: z.string().optional().transform((v) => (v ? v : undefined)),
  TURN_SECRET: z.string().optional().transform((v) => (v ? v : undefined)),
  TURN_CREDENTIAL_TTL: z.coerce.number().int().min(60).default(86_400),
  TURN_REALM: z.string().default('sonder.local'),

  // Floors are deliberately low: the schema's job is to catch typos, not to
  // enforce product policy, and the test suite runs with sub-second timeouts.
  CALL_RING_TIMEOUT_MS: z.coerce.number().int().min(500).default(45_000),
  CALL_RECONNECT_GRACE_MS: z.coerce.number().int().min(500).default(30_000),
});

/**
 * Strip one layer of matching surrounding quotes from every value.
 *
 * Every .env parser removes the quotes in FOO="bar"; a hosting platform's
 * variables panel does not. Paste JWT_ACCESS_TTL="15m" out of .env.example into
 * one and the value is literally five characters, quotes included — so the same
 * text means two different things depending on where it was pasted. That is not
 * a mistake anyone can see: it looks correct in the panel, and it surfaced as
 * HTTP 500 on every login with a healthy-looking deploy.
 *
 * Rather than police the file, make both spellings mean the same thing. A value
 * whose first and last characters are the same quote loses them; anything else
 * is passed through untouched.
 */
function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && last === first) return value.slice(1, -1);
  return value;
}

const rawEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) rawEnv[key] = unquote(value);
}

const parsed = envSchema.safeParse(rawEnv);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(
    `\nInvalid environment configuration:\n${issues}\n\n` +
      `Copy .env.example to .env at the repo root and fill in the required values.\n`,
  );
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Origin allow-list, with a development-only loopback exemption.
 *
 * In development the web app can legitimately land on a port other than 3000 —
 * `WEB_PORT` is set, or Next picks the next free port because something else
 * holds 3000 — and making that require a CORS_ORIGINS edit is friction with no
 * security value: an attacker cannot serve from the victim's own loopback.
 *
 * In production the exemption is off and only the configured origins pass. No
 * wildcards, and nothing is inferred from the request's own headers.
 */
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

export function isAllowedOrigin(origin: string): boolean {
  if (env.CORS_ORIGINS.includes(origin)) return true;
  return !isProd && LOOPBACK_ORIGIN.test(origin);
}

/** A TURN relay is what makes calls work on symmetric NAT and mobile data. */
export const hasTurn = Boolean(
  env.TURN_SERVER && (env.TURN_SECRET || (env.TURN_USERNAME && env.TURN_PASSWORD)),
);

if (isProd) {
  if (!env.COOKIE_SECURE) {
    console.warn(
      '[env] COOKIE_SECURE=false in production. Refresh cookies will be sent over plain HTTP.',
    );
  }
  if (!hasTurn) {
    console.warn(
      '[env] No TURN server configured. Calls will fail for peers behind ' +
        'symmetric NAT (a large share of mobile networks). Set TURN_SERVER + TURN_SECRET.',
    );
  }
}
