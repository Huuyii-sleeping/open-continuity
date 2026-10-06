import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { MemoryService } from "../core/memory-service.js";
import { AccessPolicy } from "../core/access-policy.js";
import { errorResponse, normalizeError } from "../shared/errors.js";
import { agenticQueryInputSchema, contextPackInputSchema, handoffCreateInputSchema, handoffResumeInputSchema, historyInputSchema, recallInputSchema, rememberInputSchema, type RememberInput } from "../shared/types.js";
import { developmentCapabilities, type RuntimeCapabilities } from "../core/profile.js";

function requestApiKey(headers: Record<string, unknown>): string | undefined {
  const direct = headers["x-open-continuity-api-key"];
  if (typeof direct === "string") return direct;
  const authorization = headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return authorization.slice(7);
  return undefined;
}

function errorStatus(error: unknown): number {
  return normalizeError(error).status;
}

const booleanQuerySchema = z.preprocess((value) => {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());
const limitQuerySchema = z.coerce.number().int().min(1).max(100).default(20);

export function buildHttpApp(service = new MemoryService(), policy = new AccessPolicy(), capabilities: RuntimeCapabilities = developmentCapabilities()): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const normalized = normalizeError(error);
    return reply.code(normalized.status).send(errorResponse(normalized));
  });
  app.get("/health", async () => ({ ok: true, service: "open-continuity", version: capabilities.version, profile: capabilities.profile, storage: capabilities.storage, capabilities }));
  app.get("/v1/capabilities", async () => capabilities);
  app.addHook("onClose", async () => { await service.close(); });
  app.post("/v1/memories", async (request, reply) => {
    try {
      const input = rememberInputSchema.parse(request.body) as RememberInput;
      policy.authorize({ operation: "remember", transport: "http", agentId: input.agentId, apiKey: requestApiKey(request.headers as Record<string, unknown>) });
      return await service.remember(input);
    } catch (error) { return reply.code(errorStatus(error)).send(errorResponse(error)); }
  });
  app.get("/v1/memories", async (request, reply) => {
    try {
      const query = recallInputSchema.parse({
        ...(request.query as object),
        includePrivate: booleanQuerySchema.parse((request.query as Record<string, unknown>).includePrivate),
        limit: limitQuerySchema.parse((request.query as Record<string, unknown>).limit),
      });
      policy.authorize({ operation: "recall", transport: "http", agentId: query.agentId, apiKey: requestApiKey(request.headers as Record<string, unknown>), includePrivate: query.includePrivate });
      return await service.recall(query);
    } catch (error) { return reply.code(errorStatus(error)).send(errorResponse(error)); }
  });
  app.post("/v1/context-pack", async (request, reply) => {
    try {
      const input = contextPackInputSchema.parse(request.body);
      policy.authorize({ operation: "context", transport: "http", agentId: input.agentId, apiKey: requestApiKey(request.headers as Record<string, unknown>), includePrivate: input.includePrivate });
      return await service.context(input);
    } catch (error) { return reply.code(errorStatus(error)).send(errorResponse(error)); }
  });
  app.post("/v1/query", async (request, reply) => {
    try {
      const input = agenticQueryInputSchema.parse(request.body);
      policy.authorize({ operation: "query", transport: "http", agentId: input.agentId, apiKey: requestApiKey(request.headers as Record<string, unknown>), includePrivate: input.includePrivate });
      return await service.query(input);
    } catch (error) { return reply.code(errorStatus(error)).send(errorResponse(error)); }
  });
  app.post("/v1/handoffs", async (request, reply) => {
    try {
      const input = handoffCreateInputSchema.parse(request.body);
      policy.authorize({ operation: "handoff_create", transport: "http", agentId: input.agentId, apiKey: requestApiKey(request.headers as Record<string, unknown>) });
      return await service.createHandoff(input);
    } catch (error) { return reply.code(errorStatus(error)).send(errorResponse(error)); }
  });
  app.get("/v1/handoffs/:taskId", async (request, reply) => {
    try {
      const params = z.object({ taskId: z.string().min(1) }).parse(request.params);
      const rawQuery = request.query as Record<string, unknown>;
      const input = handoffResumeInputSchema.parse({ ...rawQuery, ...params, includePrivate: booleanQuerySchema.parse(rawQuery.includePrivate) });
      policy.authorize({ operation: "handoff_resume", transport: "http", agentId: input.agentId, apiKey: requestApiKey(request.headers as Record<string, unknown>), includePrivate: input.includePrivate });
      return await service.resumeHandoff(input);
    } catch (error) { return reply.code(errorStatus(error)).send(errorResponse(error)); }
  });
  app.delete("/v1/memories/:memoryId", async (request, reply) => {
    try {
      const params = z.object({ memoryId: z.string().min(1) }).parse(request.params);
      const body = z.object({ userId: z.string().min(1), agentId: z.string().min(1), taskId: z.string().min(1).optional(), includePrivate: z.boolean().default(false) }).parse(request.body);
      policy.authorize({ operation: "forget", transport: "http", agentId: body.agentId, apiKey: requestApiKey(request.headers as Record<string, unknown>), includePrivate: body.includePrivate });
      return await service.forget({ ...params, ...body });
    } catch (error) { return reply.code(errorStatus(error)).send(errorResponse(error)); }
  });
  app.get("/v1/memories/:memoryId/history", async (request, reply) => {
    try {
      const params = z.object({ memoryId: z.string().min(1) }).parse(request.params);
      const rawQuery = request.query as Record<string, unknown>;
      const query = historyInputSchema.parse({ ...rawQuery, memoryId: params.memoryId, includePrivate: booleanQuerySchema.parse(rawQuery.includePrivate), limit: limitQuerySchema.parse(rawQuery.limit) });
      policy.authorize({ operation: "history", transport: "http", agentId: query.agentId, apiKey: requestApiKey(request.headers as Record<string, unknown>), includePrivate: query.includePrivate });
      return await service.history(query);
    } catch (error) { return reply.code(errorStatus(error)).send(errorResponse(error)); }
  });
  app.get("/v1/memory-events", async (request, reply) => {
    try {
      const rawQuery = request.query as Record<string, unknown>;
      const query = historyInputSchema.parse({ ...rawQuery, includePrivate: booleanQuerySchema.parse(rawQuery.includePrivate), limit: limitQuerySchema.parse(rawQuery.limit) });
      policy.authorize({ operation: "history", transport: "http", agentId: query.agentId, apiKey: requestApiKey(request.headers as Record<string, unknown>), includePrivate: query.includePrivate });
      return await service.history(query);
    } catch (error) { return reply.code(errorStatus(error)).send(errorResponse(error)); }
  });
  return app;
}
