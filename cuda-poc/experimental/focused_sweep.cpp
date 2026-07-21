#include "../include/brc_argon_cuda.h"

#include <cuda_runtime.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {
constexpr std::size_t kMib = 1024ULL * 1024ULL;
constexpr std::size_t kReserve = 2ULL * 1024ULL * kMib;
constexpr std::uint32_t kBatches[] = {304, 320, 336};

double env_double(const char* name, double fallback) {
  const char* raw = std::getenv(name);
  return raw == nullptr ? fallback : std::max(1.0, std::atof(raw));
}

int env_int(const char* name, int fallback) {
  const char* raw = std::getenv(name);
  return raw == nullptr ? fallback : std::max(1, std::atoi(raw));
}

bool reserve_ok(std::size_t& free_bytes) {
  std::size_t total_bytes = 0;
  return cudaMemGetInfo(&free_bytes, &total_bytes) == cudaSuccess &&
         free_bytes >= kReserve;
}
}  // namespace

int main() {
  std::uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES]{};
  std::uint8_t target[BRC_ARGON_CUDA_DIGEST_BYTES];
  std::memset(target, 0xff, sizeof(target));
  const double seconds = env_double("CUDA_FOCUS_SECONDS", 10.0);
  const int trials = env_int("CUDA_FOCUS_TRIALS", 3);
  double sums[3]{};
  double sums_sq[3]{};
  int samples[3]{};

  std::printf("focused_batches=304,320,336 trials=%d seconds_per_trial=%.1f reserve_mib=2048\n",
              trials, seconds);
  for (int trial = 0; trial < trials; ++trial) {
    brc_argon_cuda_context* context = nullptr;
    if (brc_argon_cuda_create(&context, -1) != 0) {
      std::fprintf(stderr, "create failed: %s\n", brc_argon_cuda_last_error());
      return 1;
    }
    for (int offset = 0; offset < 3; ++offset) {
      const int index = (offset + trial) % 3;
      const std::uint32_t batch = kBatches[index];
      if (brc_argon_cuda_trim(context, 0) != 0) {
        std::fprintf(stderr, "trim failed: %s\n", brc_argon_cuda_last_error());
        brc_argon_cuda_destroy(context);
        return 1;
      }
      brc_argon_cuda_share share{};
      if (brc_argon_cuda_mine_batch(context, header, 0, batch, target, &share) != 0) {
        std::fprintf(stderr, "warmup failed at batch %u: %s\n", batch,
                     brc_argon_cuda_last_error());
        brc_argon_cuda_destroy(context);
        return 1;
      }
      const auto started = std::chrono::steady_clock::now();
      std::uint32_t rounds = 0;
      double elapsed = 0;
      do {
        if (brc_argon_cuda_mine_batch(context, header, 0, batch, target, &share) != 0) {
          std::fprintf(stderr, "benchmark failed at batch %u: %s\n", batch,
                       brc_argon_cuda_last_error());
          brc_argon_cuda_destroy(context);
          return 1;
        }
        ++rounds;
        elapsed = std::chrono::duration<double>(
            std::chrono::steady_clock::now() - started).count();
      } while (elapsed < seconds);
      std::size_t free_bytes = 0;
      if (!reserve_ok(free_bytes)) {
        std::fprintf(stderr, "reserve violated at batch %u free_after_mib=%zu\n",
                     batch, free_bytes / kMib);
        brc_argon_cuda_destroy(context);
        return 1;
      }
      const double rate = static_cast<double>(batch) * rounds / elapsed;
      sums[index] += rate;
      sums_sq[index] += rate * rate;
      ++samples[index];
      std::printf("trial=%d batch=%u rounds=%u elapsed_sec=%.2f host_hashes_per_sec=%.2f free_after_mib=%zu\n",
                  trial + 1, batch, rounds, elapsed, rate, free_bytes / kMib);
    }
    brc_argon_cuda_destroy(context);
  }
  for (int i = 0; i < 3; ++i) {
    const double mean = sums[i] / samples[i];
    const double variance = std::max(0.0, sums_sq[i] / samples[i] - mean * mean);
    std::printf("summary batch=%u mean_h_per_sec=%.2f stddev=%.2f samples=%d\n",
                kBatches[i], mean, std::sqrt(variance), samples[i]);
  }
  return 0;
}
