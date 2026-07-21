#pragma once

#include <cstdint>

#include "argon2_block.cuh"

namespace brc_argon2 {

constexpr std::uint32_t kMemoryBlocks = 32768;
constexpr std::uint32_t kSegmentLength = kMemoryBlocks / 4;

__device__ inline void put_le32(std::uint64_t* block, int index, std::uint32_t value) {
  block[index] = value;
}

__device__ inline void init_address_block(std::uint64_t* address,
                                          std::uint32_t pass,
                                          std::uint32_t slice,
                                          std::uint64_t counter) {
  std::uint64_t zero[128]{};
  std::uint64_t input[128]{};
  input[0] = pass;
  input[1] = 0; // one lane
  input[2] = slice;
  input[3] = kMemoryBlocks;
  input[4] = 1; // passes
  input[5] = 2; // Argon2id
  input[6] = counter;
  fill_block(zero, input, address, false);
  fill_block(zero, address, address, false);
}

__device__ inline std::uint32_t reference_index(std::uint32_t pass,
                                                std::uint32_t slice,
                                                std::uint32_t index,
                                                std::uint32_t pseudo) {
  std::uint32_t reference_area;
  std::uint32_t start_position;
  if (pass == 0) {
    start_position = 0;
    reference_area = (slice == 0)
        ? index - 1
        : slice * kSegmentLength + index - 1;
  } else {
    start_position = ((slice + 1) * kSegmentLength) % kMemoryBlocks;
    reference_area = kMemoryBlocks - kSegmentLength + index - 1;
  }
  // The mapping deliberately uses only the low 32 bits of J1, as specified by
  // Argon2's index_alpha function.
  // The reference mapping uses the high half of two unsigned 32-bit
  // products. Keep the original form for the production baseline and expose
  // the intrinsic form to the experimental optimization builds.
#ifdef BRC_CUDA_OPT_REF_INDEX
  const std::uint64_t x2 = static_cast<std::uint64_t>(pseudo) * pseudo;
  const std::uint32_t x2_high = static_cast<std::uint32_t>(x2 >> 32);
  const std::uint32_t y = __umulhi(reference_area, x2_high);
#else
  const std::uint64_t x = static_cast<std::uint64_t>(pseudo);
  const std::uint64_t x2 = x * x;
  const std::uint64_t y = (static_cast<std::uint64_t>(reference_area) * (x2 >> 32)) >> 32;
#endif
  const std::uint32_t relative = reference_area - 1 - static_cast<std::uint32_t>(y);
  return (start_position + relative) % kMemoryBlocks;
}

// Fill one lane. This intentionally uses one CUDA thread for the first
// correctness implementation; the memory is global and the algorithmic
// dependencies are explicit. The later batching pass will parallelize across
// independent jobs while preserving this exact block order per job.
__device__ inline void fill_lane(std::uint64_t* memory) {
  std::uint64_t address[128]{};
  for (std::uint32_t pass = 0; pass < 1; ++pass) {
    for (std::uint32_t slice = 0; slice < 4; ++slice) {
      const bool data_independent = pass == 0 && slice < 2;
      std::uint32_t start = (pass == 0 && slice == 0) ? 2 : 0;
      if (data_independent) {
        for (int i = 0; i < 128; ++i) address[i] = 0;
        // RFC 9106 address counters are one-based.
        init_address_block(address, pass, slice, 1);
      }
      for (std::uint32_t index = start; index < kSegmentLength; ++index) {
        const std::uint32_t absolute = slice * kSegmentLength + index;
        const std::uint64_t* prev = memory + ((absolute + kMemoryBlocks - 1) % kMemoryBlocks) * 128;
        std::uint32_t pseudo;
        if (data_independent) {
          if (index != start && (index & 127) == 0) init_address_block(address, pass, slice, index / 128 + 1);
          pseudo = static_cast<std::uint32_t>(address[index & 127]);
        } else {
          pseudo = static_cast<std::uint32_t>(prev[0]);
        }
        const std::uint32_t ref = reference_index(pass, slice, index, pseudo);
        std::uint64_t* dst = memory + absolute * 128;
        fill_block(prev, memory + ref * 128, dst, pass != 0);
      }
    }
  }
}

} // namespace brc_argon2
