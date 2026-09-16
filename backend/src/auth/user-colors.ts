const PALETTE = [
  '#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5',
  '#2196f3', '#009688', '#4caf50', '#ff9800', '#795548',
  '#00bcd4', '#8bc34a', '#ff5722', '#37474f', '#ad1457',
  '#0277bd', '#2e7d32', '#ef6c00', '#5e35b1', '#00838f',
];

export function colorForUser(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}
