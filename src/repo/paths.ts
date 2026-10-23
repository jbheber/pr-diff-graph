import { posix } from 'node:path';

/** Normalizes a repo-relative POSIX path: no leading `./`, no trailing `/`, `''` for the root. */
export function norm(p: string): string {
  const n = posix.normalize(p.replace(/\\/g, '/'));
  if (n === '.' || n === './') return '';
  return n.replace(/^\.\//, '').replace(/\/+$/, '');
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function join(dir: string, rel: string): string {
  return norm(posix.join(dir, rel));
}
