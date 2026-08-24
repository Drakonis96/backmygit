import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const [{ db }, secrets, rclone] = await Promise.all([
  import('/app/dist-server/db.js'),
  import('/app/dist-server/secrets.js'),
  import('/app/dist-server/rclone.js'),
]);

const now = new Date().toISOString();
const source = '/data/crypt-test-source.tar.zst';
const plaintext = 'BackMyGit crypt integration payload that must not appear remotely';
await fs.writeFile(source, plaintext);
await secrets.ensureMasterKey();
db.prepare(`INSERT INTO cloud_connections(id,name,provider,remote_name,auth_type,status,managed,created_at,updated_at)
  VALUES('crypt-connection','Crypt test','external','local_test','external','connected',0,?,?)`).run(now, now);
db.prepare(`INSERT INTO storage_targets(id,connection_id,kind,name,root_path,encryption_mode,created_at,updated_at)
  VALUES('crypt-target','crypt-connection','rclone','Crypt target','encrypted','crypt',?,?)`).run(now, now);
await secrets.putSecret('target', 'crypt-target', 'crypt', {
  password: await rclone.obscureRcloneSecret('container-test-password-primary'),
  password2: await rclone.obscureRcloneSecret('container-test-password-salt'),
});
await rclone.withTargetRcloneConfig(
  { id: 'crypt-connection', remote_name: 'local_test', managed: 0 },
  { id: 'crypt-target', root_path: 'encrypted', encryption_mode: 'crypt' },
  async target => {
    const destination = rclone.remotePath(target.remoteName, target.rootPath, 'owner/repository/snapshot.tar.zst');
    let progressBytes = 0;
    const streamed = await rclone.runRcloneStreaming(['copyto', source, destination], {
      configPath: target.configPath,
      statsInterval: '10ms',
      onProgress: progress => { progressBytes = Math.max(progressBytes, progress.bytes); },
    });
    if (progressBytes < Buffer.byteLength(plaintext)) throw new Error(`rclone streaming progress was not parsed: ${streamed.stderr}`);
    const { stdout } = await rclone.runRclone(['hashsum', 'SHA-256', '--download', destination], { configPath: target.configPath });
    const expected = createHash('sha256').update(plaintext).digest('hex');
    if (!stdout.startsWith(expected)) throw new Error('crypt remote did not return the plaintext SHA-256');
  },
);
const remoteBase = '/remote-parent/encrypted';
const entries = await fs.readdir(remoteBase, { recursive: true, withFileTypes: true });
const files = entries.filter(entry => entry.isFile());
if (!files.length) throw new Error('crypt remote did not create an encrypted object');
if (entries.some(entry => ['owner', 'repository', 'snapshot.tar.zst'].includes(entry.name)))
  throw new Error('crypt remote exposed a plaintext path component');
for (const entry of files) {
  const parent = entry.parentPath || entry.path;
  const content = await fs.readFile(path.join(parent, entry.name));
  if (content.includes(Buffer.from(plaintext))) throw new Error('crypt remote exposed plaintext content');
}
db.close();
console.log('Crypt container test passed: names and contents encrypted, download SHA-256 verified.');
