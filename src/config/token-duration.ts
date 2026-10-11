const DURATION_UNITS_MS: Record<string, number> = {
  ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000,
};

export function parseTokenDurationMs(duration: string): number {
  if (duration.length > 100) throw new Error('Token duration must not exceed 100 characters');
  const matchedDuration = /^(\d+)(ms|s|m|h|d)$/.exec(duration);
  if (!matchedDuration) throw new Error('Token duration must be an integer followed by ms, s, m, h or d');
  const milliseconds = Number(matchedDuration[1]) * DURATION_UNITS_MS[matchedDuration[2]];
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1000 ||
      !Number.isFinite(new Date(Date.now() + milliseconds).getTime())) {
    throw new Error('Token duration must be at least one second and fit within the Date range');
  }
  return milliseconds;
}
