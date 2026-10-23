import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the script node was started with. Both sides go through
 * `realpathSync`, so it holds when started through a symlink (an npm `bin` link) too.
 */
export function isEntryPoint(
  moduleUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}
