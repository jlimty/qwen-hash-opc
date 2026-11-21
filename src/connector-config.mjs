// The paste-ready QwenWork connector a new client receives once, at the end of intake.
// Same shape as the configs imported by hand: { mcpServers: { name: { url, headers, timeout } } }.

export function connectorSlug(clientName) {
  const slug = String(clientName ?? '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `tender-desk-${slug || 'client'}`;
}

export function connectorConfig({ name, url, origin, timeout, token }) {
  return { mcpServers: { [name]: { url, headers: { Authorization: `Bearer ${token}`, Origin: origin }, timeout } } };
}
