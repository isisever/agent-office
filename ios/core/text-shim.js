// Bare has no TextEncoder/TextDecoder globals, but app/src/link-wire.js (shared with the Node desktop) builds both at
// module load. Without them require('link-wire') throws a ReferenceError during startup, which Bare turns into a native
// abort when nothing handles it. This installs minimal UTF-8 versions on top of b4a, only when the globals are missing.
'use strict';
const b4a = require('b4a');

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(text = '') {
      const buf = b4a.from(String(text), 'utf8');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
  };
}

if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    get encoding() { return 'utf-8'; }
    decode(bytes) {
      if (bytes === undefined || bytes === null) return '';
      const view = ArrayBuffer.isView(bytes) ? bytes : new Uint8Array(bytes);
      return b4a.toString(b4a.from(view.buffer, view.byteOffset, view.byteLength), 'utf8');
    }
  };
}
