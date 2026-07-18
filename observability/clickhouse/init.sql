CREATE DATABASE IF NOT EXISTS miner;

CREATE TABLE IF NOT EXISTS miner.events
(
    ts DateTime64(3, 'UTC'),
    event LowCardinality(String),
    machine LowCardinality(String) DEFAULT '',
    source_file String DEFAULT '',
    level LowCardinality(String) DEFAULT '',
    message String DEFAULT '',
    workerId String DEFAULT '',
    backend LowCardinality(String) DEFAULT '',
    jobId String DEFAULT '',
    token UInt64 DEFAULT 0,
    hps Float64 DEFAULT 0,
    height UInt64 DEFAULT 0,
    difficultyHex String DEFAULT '',
    batch UInt64 DEFAULT 0,
    workspaceMiB UInt64 DEFAULT 0,
    freeMiB UInt64 DEFAULT 0,
    totalMiB UInt64 DEFAULT 0,
    reserveMiB UInt64 DEFAULT 0,
    guardMiB UInt64 DEFAULT 0,
    iterations UInt64 DEFAULT 0,
    accepted Bool DEFAULT false,
    result String DEFAULT '',
    earnedBrc Float64 DEFAULT 0,
    pendingBrc Float64 DEFAULT 0,
    paidBrc Float64 DEFAULT 0,
    finderBonusPct Float64 DEFAULT 0,
    yourBlockStrikes UInt64 DEFAULT 0,
    lastStrikeHeight UInt64 DEFAULT 0,
    raw_json String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (machine, event, ts);
