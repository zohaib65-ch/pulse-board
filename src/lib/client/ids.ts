/**
 * RFC 4122 version-4 UUID for ids the browser creates (events, runs, the tab session).
 *
 * `crypto.randomUUID` only exists in secure contexts (https or localhost). Over plain
 * `http://<lan-ip>` it is undefined, so fall back to `crypto.getRandomValues`, which is
 * available everywhere. Never use `Math.random` for ids.
 */
export function newId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  webCrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
