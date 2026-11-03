export function scopeIdentity(input: { scope: string; taskId?: string; agentId?: string; ownerAgentId?: string }): string {
  if (input.scope === "task") return input.taskId!;
  if (input.scope === "agent") return input.ownerAgentId || input.agentId!;
  return "-";
}
