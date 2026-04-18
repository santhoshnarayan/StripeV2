export function lttbDownsample<T>(
  data: T[],
  target: number,
  valueFn: (d: T) => number,
): number[] {
  const n = data.length;
  if (n <= target) return data.map((_, i) => i);

  const indices: number[] = [0];
  const bucketSize = (n - 2) / (target - 2);

  let prevIdx = 0;
  for (let b = 1; b < target - 1; b++) {
    const bucketStart = Math.floor(b * bucketSize) + 1;
    const bucketEnd = Math.min(Math.floor((b + 1) * bucketSize) + 1, n - 1);

    const nextBucketStart = Math.floor((b + 1) * bucketSize) + 1;
    const nextBucketEnd = Math.min(Math.floor((b + 2) * bucketSize) + 1, n - 1);
    let avgX = 0;
    let avgY = 0;
    let count = 0;
    for (let j = nextBucketStart; j < nextBucketEnd && j < n; j++) {
      avgX += j;
      avgY += valueFn(data[j]);
      count++;
    }
    if (count > 0) {
      avgX /= count;
      avgY /= count;
    }

    let bestIdx = bucketStart;
    let bestArea = -1;
    const px = prevIdx;
    const py = valueFn(data[prevIdx]);
    for (let j = bucketStart; j < bucketEnd && j < n; j++) {
      const area = Math.abs(
        (px - avgX) * (valueFn(data[j]) - py) - (px - j) * (avgY - py),
      );
      if (area > bestArea) {
        bestArea = area;
        bestIdx = j;
      }
    }
    indices.push(bestIdx);
    prevIdx = bestIdx;
  }
  indices.push(n - 1);
  return indices;
}

export const DEFAULT_CHART_POINT_BUDGET = 600;
