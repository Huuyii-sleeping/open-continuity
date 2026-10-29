import { expect, it } from "vitest";
import { AccessPolicy, accessPolicyFromEnv } from "../../../src/core/policy/access-policy.js";
it("access policy: checks transport credentials, agent allowlist and private permission independently", () => {
  const policy = new AccessPolicy({ apiKey: "fictional-test-credential", allowedAgentIds: ["fictional-approved"] });
  const request = { operation: "recall" as const, transport: "http" as const, agentId: "fictional-approved" };
  expect(() => policy.authorize(request)).toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
  expect(() => policy.authorize({ ...request, apiKey: "fictional-test-credential", agentId: "fictional-other" })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  expect(() => policy.authorize({ ...request, apiKey: "fictional-test-credential", includePrivate: true })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  expect(() => policy.authorize({ ...request, apiKey: "fictional-test-credential" })).not.toThrow();
});
it("access policy: uses an explicitly supplied environment", () => {
  const policy = accessPolicyFromEnv({ OPEN_CONTINUITY_ALLOWED_AGENTS: "fictional-a", OPEN_CONTINUITY_ALLOW_PRIVATE: "true" });
  expect(() => policy.authorize({ operation: "context", transport: "internal", agentId: "fictional-a", includePrivate: true })).not.toThrow();
});
