import { Router } from 'express';
import { query } from '../../db/pool.js';
import { open, seal } from '../../lib/secretbox.js';
import { current } from '../../lib/settings.js';
import { PLUGINS, isPluginEnabled } from '../../lib/plugins.js';
import { TIERS } from '../../lib/permissionSet.js';
import { requireAdmin, requirePanel, startSession } from '../../middleware/session.js';
import { guildMember } from '../discord/discord.js';
import { base32Encode, otpauthUri, verifyTotp } from './totp.js';
import {
  challengeRequired,
  clearChallenge,
  newSecret,
  readChallenge,
  twofactorEnabled,
} from './twofactor.js';

/**
 * Records an admin action for the audit trail.
 *
 * @param {string} actorId User id of the acting admin.
 * @param {string} action Action name.
 * @param {string} targetType Entity type acted on.
 * @param {string} targetId Entity id.
 * @param {object} meta Extra detail worth keeping.
 * @returns {Promise<void>}
 */
async function audit(actorId, action, targetType, targetId, meta = {}) {
  await query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, action, targetType, targetId, meta],
  );
}

/**
 * Loads the full user row for id, or null.
 *
 * @param {string} userId
 * @returns {Promise<object|null>} The users row.
 */
async function loadUser(userId) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Login challenge, mounted at /api/auth
// ---------------------------------------------------------------------------

export const twofactorAuthRouter = Router();

/**
 * Describes the pending challenge so the code page knows what to render.
 *
 * An account required to use 2FA that has not enrolled yet gets its enrolment
 * secret here, inside the challenge: the QR is scanned and the first valid
 * code both confirms enrolment and completes the sign-in.
 */
twofactorAuthRouter.post('/2fa/begin', async (req, res, next) => {
  try {
    const userId = readChallenge(req);
    if (!userId) return res.status(401).json({ error: 'Sign in again to continue.' });
    if (!twofactorEnabled()) {
      return res.status(409).json({ error: 'Two-factor authentication is not enabled.' });
    }

    const user = await loadUser(userId);
    if (!user) return res.status(401).json({ error: 'Sign in again to continue.' });

    if (user.totp_secret_enc && user.totp_confirmed_at) {
      return res.json({ enrolled: true });
    }

    // Reuse an unconfirmed pending secret so a page refresh does not
    // invalidate a QR code that was already scanned.
    let secret;
    if (user.totp_secret_enc && !user.totp_confirmed_at) {
      secret = Buffer.from(open(user.totp_secret_enc), 'base64');
    } else {
      secret = newSecret();
      await query(
        'UPDATE users SET totp_secret_enc = $2, totp_confirmed_at = NULL WHERE id = $1',
        [user.id, seal(secret.toString('base64'))],
      );
    }

    const secretBase32 = base32Encode(secret);
    return res.json({
      enrolled: false,
      secret: secretBase32,
      otpauth: otpauthUri(user.username ?? 'admin', secretBase32),
    });
  } catch (error) {
    return next(error);
  }
});

/** Completes a challenged sign-in with a one-time code. */
twofactorAuthRouter.post('/2fa', async (req, res, next) => {
  try {
    const userId = readChallenge(req);
    if (!userId) return res.status(401).json({ error: 'Sign in again to continue.' });
    if (!twofactorEnabled()) {
      return res.status(409).json({ error: 'Two-factor authentication is not enabled.' });
    }

    const user = await loadUser(userId);
    if (!user?.totp_secret_enc) {
      return res.status(400).json({ error: 'Two-factor authentication is not set up yet.' });
    }

    const secret = Buffer.from(open(user.totp_secret_enc), 'base64');
    if (!verifyTotp(secret, req.body?.code)) {
      return res.status(401).json({ error: 'That code is not right. Codes rotate every 30 seconds.' });
    }

    // First valid code from a required-but-unenrolled account confirms the
    // enrolment it just completed.
    if (!user.totp_confirmed_at) {
      await query('UPDATE users SET totp_confirmed_at = now() WHERE id = $1', [user.id]);
      await audit(user.id, 'twofactor.enrol', 'user', user.id);
    }

    // Discord-backed accounts get a fresh role snapshot; leaving the guild
    // between the two factors ends the sign-in.
    let roleIds = [];
    if (user.discord_id && isPluginEnabled(current().plugins, PLUGINS.DISCORD)) {
      const member = await guildMember(user.discord_id);
      if (!member) {
        clearChallenge(res);
        return res.status(403).json({ error: 'That account is no longer a member of the server.' });
      }
      roleIds = member.roles;
    }

    clearChallenge(res);
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await startSession(res, { id: user.id }, roleIds);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Enrolment and admin controls, mounted at /api/plugin/twofactor
// ---------------------------------------------------------------------------

export const twofactorAdminRouter = Router();

// Enrolment is for admin accounts; participants have no accounts at all.
twofactorAdminRouter.use(requirePanel);

/** The caller's own enrolment state. */
twofactorAdminRouter.get('/status', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT totp_required, totp_confirmed_at,
              totp_secret_enc IS NOT NULL AS has_secret
         FROM users WHERE id = $1`,
      [req.user.id],
    );
    const row = rows[0];
    return res.json({
      enabled: twofactorEnabled(),
      enrolled: Boolean(row.has_secret && row.totp_confirmed_at),
      confirmedAt: row.totp_confirmed_at,
      required: row.totp_required,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * Begins enrolment for the signed-in admin.
 *
 * Returns both the otpauth:// URI (rendered as a QR client-side) and the
 * base32 secret for manual entry.
 */
twofactorAdminRouter.post('/enroll', async (req, res, next) => {
  try {
    if (!twofactorEnabled()) {
      return res.status(409).json({ error: 'The Two-Factor Authentication plugin is not enabled.' });
    }

    const user = await loadUser(req.user.id);
    if (user.totp_secret_enc && user.totp_confirmed_at) {
      return res.status(409).json({ error: 'Two-factor authentication is already set up.' });
    }

    // Reuse an unconfirmed pending secret so refreshing the page does not
    // invalidate a QR code that was already scanned.
    let secret;
    if (user.totp_secret_enc) {
      secret = Buffer.from(open(user.totp_secret_enc), 'base64');
    } else {
      secret = newSecret();
      await query(
        'UPDATE users SET totp_secret_enc = $2, totp_confirmed_at = NULL WHERE id = $1',
        [user.id, seal(secret.toString('base64'))],
      );
    }

    const secretBase32 = base32Encode(secret);
    return res.json({
      secret: secretBase32,
      otpauth: otpauthUri(user.username ?? 'admin', secretBase32),
    });
  } catch (error) {
    return next(error);
  }
});

/** Confirms enrolment with a first valid code. */
twofactorAdminRouter.post('/confirm', async (req, res, next) => {
  try {
    if (!twofactorEnabled()) {
      return res.status(409).json({ error: 'The Two-Factor Authentication plugin is not enabled.' });
    }

    const user = await loadUser(req.user.id);
    if (!user.totp_secret_enc) {
      return res.status(400).json({ error: 'Begin enrolment first.' });
    }

    const secret = Buffer.from(open(user.totp_secret_enc), 'base64');
    if (!verifyTotp(secret, req.body?.code)) {
      return res.status(400).json({ error: 'That code is not right. Codes rotate every 30 seconds.' });
    }

    await query('UPDATE users SET totp_confirmed_at = now() WHERE id = $1', [user.id]);
    await audit(req.user.id, 'twofactor.enrol', 'user', req.user.id);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/**
 * Removes the caller's own enrolment.
 *
 * Refused while 2FA is required for the account, and it takes a valid code:
 * a walked-away-from session must not be enough to switch the factor off.
 */
twofactorAdminRouter.post('/unenroll', async (req, res, next) => {
  try {
    const user = await loadUser(req.user.id);
    if (!user.totp_secret_enc) return res.status(400).json({ error: 'Nothing to remove.' });
    if (user.totp_required) {
      return res.status(409).json({
        error: 'Two-factor authentication is required for this account. Ask another admin to lift it first.',
      });
    }

    const secret = Buffer.from(open(user.totp_secret_enc), 'base64');
    if (!verifyTotp(secret, req.body?.code)) {
      return res.status(400).json({ error: 'Enter a current code to confirm.' });
    }

    await query(
      'UPDATE users SET totp_secret_enc = NULL, totp_confirmed_at = NULL WHERE id = $1',
      [req.user.id],
    );
    await audit(req.user.id, 'twofactor.unenrol', 'user', req.user.id);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

/** Sets whether an admin account must use 2FA. Super admins only. */
twofactorAdminRouter.put('/require/:userId', requireAdmin, async (req, res, next) => {
  try {
    if (!twofactorEnabled()) {
      return res.status(409).json({ error: 'The Two-Factor Authentication plugin is not enabled.' });
    }

    const required = req.body?.required === true;
    const { rows } = await query(
      `UPDATE users SET totp_required = $2
        WHERE id = $1 AND tier <> $3
        RETURNING id`,
      [req.params.userId, required, TIERS.NONE],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'That admin was not found.' });

    await audit(req.user.id, 'twofactor.require', 'user', req.params.userId, { required });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});
