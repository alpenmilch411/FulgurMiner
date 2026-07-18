#include "include/brc_argon_cuda.h"

#include <cuda_runtime.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {

constexpr std::size_t kMib = 1024ULL * 1024ULL;
constexpr std::size_t kGib = 1024ULL * kMib;
constexpr std::size_t kReserve = 2ULL * kGib;
constexpr std::size_t kSafety = 64ULL * kMib;
constexpr std::size_t kWorkspacePerNonce = 32ULL * kMib;

const std::uint8_t kExpectedDigest[BRC_ARGON_CUDA_DIGEST_BYTES] = {
    0x79, 0x8c, 0x9d, 0x14, 0x7d, 0xd1, 0x26, 0x49,
    0x52, 0x07, 0x17, 0x91, 0x7c, 0x1b, 0xb2, 0x11,
    0x68, 0xd6, 0x04, 0xac, 0x69, 0x71, 0xa8, 0x5d,
    0xc2, 0x7b, 0x86, 0x98, 0x8f, 0xed, 0xd7, 0x4f};

int selected_device() {
  const char* raw = std::getenv("MINER_CUDA_DEVICE");
  if (raw == nullptr || *raw == '\0') return 0;
  char* end = nullptr;
  const long value = std::strtol(raw, &end, 10);
  return end != raw && end != nullptr && *end == '\0' && value >= 0 ? static_cast<int>(value) : 0;
}

bool check_free_vram(const char* stage, std::size_t& free_bytes) {
  std::size_t total_bytes = 0;
  const cudaError_t error = cudaMemGetInfo(&free_bytes, &total_bytes);
  if (error != cudaSuccess) {
    std::fprintf(stderr, "FAIL %s: cudaMemGetInfo: %s\n", stage, cudaGetErrorString(error));
    return false;
  }
  if (free_bytes < kReserve) {
    std::fprintf(stderr, "FAIL %s: only %zu MiB free; required reserve is 2048 MiB\n",
                 stage, free_bytes / kMib);
    return false;
  }
  return true;
}

bool hash_check(brc_argon_cuda_context* context) {
  std::uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES]{};
  std::uint8_t digest[BRC_ARGON_CUDA_DIGEST_BYTES]{};
  if (brc_argon_cuda_hash(context, header, digest) != 0) {
    std::fprintf(stderr, "FAIL hash: %s\n", brc_argon_cuda_last_error());
    return false;
  }
  if (std::memcmp(digest, kExpectedDigest, sizeof(digest)) != 0) {
    std::fprintf(stderr, "FAIL hash: known digest mismatch\n");
    return false;
  }
  std::printf("PASS hash known-vector\n");
  return true;
}

bool batch_check(brc_argon_cuda_context* context, std::uint32_t count) {
  std::uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES]{};
  std::uint8_t target[BRC_ARGON_CUDA_DIGEST_BYTES];
  std::memset(target, 0xff, sizeof(target));
  brc_argon_cuda_share share{};
  const int result = brc_argon_cuda_mine_batch(context, header, 0, count, target, &share);
  if (result != 0 || share.nonce != 0 ||
      std::memcmp(share.digest, kExpectedDigest, sizeof(share.digest)) != 0) {
    std::fprintf(stderr, "FAIL batch count=%u: result=%d nonce=%u error=%s\n",
                 count, result, share.nonce, brc_argon_cuda_last_error());
    return false;
  }
  std::printf("PASS batch count=%u\n", count);
  return true;
}

bool strict_target_check(brc_argon_cuda_context* context) {
  std::uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES]{};
  brc_argon_cuda_share share{};
  const int result = brc_argon_cuda_mine_batch(
      context, header, 0, 1, kExpectedDigest, &share);
  if (result != 1) {
    std::fprintf(stderr, "FAIL strict target: result=%d error=%s\n",
                 result, brc_argon_cuda_last_error());
    return false;
  }
  std::printf("PASS strict-target boundary\n");
  return true;
}

}  // namespace

int main() {
  const int device = selected_device();
  if (cudaSetDevice(device) != cudaSuccess) {
    std::fprintf(stderr, "FAIL device %d: %s\n", device,
                 cudaGetErrorString(cudaGetLastError()));
    return 1;
  }
  cudaDeviceProp properties{};
  if (cudaGetDeviceProperties(&properties, device) != cudaSuccess) {
    std::fprintf(stderr, "FAIL device properties: %s\n",
                 cudaGetErrorString(cudaGetLastError()));
    return 1;
  }
  std::size_t free_before = 0;
  if (!check_free_vram("startup", free_before)) return 1;

  const std::size_t usable = free_before > kReserve + kSafety
      ? free_before - kReserve - kSafety : 0;
  const std::size_t safe_nonces = usable / kWorkspacePerNonce;
  if (safe_nonces == 0) {
    std::fprintf(stderr, "FAIL no batch fits while preserving 2048 MiB VRAM reserve\n");
    return 1;
  }
  const std::uint32_t max_batch = static_cast<std::uint32_t>(
      std::min<std::size_t>(safe_nonces, 256));
  std::vector<std::uint32_t> counts{1, 16};
  if (max_batch >= 128) counts.push_back(128);
  if (max_batch >= 256) counts.push_back(256);
  if (counts.back() > max_batch) counts.back() = max_batch;

  std::printf("device=%d name=%s vram_mib=%zu free_before_mib=%zu reserve_mib=2048 "
              "test_max_batch=%u\n",
              device, properties.name, properties.totalGlobalMem / kMib,
              free_before / kMib, max_batch);

  brc_argon_cuda_context* context = nullptr;
  if (brc_argon_cuda_create(&context, device) != 0) {
    std::fprintf(stderr, "FAIL create: %s\n", brc_argon_cuda_last_error());
    return 1;
  }
  bool ok = hash_check(context);
  for (const std::uint32_t count : counts) {
    if (ok) ok = batch_check(context, count);
  }
  if (ok) ok = strict_target_check(context);

  std::size_t free_after = 0;
  if (ok) ok = check_free_vram("after validation", free_after);
  if (ok) {
    std::printf("PASS vram reserve free_after_mib=%zu\n", free_after / kMib);
  }

  const char* rounds_raw = std::getenv("CUDA_CHECK_ROUNDS");
  const int minimum_rounds = rounds_raw == nullptr ? 2 : std::max(1, std::atoi(rounds_raw));
  const char* seconds_raw = std::getenv("CUDA_CHECK_SECONDS");
  const double minimum_seconds = seconds_raw == nullptr
      ? 10.0 : std::max(1.0, std::atof(seconds_raw));
  if (ok) {
    std::uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES]{};
    std::uint8_t target[BRC_ARGON_CUDA_DIGEST_BYTES];
    std::memset(target, 0xff, sizeof(target));
    brc_argon_cuda_share share{};
    constexpr int warmup_rounds = 2;
    for (int round = 0; round < warmup_rounds; ++round) {
      if (brc_argon_cuda_mine_batch(context, header, 0, max_batch, target, &share) != 0) {
        std::fprintf(stderr, "FAIL performance warmup: %s\n", brc_argon_cuda_last_error());
        ok = false;
        break;
      }
    }
    if (!ok) {
      brc_argon_cuda_destroy(context);
      return 1;
    }
    const auto started = std::chrono::steady_clock::now();
    int measured_rounds = 0;
    double elapsed_seconds = 0.0;
    do {
      if (brc_argon_cuda_mine_batch(context, header, 0, max_batch, target, &share) != 0) {
        std::fprintf(stderr, "FAIL performance batch: %s\n", brc_argon_cuda_last_error());
        ok = false;
        break;
      }
      ++measured_rounds;
      elapsed_seconds = std::chrono::duration<double>(
          std::chrono::steady_clock::now() - started).count();
    } while (measured_rounds < minimum_rounds || elapsed_seconds < minimum_seconds);
    if (ok) {
      std::printf("PASS performance batch=%u warmup_rounds=%d measured_rounds=%d "
                  "elapsed_sec=%.2f host_hashes_per_sec=%.2f\n",
                  max_batch, warmup_rounds, measured_rounds, elapsed_seconds,
                  static_cast<double>(max_batch) * measured_rounds / elapsed_seconds);
    }
  }
  brc_argon_cuda_destroy(context);
  return ok ? 0 : 1;
}
