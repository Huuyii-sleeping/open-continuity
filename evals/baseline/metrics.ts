export interface Ratio { numerator: number; denominator: number; value: number | null }
export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator ? numerator / denominator : null };
}

export interface Judgment { relevant: string[]; forbidden: string[] }
export function scoreRanking(selected: string[], judgment: Judgment, ks: number[], grades: Record<string, number> = {}) {
  const relevant = new Set(judgment.relevant);
  // Duplicate results consume rank positions; they must never inflate recall or gain.
  const uniqueRelevant = new Set(selected.filter((label) => relevant.has(label)));
  const gain = (label: string) => relevant.has(label) ? 2 ** (grades[label] ?? 1) - 1 : 0;
  const dcg = (labels: string[]) => {
    const seen = new Set<string>();
    return labels.reduce((sum, label, index) => {
      const value = seen.has(label) ? 0 : gain(label);
      seen.add(label);
      return sum + value / Math.log2(index + 2);
    }, 0);
  };
  const ideal = [...relevant].sort((a, b) => gain(b) - gain(a));
  const atK = Object.fromEntries(ks.map((k) => {
    const top = selected.slice(0, k);
    const first = top.findIndex((label) => relevant.has(label));
    const idealGain = dcg(ideal.slice(0, k));
    return [String(k), {
      recall: ratio(new Set(top.filter((label) => relevant.has(label))).size, relevant.size),
      reciprocalRank: relevant.size ? (first < 0 ? 0 : 1 / (first + 1)) : null,
      ndcg: idealGain ? dcg(top) / idealGain : null,
    }];
  }));
  return {
    atK,
    miss: ratio(relevant.size - uniqueRelevant.size, relevant.size),
    falseSelection: ratio(selected.filter((label) => !relevant.has(label)).length, selected.length),
    forbiddenSelected: selected.filter((label) => judgment.forbidden.includes(label)),
    duplicates: selected.length - new Set(selected).size,
  };
}

export function latencySummary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1]! : null;
  return { samplesMs: samples, count: samples.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) ?? null };
}

export function mean(values: Array<number | null>): Ratio {
  const defined = values.filter((value): value is number => value !== null);
  return ratio(defined.reduce((sum, value) => sum + value, 0), defined.length);
}
