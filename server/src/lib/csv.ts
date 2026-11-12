/** RFC 4180 CSV with formula-injection protection for spreadsheet apps. */
export function csvCell(value: unknown): string {
  if (value == null) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function minorToMajor(minor: number, decimals = 2): string {
  return (minor / 10 ** decimals).toFixed(decimals);
}
