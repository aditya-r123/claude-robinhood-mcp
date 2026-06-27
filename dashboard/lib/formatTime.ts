// Timestamps from the EC2 logs are in America/New_York (ET).
// This module converts them to a Date and formats in both ET and PT.

function nthSundayOfMonth(year: number, month: number, n: number): number {
  // Returns the day-of-month of the nth Sunday (1-indexed) of the given month.
  const firstDow = new Date(year, month - 1, 1).getDay(); // 0=Sun
  const firstSun = firstDow === 0 ? 1 : 8 - firstDow;
  return firstSun + (n - 1) * 7;
}

// US DST: starts 2nd Sunday of March 02:00 local, ends 1st Sunday of November 02:00 local.
// For our purposes (market hours, weekdays) the 02:00 boundary never matters.
function isUSDST(year: number, month: number, day: number): boolean {
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  const boundaryDay =
    month === 3
      ? nthSundayOfMonth(year, 3, 2)   // spring forward
      : nthSundayOfMonth(year, 11, 1); // fall back
  return month === 3 ? day >= boundaryDay : day < boundaryDay;
}

function tzAbbr(date: Date, tz: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName')?.value ?? ''
  );
}

// Parse a "YYYY-MM-DD" + "HH:MM:SS" string pair that is in ET, return a UTC Date.
function etToDate(date: string, time: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [h, m, s] = time.split(':').map(Number);
  // ET = UTC − 4 (EDT) or UTC − 5 (EST)
  const utcOffset = isUSDST(year, month, day) ? 4 : 5;
  return new Date(Date.UTC(year, month - 1, day, h + utcOffset, m, s ?? 0));
}

const timeFmt = (tz: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

const etFmt = timeFmt('America/New_York');
const ptFmt = timeFmt('America/Los_Angeles');

/**
 * Format a log timestamp (ET date + time strings) as "9:35 AM ET / 6:35 AM PT".
 * date: "YYYY-MM-DD", time: "HH:MM:SS" or "HH:MM"
 */
export function formatTs(date: string, time: string): string {
  const d = etToDate(date, time);
  const et = etFmt.format(d);
  const pt = ptFmt.format(d);
  const etZ = tzAbbr(d, 'America/New_York');
  const ptZ = tzAbbr(d, 'America/Los_Angeles');
  return `${et} ${etZ} / ${pt} ${ptZ}`;
}

/** Duration in seconds → human string like "2m 9s" or "47s". */
export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
