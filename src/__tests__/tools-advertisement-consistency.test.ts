import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const readUtf8 = (p: string) => fs.readFileSync(p, 'utf8');

const extractQuoted = (text: string, regex: RegExp): Set<string> => {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    out.add(m[1]);
  }
  return out;
};

describe('MCP tools advertisement consistency', () => {
  test('index-compat advertises exactly what it handles', () => {
    const repoRoot = process.cwd();
    const p = path.join(repoRoot, 'src/tools/index-compat.ts');
    const text = readUtf8(p);

    const advertised = extractQuoted(text, /name:\s*'([^']+)'/g);
    const handled = extractQuoted(text, /case\s*'([^']+)'/g);

    // Every handler case must be in ListTools; otherwise some clients won't see it.
    const missingFromList = [...handled].filter((n) => !advertised.has(n));
    // Every advertised tool must have a handler.
    const missingHandler = [...advertised].filter((n) => !handled.has(n));

    expect(missingFromList).toEqual([]);
    expect(missingHandler).toEqual([]);
  });

  test('Jamf client write-like methods are exposed as tools', () => {
    const repoRoot = process.cwd();
    const clientPath = path.join(repoRoot, 'src/jamf-client-hybrid.ts');
    const toolsPath = path.join(repoRoot, 'src/tools/index-compat.ts');

    const clientText = readUtf8(clientPath);
    const toolsText = readUtf8(toolsPath);

    const toolNames = extractQuoted(toolsText, /name:\s*'([^']+)'/g);

    const methodMatches = clientText.matchAll(/^\s*(?:public\s+)?(async\s+)?(?!private\s)([A-Za-z0-9_]+)\s*\(/gm);
    const methods = new Set<string>();
    for (const m of methodMatches) {
      const name = m[2];
      if (name === 'constructor') continue;
      if (['if', 'for', 'while', 'switch', 'catch'].includes(name)) continue;
      methods.add(name);
    }

    const prefixes = ['create', 'update', 'delete', 'execute', 'deploy', 'remove', 'set', 'trigger', 'run'];
    const writeLike = [...methods].filter((m) => prefixes.some((p) => m.startsWith(p)));
    const notExposed = writeLike.filter((m) => !toolNames.has(m));

    expect(notExposed).toEqual([]);
  });
});
