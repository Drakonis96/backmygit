# BackMyGit

[![Release](https://img.shields.io/github/v/release/Drakonis96/backmygit)](https://github.com/Drakonis96/backmygit/releases/latest)
[![Docker](https://img.shields.io/docker/v/drakonis96/backmygit?label=docker)](https://hub.docker.com/r/drakonis96/backmygit)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-3f916c)](LICENSE)

BackMyGit is a self-hosted, authentication-free GitHub backup manager. It discovers public repositories in real time, creates verified and directly accessible Git backups, and manages persistent schedules, retention, history, and storage from a responsive English/Spanish interface.

## Table of Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Backup layout](#backup-layout)
- [Links](#links)

## Features

- Real-time public GitHub repository and branch discovery
- Atomic background backups with Git integrity checks and retry handling
- Daily, weekly, monthly, and interval schedules with location-based timezones
- Global and per-repository retention policies
- Filesystem reconciliation, backup browser, downloads, history, and storage insights
- Responsive light/dark UI in English and Spanish
- Transparent host storage: repository backups never live in a hidden Docker volume

## Screenshots

| Dashboard | Repositories |
| --- | --- |
| ![Dashboard](docs/screenshots/dashboard.png) | ![Repositories](docs/screenshots/repositories.png) |

| Backups | History |
| --- | --- |
| ![Backup manager](docs/screenshots/backups.png) | ![Execution history](docs/screenshots/history.png) |

| Storage | Settings |
| --- | --- |
| ![Storage management](docs/screenshots/storage.png) | ![Global settings](docs/screenshots/settings.png) |

## Quick start

Requirements: Docker Engine and Docker Compose v2.

```bash
git clone https://github.com/Drakonis96/backmygit.git
cd backmygit
cp .env.example .env
```

Set an absolute, writable backup directory in `.env`:

```env
BACKUP_HOST_PATH=/mnt/storage/github-backups
```

Then start BackMyGit and open [http://localhost:8787](http://localhost:8787):

```bash
mkdir -p /mnt/storage/github-backups
docker compose up -d
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKUP_HOST_PATH` | required | Host directory bind-mounted at `/backups` |
| `BACKMYGIT_IMAGE` | `drakonis96/backmygit:v0.1.0` | Published image to run |
| `APP_PORT` | `8787` | Web interface port |
| `WORKER_CONCURRENCY` | `2` | Concurrent jobs for different branches |
| `MIN_FREE_BYTES` | `536870912` | Free-space safety threshold |
| `GIT_TIMEOUT_MS` | `1800000` | Git command timeout in milliseconds |
| `APP_VERSION` | `0.1.0` | Version stored in backup metadata |

Application state is stored in the `app-data` volume. Actual backups are stored only in `BACKUP_HOST_PATH` and remain available if the container is stopped or removed.

## Backup layout

Every successful run creates a usable Git working copy with its `.git` directory and a `backup-metadata.json` file:

```text
BACKUP_HOST_PATH/
└── owner_repository/
    └── branch/
        └── YYYY-MM-DD_HH-mm-ss/
            ├── .git/
            ├── repository files…
            └── backup-metadata.json
```

Branch path separators are normalized safely; the exact original branch is preserved in metadata. Work is prepared under `/backups/.tmp` and moved into place only after verification.

## Links

- [Documentation](https://github.com/Drakonis96/backmygit#readme)
- [Releases](https://github.com/Drakonis96/backmygit/releases)
- [Docker Hub](https://hub.docker.com/r/drakonis96/backmygit)
- [Issues](https://github.com/Drakonis96/backmygit/issues)
- [License](LICENSE)

Location search uses the [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api).
