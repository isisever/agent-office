// scrypt's ROMix (RFC 7914, section 5) on Salsa20/8: the slow part of scrypt, in portable C. PBKDF2-HMAC-SHA256 around it
// stays in JavaScript (crypto-shim.js, on sodium's SHA-256). Words are little-endian, as the RFC specifies.
#ifndef SCRYPT_LL_ROMIX_H
#define SCRYPT_LL_ROMIX_H
#include <stddef.h>
#include <stdint.h>

// block: 128 * r bytes, replaced by ROMix(block). N: a power of two > 1. Returns 0, or -1 when memory runs out.
int scrypt_romix(uint8_t *block, uint32_t r, uint32_t N);

#endif
