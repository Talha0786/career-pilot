import { describe, it, expect } from 'vitest';
import { htmlToText } from './html-to-text.js';

describe('htmlToText', () => {
  it('strips tags and preserves paragraph breaks', () => {
    const html = '<p>Hello <b>world</b>.</p><p>Second paragraph.</p>';
    expect(htmlToText(html)).toBe('Hello world.\nSecond paragraph.');
  });

  it('converts list items to markdown-ish dashes', () => {
    const html = '<ul><li>One</li><li>Two</li></ul>';
    expect(htmlToText(html)).toBe('- One\n- Two');
  });

  it('strips script and style blocks entirely', () => {
    const html = '<style>.x{color:red}</style><p>Visible</p><script>alert(1)</script>';
    expect(htmlToText(html)).toBe('Visible');
  });

  it('decodes common HTML entities', () => {
    expect(htmlToText('Tom &amp; Jerry &mdash; a &quot;classic&quot;')).toBe('Tom & Jerry — a "classic"');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});
