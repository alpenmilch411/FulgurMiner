// Isolated CUDA availability probe. This intentionally does not touch the
// existing miner or claim Argon2 parity.
#include <cuda_runtime.h>

#include <cstdio>

int main() {
  int count = 0;
  const cudaError_t status = cudaGetDeviceCount(&count);
  if (status != cudaSuccess) {
    std::fprintf(stderr, "CUDA unavailable: %s\n", cudaGetErrorString(status));
    return 2;
  }
  if (count == 0) {
    std::fprintf(stderr, "CUDA unavailable: no NVIDIA devices exposed\n");
    return 2;
  }
  for (int i = 0; i < count; ++i) {
    cudaDeviceProp prop{};
    if (cudaGetDeviceProperties(&prop, i) != cudaSuccess) return 2;
    std::printf("%d,%s,%zu MiB,compute_%d%d\n", i, prop.name,
                prop.totalGlobalMem / (1024 * 1024), prop.major, prop.minor);
  }
  return 0;
}
