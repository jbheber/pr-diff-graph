import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isEntryPoint } from '../../src/entry.js';

describe('isEntryPoint', () => {
  let dir: string;
  let script: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdg-entry-'));
    await mkdir(join(dir, 'real'));
    script = join(dir, 'real', 'index.js');
    await writeFile(script, '');
    // A junction needs no privileges on Windows; elsewhere it is a plain directory symlink.
    await symlink(join(dir, 'real'), join(dir, 'link'), 'junction');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('matches the script itself', () => {
    expect(isEntryPoint(pathToFileURL(script).href, script)).toBe(true);
  });

  it('matches through a symlink, as an npm bin link starts it', () => {
    expect(isEntryPoint(pathToFileURL(script).href, join(dir, 'link', 'index.js'))).toBe(true);
  });

  it('rejects another script, a missing file and no argv[1]', () => {
    expect(isEntryPoint(pathToFileURL(script).href, join(dir, 'other.js'))).toBe(false);
    expect(isEntryPoint(pathToFileURL(script).href, undefined)).toBe(false);
  });
});
