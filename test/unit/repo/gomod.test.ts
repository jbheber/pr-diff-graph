import { describe, expect, it } from 'vitest';
import { indexOf, recordingLogger } from './helpers.js';

describe('go modules', () => {
  it('finds modules in go.mod files and go.work', async () => {
    const log = recordingLogger();
    const idx = await indexOf(
      {
        'go.mod': 'module example.com/root // main\n\ngo 1.22\n',
        'go.work': 'go 1.22\n\nuse (\n\t./svc/a\n\t./svc/b // second\n)\nuse ./missing\n',
        'svc/a/go.mod': 'module "example.com/svc/a"\n',
        'svc/b/go.mod': 'module example.com/svc/b\r\n',
      },
      log,
    );
    expect(idx.goModules).toEqual([
      { dir: '', modulePath: 'example.com/root' },
      { dir: 'svc/a', modulePath: 'example.com/svc/a' },
      { dir: 'svc/b', modulePath: 'example.com/svc/b' },
    ]);
    expect(log.warnings.some((w) => w.includes('./missing'))).toBe(true);
    expect(log.warnings.some((w) => w.includes('svc/a'))).toBe(false);
  });
});
