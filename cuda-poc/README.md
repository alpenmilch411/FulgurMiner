# CUDA Argon2 CUDA POC / library

This directory is intentionally isolated from the existing miner. It is the
staging area for the first CUDA milestone and does not alter BrowserCoin
consensus, networking, or the existing WASM/Rust engines.

The CLI exposes:

```text
brc-pow-cuda hash <148-byte-header-hex>
```

The device implementation must be Argon2id v1.3 with `m=32768 KiB`, `t=1`,
`p=1`, 32-byte output, raw salt `browsercoin-pow-v5`, and the raw 148-byte
header as password. Parity is not considered proven until the executable has
been compared byte-for-byte with both existing implementations.

The MIT-licensed `argon2-gpu` project was evaluated as a possible source. Its
CUDA kernel files carry GPL notices, so they are not copied here. A compatible
permissive/public-domain device implementation is required before this POC is
promoted into `native/brc-pow-cuda/`.

The current development environment has a usable NVIDIA device through CUDA
12.8. The standalone implementation and public library API have been
validated against the independent Rust reference on an RTX 5080.

## Device probe

Build and run the isolated probe with:

```bash
make
./device-probe
```

## CUDA implementation status

The current CUDA source contains the Argon2id H0 construction, Blake2b
expansion, memory-block permutation, indexed memory fill, a warp-cooperative
batch launcher, and a single-hash launcher. The all-zero known-answer digest
matches the independent Rust implementation:

```text
798c9d147dd12649520717917c1bb21168d604ac6971a85dc27b86988fedd74f
```

The reusable API is declared in `include/brc_argon_cuda.h` and built as
`libbrc-argon-cuda.a`. The context owns and reuses CUDA workspace across hash
and batch calls.

Build it with Make:

```bash
make library
make library-smoke
./library-smoke
```

Run the single-command CUDA validation suite with:

```bash
make cuda-check
```

It checks the known digest, batched share behavior, the strict-target
boundary, and a warmed-up throughput pass. The performance section warms up
for two batches, then runs for at least 30 seconds by default. The test chooses
its batch from current free VRAM and always preserves at least 2 GiB free, with
an additional 64 MiB safety cushion. `CUDA_CHECK_SECONDS` controls the minimum
measurement duration and `CUDA_CHECK_ROUNDS` sets a minimum number of measured
batches.

If Nsight Compute is installed, profile the warmed cooperative kernel with:

```bash
make cuda-profile
```

This writes `/tmp/fulgur-cuda-profile.ncu-rep` by default. Override the output
with `CUDA_PROFILE_OUT` or the profiling duration with `CUDA_PROFILE_SECONDS`.
If performance-counter permissions are unavailable, try the lighter launch
timing profile with `make cuda-profile-launch`; it may still provide kernel
duration and launch-geometry information.
If Nsight Compute cannot access performance counters, use Nsight Systems for a
CUDA API/kernel timeline:

```bash
make cuda-profile-timeline
```

This writes `/tmp/fulgur-cuda-timeline.qdrep` by default and can show kernel
durations, launch spacing, synchronization, and host/device overlap.
Summarize the generated report in the terminal with:

```bash
make cuda-profile-timeline-stats
```

Set `CUDA_PROFILE_REPORT` if the report was written elsewhere.

Or with CMake:

```bash
cmake -S . -B build -DCMAKE_CUDA_ARCHITECTURES=120
cmake --build build
```

On the current RTX 5080 development machine, CUDA 12.8 and native `sm_120`
are required. Build and run the explicit diagnostic with:

```bash
make diagnose
```

The hash command is:

```bash
make brc-pow-cuda
./brc-pow-cuda hash <148-byte-header-hex>
```

The correctness-first batched nonce command is:

```bash
./brc-pow-cuda mine <148-byte-header-hex> <nonce-start> <count> <target-hex>
```

The helper selects its batch from available VRAM, keeping a configurable
reserve. `MINER_CUDA_BATCH` may cap the selected batch, while `0` or an unset
value means automatic sizing; each nonce uses about 32 MiB of GPU workspace.
The nonce is inserted as a
big-endian `u32` at header offset 112, and a share is accepted only when the
32-byte digest is strictly less than the target interpreted as a big-endian
integer. The command prints `no-share` or the matching nonce and digest.

The standalone pool miner is intentionally not wired yet; networking follows
only after batched local mining and the reusable CUDA library boundary are
stable.

On WSL2, successful access normally requires a current Windows NVIDIA driver
with WSL GPU support. The session must expose `/dev/dxg`; `nvidia-smi` and the
probe must both report a device. Installing only the Linux CUDA toolkit is not
enough.
