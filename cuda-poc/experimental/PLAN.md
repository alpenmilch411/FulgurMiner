# Experimental CUDA plan

## 1. Register/shuffle permutation

Build a standalone microbenchmark for the Argon2 BlaMka permutation:

- shared-memory reference implementation matching the stable mapping;
- lane-owned register implementation using `__shfl_sync`;
- deterministic host-side comparison for every output word;
- CUDA-event timing at representative warp counts.

The microbenchmark is not a consensus implementation. It only answers whether
shared-memory traffic and barriers can be reduced without guessing from pool
hashrate output.

Initial result: the outputs match the host reference, but the naive shuffle
mapping reaches only 0.444x the shared-memory reference speed at 10,000 rounds
(216.6M versus 488.2M G-rounds/s). This direct mapping is rejected. Any future
shuffle design must reduce exchange count substantially, likely through a
hybrid layout or warp ownership scheme, before a full-hash prototype is worth
building.

## 2. Full-hash integration prototype

If the permutation benchmark wins, copy the design into a separate full Argon2
kernel and validate it against all existing vectors. Keep the stable helper
binary and `CudaGrindPool` unchanged while this work proceeds.

## 3. Longer-run validation

The experimental executable must preserve at least 2 GiB of free VRAM, run for
at least 30 seconds after warmup, and report mean/min/max throughput across
multiple trials before any production decision.

Other candidates after the shuffle prototype are persistent kernels, larger
auto-selected batches, and architecture-specific BlaMka instruction tuning.

The first batch sweep reached 336 nonces at about 2.38 kH/s while preserving
2 GiB free, and stopped at 352 because the reserve would be crossed. The
nominal 32 MiB-per-nonce selector estimate was optimistic by roughly 1.8 GiB
on this RTX/driver combination; production sizing needs an allocation-overhead
calibration or a post-allocation reserve check before trusting larger batches.

Focused 30-second trials confirm that 336 is the best safe batch on this
system:

| Batch | Mean H/s | Stddev | Free VRAM |
| ---: | ---: | ---: | ---: |
| 304 | 2272.71 | 70.66 | 4875 MiB |
| 320 | 2326.79 | 95.91 | 2997 MiB |
| 336 | 2473.24 | 53.43 | 2480 MiB |

Batch 336 is about 6.3% faster than 320 and remains above the 2 GiB reserve.
Batch 352 is not safe on this card. The next experiment is a persistent
kernel that keeps the allocated workspace and execution context alive while
processing successive nonce ranges, with the stable kernel remaining untouched.

The first persistent-kernel prototype reached 2440.94 H/s for ten 336-hash
iterations after warmup, versus 2473.24 H/s for the ordinary batch path. This
was only about 1.4 seconds and is not sufficient to reject the design: the
benchmark must be repeated for at least 30 seconds on the same hash structure.
The prototype remains a baseline until that sustained comparison is complete.

A same-process sustained comparison then measured 2550.25 H/s for the stable
path and 2627.87 H/s for the persistent path, a 1.030x improvement. This is
promising but still needs repeated trials and digest/share validation before
any production integration.

After correcting the nonce used by the digest check, a 30-second comparison
measured 2495.24 H/s for the stable path and 2545.55 H/s for the persistent
path, a 1.020x improvement. The persistent digest matched the stable hash and
the 2 GiB VRAM reserve was maintained. This is a promising candidate, but one
more independent run is needed before moving it toward miner integration.

Next candidates are occupancy/block-shape tuning and memory-layout variants.

The share-aware persistent API is now implemented in the main CUDA library and
helper behind `MINER_CUDA_PERSISTENT=1`. It records validity for every nonce
in each persistent window, returns the first hit, and lets the existing helper
continue from that nonce so continuous mode does not lose payable shares. The
ordinary batch path remains the default fallback while pool validation is
pending.

## Latest cumulative suite result

Feature 2 was rejected before timing because its cached address path failed
the known digest. The safe sequence completed with these single 30-second
measurements on the RTX 5080:

| Variant | H/s | Free VRAM |
| --- | ---: | ---: |
| baseline | 2190.19 | 3547 MiB |
| Feature 1 | 1795.95 | 3547 MiB |
| Features 1+3 | 2191.81 | 2081 MiB |
| Features 1+3+4 | 2947.09 | 2121 MiB |
| Features 1+3+4+5 | 3307.09 | 2141 MiB |

All variants passed the known vector, batch counts through 336, strict-target
boundary, and the VRAM reserve check. The hybrid and H0 stages are promising,
but the large improvement must be confirmed with same-process comparisons and
additional nonzero-nonce vectors before production use. The combined
persistent comparison on the final variant measured 3800.78 H/s baseline and
3893.31 H/s persistent, a 1.024x improvement.
## Cumulative optimization suite

The next work is organized as six cumulative features. Each variant is built
as an experimental executable and must pass correctness before it is timed.
No variant changes the production library until the suite selects it.

Feature 1 and Feature 2 are now available as compile-time experimental
validation builds. Feature 2 initializes the 16 fixed address blocks once per
CUDA context and reuses them across hashes; the default production build does
not enable either optimization yet.

The first suite run caught and stopped on the address-cache variant. After
correcting its size and testing slice 0 and slice 1 independently, both still
failed the known digest. Feature 2 is therefore rejected for now and excluded
from the performance sequence; its experimental target remains available for
later debugging. This illustrates why each cumulative stage runs correctness
before performance.

The cumulative validation binaries for permutation loop specialization, the
hybrid register/shared-memory fill path, and H0 loop specialization also now
compile. They remain experimental until the full suite reports matching
digests and sustained measurements.

### Feature 1: 32-bit reference-index arithmetic

Replace the mathematically equivalent 64-bit products in `reference_index()`
with CUDA high-word 32-bit multiplication intrinsics. Validate every digest
against the stable implementation and test strict-target boundaries.

### Feature 2: reusable data-independent address blocks

Precompute the Argon2id address blocks for the first two slices once per CUDA
context. These values depend on Argon2 parameters, not the nonce/header.
Compare against Feature 1 using multiple headers and nonces.

### Feature 3: specialized permutation

Specialize the row and column mappings and selectively unroll the fixed
permutation loops. Watch register count and local-memory spills; a lower
instruction count is not an improvement if occupancy falls.

### Feature 4: hybrid warp/register layout

Test a hybrid BlaMka implementation that keeps short-lived G operands in
registers and uses shared memory only between permutation phases. The previous
naive shuffle design is rejected, so this stage requires exact digest matching
and a sustained win over the shared-memory version.

### Feature 5: optimized H0/BLAKE2b path

Optimize the nonce-dependent H0 calculation while preserving exact BLAKE2b
padding and little-endian framing. Test varied nonce and target fields to
catch accidental reuse of stale prefix state.

### Feature 6: persistent execution

Combine the best kernel variant with the share-aware persistent launch. The
existing persistent implementation is the first baseline for this stage; it
must preserve accepted shares and job updates.

The automated sequence is:

1. stable batch baseline;
2. Feature 1;
3. Features 1+2;
4. Features 1+2+3;
5. Features 1+2+3+4;
6. Features 1+2+3+4+5;
7. the best preceding kernel with Feature 6 persistent execution.

Every stage runs known-answer digests, batch counts 1/16/128/336,
strict-target boundary checks, and a 30-second warmed throughput comparison
against a fresh baseline in the same process. The suite reports mean and
standard deviation, keeps at least 2 GiB free VRAM, and stops a variant on
any correctness failure.
Same-process confirmation with four nonzero-nonce vectors validated the final
safe kernel independently: stable 2420.95 H/s versus optimized
Feature 1+3+4+5 at 3568.39 H/s, a 1.474x speedup. The optimized digest
matched the stable implementation for nonces 0, 1, `0x12345678`, and
`0xffffffff`. This is the selected candidate for production integration.
Feature 2 remains disabled because its address cache still fails the known
digest.

The optimized production build was then validated against the pool. Normal
optimized mining sustained roughly 3.65–3.70 kH/s with accepted shares.
Persistent mode sustained roughly 3.70–3.76 kH/s with accepted shares and no
CUDA or job-update errors, matching the controlled benchmark's small 2–3%
gain. A VRAM rebalance from batch 336 to 288 caused a temporary drop to about
2.27 kH/s, making rebalance hysteresis and allocation stability the next
practical optimization target.
