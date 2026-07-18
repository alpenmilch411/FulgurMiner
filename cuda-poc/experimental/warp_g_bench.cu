#include <cuda_runtime.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

constexpr int kJobs = 256;
constexpr int kWords = 16;
constexpr int kThreads = 128;
constexpr std::uint64_t kSeed = 0x9e3779b97f4a7c15ULL;

__device__ inline std::uint64_t rotr(std::uint64_t x, unsigned n) {
  return (x >> n) | (x << (64 - n));
}

__device__ inline std::uint64_t f(std::uint64_t x, std::uint64_t y) {
  const std::uint64_t lo = static_cast<std::uint64_t>(static_cast<std::uint32_t>(x))
                         * static_cast<std::uint64_t>(static_cast<std::uint32_t>(y));
  return x + y + 2 * lo;
}

__device__ inline void g(std::uint64_t& a, std::uint64_t& b,
                         std::uint64_t& c, std::uint64_t& d) {
  a = f(a, b); d = rotr(d ^ a, 32);
  c = f(c, d); b = rotr(b ^ c, 24);
  a = f(a, b); d = rotr(d ^ a, 16);
  c = f(c, d); b = rotr(b ^ c, 63);
}

__device__ void shared_g_round(std::uint64_t* x) {
  const int lane = threadIdx.x & 31;
  if (lane < 4) g(x[lane], x[4 + lane], x[8 + lane], x[12 + lane]);
  __syncwarp();
  if (lane == 0) g(x[0], x[5], x[10], x[15]);
  if (lane == 1) g(x[1], x[6], x[11], x[12]);
  if (lane == 2) g(x[2], x[7], x[8], x[13]);
  if (lane == 3) g(x[3], x[4], x[9], x[14]);
  __syncwarp();
}

__device__ void shuffle_g(std::uint64_t& value, int lane, int op,
                          int ia, int ib, int ic, int id) {
  constexpr unsigned mask = 0xffffffffu;
  std::uint64_t a = __shfl_sync(mask, value, ia);
  std::uint64_t b = __shfl_sync(mask, value, ib);
  std::uint64_t c = __shfl_sync(mask, value, ic);
  std::uint64_t d = __shfl_sync(mask, value, id);
  if (lane == op) g(a, b, c, d);
  const std::uint64_t oa = __shfl_sync(mask, a, op);
  const std::uint64_t ob = __shfl_sync(mask, b, op);
  const std::uint64_t oc = __shfl_sync(mask, c, op);
  const std::uint64_t od = __shfl_sync(mask, d, op);
  if (lane == ia) value = oa;
  if (lane == ib) value = ob;
  if (lane == ic) value = oc;
  if (lane == id) value = od;
}

__device__ void shuffle_g_round(std::uint64_t& value, int lane) {
  for (int op = 0; op < 4; ++op)
    shuffle_g(value, lane, op, op, 4 + op, 8 + op, 12 + op);
  __syncwarp();
  shuffle_g(value, lane, 4, 0, 5, 10, 15);
  shuffle_g(value, lane, 5, 1, 6, 11, 12);
  shuffle_g(value, lane, 6, 2, 7, 8, 13);
  shuffle_g(value, lane, 7, 3, 4, 9, 14);
  __syncwarp();
}

__global__ void shared_kernel(std::uint64_t* out, int rounds) {
  const int lane = threadIdx.x & 31;
  const int warp = threadIdx.x >> 5;
  const int job = blockIdx.x * 4 + warp;
  if (job >= kJobs) return;
  __shared__ std::uint64_t state[4][kWords];
  if (lane < kWords)
    state[warp][lane] = kSeed + static_cast<std::uint64_t>(job) * 97 + lane;
  __syncwarp();
  for (int round = 0; round < rounds; ++round) shared_g_round(state[warp]);
  if (lane < kWords) out[job * kWords + lane] = state[warp][lane];
}

__global__ void shuffle_kernel(std::uint64_t* out, int rounds) {
  const int lane = threadIdx.x & 31;
  const int warp = threadIdx.x >> 5;
  const int job = blockIdx.x * 4 + warp;
  if (job >= kJobs) return;
  std::uint64_t value = lane < kWords
      ? kSeed + static_cast<std::uint64_t>(job) * 97 + lane : 0;
  for (int round = 0; round < rounds; ++round) shuffle_g_round(value, lane);
  if (lane < kWords) out[job * kWords + lane] = value;
}

void host_g(std::uint64_t& a, std::uint64_t& b,
            std::uint64_t& c, std::uint64_t& d) {
  auto rotr_host = [](std::uint64_t x, unsigned n) {
    return (x >> n) | (x << (64 - n));
  };
  auto f_host = [](std::uint64_t x, std::uint64_t y) {
    const std::uint64_t lo = static_cast<std::uint64_t>(static_cast<std::uint32_t>(x))
                           * static_cast<std::uint64_t>(static_cast<std::uint32_t>(y));
    return x + y + 2 * lo;
  };
  a = f_host(a, b); d = rotr_host(d ^ a, 32);
  c = f_host(c, d); b = rotr_host(b ^ c, 24);
  a = f_host(a, b); d = rotr_host(d ^ a, 16);
  c = f_host(c, d); b = rotr_host(b ^ c, 63);
}

std::vector<std::uint64_t> host_reference(int job, int rounds) {
  std::vector<std::uint64_t> x(kWords);
  for (int i = 0; i < kWords; ++i) x[i] = kSeed + static_cast<std::uint64_t>(job) * 97 + i;
  for (int round = 0; round < rounds; ++round) {
    for (int op = 0; op < 4; ++op) host_g(x[op], x[4 + op], x[8 + op], x[12 + op]);
    host_g(x[0], x[5], x[10], x[15]);
    host_g(x[1], x[6], x[11], x[12]);
    host_g(x[2], x[7], x[8], x[13]);
    host_g(x[3], x[4], x[9], x[14]);
  }
  return x;
}

bool launch_and_check(void (*launch)(std::uint64_t*, int), std::uint64_t* out,
                     int rounds, const char* name, float& milliseconds) {
  cudaEvent_t begin = nullptr, end = nullptr;
  if (cudaEventCreate(&begin) != cudaSuccess || cudaEventCreate(&end) != cudaSuccess)
    return false;
  launch(out, rounds);
  if (cudaDeviceSynchronize() != cudaSuccess) return false;
  cudaEventRecord(begin);
  launch(out, rounds);
  cudaEventRecord(end);
  if (cudaEventSynchronize(end) != cudaSuccess ||
      cudaEventElapsedTime(&milliseconds, begin, end) != cudaSuccess) return false;
  cudaEventDestroy(begin);
  cudaEventDestroy(end);
  std::printf("%s rounds=%d elapsed_ms=%.3f g_rounds_per_sec=%.2f\n",
              name, rounds, milliseconds,
              static_cast<double>(kJobs) * rounds * 1000.0 / milliseconds);
  return true;
}

}  // namespace

int main() {
  const int rounds = std::max(1, std::atoi(std::getenv("WARP_G_ROUNDS") ?: "10000"));
  std::uint64_t* device_out = nullptr;
  if (cudaMalloc(&device_out, kJobs * kWords * sizeof(std::uint64_t)) != cudaSuccess)
    return 1;
  std::vector<std::uint64_t> shared_out(kJobs * kWords), shuffle_out(kJobs * kWords);
  float shared_ms = 0, shuffle_ms = 0;
  auto shared_launch = [](std::uint64_t* out, int r) {
    shared_kernel<<<(kJobs + 3) / 4, kThreads>>>(out, r);
  };
  auto shuffle_launch = [](std::uint64_t* out, int r) {
    shuffle_kernel<<<(kJobs + 3) / 4, kThreads>>>(out, r);
  };
  bool ok = launch_and_check(shared_launch, device_out, rounds, "shared", shared_ms);
  if (ok && cudaMemcpy(shared_out.data(), device_out, shared_out.size() * sizeof(std::uint64_t),
                       cudaMemcpyDeviceToHost) != cudaSuccess) ok = false;
  ok = ok && launch_and_check(shuffle_launch, device_out, rounds, "shuffle", shuffle_ms);
  if (ok && cudaMemcpy(shuffle_out.data(), device_out, shuffle_out.size() * sizeof(std::uint64_t),
                       cudaMemcpyDeviceToHost) != cudaSuccess) ok = false;
  const auto expected = host_reference(0, rounds);
  for (int i = 0; ok && i < kWords; ++i) {
    if (shared_out[i] != expected[i] || shuffle_out[i] != expected[i]) {
      std::fprintf(stderr, "FAIL output mismatch word=%d shared=%016llx shuffle=%016llx expected=%016llx\n",
                   i, static_cast<unsigned long long>(shared_out[i]),
                   static_cast<unsigned long long>(shuffle_out[i]),
                   static_cast<unsigned long long>(expected[i]));
      ok = false;
    }
  }
  if (ok) {
    std::printf("PASS shared and shuffle outputs match reference\n");
    std::printf("shuffle_speedup=%.3fx\n", shared_ms / shuffle_ms);
  }
  cudaFree(device_out);
  return ok ? 0 : 1;
}
