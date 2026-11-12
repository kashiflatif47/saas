/** IANA time zone helpers. `Intl` throws a RangeError for unknown zones, which must never reach a request handler. */

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Returns `tz` when it is a valid IANA zone, otherwise UTC (used when reading possibly-bad stored data). */
export function safeTimeZone(tz: unknown): string {
  return isValidTimeZone(tz) ? tz : 'UTC';
}
