import { randomBytes } from 'node:crypto';

// A stand-in for Neon Auth's email endpoints (sign-up, sign-in, get-session, sign-out), keyed by session cookie.
// requireVerification mirrors Neon Auth with "verify email" on: sign-up opens no session, and sign-in is refused until verified.
export function fakeNeonAuth({ adminUserId = 'admin-user-0001', requireVerification = false } = {}) {
  const users = new Map([['admin@example.com', { id: adminUserId, password: 'admin password long', verified: true }]]);
  const sessions = new Map();
  const calls = [];
  const json = (status, body, cookie) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json',
    ...(cookie && { 'Set-Cookie': `__Secure-neon-auth.session_token=${cookie}; Path=/; HttpOnly; Secure` }) } });
  const issue = (user) => { const value = `tok-${randomBytes(6).toString('hex')}.sig`; sessions.set(value, user.id); return value; };
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/auth/, '');
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path, origin: init.headers?.Origin, body });
    if (path === '/sign-up/email') {
      if (users.has(body.email)) return json(422, { message: 'User already exists' });
      const user = { id: `user-${randomBytes(6).toString('hex')}`, password: body.password, verified: !requireVerification };
      users.set(body.email, user);
      if (requireVerification) return json(200, { token: null, user: { id: user.id, emailVerified: false } });
      return json(200, { user: { id: user.id } }, issue(user));
    }
    if (path === '/sign-in/email') {
      const user = users.get(body.email);
      if (!user || user.password !== body.password) return json(401, { message: 'Invalid email or password' });
      if (!user.verified) return json(403, { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' });
      return json(200, { user: { id: user.id } }, issue(user));
    }
    if (path === '/get-session') {
      const token = /session_token=([^;]+)/.exec(init.headers?.Cookie ?? '')?.[1];
      const id = sessions.get(token);
      return id ? json(200, { user: { id }, session: { expiresAt: new Date(Date.now() + 3600000).toISOString() } }) : json(200, null);
    }
    if (path === '/sign-out') return json(200, { success: true });
    return json(404, {});
  };
  return { fetchImpl, calls, verifyEmail: (email) => { users.get(email).verified = true; } };
}
