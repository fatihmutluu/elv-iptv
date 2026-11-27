/** Minimal Cloudflare D1 result shape (avoids third-party runtime/type dependencies). */
export interface D1Result<T = unknown> {
  readonly results?: readonly T[];
  readonly success: boolean;
  readonly meta?: { readonly changes?: number };
}

/** Minimal Cloudflare D1 prepared statement interface. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

/** Minimal Cloudflare D1 database binding interface. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
