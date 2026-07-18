#include <openssl/evp.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

using Block = std::array<std::uint64_t, 128>;

static void le32(std::vector<std::uint8_t>& v, std::uint32_t x) {
  for (int i = 0; i < 4; ++i) v.push_back(static_cast<std::uint8_t>(x >> (8 * i)));
}

static bool hash64(const std::uint8_t* input, std::size_t len, std::uint8_t out[64]) {
  EVP_MD_CTX* c = EVP_MD_CTX_new(); unsigned n = 0;
  const int ok = c && EVP_DigestInit_ex(c, EVP_blake2b512(), nullptr) == 1
    && EVP_DigestUpdate(c, input, len) == 1
    && EVP_DigestFinal_ex(c, out, &n) == 1;
  EVP_MD_CTX_free(c); return ok && n == 64;
}

static Block seed(const std::uint8_t h0[64], std::uint32_t index) {
  std::vector<std::uint8_t> in; le32(in, 1024); in.insert(in.end(), h0, h0 + 64);
  le32(in, index); le32(in, 0);
  std::uint8_t v[64]; hash64(in.data(), in.size(), v);
  std::array<std::uint8_t, 1024> bytes{}; int at = 0;
  for (int i = 0; i < 32; ++i) bytes[at++] = v[i];
  for (int i = 0; i < 29; ++i) {
    std::uint8_t next[64]; hash64(v, 64, next);
    for (int j = 0; j < 32; ++j) bytes[at++] = next[j];
    std::memcpy(v, next, 64);
  }
  hash64(v, 64, bytes.data() + at);
  Block out{};
  for (int i = 0; i < 128; ++i)
    for (int j = 0; j < 8; ++j) out[i] |= std::uint64_t(bytes[i * 8 + j]) << (8 * j);
  return out;
}

static std::uint64_t f(std::uint64_t x, std::uint64_t y) {
  const auto lo = std::uint64_t(static_cast<std::uint32_t>(x)) * std::uint64_t(static_cast<std::uint32_t>(y));
  return x + y + 2 * lo;
}
static std::uint64_t rr(std::uint64_t x, int n) { return (x >> n) | (x << (64 - n)); }
static void g(std::uint64_t& a, std::uint64_t& b, std::uint64_t& c, std::uint64_t& d) {
  a=f(a,b); d=rr(d^a,32); c=f(c,d); b=rr(b^c,24);
  a=f(a,b); d=rr(d^a,16); c=f(c,d); b=rr(b^c,63);
}
static void round16(std::uint64_t* x) {
  g(x[0],x[4],x[8],x[12]); g(x[1],x[5],x[9],x[13]);
  g(x[2],x[6],x[10],x[14]); g(x[3],x[7],x[11],x[15]);
  g(x[0],x[5],x[10],x[15]); g(x[1],x[6],x[11],x[12]);
  g(x[2],x[7],x[8],x[13]); g(x[3],x[4],x[9],x[14]);
}
static Block compress(const Block& prev, const Block& ref) {
  Block r{}, z{}; for (int i=0;i<128;++i) r[i]=z[i]=prev[i]^ref[i];
  for (int row=0;row<8;++row) round16(z.data()+row*16);
  std::uint64_t q[16];
  for (int col=0;col<8;++col) {
    for (int i=0;i<8;++i) { q[i*2]=z[i*16+col*2]; q[i*2+1]=z[i*16+col*2+1]; }
    round16(q);
    for (int i=0;i<8;++i) { z[i*16+col*2]=q[i*2]; z[i*16+col*2+1]=q[i*2+1]; }
  }
  for (int i=0;i<128;++i) z[i]^=r[i]; return z;
}

int main() {
  std::array<std::uint8_t,148> header{};
  std::vector<std::uint8_t> h; le32(h,1); le32(h,32); le32(h,32768); le32(h,1); le32(h,0x13); le32(h,2);
  le32(h,148); h.insert(h.end(),header.begin(),header.end()); const char salt[]="browsercoin-pow-v5";
  le32(h,sizeof(salt)-1); h.insert(h.end(),salt,salt+sizeof(salt)-1); le32(h,0); le32(h,0);
  std::uint8_t h0[64]; if (!hash64(h.data(),h.size(),h0)) return 1;
  Block b2=compress(seed(h0,1),seed(h0,0));
  for (int i=0;i<8;++i) for(int j=0;j<8;++j) std::printf("%02x",static_cast<unsigned>(b2[i]>>(8*j))&255);
  std::putchar('\n'); return 0;
}
