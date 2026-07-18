// CUDA Argon2id implementation, built in correctness-checked slices.
// This first slice implements Argon2's H0 input framing and BLAKE2b-512 on
// the device. It intentionally does not claim to produce a PoW digest yet.
#include <cuda_runtime.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "argon2_block.cuh"
#include "argon2_memory.cuh"

namespace {

constexpr int kHeaderLen = 148;
constexpr int kSaltLen = 18;
constexpr int kH0Len = 64;
__device__ __constant__ char kSaltDevice[kSaltLen + 1] = "browsercoin-pow-v5";

__device__ __constant__ std::uint64_t kIV[8] = {
    0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL,
    0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
    0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL,
    0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL};

__device__ __constant__ std::uint8_t kSigma[12][16] = {
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
    {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
    {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
    {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
    {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3}};

__device__ inline std::uint64_t rotr(std::uint64_t x, int n) {
  return (x >> n) | (x << (64 - n));
}

__device__ inline void mix(std::uint64_t& a, std::uint64_t& b,
                           std::uint64_t& c, std::uint64_t& d,
                           std::uint64_t x, std::uint64_t y) {
  a = a + b + x;
  d = rotr(d ^ a, 32);
  c += d;
  b = rotr(b ^ c, 24);
  a = a + b + y;
  d = rotr(d ^ a, 16);
  c += d;
  b = rotr(b ^ c, 63);
}

__device__ void blake2b_compress(std::uint64_t h[8], const std::uint8_t block[128],
                                 std::uint64_t counter, bool last) {
  std::uint64_t m[16];
  for (int i = 0; i < 16; ++i) {
    m[i] = 0;
    for (int j = 0; j < 8; ++j) m[i] |= std::uint64_t(block[i * 8 + j]) << (8 * j);
  }
  std::uint64_t v[16];
  for (int i = 0; i < 8; ++i) v[i] = h[i];
  for (int i = 0; i < 8; ++i) v[i + 8] = kIV[i];
  v[12] ^= counter;
  if (last) v[14] = ~v[14];
  for (int r = 0; r < 12; ++r) {
    const auto* s = kSigma[r];
    mix(v[0], v[4], v[8], v[12], m[s[0]], m[s[1]]);
    mix(v[1], v[5], v[9], v[13], m[s[2]], m[s[3]]);
    mix(v[2], v[6], v[10], v[14], m[s[4]], m[s[5]]);
    mix(v[3], v[7], v[11], v[15], m[s[6]], m[s[7]]);
    mix(v[0], v[5], v[10], v[15], m[s[8]], m[s[9]]);
    mix(v[1], v[6], v[11], v[12], m[s[10]], m[s[11]]);
    mix(v[2], v[7], v[8], v[13], m[s[12]], m[s[13]]);
    mix(v[3], v[4], v[9], v[14], m[s[14]], m[s[15]]);
  }
  for (int i = 0; i < 8; ++i) h[i] ^= v[i] ^ v[i + 8];
}

// Blake2b with an output length up to 64 bytes. Argon2 H' uses both short
// inputs (initial blocks) and a 1028-byte finalization input, so process all
// input blocks with the byte counter advancing across the message.
__device__ void blake2b_hash64(const std::uint8_t* data, int len,
                               std::uint8_t* out, int out_len) {
  std::uint64_t h[8];
  for (int i = 0; i < 8; ++i) h[i] = kIV[i];
  h[0] ^= 0x01010000ULL | static_cast<std::uint64_t>(out_len);
  int offset = 0;
  while (offset < len || (len == 0 && offset == 0)) {
    std::uint8_t block[128]{};
    const int remaining = len - offset;
    const int chunk = remaining > 128 ? 128 : remaining;
    for (int i = 0; i < chunk; ++i) block[i] = data[offset + i];
    offset += chunk;
    blake2b_compress(h, block, static_cast<std::uint64_t>(offset), offset == len);
  }
  for (int i = 0; i < out_len; ++i)
    out[i] = static_cast<std::uint8_t>(h[i / 8] >> (8 * (i % 8)));
}

// RFC 9106 variable-length Blake2b, called H' by Argon2. This is used to
// expand H0||LE32(pass)||LE32(lane) into each 1024-byte initial block.
__device__ void blake2b_long(const std::uint8_t* input, int input_len,
                             std::uint8_t* out, int out_len) {
  std::uint8_t first[4 + 1024]{};
  first[0] = static_cast<std::uint8_t>(out_len);
  first[1] = static_cast<std::uint8_t>(out_len >> 8);
  first[2] = static_cast<std::uint8_t>(out_len >> 16);
  first[3] = static_cast<std::uint8_t>(out_len >> 24);
  for (int i = 0; i < input_len; ++i) first[i + 4] = input[i];

  if (out_len <= 64) {
    blake2b_hash64(first, input_len + 4, out, out_len);
    return;
  }

  std::uint8_t v[64];
  blake2b_hash64(first, input_len + 4, v, 64);

  int produced = 0;
  for (int i = 0; i < 32; ++i) out[produced++] = v[i];
  int remaining = out_len - 32;
  while (remaining > 64) {
    std::uint8_t next[64];
    blake2b_hash64(v, 64, next, 64);
    for (int i = 0; i < 32; ++i) out[produced++] = next[i];
    for (int i = 0; i < 64; ++i) v[i] = next[i];
    remaining -= 32;
  }
  blake2b_hash64(v, 64, out + produced, remaining);
}

__device__ void initial_block(const std::uint8_t h0[kH0Len],
                              std::uint32_t block_index, std::uint32_t lane,
                              std::uint64_t* dst) {
  std::uint8_t input[kH0Len + 8];
  for (int i = 0; i < kH0Len; ++i) input[i] = h0[i];
  input[64] = static_cast<std::uint8_t>(block_index);
  input[65] = static_cast<std::uint8_t>(block_index >> 8);
  input[66] = static_cast<std::uint8_t>(block_index >> 16);
  input[67] = static_cast<std::uint8_t>(block_index >> 24);
  input[68] = static_cast<std::uint8_t>(lane);
  input[69] = static_cast<std::uint8_t>(lane >> 8);
  input[70] = static_cast<std::uint8_t>(lane >> 16);
  input[71] = static_cast<std::uint8_t>(lane >> 24);
  std::uint8_t bytes[1024];
  blake2b_long(input, sizeof(input), bytes, sizeof(bytes));
  for (int i = 0; i < 128; ++i) {
    std::uint64_t word = 0;
    for (int j = 0; j < 8; ++j) word |= std::uint64_t(bytes[i * 8 + j]) << (8 * j);
    dst[i] = word;
  }
}

__device__ void h0_kernel(const std::uint8_t header[kHeaderLen], std::uint8_t out[kH0Len]) {
  // Argon2 H0, RFC 9106 section 3.3: LE32 parameters followed by length-
  // prefixed password and salt, with zero-length secret and associated data.
  std::uint8_t input[256]{};
  int p = 0;
  auto le32 = [&](std::uint32_t x) {
    input[p++] = static_cast<std::uint8_t>(x);
    input[p++] = static_cast<std::uint8_t>(x >> 8);
    input[p++] = static_cast<std::uint8_t>(x >> 16);
    input[p++] = static_cast<std::uint8_t>(x >> 24);
  };
  le32(1);             // parallelism
  le32(32);            // tag length
  le32(32 * 1024);     // memory KiB
  le32(1);             // passes
  le32(0x13);          // Argon2 version 1.3
  le32(2);             // Argon2id
  le32(kHeaderLen);    // password length

#ifdef BRC_CUDA_OPT_H0
#pragma unroll
#endif
  for (int i = 0; i < kHeaderLen; ++i) input[p++] = header[i];
  le32(kSaltLen);
#ifdef BRC_CUDA_OPT_H0
#pragma unroll
#endif
  for (int i = 0; i < kSaltLen; ++i) input[p++] = static_cast<std::uint8_t>(kSaltDevice[i]);
  le32(0);              // secret length
  le32(0);              // associated-data length

  std::uint64_t h[8];
  for (int i = 0; i < 8; ++i) h[i] = kIV[i];
  h[0] ^= 0x01010040ULL; // digest length 64, key length 0, fanout 1, depth 1
  // H0 is 202 bytes for this header/salt, so BLAKE2b consumes two blocks.
  // The counter is the number of bytes processed after each block.
  blake2b_compress(h, input, 128, false);
  blake2b_compress(h, input + 128, static_cast<std::uint64_t>(p), true);
#ifdef BRC_CUDA_OPT_H0
#pragma unroll
#endif
  for (int i = 0; i < 8; ++i)
#ifdef BRC_CUDA_OPT_H0
#pragma unroll
#endif
    for (int j = 0; j < 8; ++j) out[i * 8 + j] = static_cast<std::uint8_t>(h[i] >> (8 * j));
}

__global__ void h0_launch(const std::uint8_t* header, std::uint8_t* out) {
  if (blockIdx.x == 0 && threadIdx.x == 0) h0_kernel(header, out);
}

__device__ void argon2_hash(const std::uint8_t* header, std::uint8_t* out,
                            std::uint64_t* memory) {
  std::uint8_t h0[kH0Len];
  h0_kernel(header, h0);
  initial_block(h0, 0, 0, memory);
  initial_block(h0, 1, 0, memory + 128);
  brc_argon2::fill_lane(memory);

  std::uint8_t final_block[1024];
  const std::uint64_t* last = memory + (brc_argon2::kMemoryBlocks - 1) * 128;
  for (int i = 0; i < 128; ++i)
    for (int j = 0; j < 8; ++j)
      final_block[i * 8 + j] = static_cast<std::uint8_t>(last[i] >> (8 * j));
  blake2b_long(final_block, sizeof(final_block), out, 32);
}

__global__ void argon2_launch(const std::uint8_t* header, std::uint8_t* out,
                              std::uint64_t* memory) {
  if (blockIdx.x == 0 && threadIdx.x == 0) argon2_hash(header, out, memory);
}

__device__ bool digest_less_than(const std::uint8_t* digest,
                                 const std::uint8_t* target) {
  for (int i = 0; i < 32; ++i) {
    if (digest[i] != target[i]) return digest[i] < target[i];
  }
  return false;
}

struct CoopState {
  std::uint8_t header[kHeaderLen];
  std::uint8_t h0[64];
  std::uint64_t address[128];
  std::uint64_t r[128];
  std::uint64_t z[128];
  std::uint32_t ref;
};

__device__ void fill_block_coop(const std::uint64_t* prev,
                                const std::uint64_t* ref,
                                std::uint64_t* dst, bool with_xor,
                                CoopState& state, int lane) {
#ifdef BRC_CUDA_OPT_HYBRID
  std::uint64_t r0 = 0, r1 = 0, r2 = 0, r3 = 0;
  if (!with_xor) {
    r0 = prev[lane] ^ ref[lane];
    r1 = prev[lane + 32] ^ ref[lane + 32];
    r2 = prev[lane + 64] ^ ref[lane + 64];
    r3 = prev[lane + 96] ^ ref[lane + 96];
    state.z[lane] = r0;
    state.z[lane + 32] = r1;
    state.z[lane + 64] = r2;
    state.z[lane + 96] = r3;
  } else {
#endif
  for (int i = lane; i < 128; i += 32) {
    state.r[i] = prev[i] ^ ref[i];
    if (with_xor) state.r[i] ^= dst[i];
    state.z[i] = state.r[i];
  }
#ifdef BRC_CUDA_OPT_HYBRID
  }
#endif
  __syncwarp();

  // A Blake2 round contains eight independent G operations in each row. The
  // original path assigned one lane to an entire row, leaving the other lanes
  // idle while that lane executed all eight Gs serially. Process four rows at
  // a time, assigning one lane to each G. Two phases cover all eight rows.
#ifdef BRC_CUDA_OPT_PERMUTE
#pragma unroll
#endif
  for (int group = 0; group < 2; ++group) {
    const int op = lane & 7;
    const int base = (group * 4 + (lane >> 3)) * 16;
    if (op < 4) {
      brc_argon2::g(state.z[base + op], state.z[base + 4 + op],
                    state.z[base + 8 + op], state.z[base + 12 + op]);
    }
    __syncwarp();
    if (op >= 4) {
      const int diagonal = op - 4;
      switch (diagonal) {
        case 0: brc_argon2::g(state.z[base + 0], state.z[base + 5],
                              state.z[base + 10], state.z[base + 15]); break;
        case 1: brc_argon2::g(state.z[base + 1], state.z[base + 6],
                              state.z[base + 11], state.z[base + 12]); break;
        case 2: brc_argon2::g(state.z[base + 2], state.z[base + 7],
                              state.z[base + 8], state.z[base + 13]); break;
        default: brc_argon2::g(state.z[base + 3], state.z[base + 4],
                               state.z[base + 9], state.z[base + 14]); break;
      }
    }
    __syncwarp();
  }

  // Apply the same cooperative mapping to the eight column rounds. Each
  // column is represented by eight lanes; four columns are processed in each
  // phase. The index mapping is the exact q[] layout used by round16().
#ifdef BRC_CUDA_OPT_PERMUTE
#pragma unroll
#endif
  for (int group = 0; group < 2; ++group) {
    const int op = lane & 7;
    const int col = group * 4 + (lane >> 3);
    const int even = col * 2;
    if (op < 4) {
      const int parity = op & 1;
      const int row = (op >> 1) & 1;
      brc_argon2::g(state.z[row * 16 + even + parity],
                    state.z[(row + 2) * 16 + even + parity],
                    state.z[(row + 4) * 16 + even + parity],
                    state.z[(row + 6) * 16 + even + parity]);
    }
    __syncwarp();
    if (op >= 4) {
      int a = 0, b = 0, c = 0, d = 0;
      switch (op - 4) {
        case 0: a = 0 * 16 + even;     b = 2 * 16 + even + 1; c = 5 * 16 + even;     d = 7 * 16 + even + 1; break;
        case 1: a = 0 * 16 + even + 1; b = 3 * 16 + even;     c = 5 * 16 + even + 1; d = 6 * 16 + even;     break;
        case 2: a = 1 * 16 + even;     b = 3 * 16 + even + 1; c = 4 * 16 + even;     d = 6 * 16 + even + 1; break;
        default:a = 1 * 16 + even + 1; b = 2 * 16 + even;     c = 4 * 16 + even + 1; d = 7 * 16 + even;     break;
      }
      brc_argon2::g(state.z[a], state.z[b], state.z[c], state.z[d]);
    }
    __syncwarp();
  }

#ifdef BRC_CUDA_OPT_HYBRID
  if (!with_xor) {
    dst[lane] = state.z[lane] ^ r0;
    dst[lane + 32] = state.z[lane + 32] ^ r1;
    dst[lane + 64] = state.z[lane + 64] ^ r2;
    dst[lane + 96] = state.z[lane + 96] ^ r3;
  } else {
#endif
    for (int i = lane; i < 128; i += 32) dst[i] = state.z[i] ^ state.r[i];
#ifdef BRC_CUDA_OPT_HYBRID
  }
#endif
  __syncwarp();
}

__device__ void fill_lane_coop(std::uint64_t* memory, CoopState& state, int lane
#ifdef BRC_CUDA_OPT_ADDRESS
                               , const std::uint64_t* cached_addresses
#endif
                               ) {
  for (std::uint32_t slice = 0; slice < 4; ++slice) {
    const bool data_independent = slice < 2;
#ifdef BRC_CUDA_OPT_ADDRESS_SLICE0
    const bool use_cached_addresses = slice == 0;
#elif defined(BRC_CUDA_OPT_ADDRESS_SLICE1)
    const bool use_cached_addresses = slice == 1;
#else
    const bool use_cached_addresses = false;
#endif
    const std::uint32_t start = slice == 0 ? 2 : 0;
    if (data_independent && lane == 0 && !use_cached_addresses) {
#ifndef BRC_CUDA_OPT_ADDRESS
      for (int i = 0; i < 128; ++i) state.address[i] = 0;
      brc_argon2::init_address_block(state.address, 0, slice, 1);
#endif
    }
    __syncwarp();
    for (std::uint32_t index = start; index < brc_argon2::kSegmentLength; ++index) {
      if (data_independent && lane == 0 && index != start && (index & 127) == 0)
#ifndef BRC_CUDA_OPT_ADDRESS
        brc_argon2::init_address_block(state.address, 0, slice, index / 128 + 1);
#endif
      if (lane == 0) {
        const std::uint32_t absolute = slice * brc_argon2::kSegmentLength + index;
        const std::uint64_t* prev = memory + ((absolute + brc_argon2::kMemoryBlocks - 1)
                                               % brc_argon2::kMemoryBlocks) * 128;
        std::uint32_t pseudo = 0;
        if (data_independent) {
#ifdef BRC_CUDA_OPT_ADDRESS
          if (use_cached_addresses) {
          const std::size_t address_offset =
              (static_cast<std::size_t>(slice) * 64 + index / 128) * 128 + (index & 127);
          pseudo = static_cast<std::uint32_t>(cached_addresses[address_offset]);
          } else
#endif
#ifndef BRC_CUDA_OPT_ADDRESS
          pseudo = static_cast<std::uint32_t>(state.address[index & 127]);
#else
          pseudo = static_cast<std::uint32_t>(state.address[index & 127]);
#endif
        } else {
          pseudo = static_cast<std::uint32_t>(prev[0]);
        }
        state.ref = brc_argon2::reference_index(0, slice, index, pseudo);
      }
      __syncwarp();
      const std::uint32_t absolute = slice * brc_argon2::kSegmentLength + index;
      const std::uint64_t* prev = memory + ((absolute + brc_argon2::kMemoryBlocks - 1)
                                             % brc_argon2::kMemoryBlocks) * 128;
      fill_block_coop(prev, memory + state.ref * 128, memory + absolute * 128,
                      false, state, lane);
    }
  }
}

__device__ void argon2_hash_coop(std::uint8_t* out, std::uint64_t* memory,
                                 CoopState& state, int lane
#ifdef BRC_CUDA_OPT_ADDRESS
                                 , const std::uint64_t* cached_addresses
#endif
                                 ) {
  if (lane == 0) {
    h0_kernel(state.header, state.h0);
    initial_block(state.h0, 0, 0, memory);
    initial_block(state.h0, 1, 0, memory + 128);
  }
  __syncwarp();
  fill_lane_coop(memory, state, lane
#ifdef BRC_CUDA_OPT_ADDRESS
                 , cached_addresses
#endif
                 );
  if (lane == 0) {
    std::uint8_t final_block[1024];
    const std::uint64_t* last = memory + (brc_argon2::kMemoryBlocks - 1) * 128;
    for (int i = 0; i < 128; ++i)
      for (int j = 0; j < 8; ++j)
        final_block[i * 8 + j] = static_cast<std::uint8_t>(last[i] >> (8 * j));
    blake2b_long(final_block, sizeof(final_block), out, 32);
  }
}

__global__ void mine_batch_coop_launch(const std::uint8_t* base_header,
                                       std::uint64_t nonce_start,
                                       std::uint32_t count,
                                       const std::uint8_t* target,
                                       std::uint64_t* memories,
                                       std::uint8_t* batch_digests,
                                       std::uint8_t* batch_valid
#ifdef BRC_CUDA_OPT_ADDRESS
                                       , const std::uint64_t* cached_addresses
#endif
                                       ) {
  const int lane = threadIdx.x & 31;
  const int warp = threadIdx.x >> 5;
  const std::uint32_t index = blockIdx.x * 4 + warp;
  if (index >= count) return;
  __shared__ CoopState states[4];
  if (lane == 0) {
    for (int i = 0; i < kHeaderLen; ++i) states[warp].header[i] = base_header[i];
    const std::uint64_t nonce = nonce_start + index;
    states[warp].header[112] = static_cast<std::uint8_t>(nonce >> 24);
    states[warp].header[113] = static_cast<std::uint8_t>(nonce >> 16);
    states[warp].header[114] = static_cast<std::uint8_t>(nonce >> 8);
    states[warp].header[115] = static_cast<std::uint8_t>(nonce);
  }
  __syncwarp();
  const std::size_t words_per_job = static_cast<std::size_t>(brc_argon2::kMemoryBlocks) * 128;
  argon2_hash_coop(batch_digests + static_cast<std::size_t>(index) * 32,
                  memories + static_cast<std::size_t>(index) * words_per_job,
                  states[warp], lane
#ifdef BRC_CUDA_OPT_ADDRESS
                  , cached_addresses
#endif
                  );
  if (lane == 0) {
    batch_valid[index] = digest_less_than(
        batch_digests + static_cast<std::size_t>(index) * 32, target) ? 1 : 0;
  }
}

__global__ void mine_batch_launch(const std::uint8_t* base_header,
                                  std::uint64_t nonce_start,
                                  std::uint32_t count,
                                  const std::uint8_t* target,
                                  std::uint64_t* memories,
                                  std::uint8_t* batch_digests,
                                  std::uint8_t* batch_valid) {
  const std::uint32_t index = blockIdx.x * blockDim.x + threadIdx.x;
  if (index >= count) return;
  std::uint8_t header[kHeaderLen];
  for (int i = 0; i < kHeaderLen; ++i) header[i] = base_header[i];
  const std::uint64_t nonce = nonce_start + index;
  header[112] = static_cast<std::uint8_t>(nonce >> 24);
  header[113] = static_cast<std::uint8_t>(nonce >> 16);
  header[114] = static_cast<std::uint8_t>(nonce >> 8);
  header[115] = static_cast<std::uint8_t>(nonce);
  std::uint8_t digest[32];
  const std::size_t words_per_job =
      static_cast<std::size_t>(brc_argon2::kMemoryBlocks) * 128;
  argon2_hash(header, digest, memories + static_cast<std::size_t>(index) * words_per_job);
  for (int i = 0; i < 32; ++i)
    batch_digests[static_cast<std::size_t>(index) * 32 + i] = digest[i];
  batch_valid[index] = digest_less_than(digest, target) ? 1 : 0;
}

__global__ void mine_persistent_coop_launch(
    const std::uint8_t* base_header, std::uint64_t nonce_start,
    std::uint32_t count, std::uint32_t iterations,
    const std::uint8_t* target, std::uint64_t* memories,
    std::uint8_t* digests, std::uint8_t* valid
#ifdef BRC_CUDA_OPT_ADDRESS
    , const std::uint64_t* cached_addresses
#endif
    ) {
  const int lane = threadIdx.x & 31;
  const int warp = threadIdx.x >> 5;
  const std::uint32_t slot = blockIdx.x * 4 + warp;
  if (slot >= count) return;
  const std::uint32_t total_slots = gridDim.x * 4;
  __shared__ CoopState states[4];
  const std::size_t words_per_job = static_cast<std::size_t>(brc_argon2::kMemoryBlocks) * 128;
  for (std::uint32_t round = 0; round < iterations; ++round) {
    const std::uint32_t index = round * total_slots + slot;
    if (lane == 0) {
      for (int i = 0; i < kHeaderLen; ++i) states[warp].header[i] = base_header[i];
      const std::uint64_t nonce = nonce_start + index;
      states[warp].header[112] = static_cast<std::uint8_t>(nonce >> 24);
      states[warp].header[113] = static_cast<std::uint8_t>(nonce >> 16);
      states[warp].header[114] = static_cast<std::uint8_t>(nonce >> 8);
      states[warp].header[115] = static_cast<std::uint8_t>(nonce);
    }
    __syncwarp();
    argon2_hash_coop(digests + static_cast<std::size_t>(index) * 32,
                     memories + static_cast<std::size_t>(slot) * words_per_job,
                     states[warp], lane
#ifdef BRC_CUDA_OPT_ADDRESS
                     , cached_addresses
#endif
                     );
    if (lane == 0) {
      valid[index] = digest_less_than(digests + static_cast<std::size_t>(index) * 32,
                                      target) ? 1 : 0;
    }
  }
}

#ifdef BRC_CUDA_OPT_ADDRESS
__global__ void init_cached_addresses_launch(std::uint64_t* addresses) {
  const std::uint32_t block = blockIdx.x * blockDim.x + threadIdx.x;
  if (block >= 128) return;
  const std::uint32_t slice = block / 64;
  const std::uint32_t counter = block % 64 + 1;
  brc_argon2::init_address_block(
      addresses + static_cast<std::size_t>(block) * 128,
      0, slice, counter);
}
#endif

__global__ void diagnostic_launch(std::uint32_t* result) {
  if (blockIdx.x == 0 && threadIdx.x == 0) *result = 0xB2C0128u;
}

__global__ void initial_prefix_launch(const std::uint8_t* header, std::uint8_t* out,
                                      std::uint32_t block_index) {
  if (blockIdx.x != 0 || threadIdx.x != 0) return;
  std::uint8_t h0[kH0Len];
  std::uint64_t block[128];
  h0_kernel(header, h0);
  initial_block(h0, block_index, 0, block);
  for (int i = 0; i < 8; ++i)
    for (int j = 0; j < 8; ++j)
      out[i * 8 + j] = static_cast<std::uint8_t>(block[i] >> (8 * j));
}

__global__ void initial_tail_launch(const std::uint8_t* header, std::uint8_t* out) {
  if (blockIdx.x != 0 || threadIdx.x != 0) return;
  std::uint8_t h0[kH0Len];
  std::uint64_t block[128];
  h0_kernel(header, h0);
  initial_block(h0, 0, 0, block);
  for (int i = 0; i < 8; ++i)
    for (int j = 0; j < 8; ++j)
      out[i * 8 + j] = static_cast<std::uint8_t>(block[i + 8] >> (8 * j));
}

__global__ void initial_end_launch(const std::uint8_t* header, std::uint8_t* out) {
  if (blockIdx.x != 0 || threadIdx.x != 0) return;
  std::uint8_t h0[kH0Len];
  std::uint64_t block[128];
  h0_kernel(header, h0);
  initial_block(h0, 1, 0, block);
  for (int i = 0; i < 8; ++i)
    for (int j = 0; j < 8; ++j)
      out[i * 8 + j] = static_cast<std::uint8_t>(block[i + 120] >> (8 * j));
}

__global__ void block2_prefix_launch(const std::uint8_t* header, std::uint8_t* out,
                                     std::uint64_t* memory) {
  if (blockIdx.x != 0 || threadIdx.x != 0) return;
  std::uint8_t h0[kH0Len];
  h0_kernel(header, h0);
  initial_block(h0, 0, 0, memory);
  initial_block(h0, 1, 0, memory + 128);
  brc_argon2::fill_lane(memory);
  const std::uint64_t* block = memory + 2 * 128;
  for (int i = 0; i < 8; ++i)
    for (int j = 0; j < 8; ++j)
      out[i * 8 + j] = static_cast<std::uint8_t>(block[i] >> (8 * j));
}

__global__ void block3_prefix_launch(const std::uint8_t* header, std::uint8_t* out,
                                     std::uint64_t* memory) {
  if (blockIdx.x != 0 || threadIdx.x != 0) return;
  std::uint8_t h0[kH0Len];
  h0_kernel(header, h0);
  initial_block(h0, 0, 0, memory);
  initial_block(h0, 1, 0, memory + 128);
  brc_argon2::fill_lane(memory);
  const std::uint64_t* block = memory + 3 * 128;
  for (int i = 0; i < 8; ++i)
    for (int j = 0; j < 8; ++j)
      out[i * 8 + j] = static_cast<std::uint8_t>(block[i] >> (8 * j));
}

__global__ void block130_prefix_launch(const std::uint8_t* header, std::uint8_t* out,
                                       std::uint64_t* memory) {
  if (blockIdx.x != 0 || threadIdx.x != 0) return;
  std::uint8_t h0[kH0Len];
  h0_kernel(header, h0);
  initial_block(h0, 0, 0, memory);
  initial_block(h0, 1, 0, memory + 128);
  brc_argon2::fill_lane(memory);
  const std::uint64_t* block = memory + 130 * 128;
  for (int i = 0; i < 8; ++i)
    for (int j = 0; j < 8; ++j)
      out[i * 8 + j] = static_cast<std::uint8_t>(block[i] >> (8 * j));
}

__global__ void block8192_prefix_launch(const std::uint8_t* header, std::uint8_t* out,
                                        std::uint64_t* memory) {
  if (blockIdx.x != 0 || threadIdx.x != 0) return;
  std::uint8_t h0[kH0Len];
  h0_kernel(header, h0);
  initial_block(h0, 0, 0, memory);
  initial_block(h0, 1, 0, memory + 128);
  brc_argon2::fill_lane(memory);
  const std::uint64_t* block = memory + 8192 * 128;
  for (int i = 0; i < 8; ++i)
    for (int j = 0; j < 8; ++j)
      out[i * 8 + j] = static_cast<std::uint8_t>(block[i] >> (8 * j));
}

__global__ void block16384_prefix_launch(const std::uint8_t* header, std::uint8_t* out,
                                         std::uint64_t* memory) {
  if (blockIdx.x != 0 || threadIdx.x != 0) return;
  std::uint8_t h0[kH0Len];
  h0_kernel(header, h0);
  initial_block(h0, 0, 0, memory);
  initial_block(h0, 1, 0, memory + 128);
  brc_argon2::fill_lane(memory);
  const std::uint64_t* block = memory + 16384 * 128;
  for (int i = 0; i < 8; ++i)
    for (int j = 0; j < 8; ++j)
      out[i * 8 + j] = static_cast<std::uint8_t>(block[i] >> (8 * j));
}

__global__ void block24576_prefix_launch(const std::uint8_t* header, std::uint8_t* out,
                                         std::uint64_t* memory) {
  if (blockIdx.x != 0 || threadIdx.x != 0) return;
  std::uint8_t h0[kH0Len];
  h0_kernel(header, h0);
  initial_block(h0, 0, 0, memory);
  initial_block(h0, 1, 0, memory + 128);
  brc_argon2::fill_lane(memory);
  const std::uint64_t* block = memory + 24576 * 128;
  for (int i = 0; i < 8; ++i)
    for (int j = 0; j < 8; ++j)
      out[i * 8 + j] = static_cast<std::uint8_t>(block[i] >> (8 * j));
}

__global__ void block32767_prefix_launch(const std::uint8_t* header, std::uint8_t* out,
                                         std::uint64_t* memory) {
  if (blockIdx.x != 0 || threadIdx.x != 0) return;
  std::uint8_t h0[kH0Len];
  h0_kernel(header, h0);
  initial_block(h0, 0, 0, memory);
  initial_block(h0, 1, 0, memory + 128);
  brc_argon2::fill_lane(memory);
  const std::uint64_t* block = memory + 32767 * 128;
  for (int i = 0; i < 8; ++i)
    for (int j = 0; j < 8; ++j)
      out[i * 8 + j] = static_cast<std::uint8_t>(block[i] >> (8 * j));
}

bool decode_hex(const char* s, std::vector<std::uint8_t>& out) {
  const std::size_t n = std::strlen(s);
  if (n % 2 != 0) return false;
  out.resize(n / 2);
  for (std::size_t i = 0; i < out.size(); ++i) {
    unsigned x = 0;
    if (std::sscanf(s + i * 2, "%2x", &x) != 1) return false;
    out[i] = static_cast<std::uint8_t>(x);
  }
  return true;
}

void print_hex(const std::uint8_t* p, std::size_t n) {
  for (std::size_t i = 0; i < n; ++i) std::printf("%02x", p[i]);
  std::putchar('\n');
}

} // namespace

#include "include/brc_argon_cuda.h"

struct brc_argon_cuda_context {
  int device;
  std::uint8_t* d_header = nullptr;
  std::uint8_t* d_out = nullptr;
  std::uint8_t* d_target = nullptr;
  std::uint8_t* d_digests = nullptr;
  std::uint8_t* d_valid = nullptr;
  std::uint8_t* d_persistent_digests = nullptr;
  std::uint8_t* d_persistent_valid = nullptr;
#ifdef BRC_CUDA_OPT_ADDRESS
  std::uint64_t* d_cached_addresses = nullptr;
#endif
  std::uint64_t* d_memory = nullptr;
  std::size_t memory_jobs = 0;
  std::size_t digest_capacity = 0;
  std::size_t valid_capacity = 0;
  std::size_t persistent_capacity = 0;
  std::vector<std::uint8_t> host_digests;
  std::vector<std::uint8_t> host_valid;
  std::vector<std::uint8_t> host_persistent_valid;
};

namespace {
thread_local char g_api_error[256] = "ok";

int api_error(const char* message) {
  std::snprintf(g_api_error, sizeof(g_api_error), "%s", message);
  return -1;
}

int api_cuda_error(const char* operation, cudaError_t error) {
  std::snprintf(g_api_error, sizeof(g_api_error), "%s: %s", operation,
                cudaGetErrorString(error));
  return -1;
}

bool api_set_device(const brc_argon_cuda_context* context) {
  return context != nullptr && cudaSetDevice(context->device) == cudaSuccess;
}

bool api_ensure_workspace(brc_argon_cuda_context* context, std::size_t jobs) {
  const std::size_t words = static_cast<std::size_t>(brc_argon2::kMemoryBlocks) * 128;
  cudaError_t error = cudaSuccess;
  if (context->d_header == nullptr) error = cudaMalloc(&context->d_header, kHeaderLen);
  if (error == cudaSuccess && context->d_out == nullptr) error = cudaMalloc(&context->d_out, 32);
  if (error == cudaSuccess && context->d_target == nullptr) error = cudaMalloc(&context->d_target, 32);
  if (error == cudaSuccess && context->d_memory == nullptr) {
    error = cudaMalloc(&context->d_memory, jobs * words * sizeof(std::uint64_t));
    if (error == cudaSuccess) context->memory_jobs = jobs;
  }
  if (error == cudaSuccess && jobs > context->memory_jobs) {
    std::uint64_t* replacement = nullptr;
    error = cudaMalloc(&replacement, jobs * words * sizeof(std::uint64_t));
    if (error == cudaSuccess) {
      cudaFree(context->d_memory);
      context->d_memory = replacement;
      context->memory_jobs = jobs;
    }
  }
  if (error == cudaSuccess && (context->d_digests == nullptr || jobs > context->digest_capacity)) {
    std::uint8_t* replacement = nullptr;
    error = cudaMalloc(&replacement, jobs * 32);
    if (error == cudaSuccess) {
      cudaFree(context->d_digests);
      context->d_digests = replacement;
      context->digest_capacity = jobs;
    }
  }
  if (error == cudaSuccess && (context->d_valid == nullptr || jobs > context->valid_capacity)) {
    std::uint8_t* replacement = nullptr;
    error = cudaMalloc(&replacement, jobs);
    if (error == cudaSuccess) {
      cudaFree(context->d_valid);
      context->d_valid = replacement;
      context->valid_capacity = jobs;
    }
  }
  if (error != cudaSuccess) {
    api_cuda_error("CUDA workspace allocation", error);
    return false;
  }
  return true;
}

bool api_ensure_persistent_workspace(brc_argon_cuda_context* context, std::size_t jobs) {
  if (jobs <= context->persistent_capacity) return true;
  std::uint8_t* replacement_digests = nullptr;
  std::uint8_t* replacement_valid = nullptr;
  cudaError_t error = cudaMalloc(&replacement_digests, jobs * 32);
  if (error == cudaSuccess) error = cudaMalloc(&replacement_valid, jobs);
  if (error == cudaSuccess) {
    cudaFree(context->d_persistent_digests);
    cudaFree(context->d_persistent_valid);
    context->d_persistent_digests = replacement_digests;
    context->d_persistent_valid = replacement_valid;
    context->persistent_capacity = jobs;
    return true;
  }
  cudaFree(replacement_digests);
  cudaFree(replacement_valid);
  api_cuda_error("CUDA persistent result allocation", error);
  return false;
}
} // namespace

extern "C" int brc_argon_cuda_create(brc_argon_cuda_context** context, int device) {
  if (context == nullptr) return api_error("context output is null");
  int count = 0;
  cudaError_t error = cudaGetDeviceCount(&count);
  if (error != cudaSuccess) return api_cuda_error("cudaGetDeviceCount", error);
  if (count == 0) return api_error("no CUDA devices found");
  if (device < 0) device = 0;
  if (device >= count) return api_error("CUDA device index out of range");
  error = cudaSetDevice(device);
  if (error != cudaSuccess) return api_cuda_error("cudaSetDevice", error);
  *context = new brc_argon_cuda_context{device};
#ifdef BRC_CUDA_OPT_ADDRESS
  constexpr std::size_t address_words = 2 * 64 * 128;
  error = cudaMalloc(&(*context)->d_cached_addresses,
                     address_words * sizeof(std::uint64_t));
  if (error == cudaSuccess) {
    init_cached_addresses_launch<<<1, 128>>>((*context)->d_cached_addresses);
    error = cudaGetLastError();
  }
  if (error == cudaSuccess) error = cudaDeviceSynchronize();
  if (error != cudaSuccess) {
    cudaFree((*context)->d_cached_addresses);
    delete *context;
    *context = nullptr;
    return api_cuda_error("CUDA address cache initialization", error);
  }
#endif
  std::snprintf(g_api_error, sizeof(g_api_error), "ok");
  return 0;
}

extern "C" void brc_argon_cuda_destroy(brc_argon_cuda_context* context) {
  if (context == nullptr) return;
  cudaSetDevice(context->device);
  cudaFree(context->d_header);
  cudaFree(context->d_out);
  cudaFree(context->d_target);
  cudaFree(context->d_digests);
  cudaFree(context->d_valid);
  cudaFree(context->d_persistent_digests);
  cudaFree(context->d_persistent_valid);
#ifdef BRC_CUDA_OPT_ADDRESS
  cudaFree(context->d_cached_addresses);
#endif
  cudaFree(context->d_memory);
  delete context;
}

extern "C" int brc_argon_cuda_hash(
    brc_argon_cuda_context* context,
    const std::uint8_t header[kHeaderLen],
    std::uint8_t digest[32]) {
  if (context == nullptr || header == nullptr || digest == nullptr)
    return api_error("null hash argument");
  if (!api_set_device(context)) return api_error("invalid CUDA context");
  if (!api_ensure_workspace(context, 1)) return -1;
  cudaError_t error = cudaSuccess;
  if (error == cudaSuccess) error = cudaMemcpy(context->d_header, header, kHeaderLen, cudaMemcpyHostToDevice);
  if (error == cudaSuccess) {
    argon2_launch<<<1, 1>>>(context->d_header, context->d_out, context->d_memory);
    error = cudaGetLastError();
  }
  if (error == cudaSuccess) error = cudaDeviceSynchronize();
  if (error == cudaSuccess) error = cudaMemcpy(digest, context->d_out, 32, cudaMemcpyDeviceToHost);
  if (error != cudaSuccess) return api_cuda_error("CUDA hash", error);
  std::snprintf(g_api_error, sizeof(g_api_error), "ok");
  return 0;
}

extern "C" int brc_argon_cuda_mine_batch(
    brc_argon_cuda_context* context,
    const std::uint8_t header[kHeaderLen],
    std::uint32_t nonce_start,
    std::uint32_t count,
    const std::uint8_t target[32],
    brc_argon_cuda_share* share) {
  if (context == nullptr || header == nullptr || target == nullptr || share == nullptr)
    return api_error("null mining argument");
  if (count == 0) return api_error("batch count must be positive");
  if (nonce_start > 0xffffffffu - (count - 1))
    return api_error("nonce range exceeds uint32");
  if (!api_set_device(context)) return api_error("invalid CUDA context");
  if (!api_ensure_workspace(context, count)) return -1;
  const std::size_t digest_bytes = static_cast<std::size_t>(count) * 32;
  if (context->host_digests.size() < digest_bytes)
    context->host_digests.resize(digest_bytes);
  if (context->host_valid.size() < count)
    context->host_valid.resize(count);
  cudaError_t error = cudaMemcpy(context->d_header, header, kHeaderLen, cudaMemcpyHostToDevice);
  if (error == cudaSuccess) error = cudaMemcpy(context->d_target, target, 32, cudaMemcpyHostToDevice);
  if (error == cudaSuccess) {
    mine_batch_coop_launch<<<(count + 3) / 4, 128>>>(
        context->d_header, nonce_start, count, context->d_target,
        context->d_memory, context->d_digests, context->d_valid
#ifdef BRC_CUDA_OPT_ADDRESS
        , context->d_cached_addresses
#endif
        );
    error = cudaGetLastError();
  }
  if (error == cudaSuccess) error = cudaDeviceSynchronize();
  if (error == cudaSuccess) error = cudaMemcpy(context->host_digests.data(), context->d_digests,
                                                digest_bytes, cudaMemcpyDeviceToHost);
  if (error == cudaSuccess) error = cudaMemcpy(context->host_valid.data(), context->d_valid,
                                                count, cudaMemcpyDeviceToHost);
  if (error != cudaSuccess) return api_cuda_error("CUDA batch mine", error);
  for (std::uint32_t i = 0; i < count; ++i) {
    if (!context->host_valid[i]) continue;
    share->nonce = nonce_start + i;
    std::memcpy(share->digest, context->host_digests.data() + static_cast<std::size_t>(i) * 32, 32);
    std::snprintf(g_api_error, sizeof(g_api_error), "ok");
    return 0;
  }
  std::snprintf(g_api_error, sizeof(g_api_error), "no share");
  return 1;
}

extern "C" int brc_argon_cuda_mine_persistent(
    brc_argon_cuda_context* context,
    const std::uint8_t header[kHeaderLen],
    std::uint32_t nonce_start,
    std::uint32_t count,
    std::uint32_t iterations,
    const std::uint8_t target[32],
    brc_argon_cuda_share* share) {
  if (context == nullptr || header == nullptr || target == nullptr || share == nullptr)
    return api_error("null persistent mining argument");
  if (count == 0 || iterations == 0) return api_error("persistent batch parameters must be positive");
  const std::uint64_t total = static_cast<std::uint64_t>(count) * iterations;
  if (total > 0xffffffffULL || nonce_start > 0xffffffffu - (total - 1))
    return api_error("persistent nonce range exceeds uint32");
  if (!api_set_device(context) || !api_ensure_workspace(context, count) ||
      !api_ensure_persistent_workspace(context, static_cast<std::size_t>(total))) return -1;
  if (context->host_persistent_valid.size() < total)
    context->host_persistent_valid.resize(total);
  cudaError_t error = cudaMemcpy(context->d_header, header, kHeaderLen, cudaMemcpyHostToDevice);
  if (error == cudaSuccess) error = cudaMemcpy(context->d_target, target, 32, cudaMemcpyHostToDevice);
  if (error == cudaSuccess) {
    mine_persistent_coop_launch<<<(count + 3) / 4, 128>>>(
        context->d_header, nonce_start, count, iterations, context->d_target,
        context->d_memory, context->d_persistent_digests,
        context->d_persistent_valid
#ifdef BRC_CUDA_OPT_ADDRESS
        , context->d_cached_addresses
#endif
        );
    error = cudaGetLastError();
  }
  if (error == cudaSuccess) error = cudaDeviceSynchronize();
  if (error == cudaSuccess) error = cudaMemcpy(
      context->host_persistent_valid.data(), context->d_persistent_valid,
      static_cast<std::size_t>(total), cudaMemcpyDeviceToHost);
  if (error != cudaSuccess) return api_cuda_error("CUDA persistent mine", error);
  for (std::uint64_t i = 0; i < total; ++i) {
    if (!context->host_persistent_valid[i]) continue;
    error = cudaMemcpy(share->digest,
                       context->d_persistent_digests + i * 32, 32,
                       cudaMemcpyDeviceToHost);
    if (error != cudaSuccess) return api_cuda_error("CUDA persistent digest", error);
    share->nonce = nonce_start + static_cast<std::uint32_t>(i);
    std::snprintf(g_api_error, sizeof(g_api_error), "ok");
    return 0;
  }
  std::snprintf(g_api_error, sizeof(g_api_error), "no share");
  return 1;
}

extern "C" int brc_argon_cuda_trim(brc_argon_cuda_context* context, std::uint32_t jobs) {
  if (context == nullptr) return api_error("null trim context");
  if (!api_set_device(context)) return api_error("invalid CUDA context");
  if (jobs > context->memory_jobs) return api_error("trim cannot grow workspace");
  if (jobs < context->memory_jobs) {
    cudaError_t error = cudaFree(context->d_memory);
    if (error != cudaSuccess) return api_cuda_error("CUDA workspace trim", error);
    context->d_memory = nullptr;
    context->memory_jobs = 0;
  }
  if (jobs < context->digest_capacity) {
    cudaError_t error = cudaFree(context->d_digests);
    if (error != cudaSuccess) return api_cuda_error("CUDA digest trim", error);
    context->d_digests = nullptr;
    context->digest_capacity = 0;
  }
  if (jobs < context->valid_capacity) {
    cudaError_t error = cudaFree(context->d_valid);
    if (error != cudaSuccess) return api_cuda_error("CUDA result trim", error);
    context->d_valid = nullptr;
    context->valid_capacity = 0;
  }
  if (jobs < context->persistent_capacity) {
    cudaError_t error = cudaFree(context->d_persistent_digests);
    if (error != cudaSuccess) return api_cuda_error("CUDA persistent digest trim", error);
    error = cudaFree(context->d_persistent_valid);
    if (error != cudaSuccess) return api_cuda_error("CUDA persistent result trim", error);
    context->d_persistent_digests = nullptr;
    context->d_persistent_valid = nullptr;
    context->persistent_capacity = 0;
  }
  std::snprintf(g_api_error, sizeof(g_api_error), "ok");
  return 0;
}

extern "C" const char* brc_argon_cuda_last_error(void) {
  return g_api_error;
}

#ifndef BRC_ARGON_CUDA_LIBRARY
int main(int argc, char** argv) {
  if (argc == 2 && std::strcmp(argv[1], "diagnose") == 0) {
    int count = 0;
    cudaError_t e = cudaGetDeviceCount(&count);
    std::printf("cudaGetDeviceCount: %s (%d)\n", cudaGetErrorString(e), count);
    if (e != cudaSuccess || count == 0) return 1;
    cudaDeviceProp prop{};
    e = cudaGetDeviceProperties(&prop, 0);
    std::printf("cudaGetDeviceProperties: %s\n", cudaGetErrorString(e));
    if (e != cudaSuccess) return 1;
    std::printf("device: %s, compute_%d%d, memory=%zu MiB\n", prop.name,
                prop.major, prop.minor, prop.totalGlobalMem / (1024 * 1024));
    std::uint32_t* d_result = nullptr;
    std::uint32_t result = 0;
    e = cudaMalloc(&d_result, sizeof(result));
    std::printf("cudaMalloc: %s\n", cudaGetErrorString(e));
    if (e != cudaSuccess) return 1;
    diagnostic_launch<<<1, 1>>>(d_result);
    e = cudaGetLastError();
    std::printf("kernel launch: %s\n", cudaGetErrorString(e));
    if (e == cudaSuccess) e = cudaDeviceSynchronize();
    std::printf("cudaDeviceSynchronize: %s\n", cudaGetErrorString(e));
    if (e == cudaSuccess) e = cudaMemcpy(&result, d_result, sizeof(result), cudaMemcpyDeviceToHost);
    std::printf("cudaMemcpy: %s, sentinel=0x%08x\n", cudaGetErrorString(e), result);
    cudaFree(d_result);
    return e == cudaSuccess && result == 0xB2C0128u ? 0 : 1;
  }
  const bool prefix = argc == 3 && (std::strcmp(argv[1], "init-prefix") == 0
                                    || std::strcmp(argv[1], "init1-prefix") == 0);
  const bool block2 = argc == 3 && std::strcmp(argv[1], "block2-prefix") == 0;
  const bool block3 = argc == 3 && std::strcmp(argv[1], "block3-prefix") == 0;
  const bool block130 = argc == 3 && std::strcmp(argv[1], "block130-prefix") == 0;
  const bool block8192 = argc == 3 && std::strcmp(argv[1], "block8192-prefix") == 0;
  const bool block16384 = argc == 3 && std::strcmp(argv[1], "block16384-prefix") == 0;
  const bool block24576 = argc == 3 && std::strcmp(argv[1], "block24576-prefix") == 0;
  const bool block32767 = argc == 3 && std::strcmp(argv[1], "block32767-prefix") == 0;
  const bool tail = argc == 3 && std::strcmp(argv[1], "init-tail") == 0;
  const bool end = argc == 3 && std::strcmp(argv[1], "init-end") == 0;
  const bool mine = argc == 6 && std::strcmp(argv[1], "mine") == 0;
  const bool bench = argc == 6 && std::strcmp(argv[1], "bench") == 0;
  const bool batch_mode = mine || bench;
  if ((!batch_mode && argc != 3) || (batch_mode ? false : (!prefix && !block2 && !block3 && !block130 && !block8192 && !block16384 && !block24576 && !block32767 && !tail && !end && std::strcmp(argv[1], "h0") != 0 && std::strcmp(argv[1], "hash") != 0))) {
    std::fprintf(stderr, "usage: brc-pow-cuda diagnose | h0 | init-prefix | init1-prefix | init-tail | init-end | block2-prefix | block3-prefix | block130-prefix | block8192-prefix | block16384-prefix | block24576-prefix | block32767-prefix | hash <148-byte-header-hex> | mine <148-byte-header-hex> <nonce-start> <count> <target-hex> | bench <148-byte-header-hex> <nonce-start> <count> <rounds>\n");
    return 2;
  }
  std::vector<std::uint8_t> header;
  if (!decode_hex(argv[2], header) || header.size() != kHeaderLen) {
    std::fprintf(stderr, "header must be exactly 148 bytes of hex\n");
    return 2;
  }
  std::uint64_t nonce_start = 0;
  std::uint32_t mine_count = 0;
  std::vector<std::uint8_t> target;
  std::uint32_t rounds = 0;
  if (batch_mode) {
    char* endptr = nullptr;
    const unsigned long long parsed_start = std::strtoull(argv[3], &endptr, 0);
    if (!endptr || *endptr != '\0' || parsed_start > 0xffffffffULL) {
      std::fprintf(stderr, "nonce-start must be a uint32\n");
      return 2;
    }
    const unsigned long long parsed_count = std::strtoull(argv[4], &endptr, 0);
    if (!endptr || *endptr != '\0' || parsed_count == 0 || parsed_count > 0xffffffffULL) {
      std::fprintf(stderr, "count must be between 1 and 4294967295\n");
      return 2;
    }
    if (mine) {
      if (!decode_hex(argv[5], target) || target.size() != 32) {
        std::fprintf(stderr, "target must be exactly 32 bytes of hex\n");
        return 2;
      }
    } else {
      char* rounds_end = nullptr;
      const unsigned long long parsed_rounds = std::strtoull(argv[5], &rounds_end, 0);
      if (!rounds_end || *rounds_end != '\0' || parsed_rounds == 0 || parsed_rounds > 1000) {
        std::fprintf(stderr, "rounds must be between 1 and 1000\n");
        return 2;
      }
      target.assign(32, 0xff);
      rounds = static_cast<std::uint32_t>(parsed_rounds);
    }
    nonce_start = static_cast<std::uint64_t>(parsed_start);
    mine_count = static_cast<std::uint32_t>(parsed_count);
    if (nonce_start + mine_count - 1 > 0xffffffffULL) {
      std::fprintf(stderr, "nonce range exceeds uint32\n");
      return 2;
    }
  }
  std::uint8_t *d_header = nullptr, *d_out = nullptr;
  std::uint8_t out[kH0Len]{};
  std::uint64_t* d_memory = nullptr;
  std::uint8_t* d_target = nullptr;
  std::uint8_t* d_batch_digests = nullptr;
  std::uint8_t* d_batch_valid = nullptr;
  auto check = [](cudaError_t e) { return e == cudaSuccess; };
  const bool full_hash = std::strcmp(argv[1], "hash") == 0;
  const std::size_t output_len = full_hash ? 32 : kH0Len;
  const bool needs_memory = full_hash || block2 || block3 || block130 || block8192 || block16384 || block24576 || block32767;
  const std::size_t words_per_job = static_cast<std::size_t>(brc_argon2::kMemoryBlocks) * 128;
  const std::size_t memory_jobs = batch_mode ? mine_count : 1;
  if (!check(cudaMalloc(&d_header, header.size()))
      || (!batch_mode && !check(cudaMalloc(&d_out, output_len)))
      || (needs_memory && !batch_mode && !check(cudaMalloc(&d_memory, words_per_job * sizeof(std::uint64_t))))
      || (batch_mode && (!check(cudaMalloc(&d_target, target.size()))
                   || !check(cudaMalloc(&d_batch_digests, memory_jobs * 32))
                   || !check(cudaMalloc(&d_batch_valid, memory_jobs))
                   || !check(cudaMalloc(&d_memory, memory_jobs * words_per_job * sizeof(std::uint64_t)))))
      || !check(cudaMemcpy(d_header, header.data(), header.size(), cudaMemcpyHostToDevice))
      || (batch_mode && !check(cudaMemcpy(d_target, target.data(), target.size(), cudaMemcpyHostToDevice)))) {
    std::fprintf(stderr, "CUDA allocation/copy failed\n");
    cudaFree(d_header); cudaFree(d_out); cudaFree(d_memory); cudaFree(d_target);
    cudaFree(d_batch_digests); cudaFree(d_batch_valid); return 1;
  }
  if (bench) {
    cudaEvent_t device_begin = nullptr;
    cudaEvent_t device_end = nullptr;
    if (!check(cudaEventCreate(&device_begin)) || !check(cudaEventCreate(&device_end))) {
      std::fprintf(stderr, "CUDA benchmark event setup failed: %s\n",
                   cudaGetErrorString(cudaGetLastError()));
      cudaEventDestroy(device_begin);
      cudaEventDestroy(device_end);
      cudaFree(d_header); cudaFree(d_memory); cudaFree(d_target);
      cudaFree(d_batch_digests); cudaFree(d_batch_valid);
      return 1;
    }
    const auto begin = std::chrono::steady_clock::now();
    cudaEventRecord(device_begin);
    for (std::uint32_t round = 0; round < rounds; ++round) {
      mine_batch_coop_launch<<<(mine_count + 3) / 4, 128>>>(
          d_header, nonce_start, mine_count, d_target, d_memory,
          d_batch_digests, d_batch_valid);
      if (!check(cudaGetLastError()) || !check(cudaDeviceSynchronize())) {
        std::fprintf(stderr, "CUDA benchmark failed: %s\n", cudaGetErrorString(cudaGetLastError()));
        cudaFree(d_header); cudaFree(d_memory); cudaFree(d_target);
        cudaFree(d_batch_digests); cudaFree(d_batch_valid); return 1;
      }
    }
    cudaEventRecord(device_end);
    if (!check(cudaEventSynchronize(device_end))) {
      std::fprintf(stderr, "CUDA benchmark event failed: %s\n",
                   cudaGetErrorString(cudaGetLastError()));
      cudaEventDestroy(device_begin); cudaEventDestroy(device_end);
      cudaFree(d_header); cudaFree(d_memory); cudaFree(d_target);
      cudaFree(d_batch_digests); cudaFree(d_batch_valid);
      return 1;
    }
    const auto end_time = std::chrono::steady_clock::now();
    float device_milliseconds = 0.0f;
    if (!check(cudaEventElapsedTime(&device_milliseconds, device_begin, device_end))) {
      std::fprintf(stderr, "CUDA benchmark event read failed: %s\n",
                   cudaGetErrorString(cudaGetLastError()));
      cudaEventDestroy(device_begin); cudaEventDestroy(device_end);
      cudaFree(d_header); cudaFree(d_memory); cudaFree(d_target);
      cudaFree(d_batch_digests); cudaFree(d_batch_valid);
      return 1;
    }
    const double seconds = std::chrono::duration<double>(end_time - begin).count();
    const double device_seconds = static_cast<double>(device_milliseconds) / 1000.0;
    const double hashes = static_cast<double>(mine_count) * rounds;
    std::printf("bench count=%u rounds=%u host_elapsed=%.3f sec host_hashes_per_sec=%.3f "
                "device_elapsed=%.3f sec device_hashes_per_sec=%.3f\n",
                mine_count, rounds, seconds, hashes / seconds,
                device_seconds, hashes / device_seconds);
    cudaEventDestroy(device_begin);
    cudaEventDestroy(device_end);
    cudaFree(d_header); cudaFree(d_memory); cudaFree(d_target);
    cudaFree(d_batch_digests); cudaFree(d_batch_valid);
    return 0;
  }
  if (mine) {
    mine_batch_coop_launch<<<(mine_count + 3) / 4, 128>>>(
        d_header, nonce_start, mine_count, d_target, d_memory, d_batch_digests, d_batch_valid);
  } else if (full_hash) argon2_launch<<<1, 1>>>(d_header, d_out, d_memory);
  else if (block2) block2_prefix_launch<<<1, 1>>>(d_header, d_out, d_memory);
  else if (block3) block3_prefix_launch<<<1, 1>>>(d_header, d_out, d_memory);
  else if (block130) block130_prefix_launch<<<1, 1>>>(d_header, d_out, d_memory);
  else if (block8192) block8192_prefix_launch<<<1, 1>>>(d_header, d_out, d_memory);
  else if (block16384) block16384_prefix_launch<<<1, 1>>>(d_header, d_out, d_memory);
  else if (block24576) block24576_prefix_launch<<<1, 1>>>(d_header, d_out, d_memory);
  else if (block32767) block32767_prefix_launch<<<1, 1>>>(d_header, d_out, d_memory);
  else if (end) initial_end_launch<<<1, 1>>>(d_header, d_out);
  else if (tail) initial_tail_launch<<<1, 1>>>(d_header, d_out);
  else if (prefix) initial_prefix_launch<<<1, 1>>>(d_header, d_out,
                                                    std::strcmp(argv[1], "init1-prefix") == 0 ? 1 : 0);
  else h0_launch<<<1, 1>>>(d_header, d_out);
  if (!check(cudaGetLastError()) || !check(cudaDeviceSynchronize())) {
    std::fprintf(stderr, "CUDA H0 execution failed: %s\n", cudaGetErrorString(cudaGetLastError()));
    cudaFree(d_header); cudaFree(d_out); cudaFree(d_memory); cudaFree(d_target);
    cudaFree(d_batch_digests); cudaFree(d_batch_valid); return 1;
  }
  if (mine) {
    std::vector<std::uint8_t> batch_digests(static_cast<std::size_t>(mine_count) * 32);
    std::vector<std::uint8_t> batch_valid(mine_count);
    if (!check(cudaMemcpy(batch_digests.data(), d_batch_digests, mine_count * 32,
                          cudaMemcpyDeviceToHost))
        || !check(cudaMemcpy(batch_valid.data(), d_batch_valid, mine_count,
                             cudaMemcpyDeviceToHost))) {
      std::fprintf(stderr, "CUDA result copy failed\n");
      return 1;
    }
    std::uint32_t found_index = mine_count;
    for (std::uint32_t i = 0; i < mine_count; ++i) {
      if (batch_valid[i]) {
        found_index = i;
        break;
      }
    }
    if (found_index == mine_count) {
      std::printf("no-share\n");
    } else {
      std::printf("nonce=%llu digest=", static_cast<unsigned long long>(nonce_start + found_index));
      print_hex(batch_digests.data() + found_index * 32, 32);
    }
    cudaFree(d_header); cudaFree(d_out); cudaFree(d_memory); cudaFree(d_target);
    cudaFree(d_batch_digests); cudaFree(d_batch_valid);
    return 0;
  }
  if (!check(cudaMemcpy(out, d_out, output_len, cudaMemcpyDeviceToHost))) {
    std::fprintf(stderr, "CUDA H0 execution failed: %s\n", cudaGetErrorString(cudaGetLastError()));
    cudaFree(d_header); cudaFree(d_out); cudaFree(d_memory); return 1;
  }
  print_hex(out, output_len);
  cudaFree(d_header); cudaFree(d_out); cudaFree(d_memory);
  return 0;
}
#endif
