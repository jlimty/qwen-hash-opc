// Customer sign-up and sign-in through Neon Auth. Kept apart from the admin sign-in: the admin's account is refused
// here, and the console refuses every account but the admin's, so neither session opens the other side.
import { packSession, sessionFrom, unpackSession } from './neon-session.mjs';

export function createCustomerAuth({ baseUrl, origin, adminUserId, fetchImpl = fetch }) {
  if (!/^https:\/\//.test(baseUrl ?? '') && !/^http:\/\/127\.0\.0\.1/.test(baseUrl ?? '')) throw new Error('A Neon Auth base URL is required.');
  const root = baseUrl.replace(/\/+$/, '');
  const isAdmin = async (id) => typeof adminUserId === 'function' ? id === await adminUserId() : id === adminUserId;
  const headers = (extra = {}) => ({ Origin: origin, 'Content-Type': 'application/json', ...extra });
  const call = (path, init) => fetchImpl(`${root}${path}`, { signal: AbortSignal.timeout(8000), redirect: 'manual', ...init });
  const credentials = (email, password) => {
    const cleanEmail = String(email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) return { message: 'Enter a valid email address.' };
    if (String(password ?? '').length < 8 || String(password).length > 256) return { message: 'Use a password of at least 8 characters.' };
    return { email: cleanEmail, password: String(password) };
  };
  async function finish(response, fallback) {
    const body = await response.json().catch(() => undefined);
    const session = sessionFrom(response);
    const userId = body?.user?.id;
    if (!response.ok || !session || typeof userId !== 'string') {
      return { ok: false, message: typeof body?.message === 'string' && response.status < 500 ? body.message.slice(0, 120) : fallback };
    }
    if (await isAdmin(userId)) return { ok: false, message: 'This account cannot be used as a customer account.' };
    return { ok: true, userId, session: packSession(session) };
  }
  return {
    async signUp({ email, password, name }) {
      const checked = credentials(email, password);
      if (checked.message) return { ok: false, message: checked.message };
      const response = await call('/sign-up/email', { method: 'POST', headers: headers(),
        body: JSON.stringify({ email: checked.email, password: checked.password, name: String(name ?? '').trim().slice(0, 100) || checked.email }) });
      return finish(response, 'Sign-up is unavailable right now. Try again shortly.');
    },
    async signIn({ email, password }) {
      const checked = credentials(email, password);
      if (checked.message) return { ok: false, message: 'Email or password is incorrect.' };
      const response = await call('/sign-in/email', { method: 'POST', headers: headers(), body: JSON.stringify(checked) });
      const result = await finish(response, 'Email or password is incorrect.');
      return result.ok || result.message.startsWith('This account') ? result : { ok: false, message: 'Email or password is incorrect.' };
    },
    async verify(packed) {
      const session = unpackSession(packed);
      if (!session?.name || !session.value) return undefined;
      const response = await call('/get-session', { method: 'GET', headers: headers({ Cookie: `${session.name}=${session.value}` }) }).catch(() => undefined);
      if (!response?.ok) return undefined;
      const body = await response.json().catch(() => undefined);
      const userId = body?.user?.id;
      if (typeof userId !== 'string' || await isAdmin(userId)) return undefined;
      if (body.session?.expiresAt && new Date(body.session.expiresAt).getTime() <= Date.now()) return undefined;
      return userId;
    },
    async signOut(packed) {
      const session = unpackSession(packed);
      if (session?.name) await call('/sign-out', { method: 'POST', headers: headers({ Cookie: `${session.name}=${session.value}` }), body: '{}' }).catch(() => {});
    },
  };
}
