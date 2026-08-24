import { describe, expect, it } from 'vitest';
import { normalizeRemoteSubpath } from './rclone-config.js';

describe('cloud path validation', () => {
  it('normalizes safe folder paths', () => {
    expect(normalizeRemoteSubpath('/BackMyGit/repos/')).toBe('BackMyGit/repos');
  });

  it('rejects traversal, remote switching, and control characters', () => {
    for (const value of ['../private', 'safe/../../private', 'other:folder', 'safe\nfolder'])
      expect(() => normalizeRemoteSubpath(value)).toThrow();
  });
});
