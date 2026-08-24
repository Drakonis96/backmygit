const remoteNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const fieldNamePattern = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface ManagedRcloneConfig {
  type: string;
  fields: Record<string, string>;
}

export function assertRemoteName(value: string): string {
  if (!remoteNamePattern.test(value)) throw new Error('Invalid rclone remote name');
  return value;
}

export function renderRcloneConfig(remoteName: string, remote: ManagedRcloneConfig): string {
  assertRemoteName(remoteName);
  if (!fieldNamePattern.test(remote.type)) throw new Error('Invalid rclone provider type');
  const lines = [`[${remoteName}]`, `type = ${remote.type}`];
  for (const [key, value] of Object.entries(remote.fields).sort(([left], [right]) => left.localeCompare(right))) {
    if (!fieldNamePattern.test(key) || /[\r\n\0]/.test(value)) throw new Error('Invalid rclone configuration field');
    lines.push(`${key} = ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseRcloneConfig(source: string, remoteName: string): ManagedRcloneConfig {
  assertRemoteName(remoteName);
  if (source.length > 10 * 1024 * 1024) throw new Error('The rclone configuration file is too large');
  let active = false;
  const fields: Record<string, string> = {};
  let type = '';
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[([^\]]+)]$/.exec(line);
    if (section) {
      active = section[1] === remoteName;
      continue;
    }
    if (!active) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!fieldNamePattern.test(key) || /[\r\n\0]/.test(value)) throw new Error('Invalid rclone configuration field');
    if (key === 'type') type = value;
    else fields[key] = value;
  }
  if (!fieldNamePattern.test(type)) throw new Error(`The rclone remote ${remoteName} is unavailable`);
  return { type, fields };
}

export function remotePath(remoteName: string, rootPath: string, relative = ''): string {
  assertRemoteName(remoteName);
  const normalized = normalizeRemoteSubpath([rootPath, relative].join('/'));
  return `${remoteName}:${normalized}`;
}

export function normalizeRemoteSubpath(value: string): string {
  if (value.length > 1024 || /[\r\n\0:]/.test(value))
    throw Object.assign(new Error('Invalid remote folder path'), { status: 400 });
  const parts = value.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..'))
    throw Object.assign(new Error('Invalid remote folder path'), { status: 400 });
  return parts.join('/');
}
