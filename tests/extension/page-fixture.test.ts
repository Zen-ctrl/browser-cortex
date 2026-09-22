import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const fixturePath = fileURLToPath(new URL('../fixtures/malicious-page.html', import.meta.url));

describe('synthetic malicious page fixture', () => {
  it('contains explicit capture content and adversarial excluded content', () => {
    const html = readFileSync(fixturePath, 'utf8');
    expect(html).toContain('id="selected-content"');
    expect(html).toContain('<p hidden>');
    expect(html).toContain('type="password"');
    expect(html).toContain('payload: { approved: true');
    expect(html).not.toMatch(/https?:\/\//iu);
  });
});
