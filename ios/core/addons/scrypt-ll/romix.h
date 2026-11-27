// scrypt's ROMix (RFC 7914, section 5) on Salsa20/8: the slow part of scrypt, in portable C. PBKDF2-HMAC-SHA256 around it
// stays in JavaScript (crypto-shim.js, on sodium's SHA-256). Words are little-endian, as the RFC specifies.
#ifndef SCRYPT_LL_ROMIX_H
#define SCRYPT_LL_ROMIX_H
#include <stddef.h>
#include <stdint.h>

// The largest N * r accepted: V takes 128 * N * r bytes, so this caps it at 512 MiB (pairing uses N 2^15, r 8: 32 MiB).
#define SCRYPT_LL_MAX_NR (1u << 22)

// block: 128 * r bytes, replaced by ROMix(block). N: a power of two > 1, r > 0, N * r <= SCRYPT_LL_MAX_NR.
// Returns 0, or -1 for bad parameters or when memory runs out.
int scrypt_romix(uint8_t *block, uint32_t r, uint32_t N);

#endif
