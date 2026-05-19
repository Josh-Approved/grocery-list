/**
 * Minimal ambient types for the @noble v2 subpaths we use. The packages ship
 * real ESM at these paths (Metro resolves them fine at runtime); this only
 * narrows the surface we actually call so `tsc` is happy without loosening
 * resolution for the whole project.
 */

declare module '@noble/curves/secp256k1' {
  export const schnorr: {
    getPublicKey(privateKey: Uint8Array): Uint8Array;
    sign(message: Uint8Array | string, privateKey: Uint8Array): Uint8Array;
    verify(
      signature: Uint8Array | string,
      message: Uint8Array | string,
      publicKey: Uint8Array | string
    ): boolean;
  };
}

declare module '@noble/hashes/sha2' {
  export function sha256(message: Uint8Array): Uint8Array;
}

declare module '@noble/hashes/utils' {
  export function bytesToHex(bytes: Uint8Array): string;
  export function utf8ToBytes(str: string): Uint8Array;
}
