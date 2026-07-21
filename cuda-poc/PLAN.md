# CUDA POC plan

## Scope and integration decision

The CUDA proof-of-work is now correct and has a reusable static-library API.
The next workstream should integrate it into the existing npm miner rather
than recreate pool communication under `cuda-poc/`.

The existing `src/minerd/poolClient.ts` already owns the production protocol:
registration, `/job` polling/long-polling, nonce-slot validation, stale-job
handling, `/share` submission, retry/backoff, share dispatch, reporting, and
shutdown. `GrindPool` and `NativeGrindPool` already establish the intended
engine boundary. CUDA should add a third implementation of that boundary,
with the pool client remaining the single source of truth for networking.

`cuda-poc/` remains the CUDA implementation and helper/bridge staging area.
It may modify the main miner only where required to add the CUDA engine
selector and adapter. Do not run npm tests during this workstream.

The production path and experimental kernels should remain separable. Future
high-risk kernel work should live under a dedicated experimental POC directory
or target, with its own executable and benchmark, and should not replace the
stable helper/library until known vectors, accepted shares, VRAM safety, and
long-run throughput all pass. A future `CUDA_EXPERIMENTAL=1` selector can make
that path opt-in without changing the default engine.

### Feasibility assessment

This is a moderate adapter/build task, not a protocol rewrite. The main
unknown is the Node-to-CUDA process boundary: the current C API is a static
library and `brc-argon-local` performs bounded batches, while the TypeScript
pool interface needs long-lived start/stop, progress, throttle, exhaustion,
and repeated share callbacks. The preferred solution is a small long-lived
CUDA helper process using the existing C API and a strict line protocol,
wrapped by `CudaGrindPool` with the same public interface as the WASM/Rust
grinders. A native Node addon or FFI layer is not required for the first
integration.

Fallback: if the helper cannot provide reliable cancellation, restart,
backpressure, or acceptable throughput without a disproportionate amount of
work, keep the CUDA API and local miner intact and implement the standalone
pool-facing path in `cuda-poc` instead. That fallback still reuses the npm
client only if a clean adapter boundary remains possible; it does not justify
duplicating the pool protocol prematurely.

## Milestones

1. **Define the consensus contract**
   - Inspect the existing WASM/Rust implementations and record exact input
     framing, byte order, nonce placement, target comparison, and output
     encoding.
   - Establish known-answer vectors.

   Confirmed contract from the existing implementation:
   - The password is the raw 148-byte encoded header.
   - Header integers and the nonce are big-endian; the nonce is a `u32` at
     byte offset 112.
   - A digest is valid when its 32 bytes, interpreted as a big-endian integer,
     are strictly less than the target.
   - Pool registration is `POST /register` with `payoutAddress` and
     `minerVersion`, returning `workerId`.
   - Work is `GET /job?workerId=...` and contains `jobId`, `headerHex`,
     `shareTargetHex`, `nonceStart`, and `nonceEnd`.
   - Shares are `POST /share` with `workerId`, `jobId`, and `nonce`.
   - The CUDA miner must discard stale jobs and retry transient or ambiguous
     pool failures without silently losing valid shares.

2. **Implement and verify the CUDA proof of work**
   - Implement Argon2id v1.3 with `m=32768 KiB`, `t=1`, `p=1`, 32-byte output.
   - Use salt `browsercoin-pow-v5` and the raw 148-byte header as password.
   - Add a standalone `brc-pow-cuda hash <148-byte-header-hex>` command.
   - Compare results byte-for-byte with the known-answer vectors.

   Development note: this host currently exposes `libargon2.so.1` with the
   `argon2id_hash_raw` ABI but no headers. It may be used only as a temporary
   local oracle for generating vectors. The CUDA miner must not depend on that
   host library at runtime.

3. **Finish the CUDA engine boundary**
   - Extend the reusable API for the integration’s required lifecycle:
     persistent context/workspace, bounded batch scanning, strict target
     comparison, clean stop, and deterministic result reporting.
   - Add a long-lived CUDA helper command that accepts header/target/range
     work, emits solved nonce/digest and hashrate records, accepts throttle
     updates, and exits cleanly on stop or job replacement.
   - Keep the helper protocol machine-readable and versioned enough to reject
     incompatible binaries; never let malformed helper output become a share.

4. **Add CUDA as a drop-in npm mining method**
   - Implement `CudaGrindPool` with the same `start`, `stop`, `setThrottle`,
     and lifecycle/error semantics used by `GrindPool` and `NativeGrindPool`.
   - Preserve the pool client unchanged for registration, jobs, slots, stale
     work, retries, share queueing, reporting, and shutdown.
   - Add an explicit CUDA engine selector/configuration and status label. CUDA
     must be opt-in and fall back to WASM when CUDA, the helper, or the
     required architecture is unavailable; it must never silently mine the
     pool-assigned slot as full nonce space.
   - Decide whether one CUDA helper owns the assigned slot or whether multiple
     helpers are beneficial only after measuring persistent-context throughput.
   - Keep wallet/address handling limited to the public payout address; never
     handle private keys.

5. **Validate integration without running the test suite**
   - Use existing known-answer vectors and the CUDA library smoke tooling for
     byte parity, nonce placement, target strictness, slot boundaries, and
     lowest-hit behavior.
   - Exercise helper start/stop, job replacement, malformed output, process
     failure, throttle updates, and no-share exhaustion with focused manual
     smoke commands or a small standalone harness. Do not run npm tests.
   - Perform one controlled pool-compatible request-flow check using the
     existing client seams only after the CUDA adapter is stable.

6. **Validate on the actual NVIDIA environment**
   - With approved host access, record driver, GPU, compute capability, CUDA,
     and `/dev/dxg` visibility.
   - Run device probing, hash parity, and a small end-to-end mining test.
   - Do not claim parity or mining capability until those checks pass.

7. **Optimize and document**
   - Add batching and throughput measurements only after correctness.
   - Document build/run commands, GPU requirements, limitations, and the exact
     protocol assumptions.

8. **Extract a publishable CUDA Argon library**
   - Keep the reusable Argon2id CUDA implementation separate from
     BrowserCoin-specific pool and header logic.
   - Define a small stable API for initialization, batched hashing, nonce
     scanning, target comparison, device selection, and cleanup.
   - Separate public headers from CUDA implementation details and avoid a
     runtime dependency on the host `libargon2` oracle.
   - Add reproducible builds, known-answer tests, CUDA capability checks,
     versioning, licensing/third-party notices, and package documentation.
   - Decide whether the first release is a source library, a static library,
     or both; keep npm bindings as a later consumer rather than part of the
     initial CUDA library release.

## Current position

Milestones 1 and 2 are complete. The repository contains the CUDA device
probe, standalone hash command, independent Rust/OpenSSL diagnostics,
Makefile, README, and this plan. The system `nvcc` is 12.0, while CUDA 12.8
is available at `/usr/local/cuda-12.8`; the approved host environment is an
NVIDIA GeForce RTX 5080, driver 610.47, compute capability 12.0, with about
16 GiB VRAM. The host has readable `/dev/dxg` visibility, while sandbox-local
checks are not authoritative for host GPU visibility.

The CUDA implementation now matches the independent Rust Argon2 reference for
H0, initial blocks, data-independent and data-dependent memory-fill
boundaries, the final memory block, and the complete 32-byte digest. The
all-zero known-answer vector produces:

    798c9d147dd12649520717917c1bb21168d604ac6971a85dc27b86988fedd74f

The finalization path supports multi-block BLAKE2b input. `make diagnose`
passes on the RTX 5080, and the Makefile defaults to CUDA 12.8 / `sm_120`.

The correctness-first batched nonce kernel is now present and validated with
one- and two-nonce batches. It inserts the nonce as big-endian bytes at offset
112, performs strict big-endian target comparison, and reports the lowest
valid nonce and its digest deterministically. The equality boundary was
tested and correctly returns `no-share`.

The current `make bench` timings are end-to-end smoke timings: about 1.05
seconds for one nonce, 1.04 seconds for two nonces, and 1.06 seconds for
eight nonces. They include process startup, CUDA context setup, allocation,
and cleanup, so they are not performance claims. A persistent in-process
benchmark that reuses allocations is required before selecting a production
batch size or reporting GPU throughput. Larger batches can be evaluated after
that benchmark and the reusable API extraction.

The persistent benchmark now measures the repeated kernel loop. It reports both
host-wall-clock throughput and CUDA-event device throughput, so launch and
runtime synchronization overhead can be separated from kernel execution.
Older results are host-wall-clock measurements:
8 nonces × 3 rounds in 1.086 seconds (22.1 hashes/second), 64 nonces × 2
rounds in 1.150 seconds (111.3 hashes/second), and 128 nonces × 2 rounds in
1.159 seconds (220.9 hashes/second). Throughput scales nearly linearly with
the number of serial per-nonce threads, confirming that the GPU is not yet
saturated; these are not final hardware capability numbers.

The repeatable validation command is `make -C cuda-poc cuda-check`. It checks
the known digest vector, batch/share behavior, strict-target boundaries, and a
short throughput pass. It computes the largest test batch from current free
VRAM while reserving at least 2 GiB plus a 64 MiB safety cushion, then verifies
that at least 2 GiB remains free after validation. `CUDA_CHECK_ROUNDS` controls
the number of performance rounds. The performance portion warms up for two
batches and then measures for at least 30 seconds by default; `CUDA_CHECK_SECONDS`
can adjust that duration, while `CUDA_CHECK_ROUNDS` sets a minimum of 10 measured
rounds by default.

A warp-cooperative batch path now reproduces the known digest for nonce 0 and
reaches 521.8 hashes/second for 128 nonces × 2 rounds, about 2.36× faster than
the prior serial-thread path. That workload launches 4,096 threads while
using about 4 GiB of workspace, making it the current performance baseline.

The first public API draft is in `include/brc_argon_cuda.h`. It defines an
opaque CUDA context, single-header hashing, bounded batch mining, a share
result type, and thread-local error reporting. The implementation and build
packaging still need to be extracted from the CLI harness.

The implementation is now available as `libbrc-argon-cuda.a`, and
`library-smoke` has independently verified the public hash and batch-mining
calls against the known digest. The first API implementation still allocates
and frees per call; context-owned workspace reuse, packaging metadata, and
additional API tests remain.

Context-owned workspace reuse is now implemented. The enhanced smoke test
verifies the known digest, a valid share, digest propagation, and strict
equality rejection across repeated calls. Make-based library packaging is
working; CMake metadata is present but cannot yet be configured on this host
because `cmake` is not installed.

Next task: build a standalone local mining loop on top of the reusable API.
It will scan contiguous nonce batches, stop on a valid result or explicit
shutdown, report progress, and remain independent of pool networking. Pool
networking and npm bindings remain deferred until this local loop is validated.

The standalone `brc-argon-local` loop is now implemented and its one-batch
known-answer smoke test found nonce 0 through the public library API. A
no-share bounded run and signal/clean-stop behavior remain to be regression
tested before pool protocol work begins.

The bounded no-share run is now also validated: an all-zero target completes
one 128-nonce batch, reports progress/throughput, and stops without claiming a
share. The standalone CUDA core, reusable static library, and local miner are
therefore ready for the engine adapter.

Repository inspection confirms that pool integration does not need a new HTTP
client or JSON implementation. `src/minerd/poolClient.ts` already constructs
the WASM or Rust grinder, passes the pool-assigned `[nonceStart, nonceEnd)`
slot, continuously dispatches solved shares, and handles retries and job
identity changes. The CUDA adapter should plug in at that construction point.

The persistent helper is now implemented as `cuda_helper.cpp` and built by
`make -C cuda-poc cuda-helper`. Its line protocol accepts `START`,
`THROTTLE`, `STOP`, and `QUIT`, and emits `SOLVED`, `EXHAUSTED`, `HASHRATE`,
and `ERROR` records. It keeps one CUDA context alive and scans the complete
pool-assigned slot in batches of up to 192 nonces.

`src/minerd/cudaGrindPool.ts` now adapts that helper to the existing grinder
surface. `poolClient.ts` selects it when `MINER_CUDA=1`, preserves all existing
registration/job/share behavior, and falls back to WASM when the helper is
missing. README configuration and build instructions are present.

CUDA batch sizing is now configurable with `MINER_CUDA_BATCH` from 1 to 256.
Each batch item reserves one 32 MiB Argon2 workspace, so the maximum batch
uses about 8 GiB and launches up to 8,192 cooperative CUDA threads. The CUDA
path still uses one helper/context; `MINER_WORKERS` remains a CPU setting.
The helper now honors `MINER_CUDA_DEVICE` and exposes `--info`, so multi-GPU
hosts can verify and select the intended card explicitly.

## VRAM-first automatic batch sizing

VRAM availability is now the authoritative safety limit so more capable cards
can use larger batches while smaller or shared cards automatically remain
safe.

Implemented behavior:

- `MINER_CUDA_BATCH` is now an optional requested cap; unset/`0` means auto.
- The fixed 256 batch ceiling has been removed from the public API and helper.
- `MINER_CUDA_VRAM_MAX_MIB` optionally caps total GPU memory usage.
- `MINER_CUDA_VRAM_RESERVE_MIB` defaults to 1024 MiB for Windows, WSL,
  display workloads, and other CUDA applications.
- The helper accounts for current device usage and selects the largest fitting
  batch before allocation.
- The helper reports the selected batch, workspace estimate, free VRAM, total
  VRAM, and reserve.
- The helper rechecks VRAM every 30 seconds, changes capacity only when the
  candidate differs by at least 16 nonces, and trims released workspace before
  continuing.
- Dynamic digest/result buffers and transactional workspace replacement are
  implemented.

Remaining safety work:

- Handle a late allocation failure as a reduced-batch retry or controlled
  fallback rather than a helper restart loop.
- Add direct C API free-memory validation for callers other than the helper.
- Revalidate very large launch geometry and profile larger-card behavior.

The observed RTX 5080 baseline to preserve is batch 256 at approximately
1,024 reported H/s and 13.1 GiB total GPU memory usage, including the roughly
4.5 GiB system baseline. This workstream should be implemented and measured
before raising the batch size further.

## Optimization assessment

The latest RTX 5080 observation was approximately 99% reported GPU
utilization, 160 W of a 360 W board limit, and 13.1 GiB total VRAM usage. This
means the kernels are continuously active but the board is not power-limited.
The low power relative to the board limit suggests dependency, memory-latency,
warp-efficiency, or occupancy stalls rather than a saturated arithmetic path.
The utilization percentage alone is not an efficiency measure.

The host-side pool communication is not the likely bottleneck: each batch only
copies a 148-byte header, a 32-byte target, and small result buffers. The main
optimization target is the warp-cooperative Argon2 implementation:

The CUDA API now also reuses its host-side digest and validity buffers between
batches. This removes repeated CPU allocator work from the hot loop; the
transfers themselves remain small and synchronous.

- `round16()` performs most of its work in eight lanes while the rest of the
  warp waits.
- Repeated `__syncwarp()` barriers serialize the dependent memory-fill loop.
- Argon2 reference-block selection is random and latency-sensitive.
- Shared `CoopState` and register pressure may limit active warps even when the
  device reports high utilization.
- H0 construction, finalization, host copies, and kernel-launch overhead are
  expected to be secondary because each batch performs substantial memory-hard
  work.

The next optimization sequence is:

1. CUDA-event timing is now available in the persistent `bench` command; use
   its `device_hashes_per_sec` field for kernel comparisons instead of the
   helper's one-second, whole-batch hashrate reporting.
2. Capture Nsight Compute/System metrics for achieved occupancy, warp stall
   reasons, global-memory throughput, instruction throughput, and barrier cost.
3. The first warp-mapping prototype is now implemented in `fill_block_coop()`.
   It distributes the row and column G operations across the warp with explicit
   barriers between dependent phases. It still uses the existing shared state,
   so it is a focused optimization experiment rather than the final layout.
4. Re-measure correctness vectors, accepted shares, VRAM, power, and H/s at
   batches 128, 192, 256, and the later VRAM-selected sizes.

The automated correctness, VRAM-safety, and performance check is implemented
in `cuda_validation.cpp` and exposed through the single `cuda-check` target.

Compiler resource inspection showed the cooperative kernel reaching 255
registers per thread with spills and 12.6 KiB shared memory per block. A
follow-up change moved the per-thread header and digest temporaries into the
per-warp shared state/output path; runtime throughput validation is still
required before treating that register-pressure reduction as an improvement.

Nsight Compute is installed in the development environment, but its CUDA driver
connection is unavailable there because only a stub `libcuda` is exposed. The
reproducible `make -C cuda-poc cuda-profile` target is therefore intended to be
run on the RTX host; it profiles the warmed cooperative kernel and writes an
`.ncu-rep` report while retaining the validation program's 2 GiB VRAM reserve.
The RTX host also lacks NVIDIA performance-counter permission, including for
the lighter LaunchStats section. `make -C cuda-poc cuda-profile-timeline` now
provides an Nsight Systems fallback for CUDA API/kernel durations and launch
spacing that does not depend on those counters.
On the RTX host, that fallback records CUDA API waits but still omits kernel
and GPU-memory activity records, even with CUDA memory tracking enabled. The
available evidence is nevertheless sufficient to rule out host communication,
launches, and result copies as the dominant bottleneck; further gains should
target the cooperative kernel's memory dependency, synchronization, and
register/shared-state behavior.

Before profiling, a 1.2x–1.5x improvement is plausible; 1.5x–2x is possible
if the warp redesign improves both arithmetic utilization and dependency
handling. Higher gains are speculative because Argon2's memory dependencies
remain part of the consensus algorithm. Running multiple CUDA processes is
not an optimization path: the batch-64 contention experiment reduced total
throughput to roughly the single-process batch-64 rate.

Observed throughput and hardware measurements are recorded in
[`BENCHMARKS.md`](BENCHMARKS.md). The current baseline is batch 256 at about
2,041 sustained validation H/s on the RTX 5080, using about 13.1 GiB total GPU
memory including the system baseline. The next optimization comparison must use
precise CUDA timing or profiler metrics in addition to the pool display.

The warp-mapping prototype builds successfully, passes the known digest and
accepted-share validation, and improved the sustained validation rate by about
5.5%. The manual helper smoke
reached CUDA initialization but this sandbox reports `CUDA driver version is
insufficient for CUDA runtime version`; an actual compatible NVIDIA runtime
still needs to validate digest parity and sustained throughput. The remaining
work is runtime validation, selector/UI polish, and packaging—not a new pool
protocol.

The attempted fine-tuning experiment that removed barriers between the two
disjoint row groups and the two disjoint column groups was not a confirmed
improvement and has been reverted. The restored baseline keeps the explicit
barriers between all group phases while retaining the successful register/
temporary-storage reduction.
