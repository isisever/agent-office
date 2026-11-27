// Bare addon: romix(block: Uint8Array of 128 * r bytes, r, N) replaces block with scrypt's ROMix, in place.
#include <bare.h>
#include <js.h>

#include "romix.h"

static js_value_t *
scrypt_ll_romix(js_env_t *env, js_callback_info_t *info) {
  size_t argc = 3;
  js_value_t *argv[3];
  if (js_get_callback_info(env, info, &argc, argv, NULL, NULL) != 0 || argc != 3) {
    js_throw_error(env, NULL, "romix(block, r, N)");
    return NULL;
  }
  void *data;
  size_t len;
  uint32_t r, n;
  if (js_get_typedarray_info(env, argv[0], NULL, &data, &len, NULL, NULL) != 0 ||
      js_get_value_uint32(env, argv[1], &r) != 0 || js_get_value_uint32(env, argv[2], &n) != 0 ||
      r == 0 || r > 64 || len != 128 * (size_t) r || n < 2 || n > (1u << 20) || (n & (n - 1)) != 0) {
    js_throw_error(env, NULL, "romix: bad arguments");
    return NULL;
  }
  if (scrypt_romix(data, r, n) != 0) js_throw_error(env, NULL, "romix: out of memory");
  return NULL;
}

static js_value_t *
scrypt_ll_exports(js_env_t *env, js_value_t *exports) {
  js_value_t *fn;
  js_create_function(env, "romix", -1, scrypt_ll_romix, NULL, &fn);
  js_set_named_property(env, exports, "romix", fn);
  return exports;
}

BARE_MODULE(scrypt_ll, scrypt_ll_exports)
