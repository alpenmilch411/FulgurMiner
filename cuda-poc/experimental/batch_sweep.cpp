#include "../include/brc_argon_cuda.h"

#include <cuda_runtime.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {
constexpr std::size_t kMib = 1024ULL * 1024ULL;
constexpr std::size_t kGib = 1024ULL * kMib;
constexpr std::size_t kReserve = 2ULL * kGib;
constexpr std::size_t kSafety = 64ULL * kMib;
constexpr std::size_t kPerNonce = 32ULL * kMib;
constexpr std::uint32_t kStep = 16;

std::uint32_t safe_batch() {
  std::size_t free_bytes = 0, total_bytes = 0;
  if (cudaMemGetInfo(&free_bytes, &total_bytes) != cudaSuccess ||
      free_bytes <= kReserve + kSafety) return 0;
  const std::size_t usable = free_bytes - kReserve - kSafety;
  const std::size_t count = usable / kPerNonce;
  return static_cast<std::uint32_t>(std::min<std::size_t>(count, 4096) / kStep * kStep);
}

bool free_vram_ok(std::size_t& free_bytes) {
  std::size_t total_bytes = 0;
  if (cudaMemGetInfo(&free_bytes, &total_bytes) != cudaSuccess) return false;
  return free_bytes >= kReserve;
}

}  // namespace

int main() {
  std::uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES]{};
  std::uint8_t target[BRC_ARGON_CUDA_DIGEST_BYTES];
  std::memset(target, 0xff, sizeof(target));
  brc_argon_cuda_context* context = nullptr;
  if (brc_argon_cuda_create(&context, -1) != 0) {
    std::fprintf(stderr, "create failed: %s\n", brc_argon_cuda_last_error());
    return 1;
  }
  const std::uint32_t maximum = safe_batch();
  if (maximum < 256) {
    std::fprintf(stderr, "less than batch 256 fits with the 2 GiB reserve\n");
    brc_argon_cuda_destroy(context);
    return 1;
  }
  const char* seconds_raw = std::getenv("CUDA_SWEEP_SECONDS");
  const double minimum_seconds = seconds_raw == nullptr
      ? 5.0 : std::max(1.0, std::atof(seconds_raw));
  std::printf("reserve_mib=2048 maximum_batch=%u seconds_per_batch=%.1f\n",
              maximum, minimum_seconds);

  bool ok = true;
  for (std::uint32_t batch = 256; batch <= maximum && ok; batch += kStep) {
    if (brc_argon_cuda_trim(context, 0) != 0) {
      std::fprintf(stderr, "trim failed at batch %u: %s\n", batch,
                   brc_argon_cuda_last_error());
      ok = false;
      break;
    }
    brc_argon_cuda_share share{};
    if (brc_argon_cuda_mine_batch(context, header, 0, batch, target, &share) != 0) {
      std::fprintf(stderr, "warmup failed at batch %u: %s\n", batch,
                   brc_argon_cuda_last_error());
      ok = false;
      break;
    }
    const auto started = std::chrono::steady_clock::now();
    std::uint32_t rounds = 0;
    double elapsed = 0;
    do {
      if (brc_argon_cuda_mine_batch(context, header, 0, batch, target, &share) != 0) {
        std::fprintf(stderr, "benchmark failed at batch %u: %s\n", batch,
                     brc_argon_cuda_last_error());
        ok = false;
        break;
      }
      ++rounds;
      elapsed = std::chrono::duration<double>(
          std::chrono::steady_clock::now() - started).count();
    } while (elapsed < minimum_seconds);
    std::size_t free_bytes = 0;
    if (ok && !free_vram_ok(free_bytes)) {
      // Hitting the first batch that cannot preserve the reserve is the
      // expected end of this sweep, not a failed experiment.
      std::printf("stop batch=%u reserve_limit free_after_mib=%zu\n",
                  batch, free_bytes / kMib);
      break;
    }
    if (ok) {
      std::printf("batch=%u rounds=%u elapsed_sec=%.2f host_hashes_per_sec=%.2f "
                  "free_after_mib=%zu\n", batch, rounds, elapsed,
                  static_cast<double>(batch) * rounds / elapsed, free_bytes / kMib);
    }
  }
  brc_argon_cuda_destroy(context);
  return ok ? 0 : 1;
}
