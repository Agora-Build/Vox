import { describe, it, expect } from 'vitest';
import { parseNextCronRun, validateCronExpression } from '../server/cron';

describe('Cron Parser', () => {
  describe('parseNextCronRun', () => {
    it('should calculate next run for every minute (* * * * *)', () => {
      const fromDate = new Date('2024-01-15T10:30:00Z');
      const nextRun = parseNextCronRun('* * * * *', fromDate);

      expect(nextRun.getUTCMinutes()).toBe(31);
      expect(nextRun.getUTCHours()).toBe(10);
    });

    it('should handle extra whitespace in cron expression', () => {
      const fromDate = new Date('2024-01-15T10:30:00Z');
      const nextRun = parseNextCronRun('  0   *   *   *   *  ', fromDate);

      expect(nextRun.getUTCMinutes()).toBe(0);
      expect(nextRun.getUTCHours()).toBe(11);
    });

    it('should set seconds and milliseconds to 0', () => {
      const fromDate = new Date('2024-01-15T10:30:45.123Z');
      const nextRun = parseNextCronRun('0 * * * *', fromDate);

      expect(nextRun.getUTCSeconds()).toBe(0);
      expect(nextRun.getUTCMilliseconds()).toBe(0);
    });

    it('should calculate next run for hourly at minute 0 (0 * * * *)', () => {
      const fromDate = new Date('2024-01-15T10:30:00Z');
      const nextRun = parseNextCronRun('0 * * * *', fromDate);

      // Since current minute (30) > 0, should go to next hour
      expect(nextRun.getUTCMinutes()).toBe(0);
      expect(nextRun.getUTCHours()).toBe(11);
    });

    it('should calculate next run for hourly at minute 30 (30 * * * *)', () => {
      const fromDate = new Date('2024-01-15T10:15:00Z');
      const nextRun = parseNextCronRun('30 * * * *', fromDate);

      // Current minute (15) < 30, so should be same hour
      expect(nextRun.getUTCMinutes()).toBe(30);
      expect(nextRun.getUTCHours()).toBe(10);
    });

    it('should calculate next run for hourly at minute 30 when past that time (30 * * * *)', () => {
      const fromDate = new Date('2024-01-15T10:45:00Z');
      const nextRun = parseNextCronRun('30 * * * *', fromDate);

      // Current minute (45) > 30, should go to next hour
      expect(nextRun.getUTCMinutes()).toBe(30);
      expect(nextRun.getUTCHours()).toBe(11);
    });

    it('should calculate next run for daily at midnight (0 0 * * *)', () => {
      const fromDate = new Date('2024-01-15T10:30:00Z');
      const nextRun = parseNextCronRun('0 0 * * *', fromDate);

      // Should be next day at midnight
      expect(nextRun.getUTCMinutes()).toBe(0);
      expect(nextRun.getUTCHours()).toBe(0);
      expect(nextRun.getUTCDate()).toBe(16);
    });

    it('should calculate next run for daily at 8:30 (30 8 * * *)', () => {
      const fromDate = new Date('2024-01-15T07:00:00Z');
      const nextRun = parseNextCronRun('30 8 * * *', fromDate);

      // Time is before 8:30, should be today
      expect(nextRun.getUTCMinutes()).toBe(30);
      expect(nextRun.getUTCHours()).toBe(8);
      expect(nextRun.getUTCDate()).toBe(15);
    });

    it('should calculate next run for daily at 8:30 when past that time', () => {
      const fromDate = new Date('2024-01-15T10:00:00Z');
      const nextRun = parseNextCronRun('30 8 * * *', fromDate);

      // Time is after 8:30, should be next day
      expect(nextRun.getUTCMinutes()).toBe(30);
      expect(nextRun.getUTCHours()).toBe(8);
      expect(nextRun.getUTCDate()).toBe(16);
    });

    it('should calculate next run for weekly on Sunday (0 0 * * 0)', () => {
      // Monday January 15, 2024
      const fromDate = new Date('2024-01-15T10:30:00Z');
      const nextRun = parseNextCronRun('0 0 * * 0', fromDate);

      // Next Sunday should be January 21
      expect(nextRun.getUTCDay()).toBe(0); // Sunday
      expect(nextRun.getUTCMinutes()).toBe(0);
      expect(nextRun.getUTCHours()).toBe(0);
      expect(nextRun.getUTCDate()).toBe(21);
    });

    it('should calculate next run for weekly on Wednesday (0 0 * * 3)', () => {
      // Monday January 15, 2024
      const fromDate = new Date('2024-01-15T10:30:00Z');
      const nextRun = parseNextCronRun('0 0 * * 3', fromDate);

      // Next Wednesday should be January 17
      expect(nextRun.getUTCDay()).toBe(3); // Wednesday
      expect(nextRun.getUTCDate()).toBe(17);
    });

    it('should handle same day weekly when time has passed', () => {
      // Wednesday January 17, 2024 at 10:30
      const fromDate = new Date('2024-01-17T10:30:00Z');
      const nextRun = parseNextCronRun('0 8 * * 3', fromDate);

      // 8:00 AM on Wednesday has passed, should be next Wednesday January 24
      expect(nextRun.getUTCDay()).toBe(3);
      expect(nextRun.getUTCDate()).toBe(24);
    });

    it('should throw error for invalid cron expression', () => {
      expect(() => parseNextCronRun('invalid')).toThrow('Invalid cron expression');
      expect(() => parseNextCronRun('0 0 * *')).toThrow('Invalid cron expression');
      expect(() => parseNextCronRun('0 0 * * * *')).toThrow('Invalid cron expression');
    });

    it('should handle midnight boundary correctly', () => {
      // 11:30 PM, next run at midnight should be next day
      const fromDate = new Date('2024-01-15T23:30:00Z');
      const nextRun = parseNextCronRun('0 0 * * *', fromDate);

      expect(nextRun.getUTCHours()).toBe(0);
      expect(nextRun.getUTCMinutes()).toBe(0);
      expect(nextRun.getUTCDate()).toBe(16);
    });

    it('should handle month boundary correctly', () => {
      // January 31st, daily at 8:30 should roll to February 1st
      const fromDate = new Date('2024-01-31T10:00:00Z');
      const nextRun = parseNextCronRun('30 8 * * *', fromDate);

      expect(nextRun.getUTCDate()).toBe(1);
      expect(nextRun.getUTCMonth()).toBe(1); // February (0-indexed)
    });

    it('should handle year boundary correctly', () => {
      // December 31st, daily at midnight
      const fromDate = new Date('2024-12-31T10:00:00Z');
      const nextRun = parseNextCronRun('0 0 * * *', fromDate);

      expect(nextRun.getUTCDate()).toBe(1);
      expect(nextRun.getUTCMonth()).toBe(0); // January
      expect(nextRun.getUTCFullYear()).toBe(2025);
    });

    it('should use default fromDate when not provided', () => {
      const beforeCall = new Date();
      const nextRun = parseNextCronRun('* * * * *');
      const afterCall = new Date();

      // Next run should be 1 minute after "now"
      expect(nextRun.getTime()).toBeGreaterThan(beforeCall.getTime());
      expect(nextRun.getTime()).toBeLessThanOrEqual(afterCall.getTime() + 60000);
    });

    it('should handle Saturday to Sunday transition for weekly', () => {
      // Saturday January 13, 2024, weekly on Sunday
      const fromDate = new Date('2024-01-13T10:00:00Z');
      const nextRun = parseNextCronRun('0 0 * * 0', fromDate);

      expect(nextRun.getUTCDay()).toBe(0); // Sunday
      expect(nextRun.getUTCDate()).toBe(14);
    });

    it('should handle same weekday when time has not passed yet', () => {
      // Wednesday at 6:00 AM, cron is Wednesday at 8:00 AM
      const fromDate = new Date('2024-01-17T06:00:00Z');
      const nextRun = parseNextCronRun('0 8 * * 3', fromDate);

      // Should be same day since 8:00 AM hasn't passed
      expect(nextRun.getUTCDay()).toBe(3);
      expect(nextRun.getUTCDate()).toBe(17);
      expect(nextRun.getUTCHours()).toBe(8);
    });
  });

  describe('validateCronExpression', () => {
    it('should validate correct cron expressions', () => {
      expect(validateCronExpression('* * * * *')).toBe(true);
      expect(validateCronExpression('0 * * * *')).toBe(true);
      expect(validateCronExpression('30 8 * * *')).toBe(true);
      expect(validateCronExpression('0 0 * * 0')).toBe(true);
      expect(validateCronExpression('59 23 31 12 6')).toBe(true);
    });

    it('should reject invalid minute values', () => {
      expect(() => validateCronExpression('60 * * * *')).toThrow('Invalid minute');
      expect(() => validateCronExpression('-1 * * * *')).toThrow('Invalid minute');
    });

    it('should reject invalid hour values', () => {
      expect(() => validateCronExpression('0 24 * * *')).toThrow('Invalid hour');
      expect(() => validateCronExpression('0 -1 * * *')).toThrow('Invalid hour');
    });

    it('should reject invalid day of month values', () => {
      expect(() => validateCronExpression('0 0 32 * *')).toThrow('Invalid day of month');
      expect(() => validateCronExpression('0 0 0 * *')).toThrow('Invalid day of month');
    });

    it('should reject invalid month values', () => {
      expect(() => validateCronExpression('0 0 * 13 *')).toThrow('Invalid month');
      expect(() => validateCronExpression('0 0 * 0 *')).toThrow('Invalid month');
    });

    it('should reject invalid day of week values', () => {
      expect(() => validateCronExpression('0 0 * * 7')).toThrow('Invalid day of week');
      expect(() => validateCronExpression('0 0 * * -1')).toThrow('Invalid day of week');
    });

    it('should reject invalid expression format', () => {
      expect(() => validateCronExpression('0 0 * *')).toThrow('expected 5 parts');
      expect(() => validateCronExpression('0 0 * * * *')).toThrow('expected 5 parts');
    });

    it('should reject empty string', () => {
      expect(() => validateCronExpression('')).toThrow('expected 5 parts');
    });

    it('should reject non-numeric values (except *)', () => {
      expect(() => validateCronExpression('abc * * * *')).toThrow('Invalid minute');
      expect(() => validateCronExpression('0 xyz * * *')).toThrow('Invalid hour');
    });

    it('should accept edge boundary values', () => {
      expect(validateCronExpression('0 0 1 1 0')).toBe(true);  // minimum values
      expect(validateCronExpression('59 23 31 12 6')).toBe(true);  // maximum values
    });
  });

  describe('Real-world cron patterns', () => {
    it('should handle "every 5 minutes" pattern (*/5 approximated as 5)', () => {
      // Our simple parser doesn't support */5, but 5 * * * * means "at minute 5 of every hour"
      const fromDate = new Date('2024-01-15T10:03:00Z');
      const nextRun = parseNextCronRun('5 * * * *', fromDate);

      expect(nextRun.getUTCMinutes()).toBe(5);
      expect(nextRun.getUTCHours()).toBe(10);
    });

    it('should handle business hours pattern (9 AM weekdays approximated)', () => {
      // Monday at 7 AM, next 9 AM weekday should be same day
      const fromDate = new Date('2024-01-15T07:00:00Z'); // Monday
      const nextRun = parseNextCronRun('0 9 * * 1', fromDate);

      expect(nextRun.getUTCHours()).toBe(9);
      expect(nextRun.getUTCDay()).toBe(1); // Monday
    });

    it('should handle nightly backup pattern (2 AM daily)', () => {
      const fromDate = new Date('2024-01-15T10:00:00Z');
      const nextRun = parseNextCronRun('0 2 * * *', fromDate);

      expect(nextRun.getUTCHours()).toBe(2);
      expect(nextRun.getUTCMinutes()).toBe(0);
      expect(nextRun.getUTCDate()).toBe(16); // Next day
    });
  });
});
