# CUDA benchmark log

These are end-to-end mining observations from the persistent CUDA helper and
pool client. The displayed pool hashrate is reported in roughly one-second
windows using whole completed batches, so values are quantized and should not
be treated as precise profiler measurements.

## Hardware and runtime

- GPU: NVIDIA GeForce RTX 5080
- Reported VRAM: 16,303 MiB
- NVIDIA-SMI: 610.43.02
- KMD driver: 610.47
- CUDA UMD: 13.3
- Build toolkit: CUDA 12.8
- Build architecture: `sm_120`
- Observed baseline non-miner GPU memory: approximately 4.5 GiB

## Single-process results

Configuration: `MINER_CUDA=1`, `MINER_CUDA_DEVICE=0`,
`MINER_SMART=off`, `MINER_THROTTLE=1`, one mining process.

| Batch | Reported hashrate | Approx. CUDA workspace | Approx. launched threads |
|---:|---:|---:|---:|
| 32 | 180 H/s observed in an earlier run | 1 GiB | 1,024 |
| 64 | 320 H/s | 2 GiB | 2,048 |
| 96 | 384 H/s | 3 GiB | 3,072 |
| 128 | 512 H/s | 4 GiB | 4,096 |
| 144 | 576 H/s | 4.5 GiB | 4,608 |
| 160 | 640 H/s | 5 GiB | 5,120 |
| 192 | 768 H/s | 6 GiB | 6,144 |
| 256 | 1,024 H/s | 8 GiB | 8,192 |

At batch 256, total reported GPU memory usage was approximately 13.1 GiB,
including the approximately 4.5 GiB system/desktop baseline. GPU utilization
was observed at 99%, with approximately 106 W reported usage.

Accepted pool shares have been observed with the CUDA path, confirming that
the produced nonces and digests are valid under the pool protocol.

## Multi-process contention

Two CUDA helpers did not add throughput. For example, one batch-64 process
reported approximately 256 H/s while a second batch-64 process reported
approximately 64 H/s, for about 320 H/s total. This matched the throughput of
one batch-64 process and was below one batch-128 process at approximately
512 H/s. The GPU was already saturated; the second context competed for the
same memory bandwidth and execution resources.

## Optimization estimate

The current warp-cooperative kernel leaves substantial implementation-level
headroom: `round16()` performs most of its work in only eight lanes, while
the rest of the warp waits at synchronization points. Argon2's dependent and
random memory accesses prevent ideal scaling, so the unused lanes do not
translate directly into a 4x projection.

Before profiling, a reasonable expectation is:

- 1.2x–1.5x: plausible from focused warp/permutation and synchronization work.
- 1.5x–2x: achievable if the revised mapping improves both arithmetic
  utilization and memory behavior.
- Above 2x: possible but speculative; it requires measurement and may be
  limited by Argon2's random global-memory dependency pattern.

The next comparison should use CUDA-event timing or Nsight metrics rather than
the pool's quantized one-second hashrate display. Batch 256 / approximately
1,024 H/s is the current production-integration baseline.
