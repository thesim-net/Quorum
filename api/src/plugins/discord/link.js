/**
 * Pure Discord identity decisions for the OAuth callback.
 *
 * One registered redirect URI serves two purposes: signing in, and attaching a
 * Discord identity to the account already in the session. Which one is running
 * is carried in the OAuth `state` parameter, and what the callback does with
 * the result is decided here.
 *
 * Kept free of config, database, and Discord imports so every branch - not
 * least the one that must never create an account - is unit-testable on its own.
 */

/** What an OAuth round trip was started for. */
export const INTENTS = {
  SIGN_IN: 'signin',
  LINK: 'link',
};

/** What the callback should do once Discord has answered. */
export const CALLBACK_ACTIONS = {
  SIGN_IN: 'sign_in',
  CREATE_BOOTSTRAP: 'create_bootstrap',
  NO_ACCOUNT: 'no_account',
  LINK: 'link',
  LINK_SIGNED_OUT: 'link_signed_out',
};

// The random half of the state is base64url, which never contains a dot, so
// the first dot always separates the intent from the token.
const SEPARATOR = '.';

const KNOWN_INTENTS = new Set(Object.values(INTENTS));

/**
 * Builds the OAuth state value, carrying the intent alongside the CSRF token.
 *
 * The whole string is what gets stored in the state cookie and compared on the
 * callback, so the intent is covered by that comparison: a crafted callback
 * cannot turn a sign-in into a link.
 *
 * @param {string} intent An INTENTS value.
 * @param {string} token Opaque CSRF token.
 * @returns {string} The state to send to Discord.
 */
export function encodeState(intent, token) {
  const safe = KNOWN_INTENTS.has(intent) ? intent : INTENTS.SIGN_IN;
  return `${safe}${SEPARATOR}${token}`;
}

/**
 * Reads an OAuth state value back.
 *
 * @param {string} state The state returned by Discord.
 * @returns {{intent: string, token: string}|null} The parts, or null when the
 *   value is malformed or names an intent this build does not have.
 */
export function decodeState(state) {
  const raw = String(state ?? '');
  const at = raw.indexOf(SEPARATOR);
  if (at < 1) return null;

  const intent = raw.slice(0, at);
  const token = raw.slice(at + 1);
  if (!KNOWN_INTENTS.has(intent) || !token) return null;

  return { intent, token };
}

/**
 * Decides what a verified Discord identity means for this request.
 *
 * The rule that matters: an unknown Discord id never mints an account. Accounts
 * exist for administrators, respondents are anonymous, and silently creating a
 * powerless second account is what stranded the owner's real one behind a
 * duplicate. The single exception is BOOTSTRAP_ADMIN_IDS, whose documented
 * purpose is to let a deployment's first super admin arrive by signing in.
 *
 * @param {{intent: string, signedInUserId?: string|null,
 *   existingUserId?: string|null, isBootstrapAdmin?: boolean}} context
 *   `existingUserId` is whoever already holds this discord_id, if anyone.
 * @returns {{action: string, userId: string|null}} The action to take and the
 *   account it applies to.
 */
export function resolveCallback({
  intent,
  signedInUserId = null,
  existingUserId = null,
  isBootstrapAdmin = false,
}) {
  if (intent === INTENTS.LINK) {
    // A link always targets the account already in the session. It never
    // creates one, and never switches to whoever else holds the id - that case
    // is a refusal, decided by resolveLink once the id is re-checked.
    return signedInUserId
      ? { action: CALLBACK_ACTIONS.LINK, userId: signedInUserId }
      : { action: CALLBACK_ACTIONS.LINK_SIGNED_OUT, userId: null };
  }

  if (existingUserId) return { action: CALLBACK_ACTIONS.SIGN_IN, userId: existingUserId };
  if (isBootstrapAdmin) return { action: CALLBACK_ACTIONS.CREATE_BOOTSTRAP, userId: null };
  return { action: CALLBACK_ACTIONS.NO_ACCOUNT, userId: null };
}

/**
 * Decides whether a verified Discord id may be attached to an account.
 *
 * `discord_id` is UNIQUE, but the constraint is the backstop rather than the
 * check: the owner is looked up first so a taken id comes back as a clean 409
 * with something the admin can act on, not a unique violation turned into a 500.
 *
 * @param {{signedInUserId: string, ownerUserId?: string|null}} context
 *   `ownerUserId` is whoever currently holds the id, if anyone.
 * @returns {{ok: boolean, status: number, error: string|null, changed: boolean}}
 *   `changed` is false when the id is already this account's, which is a
 *   no-op rather than a failure.
 */
export function resolveLink({ signedInUserId, ownerUserId = null }) {
  if (ownerUserId && ownerUserId !== signedInUserId) {
    return {
      ok: false,
      status: 409,
      error: 'That Discord account is already linked to another user.',
      changed: false,
    };
  }

  return { ok: true, status: 200, error: null, changed: ownerUserId !== signedInUserId };
}
