// Neon Auth (Better Auth) session cookies, shared by the admin console sign-in and the customer sign-in.
const sessionCookie = /(?:^|,\s*)((?:__Secure-)?[A-Za-z0-9._-]*session_token)=([^;,\s]+)/;

export function sessionFrom(response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const match = sessionCookie.exec(cookie);
    if (match) return { name: match[1], value: match[2] };
  }
  return undefined;
}

export const packSession = ({ name, value }) => `${encodeURIComponent(name)}~${encodeURIComponent(value)}`;

export function unpackSession(packed) {
  const [name, value] = String(packed ?? '').split('~');
  try { return { name: decodeURIComponent(name), value: decodeURIComponent(value ?? '') }; } catch { return undefined; }
}
