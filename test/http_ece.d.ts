// http_ece ships no types; the push tests use its decrypt only, to read a notification as a browser would.
declare module 'http_ece' {
  import type { ECDH } from 'node:crypto';
  const ece: { decrypt(buffer: Buffer, params: { version: 'aes128gcm'; privateKey: ECDH; authSecret: Buffer }): Buffer };
  export default ece;
}
