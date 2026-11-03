import { expect, it, vi } from "vitest";
import { forgetPostgres } from "../../src/storage/postgres/writes/forget.js";
import type { DatabaseClient, PostgresForgetPort } from "../../src/storage/postgres/contracts.js";
import { OpenContinuityError } from "../../src/shared/errors.js";
it("PostgreSQL forget port: a failed rollback destroys the uncertain session", async () => {
  const release = vi.fn(), client: DatabaseClient = { query: async () => { throw new Error("fictional-query-failure"); }, release };
  const rollback = vi.fn(async () => false);
  const port: PostgresForgetPort = { initialize: async () => {}, connect: async () => client, rollback, storageError: () => new OpenContinuityError("STORAGE_ERROR", "fictional", 500) };
  await expect(forgetPostgres(port, "fictional-user", "fictional-reader", "fictional-memory")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  expect(rollback).toHaveBeenCalledExactlyOnceWith(client); expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
