# Contributing to the Project

Thank you for your interest in contributing! We welcome contributions of all
kinds, including bug reports, feature requests, documentation improvements,
and code contributions. Please follow the guidelines below to ensure a smooth
contribution process.

## Building with Docker

To build and run the project using Docker, ensure you have Docker and Docker
Compose installed. Then, you can use the provided `docker-compose-local.yml`
file to spin up the application.

```bash
docker compose -f docker-compose-local.yml up --build
```

Just browse to `http://localhost:3000` to see the application in action.

## Building from scratch on your local machine

(Note: the docker build is _so_ fast that it's often easier to just use that for
testing changes, but if you want to build and run locally, here's how.)

```bash
npm install
npm run build
npm start
```

Open your browser to `http://localhost:3000` to view the most recent rendered
PNG (also available at `/map.png`). The interactive management UI now lives at
`http://localhost:3000/manage`. By default the server reads
`/app/data/config.yaml` and `/app/data/background.png`. The
repository’s `data/` directory is copied into that location during Docker
builds and is bind-mounted via `docker-compose.yml` for local development. If
you prefer to run `npm start` directly, create a symlink or bind mount so that
`/app/data` points to your desired config folder.

- `PORT` – port for the HTTP/WebSocket server (defaults to `3000`)
