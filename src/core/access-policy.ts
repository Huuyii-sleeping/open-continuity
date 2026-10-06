import { OpenContinuityError } from "../shared/errors.js";

export type AccessOperation = "remember" | "recall" | "context" | "query" | "forget" | "history" | "handoff_create" | "handoff_resume";
export type AccessTransport = "http" | "mcp" | "internal";

export interface AccessRequest {
  operation: AccessOperation;
  transport: AccessTransport;
  agentId: string;
  apiKey?: string;
  includePrivate?: boolean;
}

export interface AccessPolicyOptions {
  apiKey?: string;
  allowedAgentIds?: readonly string[];
  allowPrivateRecall?: boolean;
}

export class AccessPolicy {
  private readonly allowedAgentIds?: ReadonlySet<string>;

  constructor(private readonly options: AccessPolicyOptions = {}) {
    if (options.allowedAgentIds && options.allowedAgentIds.length > 0) {
      this.allowedAgentIds = new Set(options.allowedAgentIds);
    }
  }

  authorize(request: AccessRequest): void {
    if (this.options.apiKey && request.transport === "http" && request.apiKey !== this.options.apiKey) {
      throw new OpenContinuityError("UNAUTHORIZED", "A valid API key is required", 401);
    }
    if (this.allowedAgentIds && !this.allowedAgentIds.has(request.agentId)) {
      throw new OpenContinuityError("FORBIDDEN", "Agent is not allowed to access this runtime", 403);
    }
    if (request.includePrivate && !this.options.allowPrivateRecall) {
      throw new OpenContinuityError("FORBIDDEN", "Private memory recall is disabled by policy", 403);
    }
  }
}

export function accessPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): AccessPolicy {
  const allowedAgentIds = env.OPEN_CONTINUITY_ALLOWED_AGENTS?.split(",").map((value) => value.trim()).filter(Boolean);
  return new AccessPolicy({
    apiKey: env.OPEN_CONTINUITY_API_KEY || undefined,
    allowedAgentIds,
    allowPrivateRecall: env.OPEN_CONTINUITY_ALLOW_PRIVATE === "true",
  });
}
