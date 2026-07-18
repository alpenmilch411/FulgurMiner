// Experimental only: include the proven implementation so this prototype can
// call its internal cooperative Argon2 device routine without changing the
// stable library or public API.
#include "../argon2_cuda.cu"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {
constexpr std::size_t kMib = 1024ULL * 1024ULL;
constexpr std::size_t kReserve = 2ULL * 1024ULL * kMib;
constexpr std::size_t kWordsPerJob = static_cast<std::size_t>(brc_argon2::kMemoryBlocks) * 128;
constexpr std::uint32_t kBatch = 336;

int env_int(const char* name, int fallback) {
  const char* raw = std::getenv(name);
  return raw == nullptr ? fallback : std::max(1, std::atoi(raw));
}

double env_double(const char* name, double fallback) {
  const char* raw = std::getenv(name);
  return raw == nullptr ? fallback : std::max(1.0, std::atof(raw));
}

__global__ void persistent_mine_launch(
    const std::uint8_t* base_header, std::uint64_t nonce_start,
    std::uint32_t batch, std::uint32_t iterations,
    const std::uint8_t* target, std::uint64_t* memories,
    std::uint8_t* digests, std::uint8_t* valid
#ifdef BRC_CUDA_OPT_ADDRESS
    , const std::uint64_t* cached_addresses
#endif
    ) {
  const int lane = threadIdx.x & 31;
  const int warp_in_block = threadIdx.x >> 5;
  const std::uint32_t slot = blockIdx.x * 4 + warp_in_block;
  if (slot >= batch) return;
  const std::uint32_t total_slots = gridDim.x * 4;
  __shared__ CoopState states[4];

  for (std::uint32_t round = 0; round < iterations; ++round) {
    const std::uint32_t index = round * total_slots + slot;
    if (lane == 0) {
      for (int i = 0; i < kHeaderLen; ++i) states[warp_in_block].header[i] = base_header[i];
      const std::uint64_t nonce = nonce_start + index;
      states[warp_in_block].header[112] = static_cast<std::uint8_t>(nonce >> 24);
      states[warp_in_block].header[113] = static_cast<std::uint8_t>(nonce >> 16);
      states[warp_in_block].header[114] = static_cast<std::uint8_t>(nonce >> 8);
      states[warp_in_block].header[115] = static_cast<std::uint8_t>(nonce);
    }
    __syncwarp();
    argon2_hash_coop(
        digests + static_cast<std::size_t>(slot) * 32,
        memories + static_cast<std::size_t>(slot) * kWordsPerJob,
        states[warp_in_block], lane
#ifdef BRC_CUDA_OPT_ADDRESS
        , cached_addresses
#endif
        );
    if (lane == 0) {
      valid[slot] = digest_less_than(
          digests + static_cast<std::size_t>(slot) * 32, target) ? 1 : 0;
    }
  }
}
}  // namespace

int run_comparison() {
  const double comparison_seconds = env_double("CUDA_COMPARE_SECONDS", 30.0);
  const std::size_t memory_bytes = static_cast<std::size_t>(kBatch) * kWordsPerJob * sizeof(std::uint64_t);
  std::size_t free_before = 0, total = 0;
  if (cudaMemGetInfo(&free_before, &total) != cudaSuccess ||
      free_before < memory_bytes + kReserve) {
    std::fprintf(stderr, "insufficient VRAM for batch %u with 2 GiB reserve\n", kBatch);
    return 1;
  }

  std::uint8_t header[kHeaderLen]{};
  std::uint8_t target[32];
  std::memset(target, 0xff, sizeof(target));

  brc_argon_cuda_context* baseline_context = nullptr;
  if (brc_argon_cuda_create(&baseline_context, -1) != 0) {
    std::fprintf(stderr, "baseline create failed: %s\n", brc_argon_cuda_last_error());
    return 1;
  }
  brc_argon_cuda_share baseline_share{};
  if (brc_argon_cuda_mine_batch(baseline_context, header, 0, kBatch, target,
                                &baseline_share) < 0) {
    std::fprintf(stderr, "baseline warmup failed: %s\n", brc_argon_cuda_last_error());
    brc_argon_cuda_destroy(baseline_context);
    return 1;
  }
  const auto baseline_started = std::chrono::steady_clock::now();
  std::uint32_t baseline_rounds = 0;
  double baseline_elapsed = 0;
  do {
    if (brc_argon_cuda_mine_batch(baseline_context, header, 0, kBatch, target,
                                  &baseline_share) < 0) {
      std::fprintf(stderr, "baseline benchmark failed: %s\n", brc_argon_cuda_last_error());
      brc_argon_cuda_destroy(baseline_context);
      return 1;
    }
    ++baseline_rounds;
    baseline_elapsed = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - baseline_started).count();
  } while (baseline_elapsed < comparison_seconds);
  const double baseline_rate = static_cast<double>(kBatch) * baseline_rounds / baseline_elapsed;
  std::printf("baseline batch=%u rounds=%u elapsed_sec=%.2f host_hashes_per_sec=%.2f\n",
              kBatch, baseline_rounds, baseline_elapsed, baseline_rate);
  brc_argon_cuda_destroy(baseline_context);

  // By default, use the live baseline rate to make the persistent run similar
  // in duration. An explicit iteration count is still useful for smoke tests.
  const int estimated_iterations = std::max(
      1, static_cast<int>(std::ceil(baseline_rate * comparison_seconds / kBatch)));
  const int iterations = env_int("CUDA_PERSISTENT_ITERATIONS", estimated_iterations);
  std::printf("comparison_seconds=%.1f persistent_iterations=%d\n",
              comparison_seconds, iterations);

  std::uint8_t *d_header = nullptr, *d_target = nullptr, *d_digests = nullptr, *d_valid = nullptr;
  std::uint64_t* d_memory = nullptr;
#ifdef BRC_CUDA_OPT_ADDRESS
  std::uint64_t* d_cached_addresses = nullptr;
#endif
  cudaError_t error = cudaMalloc(&d_header, kHeaderLen);
  if (error == cudaSuccess) error = cudaMalloc(&d_target, 32);
  if (error == cudaSuccess) error = cudaMalloc(&d_digests, kBatch * 32ULL);
  if (error == cudaSuccess) error = cudaMalloc(&d_valid, kBatch);
  if (error == cudaSuccess) error = cudaMalloc(&d_memory, memory_bytes);
#ifdef BRC_CUDA_OPT_ADDRESS
  if (error == cudaSuccess) error = cudaMalloc(&d_cached_addresses, 2 * 64 * 128 * sizeof(std::uint64_t));
  if (error == cudaSuccess) {
    init_cached_addresses_launch<<<1, 128>>>(d_cached_addresses);
    error = cudaGetLastError();
  }
  if (error == cudaSuccess) error = cudaDeviceSynchronize();
#endif
  if (error == cudaSuccess) error = cudaMemcpy(d_header, header, kHeaderLen, cudaMemcpyHostToDevice);
  if (error == cudaSuccess) error = cudaMemcpy(d_target, target, 32, cudaMemcpyHostToDevice);
  if (error != cudaSuccess) {
    std::fprintf(stderr, "setup failed: %s\n", cudaGetErrorString(error));
    cudaFree(d_header); cudaFree(d_target); cudaFree(d_digests); cudaFree(d_valid); cudaFree(d_memory);
#ifdef BRC_CUDA_OPT_ADDRESS
    cudaFree(d_cached_addresses);
#endif
    return 1;
  }

  // Exclude first-launch/JIT/module initialization from the measurement.
  persistent_mine_launch<<<(kBatch + 3) / 4, 128>>>(
      d_header, 0, kBatch, 1, d_target, d_memory, d_digests, d_valid
#ifdef BRC_CUDA_OPT_ADDRESS
      , d_cached_addresses
#endif
      );
  error = cudaGetLastError();
  if (error == cudaSuccess) error = cudaDeviceSynchronize();
  if (error != cudaSuccess) {
    std::fprintf(stderr, "persistent warmup failed: %s\n", cudaGetErrorString(error));
    cudaFree(d_header); cudaFree(d_target); cudaFree(d_digests); cudaFree(d_valid); cudaFree(d_memory);
#ifdef BRC_CUDA_OPT_ADDRESS
    cudaFree(d_cached_addresses);
#endif
    return 1;
  }

  const auto started = std::chrono::steady_clock::now();
  persistent_mine_launch<<<(kBatch + 3) / 4, 128>>>(
      d_header, 0, kBatch, static_cast<std::uint32_t>(iterations),
      d_target, d_memory, d_digests, d_valid
#ifdef BRC_CUDA_OPT_ADDRESS
      , d_cached_addresses
#endif
      );
  error = cudaGetLastError();
  if (error == cudaSuccess) error = cudaDeviceSynchronize();
  const double elapsed = std::chrono::duration<double>(
      std::chrono::steady_clock::now() - started).count();
  if (error != cudaSuccess) {
    std::fprintf(stderr, "persistent kernel failed: %s\n", cudaGetErrorString(error));
  } else {
    std::uint8_t persistent_digest[32]{};
    error = cudaMemcpy(persistent_digest, d_digests, sizeof(persistent_digest),
                       cudaMemcpyDeviceToHost);
    brc_argon_cuda_context* check_context = nullptr;
    std::uint8_t reference_header[kHeaderLen]{};
    std::memcpy(reference_header, header, sizeof(reference_header));
    const std::uint32_t final_nonce =
        static_cast<std::uint32_t>((iterations - 1) * kBatch);
    reference_header[112] = static_cast<std::uint8_t>(final_nonce >> 24);
    reference_header[113] = static_cast<std::uint8_t>(final_nonce >> 16);
    reference_header[114] = static_cast<std::uint8_t>(final_nonce >> 8);
    reference_header[115] = static_cast<std::uint8_t>(final_nonce);
    std::uint8_t reference_digest[32]{};
    if (error == cudaSuccess && brc_argon_cuda_create(&check_context, -1) != 0) {
      std::fprintf(stderr, "correctness context failed: %s\n", brc_argon_cuda_last_error());
      error = cudaErrorUnknown;
    }
    if (error == cudaSuccess && brc_argon_cuda_hash(check_context, reference_header, reference_digest) != 0) {
      std::fprintf(stderr, "correctness hash failed: %s\n", brc_argon_cuda_last_error());
      error = cudaErrorUnknown;
    }
    if (check_context != nullptr) brc_argon_cuda_destroy(check_context);
    if (error == cudaSuccess && std::memcmp(persistent_digest, reference_digest, 32) != 0) {
      std::fprintf(stderr, "FAIL persistent digest mismatch\n");
      error = cudaErrorUnknown;
    } else if (error == cudaSuccess) {
      std::printf("PASS persistent digest matches stable hash\n");
    }
  }
  if (error == cudaSuccess) {
    std::printf("persistent batch=%u iterations=%d hashes=%llu elapsed_sec=%.3f host_hashes_per_sec=%.2f free_before_mib=%zu speedup_vs_baseline=%.3f\n",
                kBatch, iterations, static_cast<unsigned long long>(kBatch) * iterations,
                elapsed, static_cast<double>(kBatch) * iterations / elapsed,
                free_before / kMib,
                (static_cast<double>(kBatch) * iterations / elapsed) / baseline_rate);
  }
  cudaFree(d_header); cudaFree(d_target); cudaFree(d_digests); cudaFree(d_valid); cudaFree(d_memory);
#ifdef BRC_CUDA_OPT_ADDRESS
  cudaFree(d_cached_addresses);
#endif
  return error == cudaSuccess ? 0 : 1;
}

int main() {
  const int trials = env_int("CUDA_COMPARE_TRIALS", 3);
  std::printf("persistent_comparison_trials=%d seconds_per_path=%.1f\n",
              trials, env_double("CUDA_COMPARE_SECONDS", 30.0));
  for (int trial = 1; trial <= trials; ++trial) {
    std::printf("--- comparison trial %d/%d ---\n", trial, trials);
    if (run_comparison() != 0) return 1;
  }
  return 0;
}
