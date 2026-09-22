import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('core import boundary', () => {
  it('does not declare or statically import heavyweight model or transport implementations', async () => {
    const [manifest, source] = await Promise.all([
      readFile('packages/core/package.json', 'utf8'),
      readFile('packages/core/src/index.ts', 'utf8'),
    ]);
    for (const blocked of ['@mlc-ai/web-llm', '@huggingface/transformers', 'runtime-webllm', 'runtime-transformers']) {
      expect(manifest).not.toContain(blocked);
      expect(source).not.toContain(blocked);
    }
  });
});
