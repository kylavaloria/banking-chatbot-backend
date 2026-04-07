// ─────────────────────────────────────────────────────────────────────────────
// Business Day Calculator
// Counts business days (Mon–Fri, excluding PH public holidays) between
// two dates. Used by the SLA Evaluator to measure elapsed SLA time.
//
// Holiday list: update HOLIDAYS each year.
// Source: https://www.officialgazette.gov.ph/nationwide-holidays/
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Philippine public holidays
// Format: 'YYYY-MM-DD'
// Add the new year's list each December.
// ---------------------------------------------------------------------------

const HOLIDAYS: ReadonlySet<string> = new Set([
    // 2025
    '2025-01-01', // New Year's Day
    '2025-01-29', // Chinese New Year
    '2025-02-25', // EDSA People Power Revolution Anniversary
    '2025-04-09', // Araw ng Kagitingan (Day of Valor)
    '2025-04-17', // Maundy Thursday
    '2025-04-18', // Good Friday
    '2025-04-19', // Black Saturday
    '2025-05-01', // Labor Day
    '2025-06-12', // Independence Day
    '2025-06-19', // Eid al-Adha (approximate — confirm annually)
    '2025-08-21', // Ninoy Aquino Day
    '2025-08-25', // National Heroes Day (last Monday of August)
    '2025-11-01', // All Saints Day
    '2025-11-02', // All Souls Day (special non-working)
    '2025-11-30', // Bonifacio Day
    '2025-12-08', // Feast of the Immaculate Conception (special non-working)
    '2025-12-24', // Christmas Eve (special non-working)
    '2025-12-25', // Christmas Day
    '2025-12-30', // Rizal Day
    '2025-12-31', // New Year's Eve (special non-working)
  
    // 2026
    '2026-01-01', // New Year's Day
    '2026-02-17', // Chinese New Year (approximate)
    '2026-02-25', // EDSA People Power Revolution Anniversary
    '2026-04-01', // Maundy Thursday (approximate)
    '2026-04-02', // Good Friday (approximate)
    '2026-04-03', // Black Saturday (approximate)
    '2026-04-09', // Araw ng Kagitingan
    '2026-05-01', // Labor Day
    '2026-06-12', // Independence Day
    '2026-08-21', // Ninoy Aquino Day
    '2026-08-31', // National Heroes Day (last Monday of August)
    '2026-11-01', // All Saints Day
    '2026-11-30', // Bonifacio Day
    '2026-12-08', // Feast of the Immaculate Conception
    '2026-12-24', // Christmas Eve
    '2026-12-25', // Christmas Day
    '2026-12-30', // Rizal Day
    '2026-12-31', // New Year's Eve
  ]);
  
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  
  /** Returns 'YYYY-MM-DD' string for a Date in local time */
  function toDateString(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  
  /** Returns true if the date is a Saturday or Sunday */
  function isWeekend(d: Date): boolean {
    const dow = d.getDay(); // 0 = Sunday, 6 = Saturday
    return dow === 0 || dow === 6;
  }
  
  /** Returns true if the date is a public holiday */
  function isHoliday(d: Date): boolean {
    return HOLIDAYS.has(toDateString(d));
  }
  
  /** Returns true if the date is a business day (weekday and not a holiday) */
  export function isBusinessDay(d: Date): boolean {
    return !isWeekend(d) && !isHoliday(d);
  }
  
  // ---------------------------------------------------------------------------
  // Core function
  // ---------------------------------------------------------------------------
  
  /**
   * Counts the number of business days between two dates.
   *
   * - Counts from the day AFTER `from` up to and including `to`.
   * - Both dates are treated as date-only (time of day is ignored).
   * - Returns a non-negative integer.
   *
   * Examples:
   *   Monday → Tuesday with no holiday in between = 1 business day
   *   Friday → Monday with no holiday             = 1 business day (Saturday + Sunday skipped)
   *   Friday → Tuesday over a Monday holiday      = 1 business day (Saturday + Sunday + Monday skipped)
   */
  export function countBusinessDays(from: Date, to: Date): number {
    if (to <= from) return 0;
  
    // Work on date-only copies to avoid time-of-day drift
    const start = new Date(from);
    start.setUTCHours(0, 0, 0, 0);
  
    const end = new Date(to);
    end.setUTCHours(0, 0, 0, 0);
  
    let count = 0;
    const cursor = new Date(start);
    cursor.setUTCDate(cursor.getUTCDate() + 1); // start counting the day AFTER `from`
  
    while (cursor <= end) {
      if (isBusinessDay(cursor)) count++;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  
    return count;
  }
  
  /**
   * Convenience wrapper: counts business days from a timestamp string to now.
   */
  export function businessDaysSince(referenceTimestamp: string, now: Date = new Date()): number {
    return countBusinessDays(new Date(referenceTimestamp), now);
  }