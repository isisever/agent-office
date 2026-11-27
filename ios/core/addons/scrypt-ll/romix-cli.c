// Test helper (not part of the addon): reads "r N hex" on stdin, prints ROMix(hex) as hex. app/test uses it to check
// romix.c against Node's scryptSync.
#include <stdio.h>
#include <stdlib.h>

#include "romix.h"

int main(void) {
  unsigned r, n;
  if (scanf("%u %u ", &r, &n) != 2 || r == 0 || r > 64) return 2;
  size_t len = 128 * (size_t) r;
  uint8_t *b = malloc(len);
  for (size_t i = 0; i < len; i++) { unsigned x; if (scanf("%2x", &x) != 1) return 2; b[i] = (uint8_t) x; }
  if (scrypt_romix(b, r, n) != 0) return 3;
  for (size_t i = 0; i < len; i++) printf("%02x", b[i]);
  printf("\n");
  return 0;
}
