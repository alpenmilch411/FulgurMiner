#pragma once

#include <cstdint>

namespace brc_argon2 {

// Argon2 works on 1024-byte blocks represented as 128 little-endian uint64s.
// This is the BlaMka-based permutation from RFC 9106 section 3.5.
__device__ inline std::uint64_t rotr64(std::uint64_t x, unsigned n) {
  return (x >> n) | (x << (64 - n));
}

__device__ inline std::uint64_t f(std::uint64_t x, std::uint64_t y) {
  const std::uint64_t lo = static_cast<std::uint64_t>(static_cast<std::uint32_t>(x))
                         * static_cast<std::uint64_t>(static_cast<std::uint32_t>(y));
  return x + y + 2 * lo;
}

__device__ inline void g(std::uint64_t& a, std::uint64_t& b,
                         std::uint64_t& c, std::uint64_t& d) {
  a = f(a, b); d = rotr64(d ^ a, 32);
  c = f(c, d); b = rotr64(b ^ c, 24);
  a = f(a, b); d = rotr64(d ^ a, 16);
  c = f(c, d); b = rotr64(b ^ c, 63);
}

__device__ inline void round16(std::uint64_t* x) {
  g(x[0], x[4], x[8], x[12]);
  g(x[1], x[5], x[9], x[13]);
  g(x[2], x[6], x[10], x[14]);
  g(x[3], x[7], x[11], x[15]);
  g(x[0], x[5], x[10], x[15]);
  g(x[1], x[6], x[11], x[12]);
  g(x[2], x[7], x[8], x[13]);
  g(x[3], x[4], x[9], x[14]);
}

__device__ inline void permute(std::uint64_t* block) {
  // First apply the permutation to each of the eight independent rows.
  for (int row = 0; row < 8; ++row) round16(block + row * 16);

  // Then apply it to the eight columns. A column is strided by 8 words.
  std::uint64_t q[16];
  for (int col = 0; col < 8; ++col) {
    for (int i = 0; i < 8; ++i) {
      q[i * 2] = block[i * 16 + col * 2];
      q[i * 2 + 1] = block[i * 16 + col * 2 + 1];
    }
    round16(q);
    for (int i = 0; i < 8; ++i) {
      block[i * 16 + col * 2] = q[i * 2];
      block[i * 16 + col * 2 + 1] = q[i * 2 + 1];
    }
  }
}

// Compute one Argon2 memory block. `with_xor` is true for passes after the
// first, where the previous contents of dst are included in R.
__device__ inline void fill_block(const std::uint64_t* prev,
                                  const std::uint64_t* ref,
                                  std::uint64_t* dst,
                                  bool with_xor) {
  std::uint64_t r[128];
  std::uint64_t z[128];
  for (int i = 0; i < 128; ++i) {
    r[i] = prev[i] ^ ref[i];
    if (with_xor) r[i] ^= dst[i];
    z[i] = r[i];
  }
  permute(z);
  for (int i = 0; i < 128; ++i) dst[i] = z[i] ^ r[i];
}

} // namespace brc_argon2
