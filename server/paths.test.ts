import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchDirectory, isWithin, repositoryDirectory, timestampDirectory } from './paths.js';

describe('backup filesystem paths', () => {
  it('includes the owner in repository directories', () => {
    expect(repositoryDirectory('openai', 'example')).toBe('openai_example');
    expect(repositoryDirectory('another-owner', 'example')).toBe('another-owner_example');
  });

  it('normalizes branch separators and adds a stable collision guard', () => {
    const normalized = branchDirectory('feature/new-ui');
    expect(normalized).toMatch(/^feature__new-ui--[0-9a-f]{8}$/);
    expect(branchDirectory('feature/new-ui')).toBe(normalized);
    expect(branchDirectory('main')).toBe('main');
    expect(branchDirectory('feature__new-ui')).not.toBe(normalized);
  });

  it('generates the required timestamp directory format', () => {
    expect(timestampDirectory(new Date('2026-08-24T03:00:00.000Z'))).toBe('2026-08-24_03-00-00');
  });

  it('rejects path traversal and the backup root itself', () => {
    const root = path.resolve('/backups');
    expect(isWithin(root, path.join(root, 'owner_repo/main'))).toBe(true);
    expect(isWithin(root, path.resolve(root, '..', 'etc'))).toBe(false);
    expect(isWithin(root, root)).toBe(false);
  });
});
