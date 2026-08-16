import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { config } from './config.js';
import { warmGeo } from './lib/geo.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { setupRouter } from './routes/setup.js';
import { surveyRouter } from './routes/surveys.js';
import { discordAdminRouter, discordAuthRouter } from './plugins/discord/routes.js';
import { twofactorAdminRouter, twofactorAuthRouter } from './plugins/twofactor/routes.js';
import { loadSession } from './middleware/session.js';
import { ensureSetupTokenIfNeeded, loadSettings, current } from './lib/settings.js';
import { startScheduler } from './lib/scheduler.js';
import { VERSION, GIT_SHA, BUILD_TIME, REPO } from './lib/version.js';
import { attestationStatus } from './lib/attestation.js';
import { classifyPlugins } from './lib/plugins.js';

const app = express();

// nginx terminates TLS and sets X-Forwarded-*; without this Express reports
// every client as the proxy and secure cookies are refused.
app.set('trust proxy', config.trustProxyHops);
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION, commit: GIT_SHA }));
app.get('/api/version', (_req, res) =>
  res.json({ version: VERSION, commit: GIT_SHA, buildTime: BUILD_TIME, repo: REPO }),
);

// Public build-verification status: whether the running image's provenance is
// signed, plus which plugins are active. Enabled plugins are reported so the
// page can disclose any custom (unlisted) one; they never change the verdict.
app.get('/api/attestation', async (req, res) => {
  const status = await attestationStatus(req.query.refresh === '1');
  let plugins = { official: [], custom: [] };
  try {
    plugins = classifyPlugins(current().plugins);
  } catch {
    // Settings not loaded yet (pre-boot request); report no plugins.
  }
  res.json({ ...status, plugins });
});

app.use(
  '/api/auth',
  rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }),
);

app.use(loadSession());

app.use('/api/auth', authRouter);
// Auth plugins hang their sign-in routes under the same rate-limited prefix:
// the twofactor challenge at /api/auth/2fa, Discord OAuth at /api/auth/discord.
app.use('/api/auth', twofactorAuthRouter);
app.use('/api/auth/discord', discordAuthRouter);
app.use(
  '/api/plugin/discord',
  rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }),
  discordAdminRouter,
);
app.use(
  '/api/plugin/twofactor',
  rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }),
  twofactorAdminRouter,
);
app.use(
  '/api/setup',
  rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }),
  setupRouter,
);
app.use(
  '/api/surveys',
  rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false }),
  surveyRouter,
);
app.use(
  '/api/admin',
  // Admin actions are authenticated, but some are expensive (exports, the
  // Discord refresh), so a ceiling caps authenticated abuse.
  rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }),
  adminRouter,
);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// Error details are logged but never returned; a stack trace in a response
// body is a gift to anyone probing the deployment.
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Something went wrong.' });
});

/**
 * Applies pending migrations, then starts listening.
 *
 * Migrating in-process keeps a single-command deploy honest: the container
 * cannot serve traffic against a schema it has not caught up to.
 *
 * @returns {Promise<void>}
 */
async function start() {
  await migrate();

  // Settings are cached in-process, so they must be loaded before any request
  // can reach a route that reads Discord credentials.
  await loadSettings();
  await ensureSetupTokenIfNeeded();

  // Compile the country ranges in the background so the first response of
  // the day is not the one that pays for it.
  warmGeo();

  const server = app.listen(config.port, () => {
    console.log(`Quorum API listening on :${config.port}`);
  });

  // Fires time-based plugin work (survey close reminders) on a timer.
  const scheduler = startScheduler();
  server.on('close', () => clearInterval(scheduler));

  /**
   * Drains connections and closes the pool on shutdown.
   *
   * @param {string} signal Signal that triggered the shutdown.
   */
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down.`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});

export { app };
