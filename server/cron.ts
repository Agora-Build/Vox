/**
 * Simple cron parser for calculating next run time
 * Supports standard 5-field cron expressions: minute hour day month weekday
 * Examples:
 *   "* * * * *"     - Every minute
 *   "0 * * * *"     - Every hour at minute 0
 *   "0 0 * * *"     - Daily at midnight
 *   "0 0 * * 0"     - Weekly on Sunday at midnight
 *   "30 8 * * 1-5"  - Weekdays at 8:30 AM
 */
export function parseNextCronRun(cronExpression: string, fromDate: Date = new Date()): Date {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cronExpression}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const next = new Date(fromDate);
  next.setSeconds(0);
  next.setMilliseconds(0);

  // Every minute: * * * * *
  if (minute === "*" && hour === "*") {
    next.setMinutes(next.getMinutes() + 1);
    return next;
  }

  // Every hour at specific minute: N * * * *
  if (minute !== "*" && hour === "*") {
    const targetMinute = parseInt(minute);
    if (next.getMinutes() >= targetMinute) {
      next.setHours(next.getHours() + 1);
    }
    next.setMinutes(targetMinute);
    return next;
  }

  // Daily at specific time: N N * * *
  if (minute !== "*" && hour !== "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    const targetHour = parseInt(hour);
    const targetMinute = parseInt(minute);
    next.setMinutes(targetMinute);
    next.setHours(targetHour);
    if (next <= fromDate) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  // Weekly on specific day: N N * * N
  if (minute !== "*" && hour !== "*" && dayOfWeek !== "*") {
    const targetDayOfWeek = parseInt(dayOfWeek);
    const targetHour = parseInt(hour);
    const targetMinute = parseInt(minute);
    next.setMinutes(targetMinute);
    next.setHours(targetHour);
    const currentDayOfWeek = next.getDay();
    let daysToAdd = targetDayOfWeek - currentDayOfWeek;
    if (daysToAdd < 0 || (daysToAdd === 0 && next <= fromDate)) {
      daysToAdd += 7;
    }
    next.setDate(next.getDate() + daysToAdd);
    return next;
  }

  // Default: add 1 hour
  next.setHours(next.getHours() + 1);
  return next;
}

/**
 * Validate a cron expression
 * Returns true if valid, throws error if invalid
 */
export function validateCronExpression(cronExpression: string): boolean {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 parts, got ${parts.length}`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Basic validation
  const validatePart = (part: string, min: number, max: number, name: string) => {
    if (part === "*") return true;
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
