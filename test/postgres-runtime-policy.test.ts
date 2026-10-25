import { describe, expect, it, vi } from "vitest";
const captured = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }));
vi.mock("pg", () => ({ Pool: class {
  constructor(options: Record<string, unknown>) { captured.options = options; }
  async end() {}
} }));
import { PostgresMemoryStore } from "../src/postgres/postgres-memory-store.js";
describe("PostgreSQL default runtime policy", () => {
  it("bounds pool acquisition, server statements and lock waiting without extensions", async () => {
    const store = PostgresMemoryStore.fromConnectionString("postgresql://fictional@127.0.0.1/open_continuity_test");
    expect(captured.options).toMatchObject({ max: 10, connectionTimeoutMillis: 2000, statement_timeout: 5000, lock_timeout: 2000 });
    await store.close();
  });
});
