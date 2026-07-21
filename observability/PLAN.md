# Local observability plan

This stack is intentionally local and isolated from the miner runtime.

1. Define the architecture, directory layout, and JSONL event schema.
2. Add ClickHouse, Grafana, and Vector infrastructure configuration.
3. Add the ClickHouse event table and Grafana dashboards.
4. Document startup, source-file discovery, and troubleshooting.
5. Validate the configuration without running the miner test suite.

## Architecture

```text
wasm-machine.json  ─┐
                     ├─ Vector ─> ClickHouse ─> Grafana
cuda-machine.json  ─┘
```

- Vector tails existing and newly appended JSONL files without modifying them.
- The source filename becomes the `machine` label (`wasm-machine` or
  `cuda-machine`).
- ClickHouse stores the normalized event stream for time-range queries.
- Grafana provides dashboards and ad-hoc filtering.
- All service files, configuration, and persistent data live below this folder.

## Source configuration

The default source files are repository-root paths:

```text
../wasm-machine.json
../cuda-machine.json
```

They can later be overridden with environment variables or a small local
Vector config change. The files are JSONL even though the current filenames use
`.json`.

## Event contract

Every record has these common fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `ts` | ISO-8601 string | Event timestamp emitted by the miner |
| `event` | string | Event type |
| `machine` | string | Added by Vector from the source filename |
| `workerId` | string, nullable | Pool worker identity when available |
| `backend` | string, nullable | `wasm`, `native`, or `cuda` when available |

Important event-specific fields:

| Event | Fields |
| --- | --- |
| `hashrate` | `hps`, optional `height`, `workerId` |
| `cuda_pool_job` | `jobId` |
| `cuda_job` | local `token` |
| `cuda_batch` | `batch`, `workspaceMiB`, `freeMiB`, `totalMiB`, `reserveMiB`, `guardMiB` |
| `cuda_mode` | `persistent`, `iterations` |
| `nonce_slot_exhausted` | `message` |
| `share_accepted` / `share_rejected` | `accepted`, `result`, optional `workerId` |
| `block_found` | `message` and optional block metadata |
| `earnings` | `kind`, `earnedBrc`, `pendingBrc`, `paidBrc`, optional `shares` |
| `jackpot` | `finderBonusPct`, `yourBlockStrikes`, optional `lastWinner`, `lastStrikeHeight` |
| `message` / `grind_error` | `level`, `message` |

The ingestion layer must tolerate missing optional fields and preserve unknown
fields in a JSON column so future miner events do not require an immediate
schema migration.
