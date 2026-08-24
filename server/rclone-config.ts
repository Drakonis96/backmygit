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

export function remotePath(remoteName: string, rootPath: string, relative = ''): string {
  assertRemoteName(remoteName);
  const normalized = [rootPath, relative]
    .join('/')
    .split('/')
    .filter(part => part && part !== '.')
    .map(part => {
      if (part === '..' || /[\r\n\0]/.test(part)) throw new Error('Invalid remote path');
      return part;
    })
    .join('/');
  return `${remoteName}:${normalized}`;
}
