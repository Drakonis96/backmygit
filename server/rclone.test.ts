import { describe, expect, it } from 'vitest';
import { assertRemoteName, parseRcloneConfig, remotePath, renderRcloneConfig } from './rclone-config.js';

describe('rclone boundary validation', () => {
  it('renders deterministic configs without accepting line injection', () => {
    expect(renderRcloneConfig('drive_main', { type: 'drive', fields: { token: '{"a":1}', scope: 'drive' } }))
      .toBe('[drive_main]\ntype = drive\nscope = drive\ntoken = {"a":1}\n');
    expect(() => renderRcloneConfig('drive', { type: 'drive', fields: { token: 'safe\n[evil]' } })).toThrow();
  });

  it('reads back only the requested remote after rclone refreshes it', () => {
    expect(parseRcloneConfig('[other]\ntype = local\n\n[drive_main]\ntype = drive\ntoken = {"fresh":true}\n', 'drive_main'))
      .toEqual({ type: 'drive', fields: { token: '{"fresh":true}' } });
    expect(() => parseRcloneConfig('[other]\ntype = local\n', 'drive_main')).toThrow();
  });

  it('rejects command-like remote names and traversal paths', () => {
    expect(assertRemoteName('dropbox-1')).toBe('dropbox-1');
    expect(() => assertRemoteName('remote: --config /tmp/x')).toThrow();
    expect(remotePath('mega', '/BackMyGit', 'owner/repo')).toBe('mega:BackMyGit/owner/repo');
    expect(() => remotePath('mega', '/BackMyGit', '../escape')).toThrow();
  });
});
