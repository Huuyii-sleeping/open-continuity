export function now(): string { return new Date().toISOString(); }
export function idempotencyKey(userId: string, requestKey: string): string { return JSON.stringify([userId, requestKey]); }
