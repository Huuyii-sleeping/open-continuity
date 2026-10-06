import { OpenContinuityError } from "../shared/errors.js";
import type { RetrievalChannel } from "../shared/types.js";
import type { ContextPackPolicy } from "./context-pack.js";
import type { AgenticQueryPolicy } from "./agentic-query.js";
import type { StorageKind } from "./store-factory.js";
import { OPEN_CONTINUITY_VERSION } from "../version.js";

export type RuntimeProfile = "lite" | "team" | "enterprise";

export interface RetrievalPolicy {
  channels: readonly RetrievalChannel[];
  candidateLimit: number;
  rrfK: number;
}

export interface RuntimeProfileConfig {
  name: Exclude<RuntimeProfile, "enterprise">;
  storage: StorageKind;
  compatibilityMode: "json_legacy" | null;
  retrieval: RetrievalPolicy;
  contextPack: ContextPackPolicy;
  agenticQuery: AgenticQueryPolicy;
}

export interface RuntimeCapabilities {
  version: typeof OPEN_CONTINUITY_VERSION;
  profile: RuntimeProfileConfig["name"] | "development";
  storage: StorageKind | "memory";
  compatibilityMode: RuntimeProfileConfig["compatibilityMode"];
  transports: readonly ["mcp_stdio", "http"];
  memory: {
    kinds: readonly ["user_preference", "user_fact", "task_state", "decision"];
    scopes: readonly ["user", "task", "agent"];
    auditHistory: true;
    privateMemory: true;
    evolution: {
      expectedVersion: true;
      writeModes: readonly ["replace", "merge"];
      supersedes: true;
      confidenceBasis: readonly ["user_asserted", "agent_inferred", "source_supported"];
      automaticSemanticMerge: false;
    };
  };
  retrieval: {
    mode: "hybrid";
    channels: readonly RetrievalChannel[];
    candidateLimit: number;
    rrfK: number;
    fullTextEngine: "fts5" | "postgres_text" | "substring";
    semantic: false;
    rerank: false;
    agentic: true;
    graph: false;
  };
  contextPack: {
    enabled: true;
    purposes: readonly ["general", "coding", "research", "browser"];
    defaultTokenBudget: number;
    maxTokenBudget: number;
    maxMemories: number;
    estimation: "utf8_bytes_v1";
    overflow: "omit_whole_memory";
  };
  agenticQuery: {
    enabled: true; planner: "deterministic_v1"; supportsExplicitSubqueries: true; supportsHistoryEvidence: true;
    defaultMaxSteps: number; maxSteps: number; defaultTimeoutMs: number; maxTimeoutMs: number; maxSubqueries: number; historyLimit: number;
    semanticPlanner: false; graphTraversal: false;
  };
  handoff: { enabled: true; schemaVersion: "1.0"; expiration: true };
  deployment: { localOnly: boolean; multiProcess: true; multiInstance: boolean };
}

const PROFILE_RETRIEVAL: Record<RuntimeProfileConfig["name"], RetrievalPolicy> = {
  lite: { channels: ["exact", "structured", "full_text"], candidateLimit: 50, rrfK: 60 },
  team: { channels: ["exact", "structured", "full_text"], candidateLimit: 100, rrfK: 60 },
};

const PROFILE_CONTEXT_PACK: Record<RuntimeProfileConfig["name"], ContextPackPolicy> = {
  lite: { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 },
  team: { defaultTokenBudget: 4096, maxTokenBudget: 16384, maxMemories: 50 },
};

const PROFILE_AGENTIC_QUERY: Record<RuntimeProfileConfig["name"], AgenticQueryPolicy> = {
  lite: { defaultMaxSteps: 3, maxSteps: 4, defaultTimeoutMs: 1500, maxTimeoutMs: 5000, maxSubqueries: 3, historyLimit: 50 },
  team: { defaultMaxSteps: 5, maxSteps: 8, defaultTimeoutMs: 3000, maxTimeoutMs: 10000, maxSubqueries: 8, historyLimit: 100 },
};

function parseProfile(value: string | undefined): RuntimeProfile | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "lite" || value === "team" || value === "enterprise") return value;
  throw new OpenContinuityError("CONFIGURATION_ERROR", "OPEN_CONTINUITY_PROFILE must be lite, team, or enterprise", 500, { value });
}

function parseStorage(value: string | undefined): StorageKind | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "sqlite" || value === "json" || value === "postgres") return value;
  throw new OpenContinuityError("CONFIGURATION_ERROR", "OPEN_CONTINUITY_STORE must be sqlite, json, or postgres", 500, { value });
}

export function resolveRuntimeProfile(env: NodeJS.ProcessEnv = process.env): RuntimeProfileConfig {
  const requestedProfile = parseProfile(env.OPEN_CONTINUITY_PROFILE);
  const requestedStorage = parseStorage(env.OPEN_CONTINUITY_STORE);
  const profile = requestedProfile ?? (requestedStorage === "postgres" ? "team" : "lite");

  if (profile === "enterprise") {
    throw new OpenContinuityError("CONFIGURATION_ERROR", "Enterprise profile is not implemented yet", 501, { profile });
  }

  const storage = requestedStorage ?? (profile === "team" ? "postgres" : "sqlite");
  if (profile === "team" && storage !== "postgres") {
    throw new OpenContinuityError("CONFIGURATION_ERROR", "Team profile requires PostgreSQL storage", 500, { profile, storage });
  }
  if (profile === "lite" && storage === "postgres") {
    throw new OpenContinuityError("CONFIGURATION_ERROR", "Lite profile supports SQLite or legacy JSON storage, not PostgreSQL", 500, { profile, storage });
  }

  return {
    name: profile,
    storage,
    compatibilityMode: storage === "json" ? "json_legacy" : null,
    retrieval: PROFILE_RETRIEVAL[profile],
    contextPack: PROFILE_CONTEXT_PACK[profile],
    agenticQuery: PROFILE_AGENTIC_QUERY[profile],
  };
}

export function capabilitiesForProfile(config: RuntimeProfileConfig): RuntimeCapabilities {
  const fullTextEngine = config.storage === "sqlite" ? "fts5" : config.storage === "postgres" ? "postgres_text" : "substring";
  return {
    version: OPEN_CONTINUITY_VERSION,
    profile: config.name,
    storage: config.storage,
    compatibilityMode: config.compatibilityMode,
    transports: ["mcp_stdio", "http"],
    memory: {
      kinds: ["user_preference", "user_fact", "task_state", "decision"],
      scopes: ["user", "task", "agent"],
      auditHistory: true,
      privateMemory: true,
      evolution: {
        expectedVersion: true, writeModes: ["replace", "merge"], supersedes: true,
        confidenceBasis: ["user_asserted", "agent_inferred", "source_supported"], automaticSemanticMerge: false,
      },
    },
    retrieval: {
      mode: "hybrid",
      channels: config.retrieval.channels,
      candidateLimit: config.retrieval.candidateLimit,
      rrfK: config.retrieval.rrfK,
      fullTextEngine,
      semantic: false, rerank: false, agentic: true, graph: false,
    },
    contextPack: {
      enabled: true,
      purposes: ["general", "coding", "research", "browser"],
      defaultTokenBudget: config.contextPack.defaultTokenBudget,
      maxTokenBudget: config.contextPack.maxTokenBudget,
      maxMemories: config.contextPack.maxMemories,
      estimation: "utf8_bytes_v1",
      overflow: "omit_whole_memory",
    },
    agenticQuery: {
      enabled: true, planner: "deterministic_v1", supportsExplicitSubqueries: true, supportsHistoryEvidence: true,
      defaultMaxSteps: config.agenticQuery.defaultMaxSteps, maxSteps: config.agenticQuery.maxSteps,
      defaultTimeoutMs: config.agenticQuery.defaultTimeoutMs, maxTimeoutMs: config.agenticQuery.maxTimeoutMs, maxSubqueries: config.agenticQuery.maxSubqueries,
      historyLimit: config.agenticQuery.historyLimit,
      semanticPlanner: false, graphTraversal: false,
    },
    handoff: { enabled: true, schemaVersion: "1.0", expiration: true },
    deployment: { localOnly: config.name === "lite", multiProcess: true, multiInstance: config.name === "team" },
  };
}

export function developmentCapabilities(): RuntimeCapabilities {
  const lite = capabilitiesForProfile({ name: "lite", storage: "sqlite", compatibilityMode: null, retrieval: PROFILE_RETRIEVAL.lite, contextPack: PROFILE_CONTEXT_PACK.lite, agenticQuery: PROFILE_AGENTIC_QUERY.lite });
  return {
    ...lite,
    profile: "development",
    storage: "memory",
    retrieval: { ...lite.retrieval, fullTextEngine: "substring" },
  };
}
