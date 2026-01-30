// Cron parser for calculating next run time.
// Supports standard 5-field cron expressions: minute hour day month weekday
//
// Supported syntax per field:
//   *     - any value
//   N     - specific value (e.g. 5)
//   N-N   - range (e.g. 1-5)
//   N,N   - list (e.g. 0,15,30,45)
//   */N   - step from 0 (e.g. */6 = 0,6,12,18)

/**
 * Check if a value matches a cron field expression.
 */
function matchesField(expr: string, value: number): boolean {
  if (expr === "*") return true;

  // Step: */N
  if (expr.startsWith("*/")) {
    const step = parseInt(expr.slice(2));
    return !isNaN(step) && step > 0 && value % step === 0;
  }

  // List: N,N,N
  if (expr.includes(",")) {
    return expr.split(",").some((part) => matchesField(part.trim(), value));
  }

  // Range: N-N (dash not at position 0, which would be a negative number)
  if (expr.indexOf("-") > 0) {
    const [start, end] = expr.split("-").map(Number);
    if (!isNaN(start) && !isNaN(end)) {
      return value >= start && value <= end;
    }
    return false;
  }

  // Specific: N
  const num = parseInt(expr);
  return !isNaN(num) && num === value;
}

export function parseNextCronRun(cronExpression: string, fromDate: Date = new Date()): Date {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cronExpression}`);
  }

  const [minuteExpr, hourExpr, dayOfMonthExpr, monthExpr, dayOfWeekExpr] = parts;

  const next = new Date(fromDate);
  next.setSeconds(0);
  next.setMilliseconds(0);
  next.setMinutes(next.getMinutes() + 1); // Start from next minute

  // Search up to 366 days ahead (527040 minutes)
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (
      matchesField(monthExpr, next.getMonth() + 1) &&
      matchesField(dayOfMonthExpr, next.getDate()) &&
      matchesField(dayOfWeekExpr, next.getDay()) &&
      matchesField(hourExpr, next.getHours()) &&
      matchesField(minuteExpr, next.getMinutes())
    ) {
      return next;
    }
    next.setMinutes(next.getMinutes() + 1);
  }

  // Fallback: 1 hour from now (should not happen with valid expressions)
  const fallback = new Date(fromDate);
  fallback.setHours(fallback.getHours() + 1);
  return fallback;
}

/**
 * Validate a cron expression.
 * Returns true if valid, throws error if invalid.
 */
export function validateCronExpression(cronExpression: string): boolean {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 parts, got ${parts.length}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const validatePart = (part: string, min: number, max: number, name: string) => {
    if (part === "*") return true;

    // Step: */N
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2));
      if (isNaN(step) || step < 1 || step > max) {
        throw new Error(`Invalid ${name} step: ${part}`);
      }
      return true;
    }

    // List: N,N
    if (part.includes(",")) {
      for (const v of part.split(",")) {
        validatePart(v.trim(), min, max, name);
      }
      return true;
    }

    // Range: N-N (dash not at position 0, which would be a negative number)
    if (part.indexOf("-") > 0) {
      const [start, end] = part.split("-").map(Number);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
        throw new Error(`Invalid ${name} range: ${part}`);
      }
      return true;
    }

    // Specific: N
    const num = parseInt(part);
    if (isNaN(num) || num < min || num > max) {
      throw new Error(`Invalid ${name}: ${part} (expected ${min}-${max} or *)`);
    }
    return true;
  };

  validatePart(minute, 0, 59, "minute");
  validatePart(hour, 0, 23, "hour");
  validatePart(dayOfMonth, 1, 31, "day of month");
  validatePart(month, 1, 12, "month");
  validatePart(dayOfWeek, 0, 6, "day of week");

  return true;
}
