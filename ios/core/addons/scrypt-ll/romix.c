#include "romix.h"

#include <stdlib.h>
#include <string.h>

#define R(a, b) (((a) << (b)) | ((a) >> (32 - (b))))

static void salsa208(uint32_t B[16]) {
  uint32_t x[16];
  memcpy(x, B, sizeof(x));
  for (int i = 0; i < 8; i += 2) {
    x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (int i = 0; i < 16; i++) B[i] += x[i];
}

// B (32r words) <- BlockMix(B), Y scratch of the same size
static void block_mix(uint32_t *B, uint32_t *Y, uint32_t r) {
  uint32_t X[16];
  memcpy(X, &B[(2 * r - 1) * 16], 64);
  for (uint32_t i = 0; i < 2 * r; i++) {
    for (int j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
    salsa208(X);
    memcpy(&Y[i * 16], X, 64);
  }
  for (uint32_t i = 0; i < r; i++) {
    memcpy(&B[i * 16], &Y[(2 * i) * 16], 64);          // even blocks first
    memcpy(&B[(i + r) * 16], &Y[(2 * i + 1) * 16], 64);  // then the odd ones
  }
}

int scrypt_romix(uint8_t *block, uint32_t r, uint32_t N) {
  if (r == 0 || N < 2 || (N & (N - 1)) != 0) return -1;
  if ((uint64_t) N * r > SCRYPT_LL_MAX_NR) return -1;   // also keeps N * words * 4 far below SIZE_MAX
  size_t words = 32 * (size_t) r;
  if (words > SIZE_MAX / 4 / N) return -1;                // overflow guard for 32-bit size_t
  uint32_t *X = malloc(words * 4), *Y = malloc(words * 4), *V = malloc((size_t) N * words * 4);
  if (!X || !Y || !V) { free(X); free(Y); free(V); return -1; }
  for (size_t i = 0; i < words; i++) {
    const uint8_t *p = &block[i * 4];
    X[i] = (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24);
  }
  for (uint32_t i = 0; i < N; i++) {
    memcpy(&V[(size_t) i * words], X, words * 4);
    block_mix(X, Y, r);
  }
  for (uint32_t i = 0; i < N; i++) {
    uint32_t j = X[(2 * r - 1) * 16] & (N - 1);
    for (size_t k = 0; k < words; k++) X[k] ^= V[(size_t) j * words + k];
    block_mix(X, Y, r);
  }
  for (size_t i = 0; i < words; i++) {
    uint8_t *p = &block[i * 4];
    p[0] = X[i] & 0xff; p[1] = (X[i] >> 8) & 0xff; p[2] = (X[i] >> 16) & 0xff; p[3] = (X[i] >> 24) & 0xff;
  }
  free(X); free(Y); free(V);
  return 0;
}
