# FulgurMiner observability

This directory contains a local Vector → ClickHouse → Grafana stack for the
miner's JSONL session logs.

Start miners with session logging enabled, for example:

```bash
MINER_LOG_DIR=logs npm run mine
```

The current two manually named files at the repository root are also supported
as sources during development:

```text
../wasm-machine.json
../cuda-machine.json
```

Do not put credentials, wallet private keys, or pool API secrets in these logs.

## Start the stack

From this directory:

```bash
docker compose up -d
```

Open Grafana at `http://localhost:3000` and sign in with `admin` / `admin` by
default. Set `GRAFANA_ADMIN_PASSWORD` before starting the stack to use a
different password.

ClickHouse uses the local `vector` user with password `vector-local` by
default. Set `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD` in
`observability/.env` before first startup if you want different credentials.
The provisioned Grafana datasource and Vector sink use those same credentials;
after changing them, recreate the services so the datasource is reprovisioned.

The pre-provisioned dashboard is `FulgurMiner Overview`. Vector reads the two
root files from the repository and follows appended records. It also reads
timestamped files created by `MINER_LOG_DIR=logs` automatically.

Useful checks:

```bash
docker compose ps
docker compose logs -f vector
curl http://localhost:8123/ping
```

Stop services while keeping their data:

```bash
docker compose down
```

The ClickHouse and Grafana volumes are managed by Compose. Do not commit or
copy those volumes into the repository.
