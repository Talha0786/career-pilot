/** Pearson product-moment correlation coefficient. Returns NaN for <2 points or zero variance in either series. */
export function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return NaN;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return NaN;
  return cov / Math.sqrt(varX * varY);
}

/** Ranks with the standard tie-handling: equal values share the mean of the ranks they'd occupy. */
function rank(values: readonly number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++;
    const avgRank = (i + j) / 2 + 1; // 1-indexed
    for (let k = i; k <= j; k++) ranks[indexed[k]!.i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation — this package's primary matching-quality
 * metric (see `run-matching-eval.ts`'s doc comment for why rank correlation
 * over Pearson): robust to a systematic scale offset between the LLM's
 * scoring calibration and the human labeler's (e.g. the model being
 * uniformly harsher/kinder), since it only asks "does the ORDERING of
 * candidates by score match human judgment," which is what the matching
 * feature actually needs to get right (surfacing the best-fit jobs first).
 */
export function spearmanCorrelation(xs: readonly number[], ys: readonly number[]): number {
  return pearsonCorrelation(rank(xs), rank(ys));
}
