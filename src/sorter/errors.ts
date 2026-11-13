import type { ErrorCode } from "./types.js";

export class OrdolineError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OrdolineError";
    this.code = code;
  }
}

export const errorCodeOf = (err: unknown, fallback: ErrorCode): ErrorCode =>
  err instanceof OrdolineError ? err.code : (err as { code?: ErrorCode } | null)?.code ?? fallback;
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
