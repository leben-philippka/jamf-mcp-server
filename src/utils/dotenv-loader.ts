import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

export const getDotenvCandidatePaths = (metaUrl: string, cwd: string): string[] => {
  const fromEnv = process.env.DOTENV_PATH;
  const candidates: string[] = [];

  if (fromEnv) {
    candidates.push(fromEnv);
  }

  candidates.push(path.resolve(cwd, '.env'));

  const here = path.dirname(fileURLToPath(metaUrl));
  candidates.push(path.resolve(here, '../.env'));

  return Array.from(new Set(candidates));
};

export const loadDotenv = (metaUrl: string): void => {
  // Keep dotenv non-destructive: never override already-set variables.
  const candidates = getDotenvCandidatePaths(metaUrl, process.cwd());
  const envPath = candidates.find((p) => fs.existsSync(p));

  if (envPath) {
    dotenv.config({ path: envPath, override: false });
    return;
  }

  dotenv.config({ override: false });
};
