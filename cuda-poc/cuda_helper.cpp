#include "include/brc_argon_cuda.h"
#include <cuda_runtime.h>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

namespace {

constexpr std::uint64_t kNonceSpace = 1ULL << 32;
std::atomic<bool> stop_requested{false};
std::atomic<double> throttle{1.0};
std::mutex output_mutex;

int selected_device() {
  const char* raw = std::getenv("MINER_CUDA_DEVICE");
  if (raw == nullptr || *raw == '\0') return 0;
  char* end = nullptr;
  const long value = std::strtol(raw, &end, 10);
  if (end == raw || *end != '\0' || value < 0 || value > std::numeric_limits<int>::max()) return -1;
  return static_cast<int>(value);
}

bool decode_hex(const std::string& text, std::uint8_t* out, std::size_t size) {
  if (text.size() != size * 2) return false;
  for (std::size_t i = 0; i < size; ++i) {
    unsigned value = 0;
    if (std::sscanf(text.c_str() + i * 2, "%2x", &value) != 1) return false;
    out[i] = static_cast<std::uint8_t>(value);
  }
  return true;
}

bool parse_u64(const std::string& text, std::uint64_t& out) {
  char* end = nullptr;
  const unsigned long long value = std::strtoull(text.c_str(), &end, 10);
  if (end == nullptr || *end != '\0' || value > kNonceSpace) return false;
  out = static_cast<std::uint64_t>(value);
  return true;
}

bool parse_double(const std::string& text, double& out) {
  char* end = nullptr;
  out = std::strtod(text.c_str(), &end);
  return end != nullptr && *end == '\0' && std::isfinite(out);
}

void print_error(const std::string& message) {
  std::lock_guard lock(output_mutex);
  std::cout << "ERROR " << message << std::endl;
}

void run_job(brc_argon_cuda_context* context, const std::string& header_hex,
             const std::string& target_hex, std::uint64_t start,
             std::uint64_t end, double initial_throttle, bool continuous,
             std::uint32_t batch_limit) {
  std::uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES]{};
  std::uint8_t target[BRC_ARGON_CUDA_DIGEST_BYTES]{};
  if (!decode_hex(header_hex, header, sizeof(header)) ||
      !decode_hex(target_hex, target, sizeof(target))) {
    print_error("invalid START hex");
    return;
  }
  if (start >= end || end > kNonceSpace) {
    print_error("invalid START nonce range");
    return;
  }

  throttle.store(std::max(0.05, std::min(1.0, initial_throttle)), std::memory_order_relaxed);
  std::uint64_t nonce = start;
  std::uint64_t hashes = 0;
  std::uint64_t last_report_hashes = 0;
  auto last_report_at = std::chrono::steady_clock::now();

  while (!stop_requested.load(std::memory_order_relaxed) && nonce < end) {
    const std::uint32_t count = static_cast<std::uint32_t>(
        std::min<std::uint64_t>(batch_limit, end - nonce));
    brc_argon_cuda_share share{};
    const auto started = std::chrono::steady_clock::now();
    const int result = brc_argon_cuda_mine_batch(
        context, header, static_cast<std::uint32_t>(nonce), count, target, &share);
    if (result < 0) {
      print_error(brc_argon_cuda_last_error());
      return;
    }
    hashes += count;

    const double duty = throttle.load(std::memory_order_relaxed);
    if (duty < 1.0) {
      const double work_ms = std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - started).count();
      const double rest_ms = std::min(1000.0, work_ms * (1.0 - duty) / duty);
      if (rest_ms >= 1.0)
        std::this_thread::sleep_for(std::chrono::duration<double, std::milli>(rest_ms));
    }

    if (result == 0) {
      {
        std::lock_guard lock(output_mutex);
        std::cout << "SOLVED " << share.nonce << " ";
        for (std::uint8_t byte : share.digest)
          std::cout << std::hex << std::setw(2) << std::setfill('0')
                    << static_cast<unsigned>(byte);
        std::cout << std::dec << std::endl;
      }
      // The batch API returns the lowest hit. Advance past that hit so
      // continuous mode never reports the same nonce twice. Rechecking the
      // remainder of the batch is deliberate: it preserves every payable hit.
      nonce = static_cast<std::uint64_t>(share.nonce) + 1;
      if (!continuous) return;
    } else {
      nonce += count;
    }

    const auto now = std::chrono::steady_clock::now();
    if (std::chrono::duration<double>(now - last_report_at).count() >= 1.0 || nonce >= end) {
      std::lock_guard lock(output_mutex);
      std::cerr << "HASHRATE " << (hashes - last_report_hashes) << std::endl;
      last_report_hashes = hashes;
      last_report_at = now;
    }
  }
  if (!stop_requested.load(std::memory_order_relaxed)) {
    std::lock_guard lock(output_mutex);
    std::cout << "EXHAUSTED" << std::endl;
  }
}

}  // namespace

int main(int argc, char** argv) {
  brc_argon_cuda_context* context = nullptr;
  if (brc_argon_cuda_create(&context, selected_device()) != 0) {
    if (argc == 2 && std::strcmp(argv[1], "--probe") == 0) return 1;
    std::cerr << "ERROR " << brc_argon_cuda_last_error() << std::endl;
    return 1;
  }
  if (argc == 2 && std::strcmp(argv[1], "--probe") == 0) {
    brc_argon_cuda_destroy(context);
    return 0;
  }
  if (argc == 2 && std::strcmp(argv[1], "--info") == 0) {
    cudaDeviceProp properties{};
    const int device = selected_device();
    const cudaError_t error = cudaGetDeviceProperties(&properties, device);
    if (error != cudaSuccess) {
      std::cerr << "ERROR " << cudaGetErrorString(error) << std::endl;
      brc_argon_cuda_destroy(context);
      return 1;
    }
    std::cout << "device=" << device << " name=" << properties.name
              << " compute=" << properties.major << properties.minor
              << " vram_mib=" << properties.totalGlobalMem / (1024 * 1024)
              << std::endl;
    brc_argon_cuda_destroy(context);
    return 0;
  }

  std::thread job;
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream input(line);
    std::string command;
    input >> command;
    if (command == "START") {
      std::string header, target, start_text, end_text, throttle_text, continuous_text, batch_text;
      input >> header >> target >> start_text >> end_text >> throttle_text >> continuous_text >> batch_text;
      std::uint64_t start = 0, end = 0;
      double duty = 1.0;
      std::uint64_t batch_value = BRC_ARGON_CUDA_MAX_BATCH;
      if (header.empty() || target.empty() || !parse_u64(start_text, start) ||
          !parse_u64(end_text, end) || !parse_double(throttle_text, duty) ||
          !parse_u64(batch_text, batch_value) || batch_value < 1 ||
          batch_value > BRC_ARGON_CUDA_MAX_BATCH ||
          (continuous_text != "0" && continuous_text != "1")) {
        print_error("usage START <header> <target> <start> <end> <throttle> <continuous> <batch>");
        continue;
      }
      stop_requested.store(true, std::memory_order_relaxed);
      if (job.joinable()) job.join();
      stop_requested.store(false, std::memory_order_relaxed);
      const bool continuous = continuous_text == "1";
      job = std::thread(run_job, context, header, target, start, end, duty, continuous,
                        static_cast<std::uint32_t>(batch_value));
    } else if (command == "THROTTLE") {
      std::string value;
      double duty = 1.0;
      input >> value;
      if (!parse_double(value, duty)) print_error("invalid THROTTLE value");
      else throttle.store(std::max(0.05, std::min(1.0, duty)), std::memory_order_relaxed);
    } else if (command == "STOP") {
      stop_requested.store(true, std::memory_order_relaxed);
      if (job.joinable()) job.join();
      stop_requested.store(false, std::memory_order_relaxed);
      std::cout << "STOPPED" << std::endl;
    } else if (command == "QUIT") {
      stop_requested.store(true, std::memory_order_relaxed);
      if (job.joinable()) job.join();
      break;
    } else if (!command.empty()) {
      print_error("unknown command");
    }
  }

  stop_requested.store(true, std::memory_order_relaxed);
  if (job.joinable()) job.join();
  brc_argon_cuda_destroy(context);
  return 0;
}
