# Changelog

## 0.2.0 - 2026-08-24

- Add independently verified multi-destination replication through rclone.
- Add Google Drive, Dropbox, and OneDrive OAuth with PKCE and encrypted refresh-token persistence.
- Add MEGA, S3-compatible, and existing-rclone connections with a remote folder browser.
- Add optional per-destination rclone crypt encryption.
- Add persisted transfer progress, retries, leases, idempotent publication, and remote retention.
- Fence expired worker attempts and persist deletion intent so crashes and active uploads cannot orphan remote data.
- Add verified cloud restore, security audit history, and passphrase-encrypted recovery kits.
- Add mandatory authentication, role-based authorization, CSRF protection, proxy/host validation, and hardened containers.
- Add S3 endpoint SSRF checks, OAuth secret revision fencing, temporary-object cleanup, and a vulnerability-free runtime scan.
- Migrate legacy backups to canonical snapshots and independently tracked replicas without removing historical records.

## 0.1.0

- Initial release.
