// Development-only Argon2id oracle for generating CUDA parity vectors.
// This is not part of the miner and must not be used as a runtime dependency.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>

using Argon2idHashRaw = int (*) (
    std::uint32_t t_cost,
    std::uint32_t m_cost,
    std::uint32_t parallelism,
    const void* password,
    std::size_t password_len,
    const void* salt,
    std::size_t salt_len,
    void* hash,
    std::size_t hash_len);

static void hex(const std::uint8_t* p, std::size_t n) {
  for (std::size_t i = 0; i < n; ++i) std::printf("%02x", p[i]);
}

int main() {
  constexpr std::size_t kHeaderLen = 148;
  constexpr std::size_t kDigestLen = 32;
  constexpr char kSalt[] = "browsercoin-pow-v5";
  std::uint8_t header[kHeaderLen]{};
  std::uint8_t digest[kDigestLen]{};

  void* lib = dlopen("libargon2.so.1", RTLD_NOW | RTLD_LOCAL);
  if (!lib) {
    std::fprintf(stderr, "cannot load libargon2.so.1: %s\n", dlerror());
    return 1;
  }
  dlerror();
  auto hash_raw = reinterpret_cast<Argon2idHashRaw>(dlsym(lib, "argon2id_hash_raw"));
  const char* symbol_error = dlerror();
  if (symbol_error || !hash_raw) {
    std::fprintf(stderr, "cannot load argon2id_hash_raw: %s\n", symbol_error ? symbol_error : "missing symbol");
    dlclose(lib);
    return 1;
  }

  const char* names[] = {"all-zeros", "all-ff", "incrementing-i"};
  for (int vector = 0; vector < 3; ++vector) {
    for (std::size_t i = 0; i < kHeaderLen; ++i) {
      header[i] = vector == 0 ? 0 : vector == 1 ? 0xff : static_cast<std::uint8_t>(i);
    }
    const int rc = hash_raw(1, 32768, 1, header, kHeaderLen,
                            kSalt, sizeof(kSalt) - 1, digest, kDigestLen);
    if (rc != 0) {
      std::fprintf(stderr, "argon2id_hash_raw failed: %d\n", rc);
      dlclose(lib);
      return 1;
    }
    std::printf("%s ", names[vector]);
    hex(header, kHeaderLen);
    std::printf(" ");
    hex(digest, kDigestLen);
    std::printf("\n");
  }
  dlclose(lib);
  return 0;
}
