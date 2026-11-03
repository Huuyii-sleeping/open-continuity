export function bestRankScore(evidence: readonly { contribution: number }[]): number { return Math.max(...evidence.map(item => item.contribution)); }
