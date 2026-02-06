import { describe, expect, test } from '@jest/globals';
import path from 'path';

const { getDotenvCandidatePaths } = await import('../utils/dotenv-loader.js');

describe('dotenv-loader', () => {
  test('includes cwd .env and entrypoint-adjacent .env candidates', () => {
    const cwd = '/repo';
    const metaUrl = 'file:///repo/src/index.js';
    const candidates = getDotenvCandidatePaths(metaUrl, cwd);

    expect(candidates).toContain(path.resolve(cwd, '.env'));
    expect(candidates).toContain(path.resolve('/repo/src', '../.env'));
  });
});
