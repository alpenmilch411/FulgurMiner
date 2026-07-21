# CUDA benchmark log

These are end-to-end mining observations from the persistent CUDA helper and
pool client. The displayed pool hashrate is reported in roughly one-second
windows using whole completed batches, so values are quantized and should not
be treated as precise profiler measurements.

The helper's persistent `bench` command now also reports
`device_hashes_per_sec`, measured with CUDA events around the repeated kernel
launches. Use that value for kernel-to-kernel comparisons;
`host_hashes_per_sec` still includes host-side synchronization and result-copy
overhead.

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

The automated validation run on the same RTX 5080 completed all correctness
checks with a 2 GiB minimum VRAM reserve. After two warmup batches, 76 measured
batch-256 rounds ran for 10.06 seconds at approximately **1,934 host H/s**.
The test reported 14,953 MiB free before allocation and 6,107 MiB free after
the 8 GiB CUDA workspace was active; both values account for the existing
desktop/system GPU usage.

After moving the per-thread header and digest temporaries out of local storage,
the same validation command measured 80 batch-256 rounds in 10.03 seconds at
approximately **2,040.89 H/s**, a **5.5% improvement** over the previous
1,934.08 H/s baseline. The known-vector, batch, strict-target, and VRAM
reserve checks remained successful.

A 20.06-second run under Nsight Compute produced 2,003.27 H/s over 157
batch-256 rounds. This is approximately 1.8% below the normal 2,040.89 H/s
run and is retained only as a profiling reference; profiler instrumentation
must not be used as the production throughput baseline. Nsight reported
`ERR_NVGPUCTRPERM`, so no performance-counter metrics were collected.

Nsight Systems profiling succeeded without that permission. Its 20.03-second
run measured 159 batch-256 rounds at approximately **2,032.55 H/s** and
generated the CUDA timeline report; this is within normal run-to-run variation
of the 2,040.89 H/s non-profiled result.

The regenerated timeline with CUDA memory tracking measured 20.11 seconds at
**2,010.91 H/s**. Its API summary attributed 97.0% of traced time to
`cudaDeviceSynchronize`, 0.7% to `cudaMemcpy`, and 0.2% to kernel launch calls.
The report still contained no kernel or GPU-memory activity records, so those
percentages describe host API waiting, not the internal GPU stall breakdown.

After restoring the barrier configuration, a 30.11-second non-profiled run
measured **1,930.20 H/s** with all correctness and VRAM checks passing. Recent
30-second results range from roughly 1.86 to 2.04 kH/s, so future optimization
comparisons should use repeated trials or a longer window rather than a single
short run.

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
