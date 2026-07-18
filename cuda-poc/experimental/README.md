# Experimental CUDA kernels

This directory is intentionally isolated from the stable CUDA helper and
library. Experiments here may change block layout, register ownership,
warp-shuffle usage, launch geometry, or synchronization strategy without
affecting the production `MINER_CUDA=1` path.

The first experiment is a register/warp-shuffle Argon2 permutation prototype.
The current stable kernel keeps the 128-word block in shared memory. The
experimental path will investigate keeping words in lane-owned registers and
exchanging operands with warp shuffles.

Build and run the isolated microbenchmark with:

```bash
make -C cuda-poc/experimental
make -C cuda-poc/experimental run
```

Set `WARP_G_ROUNDS` to change the repeated G-round count. The benchmark prints
shared versus shuffle timing and requires both outputs to match the host
reference before reporting a speedup.

The first correct shuffle prototype currently runs at 0.444x the shared-memory
reference. It is retained as a correctness baseline, not as a candidate for
production integration.

Run the complete automated exploration with:

```bash
make -C cuda-poc/experimental all-experiments
```

This also sweeps production batches from 256 upward in steps of 16, warming up
and measuring each batch for five seconds by default. Set
`CUDA_SWEEP_SECONDS=10` for longer per-batch measurements. Every sweep keeps at
least 2 GiB of free VRAM.

The sweep stops cleanly at the first batch that would cross the reserve; that
boundary is an expected result, not a failed experiment.

An experiment is eligible for integration only after it passes the existing
known-answer vectors, batched share checks, accepted-pool-share validation, the
2 GiB VRAM reserve rule, and a sustained benchmark against the stable baseline.

For a less order-biased comparison of the current safe candidates, run
`make -C cuda-poc/experimental focus`. It alternates batches 304, 320, and 336
for three 10-second trials and reports the mean and standard deviation. Set
`CUDA_FOCUS_SECONDS` and `CUDA_FOCUS_TRIALS` for longer measurements.

Run the complete cumulative optimization matrix with one command:

```bash
CUDA_CHECK_SECONDS=30 make -C cuda-poc/experimental optimization-suite
```

It builds and runs the stable baseline, Features 1 through 5 cumulatively,
and the best-kernel persistent comparison. Every stage uses the existing
known-answer, strict-target, batch, and VRAM checks before its sustained
measurement. Expect several minutes on the reference GPU.

The persistent prototype can be built and run independently with
`make -C cuda-poc/experimental persistent`. It is a benchmark only: it does
not submit shares and is not connected to the miner. It first measures the
stable batch-336 API in the same process, then runs the persistent kernel for
approximately the same duration and prints the speedup. It repeats three
comparisons by default; set `CUDA_COMPARE_TRIALS` to change that. The default
is 30 seconds per path; set `CUDA_COMPARE_SECONDS` to change it. Set
`CUDA_PERSISTENT_ITERATIONS` only when intentionally overriding the duration
matching.
