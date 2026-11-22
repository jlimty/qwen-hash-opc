// Renders a stored brief (a fixed Markdown subset written by composeBrief: "## " headings, "- " bullets, paragraphs)
// as escaped HTML, so neither the customer nor the admin ever sees Markdown marks.
import { esc } from './console-view.mjs';

export function briefSections(markdown) {
  const sections = new Map();
  let current;
  for (const line of String(markdown ?? '').split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) { current = heading[1].trim(); sections.set(current, ''); continue; }
    if (current !== undefined) sections.set(current, `${sections.get(current)}\n${line}`.trim());
  }
  return sections;
}

function blockHtml(text) {
  const out = [];
  let list = [];
  const flush = () => { if (list.length) out.push(`<ul>${list.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`); list = []; };
  for (const paragraph of text.split(/\n\s*\n/)) {
    for (const line of paragraph.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (line.startsWith('- ')) list.push(line.slice(2));
      else { flush(); out.push(`<p>${esc(line)}</p>`); }
    }
    flush();
  }
  return out.join('');
}

export function renderBriefHtml(markdown, { skip = [] } = {}) {
  const sections = briefSections(markdown);
  if (!sections.size) return blockHtml(String(markdown ?? ''));
  return [...sections].filter(([heading]) => !skip.includes(heading))
    .map(([heading, body]) => `<section class="brief-part"><h3>${esc(heading)}</h3>${blockHtml(body)}</section>`).join('');
}
