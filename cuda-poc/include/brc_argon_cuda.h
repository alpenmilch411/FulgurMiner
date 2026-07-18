#ifndef BRC_ARGON_CUDA_H
#define BRC_ARGON_CUDA_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BRC_ARGON_CUDA_HEADER_BYTES 148u
#define BRC_ARGON_CUDA_DIGEST_BYTES 32u
#define BRC_ARGON_CUDA_MAX_BATCH 256u

typedef struct brc_argon_cuda_context brc_argon_cuda_context;

typedef struct brc_argon_cuda_share {
  uint32_t nonce;
  uint8_t digest[BRC_ARGON_CUDA_DIGEST_BYTES];
} brc_argon_cuda_share;

/* Create a context on the selected CUDA device. Pass -1 for the default device. */
int brc_argon_cuda_create(brc_argon_cuda_context** context, int device);

void brc_argon_cuda_destroy(brc_argon_cuda_context* context);

/* Hash one raw 148-byte BrowserCoin header. */
int brc_argon_cuda_hash(brc_argon_cuda_context* context,
                        const uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES],
                        uint8_t digest[BRC_ARGON_CUDA_DIGEST_BYTES]);

/* Scan nonce_start .. nonce_start + count - 1 against a strict big-endian target.
 * Returns 0 when a share is found, 1 when the batch has no share, and -1 on error. */
int brc_argon_cuda_mine_batch(
    brc_argon_cuda_context* context,
    const uint8_t header[BRC_ARGON_CUDA_HEADER_BYTES],
    uint32_t nonce_start,
    uint32_t count,
    const uint8_t target[BRC_ARGON_CUDA_DIGEST_BYTES],
    brc_argon_cuda_share* share);

/* Returns a thread-local diagnostic string for the most recent failure. */
const char* brc_argon_cuda_last_error(void);

#ifdef __cplusplus
}
#endif

#endif
