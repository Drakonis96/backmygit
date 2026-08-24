# Security and reverse-proxy guide

BackMyGit handles repository contents, cloud credentials, OAuth refresh tokens, and encryption keys. Treat the web interface, `/data`, and the backup directory as privileged infrastructure.

## Deployment checklist

1. Bind the published port to loopback or a private proxy network.
2. Terminate TLS at a maintained reverse proxy and set `PUBLIC_URL` to the exact HTTPS origin.
3. Set `FORCE_HTTPS=true`; set `TRUSTED_PROXIES` only to the proxy's exact IP or CIDR.
4. Keep the worker private. It has no HTTP listener and requires outbound access to GitHub and configured storage providers.
5. Make `BACKUP_HOST_PATH` writable by UID/GID 1000 and do not mount broader host paths.
6. Back up `/data` and `BACKUP_HOST_PATH`. Restrict both to administrators.
7. Use unique OAuth applications, minimum provider scopes, and rotate credentials after suspected exposure.
8. Keep client-side encryption enabled for destinations containing private material.
9. Generate an encrypted recovery kit, store its passphrase separately, and perform restore drills.
10. Pin a release image tag or digest and apply new releases promptly.

## Nginx example

```nginx
server {
    listen 443 ssl http2;
    server_name backups.example.com;

    ssl_certificate     /etc/letsencrypt/live/backups.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/backups.example.com/privkey.pem;

    client_max_body_size 2m;
    proxy_read_timeout 75s;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Example application settings when Nginx connects from loopback:

```env
PUBLIC_URL=https://backups.example.com
ALLOWED_HOSTS=backups.example.com
TRUSTED_PROXIES=127.0.0.1/32
FORCE_HTTPS=true
```

If Nginx runs in Docker, use the stable private network CIDR assigned to that network instead. Never trust forwarded headers from the public Internet.

## OAuth callbacks

BackMyGit never derives callback URLs from request headers. The callback is always:

```text
PUBLIC_URL/api/cloud/oauth/callback
```

Register that exact URI with Google, Dropbox, or Microsoft. OAuth state is random, stored only as a hash, expires after ten minutes, is bound to the initiating user and session, and is consumed once. PKCE S256 is used for every managed OAuth provider.

## Secrets and recovery

Managed rclone configurations and crypt keys are encrypted with AES-256-GCM under `/data/master.key`. Temporary rclone files use mode `0600` and are removed after each operation. OAuth-backed remotes are serialized across web and worker processes while rclone may rotate refresh tokens.

An exported recovery kit is independently encrypted with AES-256-GCM and a key derived from its passphrase with scrypt. Possession of both the kit and passphrase grants access to the exported cloud accounts and encrypted remote objects.

## Incident response

If the web application, database, master key, or recovery kit may have been exposed:

1. Remove public access and preserve logs and the audit trail.
2. Revoke all active sessions and change administrator passwords.
3. Revoke or rotate OAuth applications, provider tokens, MEGA credentials, and S3 keys.
4. Create new storage destinations with new crypt keys; old crypt passwords cannot be rotated in place without rewriting data.
5. Rebuild from a pinned clean image, restore trusted state, and verify several snapshots before resuming schedules.
