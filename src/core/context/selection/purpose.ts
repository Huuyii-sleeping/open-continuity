// Preference is an ordinal tie-break, not an additive relevance boost. Its bound is 12.
export const PURPOSE_WEIGHT = {
  general: { user_preference: 8, user_fact: 6, task_state: 7, decision: 7 },
  coding: { task_state: 12, decision: 10, user_preference: 8, user_fact: 5 },
  research: { decision: 12, user_fact: 10, task_state: 7, user_preference: 5 },
  browser: { user_preference: 12, user_fact: 6, task_state: 10, decision: 5 },
} as const;
