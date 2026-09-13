import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { env, hasTurn, isAllowedOrigin, isProd } from './env.js';
import { AppError } from './lib/errors.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { generalLimiter } from './middleware/rate-limit.js';
import { authRouter } from './modules/auth/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { messagingRouter } from './modules/messaging/routes.js';
import { callsRouter } from './modules/calls/routes.js';
import { socialRouter } from './modules/social/routes.js';
import { prisma } from './db.js';

export function createApp(): Express {
  const app = express();

  // Behind a proxy, req.ip must come from X-Forwarded-For or every client looks
  // like 127.0.0.1 and rate limiting becomes global. The count matters: this was
  // a hard-coded 1 while single-port hosting put two proxies in front (the
  // platform edge, then scripts/serve.mjs), so req.ip was the edge's address and
  // every visitor shared one rate-limit bucket. See TRUST_PROXY_HOPS in env.ts.
  app.set('trust proxy', isProd ? env.TRUST_PROXY_HOPS : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON only; CSP belongs on the Next.js side, where the
      // documents actually are.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin / curl / server-to-server requests have no Origin header.
        if (!origin) return callback(null, true);
        if (isAllowedOrigin(origin)) return callback(null, true);
        // A plain Error here became HTTP 500 "Something went wrong on our end",
        // which is how a misconfigured allow-list came to look like a crashing
        // server: the deploy was fine, the origin simply was not on the list.
        // Say which origin and which variable, with a status that means "your
        // request was refused" rather than "we fell over".
        callback(
          new AppError(
            403,
            'CORS_ORIGIN_NOT_ALLOWED',
            `Origin ${origin} is not in CORS_ORIGINS. Add it, or set PUBLIC_URL to the address browsers use.`,
          ),
        );
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use('/api', generalLimiter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  /** Deep health check: verifies the database is actually reachable. */
  app.get('/health/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', database: 'up', turn: hasTurn ? 'configured' : 'absent' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api', messagingRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api/social', socialRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
