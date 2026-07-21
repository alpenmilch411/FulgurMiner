#include "include/brc_argon_cuda.h"

#include <cstdio>
#include <cstring>

int main() {
  uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES]{};
  uint8_t digest[BRC_ARGON_CUDA_DIGEST_BYTES]{};
  uint8_t target[BRC_ARGON_CUDA_DIGEST_BYTES];
  std::memset(target, 0xff, sizeof(target));
  brc_argon_cuda_context* context = nullptr;
  if (brc_argon_cuda_create(&context, -1) != 0) {
    std::fprintf(stderr, "create: %s\n", brc_argon_cuda_last_error());
    return 1;
  }
  if (brc_argon_cuda_hash(context, header, digest) != 0) {
    std::fprintf(stderr, "hash: %s\n", brc_argon_cuda_last_error());
    brc_argon_cuda_destroy(context);
    return 1;
  }
  const uint8_t expected[BRC_ARGON_CUDA_DIGEST_BYTES] = {
      0x79, 0x8c, 0x9d, 0x14, 0x7d, 0xd1, 0x26, 0x49,
      0x52, 0x07, 0x17, 0x91, 0x7c, 0x1b, 0xb2, 0x11,
      0x68, 0xd6, 0x04, 0xac, 0x69, 0x71, 0xa8, 0x5d,
      0xc2, 0x7b, 0x86, 0x98, 0x8f, 0xed, 0xd7, 0x4f};
  if (std::memcmp(digest, expected, sizeof(digest)) != 0) {
    std::fprintf(stderr, "hash mismatch\n");
    brc_argon_cuda_destroy(context);
    return 1;
  }
  std::printf("hash=");
  for (uint8_t byte : digest) std::printf("%02x", byte);
  std::putchar('\n');
  brc_argon_cuda_share share{};
  const int result = brc_argon_cuda_mine_batch(context, header, 0, 1, target, &share);
  if (result != 0) {
    std::fprintf(stderr, "mine: result=%d error=%s\n", result,
                 brc_argon_cuda_last_error());
    brc_argon_cuda_destroy(context);
    return 1;
  }
  std::printf("nonce=%u\n", share.nonce);
  if (std::memcmp(share.digest, digest, sizeof(digest)) != 0) {
    std::fprintf(stderr, "share digest mismatch\n");
    brc_argon_cuda_destroy(context);
    return 1;
  }
  const int strict_result = brc_argon_cuda_mine_batch(
      context, header, 0, 1, digest, &share);
  if (strict_result != 1) {
    std::fprintf(stderr, "strict target accepted unexpectedly: %d\n", strict_result);
    brc_argon_cuda_destroy(context);
    return 1;
  }
  std::printf("strict=no-share\n");
  brc_argon_cuda_destroy(context);
  return 0;
}
