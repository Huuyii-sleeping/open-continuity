import type { RuntimeCapabilities } from "../runtime/profile.js";
import { contextSelectionCapabilities } from "../runtime/profile.js";
import type { MemoryService } from "./memory-service.js";
import { LEXICAL_FALLBACK_LIMITS, LEXICAL_FALLBACK_VERSION } from "../retrieval/full-text/lexical-fallback.js";

export function capabilitiesWithServiceSupport(capabilities: RuntimeCapabilities, service: MemoryService): RuntimeCapabilities {
  const facts = service.supportsFactDeclarations(), policy = service.retrievalCapabilityPolicy(), context = service.contextCapabilityPolicy();
  const { experimentalDense: _previousDense, ...baseRetrieval } = capabilities.retrieval;
  return { ...capabilities,
    readRuntime: service.readRuntimeCapabilities(),
    agenticQuery: { ...capabilities.agenticQuery, ...service.queryCapabilityPolicy() },
    memory: { ...capabilities.memory, evolution: { ...capabilities.memory.evolution, factDeclarations: facts ? "explicit_v1" : false } },
    retrieval: { ...baseRetrieval, semantic: Boolean(policy.experimentalDense),
      ...(policy.experimentalDense ? { experimentalDense: policy.experimentalDense } : {}), channels: policy.channels, candidateLimit: policy.candidateLimit, rrfK: policy.rrfK,
      lexicalFallback: { supported: policy.lexicalFallbackSupported, enabled: policy.lexicalFallback !== null,
        version: policy.lexicalFallbackSupported ? LEXICAL_FALLBACK_VERSION : null, limits: policy.lexicalFallbackSupported ? LEXICAL_FALLBACK_LIMITS : null },
      rankingVersion: policy.scored ? "core-ranking-v2" : null,
      fullTextRanking: policy.scored ? capabilities.retrieval.fullTextRanking : "unverified",
      structuredContribution: policy.scored ? 0 : null, exactPrecedence: policy.scored ? policy.exactPrecedence : null,
      factPolicy: facts ? "explicit-facts-v1" : null, factGroupLimit: facts ? policy.factGroupLimit : 0 },
    contextPack: { ...capabilities.contextPack, ...contextSelectionCapabilities(context), defaultTokenBudget: context.defaultTokenBudget,
      maxTokenBudget: context.maxTokenBudget, maxMemories: context.maxMemories } };
}
