export function reciprocalRank(channelRank: number, k: number): number { return 1 / (k + channelRank); }
export function fuseRanks(evidence: readonly { contribution: number }[]): number { return evidence.reduce((sum, item) => sum + item.contribution, 0); }
