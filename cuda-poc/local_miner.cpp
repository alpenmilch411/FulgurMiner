#include "include/brc_argon_cuda.h"

#include <array>
#include <atomic>
#include <chrono>
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <limits>
#include <string>

namespace {
std::atomic<bool> stop_requested{false};

void request_stop(int) { stop_requested.store(true); }

bool decode_hex(const char* text, uint8_t* output, std::size_t bytes) {
  if (std::strlen(text) != bytes * 2) return false;
  for (std::size_t i = 0; i < bytes; ++i) {
    unsigned value = 0;
    if (std::sscanf(text + i * 2, "%2x", &value) != 1) return false;
    output[i] = static_cast<uint8_t>(value);
  }
  return true;
}

bool parse_u32(const char* text, uint32_t& value) {
  char* end = nullptr;
  const unsigned long long parsed = std::strtoull(text, &end, 0);
  if (end == nullptr || *end != '\0' || parsed > std::numeric_limits<uint32_t>::max())
    return false;
  value = static_cast<uint32_t>(parsed);
  return true;
}

void print_digest(const uint8_t* digest) {
  for (std::size_t i = 0; i < BRC_ARGON_CUDA_DIGEST_BYTES; ++i)
    std::printf("%02x", digest[i]);
}
} // namespace

int main(int argc, char** argv) {
  if (argc != 4 && argc != 5) {
    std::fprintf(stderr,
                 "usage: brc-argon-local <148-byte-header-hex> <nonce-start> "
                 "<target-hex> [max-batches]\n");
    return 2;
  }
  std::array<uint8_t, BRC_ARGON_CUDA_HEADER_BYTES> header{};
  std::array<uint8_t, BRC_ARGON_CUDA_DIGEST_BYTES> target{};
  if (!decode_hex(argv[1], header.data(), header.size())) {
    std::fprintf(stderr, "header must be exactly 148 bytes of hex\n");
    return 2;
  }
  if (!decode_hex(argv[3], target.data(), target.size())) {
    std::fprintf(stderr, "target must be exactly 32 bytes of hex\n");
    return 2;
  }
  uint32_t nonce = 0;
  if (!parse_u32(argv[2], nonce)) {
    std::fprintf(stderr, "nonce-start must be a uint32\n");
    return 2;
  }
  uint32_t max_batches = 0;
  if (argc == 5 && !parse_u32(argv[4], max_batches)) {
    std::fprintf(stderr, "max-batches must be a uint32\n");
    return 2;
  }

  std::signal(SIGINT, request_stop);
  std::signal(SIGTERM, request_stop);
  brc_argon_cuda_context* context = nullptr;
  if (brc_argon_cuda_create(&context, -1) != 0) {
    std::fprintf(stderr, "create: %s\n", brc_argon_cuda_last_error());
    return 1;
  }

  constexpr uint32_t batch_size = BRC_ARGON_CUDA_MAX_BATCH;
  uint64_t batches = 0;
  uint64_t hashes = 0;
  const auto begin = std::chrono::steady_clock::now();
  while (!stop_requested.load() && (max_batches == 0 || batches < max_batches)) {
    if (nonce > std::numeric_limits<uint32_t>::max() - (batch_size - 1)) break;
    brc_argon_cuda_share share{};
    const int result = brc_argon_cuda_mine_batch(
        context, header.data(), nonce, batch_size, target.data(), &share);
    if (result < 0) {
      std::fprintf(stderr, "mine: %s\n", brc_argon_cuda_last_error());
      brc_argon_cuda_destroy(context);
      return 1;
    }
    ++batches;
    hashes += batch_size;
    nonce += batch_size;
    if (result == 0) {
      std::printf("found nonce=%" PRIu32 " digest=", share.nonce);
      print_digest(share.digest);
      std::putchar('\n');
      brc_argon_cuda_destroy(context);
      return 0;
    }
    if ((batches & 7) == 0) {
      const double seconds = std::chrono::duration<double>(
          std::chrono::steady_clock::now() - begin).count();
      std::printf("progress batches=%" PRIu64 " hashes=%" PRIu64
                  " hashes_per_sec=%.1f\n", batches, hashes, hashes / seconds);
    }
  }
  const double seconds = std::chrono::duration<double>(
      std::chrono::steady_clock::now() - begin).count();
  std::printf("stopped batches=%" PRIu64 " hashes=%" PRIu64
              " hashes_per_sec=%.1f\n", batches, hashes,
              seconds > 0 ? hashes / seconds : 0.0);
  brc_argon_cuda_destroy(context);
  return 1;
}
