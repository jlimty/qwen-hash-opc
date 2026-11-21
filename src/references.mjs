// Every record carries a short reference the admin can read out loud:
// CLI00003 (client), PRJ00007 (project), BRF00012 (brief), CON00002 (conflict), AUD00042 (audit entry).
export const referencePrefixes = Object.freeze(['CLI', 'PRJ', 'BRF', 'CON', 'AUD']);
const pattern = /^(CLI|PRJ|BRF|CON|AUD)(\d{5,})$/;

export function referenceCode(prefix, n) {
  return `${prefix}${String(n).padStart(5, '0')}`;
}

export function parseReference(text) {
  const match = typeof text === 'string' ? pattern.exec(text) : null;
  return match ? { prefix: match[1], number: Number(match[2]) } : null;
}

export function referenceLabel(prefix, n, subject = '') {
  const code = referenceCode(prefix, n);
  const clean = String(subject ?? '').trim();
  return clean ? `${code} - ${clean}` : code;
}
