/** Minimal WebCrypto ambient types referenced by `@elv/sync`'s `createWebCryptoVaultPort` (unused on Hermes). */
interface AesGcmParams {
  name: string;
  iv: ArrayBuffer;
  additionalData?: ArrayBuffer;
  tagLength?: number;
}

interface SubtleCrypto {
  digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: ArrayBuffer,
    algorithm: string,
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<unknown>;
  deriveBits(
    algorithm: { name: string; hash: string; salt: ArrayBuffer; iterations: number },
    baseKey: unknown,
    length: number,
  ): Promise<ArrayBuffer>;
  encrypt(algorithm: AesGcmParams, key: unknown, data: ArrayBuffer): Promise<ArrayBuffer>;
  decrypt(algorithm: AesGcmParams, key: unknown, data: ArrayBuffer): Promise<ArrayBuffer>;
}
