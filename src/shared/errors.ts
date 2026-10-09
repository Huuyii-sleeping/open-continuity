import { z } from "zod";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "MEMORY_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "VERSION_CONFLICT"
  | "CONFIGURATION_ERROR"
  | "CAPTURE_ALREADY_RUNNING"
  | "STORAGE_ERROR"
  | "INTERNAL_ERROR";

export class OpenContinuityError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpenContinuityError";
  }
}

export function validationError(error: z.ZodError): OpenContinuityError {
  return new OpenContinuityError("VALIDATION_ERROR", "Request validation failed", 400, error.issues.map((issue) => ({ path: issue.path, message: issue.message, code: issue.code })));
}

export function normalizeError(error: unknown): OpenContinuityError {
  if (error instanceof OpenContinuityError) return error;
  if (error instanceof z.ZodError) return validationError(error);
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
    const message = "message" in error && typeof error.message === "string" ? error.message : "Request validation failed";
    return new OpenContinuityError("VALIDATION_ERROR", message, error.statusCode);
  }
  return new OpenContinuityError("INTERNAL_ERROR", "Internal server error", 500);
}

export function errorResponse(error: unknown): { error: { code: ErrorCode; message: string; details?: unknown } } {
  const normalized = normalizeError(error);
  const response: { error: { code: ErrorCode; message: string; details?: unknown } } = {
    error: { code: normalized.code, message: normalized.message },
  };
  if (normalized.details !== undefined) response.error.details = normalized.details;
  return response;
}
