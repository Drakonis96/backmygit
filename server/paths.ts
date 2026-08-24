import { createHash } from 'node:crypto';
import path from 'node:path';

function safePart(value: string): string {
  return value.normalize('NFKC').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 160) || '_';
}

export function repositoryDirectory(owner: string, name: string): string {
  return `${safePart(owner)}_${safePart(name)}`;
}

export function branchDirectory(branch: string): string {
  const normalized = safePart(branch.replaceAll('/', '__').replaceAll('\\', '__'));
  if (normalized === branch) return normalized;
  return `${normalized}--${createHash('sha256').update(branch).digest('hex').slice(0, 8)}`;
}

export function timestampDirectory(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '').replace('T', '_').replaceAll(':', '-');
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
