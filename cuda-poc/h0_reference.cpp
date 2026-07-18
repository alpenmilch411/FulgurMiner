// Independent H0 oracle. Uses OpenSSL BLAKE2b-512 only for debugging the
// device-side H0 framing; it is not a miner dependency.
#include <openssl/evp.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

static bool decode_hex(const char* s, std::vector<std::uint8_t>& out) {
  const std::size_t n = std::strlen(s);
  if (n != 296) return false;
  out.resize(148);
  for (std::size_t i = 0; i < out.size(); ++i) {
    unsigned v = 0;
    if (std::sscanf(s + i * 2, "%2x", &v) != 1) return false;
    out[i] = static_cast<std::uint8_t>(v);
  }
  return true;
}

static void le32(std::vector<std::uint8_t>& v, std::uint32_t x) {
  v.push_back(static_cast<std::uint8_t>(x));
  v.push_back(static_cast<std::uint8_t>(x >> 8));
  v.push_back(static_cast<std::uint8_t>(x >> 16));
  v.push_back(static_cast<std::uint8_t>(x >> 24));
}

int main(int argc, char** argv) {
  const bool prefix = argc == 3 && (std::strcmp(argv[2], "init-prefix") == 0
                                    || std::strcmp(argv[2], "init1-prefix") == 0
                                    || std::strcmp(argv[2], "init-tail") == 0
                                    || std::strcmp(argv[2], "init-end") == 0);
  const std::uint32_t init_index = argc == 3
    && (std::strcmp(argv[2], "init1-prefix") == 0 || std::strcmp(argv[2], "init-end") == 0)
    ? 1 : 0;
  if (argc != 2 && !prefix) {
    std::fprintf(stderr, "usage: h0-reference <148-byte-header-hex> [init-prefix]\n");
    return 2;
  }
  std::vector<std::uint8_t> header;
  if (!decode_hex(argv[1], header)) {
    std::fprintf(stderr, "header must be exactly 148 bytes of hex\n");
    return 2;
  }
  std::vector<std::uint8_t> input;
  le32(input, 1);       // parallelism
  le32(input, 32);      // tag length
  le32(input, 32768);   // memory KiB
  le32(input, 1);       // passes
  le32(input, 0x13);    // version
  le32(input, 2);       // Argon2id
  le32(input, 148);
  input.insert(input.end(), header.begin(), header.end());
  const char salt[] = "browsercoin-pow-v5";
  le32(input, sizeof(salt) - 1);
  input.insert(input.end(), salt, salt + sizeof(salt) - 1);
  le32(input, 0);       // secret length
  le32(input, 0);       // associated data length

  EVP_MD_CTX* ctx = EVP_MD_CTX_new();
  if (!ctx || EVP_DigestInit_ex(ctx, EVP_blake2b512(), nullptr) != 1
      || EVP_DigestUpdate(ctx, input.data(), input.size()) != 1) {
    std::fprintf(stderr, "OpenSSL BLAKE2b initialization failed\n");
    EVP_MD_CTX_free(ctx);
    return 1;
  }
  std::uint8_t out[64]{};
  unsigned out_len = 0;
  const int ok = EVP_DigestFinal_ex(ctx, out, &out_len);
  EVP_MD_CTX_free(ctx);
  if (ok != 1 || out_len != 64) return 1;
  if (prefix) {
    std::vector<std::uint8_t> init;
    le32(init, 1024);
    init.insert(init.end(), out, out + 64);
    le32(init, init_index);
    le32(init, 0);
    EVP_MD_CTX* init_ctx = EVP_MD_CTX_new();
    std::uint8_t init_out[64]{};
    unsigned init_len = 0;
    const int init_ok = init_ctx
      && EVP_DigestInit_ex(init_ctx, EVP_blake2b512(), nullptr) == 1
      && EVP_DigestUpdate(init_ctx, init.data(), init.size()) == 1
      && EVP_DigestFinal_ex(init_ctx, init_out, &init_len) == 1;
    EVP_MD_CTX_free(init_ctx);
    if (!init_ok || init_len != 64) return 1;
    std::uint8_t second[64]{};
    EVP_MD_CTX* second_ctx = EVP_MD_CTX_new();
    unsigned second_len = 0;
    const int second_ok = second_ctx
      && EVP_DigestInit_ex(second_ctx, EVP_blake2b512(), nullptr) == 1
      && EVP_DigestUpdate(second_ctx, init_out, sizeof(init_out)) == 1
      && EVP_DigestFinal_ex(second_ctx, second, &second_len) == 1;
    EVP_MD_CTX_free(second_ctx);
    if (!second_ok || second_len != 64) return 1;
    auto hash64 = [](const std::uint8_t* in, std::uint8_t* digest) -> bool {
      EVP_MD_CTX* c = EVP_MD_CTX_new();
      unsigned n = 0;
      const int ok = c && EVP_DigestInit_ex(c, EVP_blake2b512(), nullptr) == 1
        && EVP_DigestUpdate(c, in, 64) == 1
        && EVP_DigestFinal_ex(c, digest, &n) == 1;
      EVP_MD_CTX_free(c);
      return ok && n == 64;
    };
    if (std::strcmp(argv[2], "init-end") == 0) {
      std::uint8_t last[64]{};
      std::memcpy(last, init_out, sizeof(last));
      for (int i = 0; i < 30; ++i) {
        std::uint8_t next[64]{};
        if (!hash64(last, next)) return 1;
        std::memcpy(last, next, sizeof(last));
      }
      for (std::uint8_t b : last) std::printf("%02x", b);
    } else if (std::strcmp(argv[2], "init-tail") == 0) {
      std::uint8_t third[64]{}, fourth[64]{};
      if (!hash64(second, third) || !hash64(third, fourth)) return 1;
      for (int i = 0; i < 32; ++i) std::printf("%02x", third[i]);
      for (int i = 0; i < 32; ++i) std::printf("%02x", fourth[i]);
    } else {
      for (int i = 0; i < 32; ++i) std::printf("%02x", init_out[i]);
      for (int i = 0; i < 32; ++i) std::printf("%02x", second[i]);
    }
  } else {
    for (std::uint8_t b : out) std::printf("%02x", b);
  }
  std::putchar('\n');
  return 0;
}
