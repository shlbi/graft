/**
 * @file GitHub-only identity adapter for Better Auth 1.7.6, without email access.
 * Only the token-bound GET /user result establishes identity. No usernames,
 * email addresses, profile URLs, or account IDs from a browser are trusted.
 *
 * Better Auth still requires a nonempty, unique email-shaped database field.
 * The .invalid alias below is an internal ID, NOT an email address supplied or
 * verified by GitHub. It is never a recovery channel or account-linking proof.
 * Keep email login, mail delivery, and account linking disabled in auth.mjs.
 */
const PROFILE_ENDPOINT = 'https://api.github.com/user';
const MAX_PROFILE_BYTES = 65536;
const PROFILE_DEADLINE_MS = 15000;

/**
 * Normalize GitHub's immutable numeric subject without rounding large numbers.
 * Accept canonical decimal strings for forward compatibility, but never derive
 * identity from a mutable login name, email, or a missing/malformed ID.
 */
function githubSubject(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) ? value : null;
}

/**
 * Read a bounded UTF-8 JSON profile. Count actual bytes instead of trusting an
 * upstream Content-Length. Cancel the body on failure; never log its contents.
 * Fetch's AbortSignal also bounds network/body reads in the production path.
 */
async function readProfile(response) {
  if (!response.body) throw new Error('Missing GitHub profile');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROFILE_BYTES) throw new Error('GitHub profile exceeds limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Better Auth's supported getUserInfo hook. The library calls it only after
 * validating OAuth state and exchanging the authorization code/PKCE verifier.
 * Fetch exactly /user with that user token; do NOT call /user/emails. GitHub
 * Apps use installation/account permissions, not OAuth email scopes.
 *
 * Return only the immutable ID and current handle. Any public email GitHub
 * happens to include is discarded, even if nonempty or marked verified. The
 * sanitized data.id preserves the stock provider's accountSubject contract.
 * Returning null lets Better Auth fail closed with unable_to_get_user_info.
 * fetchImpl is an in-process test seam, never a remotely configurable endpoint.
 */
export async function githubIdentity(tokens, { fetchImpl = fetch } = {}) {
  const accessToken = tokens?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 4096 || /\s/.test(accessToken)) return null;
  try {
    const response = await fetchImpl(PROFILE_ENDPOINT, {
      method: 'GET', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(PROFILE_DEADLINE_MS),
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'repot-github-sign-in',
        'x-github-api-version': '2026-03-10'
      }
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const profile = await readProfile(response);
    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || profile.type !== 'User') return null;
    const id = githubSubject(profile.id);
    // GitHub handles can include underscores for enterprise managed users.
    const login = profile.login;
    if (!id || typeof login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(login)) return null;
    return {
      user: {
        id,
        name: login,
        email: `github-${id}@users.repot.invalid`,
        emailVerified: false
      },
      data: { id, login }
    };
  } catch {
    // Never surface access tokens, arbitrary provider bodies or thrown URLs.
    return null;
  }
}
