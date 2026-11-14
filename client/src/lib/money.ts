/** Pure money / date-input helpers (no browser or build-time globals), shared by forms and tests. */

/** Money is stored in integer minor units. */
export const toMinor = (major: string | number, decimals = 2) => Math.round(Number(major || 0) * 10 ** decimals);
export const toMajor = (minor: number | undefined | null, decimals = 2) => ((minor ?? 0) / 10 ** decimals).toFixed(decimals);

/** Formats a Date for an <input type="datetime-local"> in the browser's LOCAL time zone. */
export function toLocalInputValue(d: string | Date | null | undefined): string {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
