export function toggleSurgeTarget(selected: readonly number[], target: number): number[] {
  if (selected.includes(target)) return selected.filter((cell) => cell !== target);
  return selected.length === 2 ? [selected[0], target] : [...selected, target];
}
