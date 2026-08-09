import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { hashPassword } from '../lib/passwords.js';
import { TIERS } from '../lib/permissionSet.js';
import { consumeSetupToken, isBootstrapped, verifySetupToken } from '../lib/settings.js';
import { startSession } from '../middleware/session.js';

export const setupRouter = Router();

const SETUP_COOKIE = 'quorum_setup';

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;

/**
 * Reports whether setup is needed, for the frontend to route on.
 *
 * Setup is complete once a super administrator exists; connecting Discord is a
 * plugin concern and no longer blocks the app.
 */
setupRouter.get('/state', async (req, res, next) => {
  try {
    res.json({
      configured: await isBootstrapped(),
      canManage: Boolean(req.user?.isSuperAdmin),
    });
  } catch (error) {
    next(error);
  }
});

/** Exchanges a setup token for a short-lived setup session. */
setupRouter.post('/token', async (req, res, next) => {
  try {
    const token = await verifySetupToken(req.body?.token);
    if (!token) return res.status(403).json({ error: 'That setup link is invalid or expired.' });

    res.cookie(SETUP_COOKIE, String(req.body.token), {
      httpOnly: true,
      secure: config.publicUrl.startsWith('https://'),
      sameSite: 'lax',
      maxAge: 60 * 60 * 1000,
      path: '/',
    });

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Creates the first super administrator from the one-time setup token.
 *
 * The token is consumed atomically, so the account can only ever be minted
 * once, and the new admin is signed in on the spot.
 */
setupRouter.post('/bootstrap', async (req, res, next) => {
  try {
    if (await isBootstrapped()) {
      return res.status(409).json({ error: 'An administrator already exists.' });
    }

    const token = await verifySetupToken(req.cookies?.[SETUP_COOKIE] ?? req.body?.token);
    if (!token) return res.status(403).json({ error: 'That setup link is invalid or expired.' });

    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!USERNAME_PATTERN.test(username)) {
      return res.status(400).json({
        error: 'Usernames are 3-32 characters: letters, numbers, dots, dashes, underscores.',
      });
    }
    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: 'Passwords need at least 8 characters.' });
    }

    if (!(await consumeSetupToken(token.id))) {
      return res.status(403).json({ error: 'That setup link is invalid or expired.' });
    }

    const { rows } = await query(
      `INSERT INTO users (username, password_hash, tier, last_login_at)
       VALUES ($1, $2, $3, now()) RETURNING id, username`,
      [username, await hashPassword(password), TIERS.SUPER],
    );

    await query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id)
       VALUES ($1, 'setup.bootstrap', 'user', $2)`,
      [rows[0].id, rows[0].id],
    );

    res.clearCookie(SETUP_COOKIE, { path: '/' });
    await startSession(res, { id: rows[0].id }, []);
    return res.status(201).json({ ok: true, username: rows[0].username });
  } catch (error) {
    return next(error);
  }
});

export { SETUP_COOKIE };
