#include "../include/brc_argon_cuda.h"

#include <cuda_runtime.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>

namespace {
struct Api {
  void* handle;
  int (*create)(brc_argon_cuda_context**, int);
  void (*destroy)(brc_argon_cuda_context*);
  int (*hash)(brc_argon_cuda_context*, const std::uint8_t*, std::uint8_t*);
  int (*mine)(brc_argon_cuda_context*, const std::uint8_t*, std::uint32_t,
              std::uint32_t, const std::uint8_t*, brc_argon_cuda_share*);
};

template <typename T>
T symbol(void* handle, const char* name) {
  return reinterpret_cast<T>(dlsym(handle, name));
}

Api load_api(const char* path) {
  Api api{};
  api.handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (api.handle == nullptr) {
    std::fprintf(stderr, "dlopen %s failed: %s\n", path, dlerror());
    return api;
  }
  api.create = symbol<decltype(api.create)>(api.handle, "brc_argon_cuda_create");
  api.destroy = symbol<decltype(api.destroy)>(api.handle, "brc_argon_cuda_destroy");
  api.hash = symbol<decltype(api.hash)>(api.handle, "brc_argon_cuda_hash");
  api.mine = symbol<decltype(api.mine)>(api.handle, "brc_argon_cuda_mine_batch");
  return api;
}

bool valid(const Api& api) {
  return api.handle != nullptr && api.create != nullptr && api.destroy != nullptr &&
         api.hash != nullptr && api.mine != nullptr;
}

bool vectors(const Api& stable, const Api& optimized) {
  std::uint8_t headers[4][BRC_ARGON_CUDA_HEADER_BYTES]{};
  const std::uint32_t nonces[] = {0, 1, 0x12345678u, 0xffffffffu};
  for (int i = 0; i < 4; ++i) {
    headers[i][112] = static_cast<std::uint8_t>(nonces[i] >> 24);
    headers[i][113] = static_cast<std::uint8_t>(nonces[i] >> 16);
    headers[i][114] = static_cast<std::uint8_t>(nonces[i] >> 8);
    headers[i][115] = static_cast<std::uint8_t>(nonces[i]);
  }
  std::uint8_t reference[4][32]{};
  std::uint8_t candidate[32]{};
  brc_argon_cuda_context* context = nullptr;
  if (stable.create(&context, 0) != 0) return false;
  for (int i = 0; i < 4; ++i) {
    if (stable.hash(context, headers[i], reference[i]) != 0) return false;
  }
  stable.destroy(context);
  context = nullptr;
  if (optimized.create(&context, 0) != 0) return false;
  for (int i = 0; i < 4; ++i) {
    if (optimized.hash(context, headers[i], candidate) != 0 ||
        std::memcmp(reference[i], candidate, 32) != 0) {
      std::fprintf(stderr, "FAIL nonzero-nonce digest vector nonce=%u\n", nonces[i]);
      optimized.destroy(context);
      return false;
    }
  }
  optimized.destroy(context);
  std::printf("PASS nonzero-nonce digest vectors=4\n");
  return true;
}

double benchmark(const Api& api, const char* label, double seconds) {
  std::uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES]{};
  std::uint8_t target[32];
  std::memset(target, 0xff, sizeof(target));
  brc_argon_cuda_context* context = nullptr;
  if (api.create(&context, 0) != 0) return 0.0;
  brc_argon_cuda_share share{};
  if (api.mine(context, header, 0, 336, target, &share) < 0) {
    api.destroy(context);
    return 0.0;
  }
  const auto started = std::chrono::steady_clock::now();
  std::uint32_t rounds = 0;
  double elapsed = 0;
  do {
    if (api.mine(context, header, 0, 336, target, &share) < 0) {
      api.destroy(context);
      return 0.0;
    }
    ++rounds;
    elapsed = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
  } while (elapsed < seconds);
  api.destroy(context);
  const double rate = 336.0 * rounds / elapsed;
  std::printf("%s rounds=%u elapsed_sec=%.2f host_hashes_per_sec=%.2f\n",
              label, rounds, elapsed, rate);
  return rate;
}
}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::fprintf(stderr, "usage: variant-compare <stable.so> <optimized.so>\n");
    return 2;
  }
  Api stable = load_api(argv[1]);
  Api optimized = load_api(argv[2]);
  if (!valid(stable) || !valid(optimized)) return 1;
  if (!vectors(stable, optimized)) return 1;
  const char* raw = std::getenv("CUDA_COMPARE_SECONDS");
  const double seconds = raw == nullptr ? 30.0 : std::max(1.0, std::atof(raw));
  const double stable_rate = benchmark(stable, "stable", seconds);
  const double optimized_rate = benchmark(optimized, "optimized", seconds);
  if (stable_rate <= 0.0 || optimized_rate <= 0.0) return 1;
  std::printf("speedup_vs_stable=%.3f\n", optimized_rate / stable_rate);
  return 0;
}
