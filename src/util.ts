export const calculateMean = <T extends number>(arr: T[]): number => {
  if (arr.length === 0) return 0;
  const sum = arr.reduce((acc, curr) => acc + curr, 0);
  return sum / arr.length;
};

export const calculateMedian = <T extends number>(arr: T[], isSorted: boolean): number => {
  if (arr.length === 0) return 0;
  const sortedArr = isSorted ? arr : [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sortedArr.length / 2);

  if (sortedArr.length % 2 === 0) {
    return (sortedArr[mid - 1] + sortedArr[mid]) / 2;
  } else {
    return sortedArr[mid];
  }
};

export const calculateStandardDeviation = <T extends number>(arr: T[]): number => {
  if (arr.length === 0) return 0;
  const mean = calculateMean(arr);
  const squaredDifferences = arr.map((num) => Math.pow(num - mean, 2));
  const sumOfSquaredDifferences = squaredDifferences.reduce((acc, curr) => acc + curr, 0);
  const variance = sumOfSquaredDifferences / arr.length;
  return Math.sqrt(variance);
};

export const calculateHistogramBins = <T extends number>(
  arr: T[],
  numBins: number,
  start: number,
  end: number
): number[] => {
  const binSize = (end - start) / numBins;
  const bins = Array(numBins).fill(0);
  for (const val of arr) {
    const binIndex = Math.min(Math.floor((val - start) / binSize), numBins - 1);
    bins[binIndex] += 1;
  }
  return bins;
};
