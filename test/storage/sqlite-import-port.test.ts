import { expect, it, vi } from "vitest";
import { importSqliteEvents } from "../../src/storage/sqlite/transfer/import-events.js";
import type { SqliteWriteContext } from "../../src/storage/sqlite/contracts.js";
import { OpenContinuityError } from "../../src/shared/errors.js";
it("SQLite import port: a nonempty target aborts before any event replay", () => {
  const importEvent = vi.fn();
  const context: SqliteWriteContext = { assertOpen() {}, all: () => [], get: () => undefined, run() {}, getRequired: () => ({ count: 1 }), writeTransaction: operation => operation(), writeFact() {}, importEvent, storageError: () => new OpenContinuityError("STORAGE_ERROR", "fictional", 500) };
  expect(() => importSqliteEvents(context, [])).toThrow(expect.objectContaining({ code: "STORAGE_ERROR" })); expect(importEvent).not.toHaveBeenCalled();
});
