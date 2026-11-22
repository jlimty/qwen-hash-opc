import assert from 'node:assert/strict';
import { test } from 'node:test';
import { briefSections, renderBriefHtml } from '../src/brief-render.mjs';

const brief = ['## Recommendation', '', 'Do not bid', '', '## Why', '', '- First <reason> & more.', '- Second reason.', '',
  '## Price position', '', 'Below the lower quartile, because the scope is small.', '', '## Comparable awards', '', '7 awards.', '', '## Limits', '', 'Past awards only.'].join('\n');

test('renders headings, bullets and paragraphs as escaped HTML with no Markdown marks left', () => {
  const html = renderBriefHtml(brief);
  assert.match(html, /<h3>Why<\/h3>/);
  assert.match(html, /<ul><li>First &lt;reason&gt; &amp; more\.<\/li><li>Second reason\.<\/li><\/ul>/);
  assert.match(html, /<p>Below the lower quartile, because the scope is small\.<\/p>/);
  assert.doesNotMatch(html, /##|^- /m);
});

test('sections can be picked and skipped by heading', () => {
  const sections = briefSections(brief);
  assert.equal(sections.get('Recommendation'), 'Do not bid');
  const html = renderBriefHtml(brief, { skip: ['Recommendation', 'Comparable awards', 'Limits'] });
  assert.doesNotMatch(html, /Comparable awards|Limits|Do not bid/);
  assert.match(html, /Price position/);
});
