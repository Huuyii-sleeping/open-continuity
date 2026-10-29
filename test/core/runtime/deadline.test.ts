import { expect, it, vi } from "vitest";
import { ReadDeadline } from "../../../src/core/runtime/deadline.js";
it("deadline: never starts new work after the shared budget expires", async () => {
  let now = 0; const budget = new ReadDeadline(10, () => now), read = vi.fn(async () => "fictional-result");
  now = 10; await expect(budget.wait(read)).rejects.toMatchObject({ code: "READ_TIMEOUT" }); expect(read).not.toHaveBeenCalled();
});
it("deadline: checks synchronous work again after it returns", async () => {
  let now = 0; const budget = new ReadDeadline(10, () => now);
  await expect(budget.wait(() => { now = 11; return "fictional-late"; })).rejects.toMatchObject({ code: "READ_TIMEOUT" });
});
