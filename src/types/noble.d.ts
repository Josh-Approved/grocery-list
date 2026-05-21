/**
 * Minimal ambient types for the @noble v2 subpaths we use. The packages ship
 * real ESM at these paths (Metro resolves them fine at runtime); this only
 * narrows the surface we actually call so `tsc` is happy without loosening
 * resolution for the whole project.
 */

declare module '@noble/curves/secp256k1.js' {
  export const schnorr: {
    getPublicKey(privateKey: Uint8Array): Uint8Array;
    sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array;
    verify(
      signature: Uint8Array,
      message: Uint8Array,
      publicKey: Uint8Array
    ): boolean;
  };
}

declare module '@noble/hashes/sha2.js' {
  export function sha256(message: Uint8Array): Uint8Array;
}

declare module '@noble/hashes/utils.js' {
  export function bytesToHex(bytes: Uint8Array): string;
  export function utf8ToBytes(str: string): Uint8Array;
}
