const sessionCookie = /(?:^|,\s*)((?:__Secure-)?[A-Za-z0-9._-]*session_token)=([^;,\s]+)/;

function sessionFrom(response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const match = sessionCookie.exec(cookie);
    if (match) return { name: match[1], value: match[2] };
  }
  return undefined;
}

export function createNeonAuth({ baseUrl, adminUserId, origin, fetchImpl = fetch }) {
  if (!/^https:\/\//.test(baseUrl ?? '') && !/^http:\/\/127\.0\.0\.1/.test(baseUrl ?? '')) throw new Error('A Neon Auth base URL is required.');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(adminUserId ?? '')) throw new Error('An admin user ID is required.');
  const root = baseUrl.replace(/\/+$/, '');
  const headers = (extra = {}) => ({ Origin: origin, 'Content-Type': 'application/json', ...extra });
  const call = (path, init) => fetchImpl(`${root}${path}`, { signal: AbortSignal.timeout(8000), redirect: 'manual', ...init });
  const pack = ({ name, value }) => `${encodeURIComponent(name)}~${encodeURIComponent(value)}`;
  const unpack = (packed) => {
    const [name, value] = String(packed).split('~');
    try { return { name: decodeURIComponent(name), value: decodeURIComponent(value ?? '') }; } catch { return undefined; }
  };

  return {
    mode: 'email',
    origin,
    async login(form) {
      const email = String(form.get('email') ?? '').trim();
      const password = String(form.get('password') ?? '');
      if (!email || !password || email.length > 254 || password.length > 256) return undefined;
      const response = await call('/sign-in/email', { method: 'POST', headers: headers(), body: JSON.stringify({ email, password }) });
      if (!response.ok) return undefined;
      const body = await response.json().catch(() => undefined);
      const session = sessionFrom(response);
      if (!session || body?.user?.id !== adminUserId) return undefined;
      return { session: pack(session), maxAge: 8 * 60 * 60 };
    },
    async verify(packed) {
      const session = unpack(packed);
      if (!session?.name || !session.value) return false;
      const response = await call('/get-session', { method: 'GET', headers: headers({ Cookie: `${session.name}=${session.value}` }) });
      if (!response.ok) return false;
      const body = await response.json().catch(() => undefined);
      return body?.user?.id === adminUserId && (!body.session?.expiresAt || new Date(body.session.expiresAt).getTime() > Date.now());
    },
    async requestReset(email, redirectPath) {
      const response = await call('/request-password-reset', { method: 'POST', headers: headers(), body: JSON.stringify({ email, redirectTo: `${origin}${redirectPath}` }) });
      if (response.status >= 500 || response.status === 429) throw new Error('Password reset is unavailable.');
    },
    async resetPassword(token, newPassword) {
      const response = await call('/reset-password', { method: 'POST', headers: headers(), body: JSON.stringify({ newPassword, token }) });
      if (response.ok) return { ok: true };
      if (response.status >= 500) throw new Error('Password reset is unavailable.');
      const body = await response.json().catch(() => undefined);
      const invalid = body?.code === 'INVALID_TOKEN' || /token/i.test(String(body?.message ?? ''));
      return { ok: false, invalid, message: invalid || typeof body?.message !== 'string' ? undefined : body.message.slice(0, 120) };
    },
    async logout(packed) {
      const session = unpack(packed);
      if (!session?.name) return;
      await call('/sign-out', { method: 'POST', headers: headers({ Cookie: `${session.name}=${session.value}` }), body: '{}' }).catch(() => {});
    },
  };
}

export async function signUpAdmin({ baseUrl, origin, email, password, name = 'Admin', fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/sign-up/email`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, name }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !body?.user?.id) throw new Error(`Sign-up was not accepted (HTTP ${response.status}${body?.message ? `: ${String(body.message).slice(0, 120)}` : ''}).`);
  return { userId: body.user.id, emailVerified: body.user.emailVerified === true };
}
