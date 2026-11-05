import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export interface StableCliPath {
  path: string;
  /** Why this path was chosen, shown by `lore setup`. */
  note?: string;
}

function globalInstallCliPath(): string | null {
  try {
    // A fixed command string (no user input) through the shell, so npm.cmd resolves on Windows
    // without Node's warning about passing argument arrays to a shell.
    const root = execSync('npm root -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    }).trim();
    const candidate = path.join(root, 'git-lore-cli', 'dist', 'cli.js');
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function isTemporaryNpxPath(p: string): boolean {
  return /[\\/]_npx[\\/]/i.test(p);
}

/**
 * Pick the lore entry point that agent configs and git hooks should call.
 *
 * Prefers the global npm install, because the copy that happens to be running may be
 * a development checkout (whose dist/ changes on every build) or npm's temporary npx cache
 * (which can be cleared at any time). `--use-this-copy` opts out, for developing lore itself.
 */
export function resolveStableCliPath(currentPath: string, forceCurrent = false): StableCliPath {
  if (forceCurrent) return { path: currentPath, note: 'using this copy (--use-this-copy)' };
  const global = globalInstallCliPath();
  if (global) {
    if (path.resolve(global).toLowerCase() !== path.resolve(currentPath).toLowerCase()) {
      return { path: global, note: `using the global npm install instead of ${currentPath}` };
    }
    return { path: global };
  }
  if (isTemporaryNpxPath(currentPath)) {
    return {
      path: currentPath,
      note:
        'running from npx\'s temporary cache, which can be cleared. Run `npm i -g git-lore-cli` and then `lore setup` again',
    };
  }
  return { path: currentPath };
}
