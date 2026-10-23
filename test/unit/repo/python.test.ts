import { describe, expect, it } from 'vitest';
import { indexOf } from './helpers.js';

describe('python roots', () => {
  it('roots are repo root, src/ when present, and dirs with pyproject.toml or setup.cfg', async () => {
    const idx = await indexOf({
      'main.py': '',
      'src/pkg/__init__.py': '',
      'services/api/pyproject.toml': '',
      'libs/old/setup.cfg': '',
      'libs/old/old/__init__.py': '',
      'docs/readme.md': '',
    });
    expect(idx.pythonRoots).toEqual(['', 'libs/old', 'services/api', 'src']);
  });

  it('is just the root for a repo with no src/ or project files', async () => {
    const idx = await indexOf({ 'a.py': '' });
    expect(idx.pythonRoots).toEqual(['']);
  });
});
