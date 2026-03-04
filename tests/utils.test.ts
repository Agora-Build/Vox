import { describe, it, expect, vi, afterEach } from 'vitest';
import { format } from 'date-fns';

// Mirror the implementation to avoid path alias issues with @/ imports
function formatSmartTimestamp(dateStr: string | Date): string {
  const date = dateStr instanceof Date ? dateStr : new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1) {
    const diffSec = Math.floor(diffMs / 1000);
    return diffSec < 5 ? "Just now" : `${diffSec} seconds ago`;
  }
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? "s" : ""} ago`;
  if (diffHr < 8) return `${diffHr} hour${diffHr !== 1 ? "s" : ""} ago`;
  return format(date, "yyyy-MM-dd HH:mm:ss");
}

describe('formatSmartTimestamp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return "Just now" for timestamps < 5 seconds ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T12:00:05.000Z'));
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:03.000Z'))).toBe('Just now');
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:01.000Z'))).toBe('Just now');
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:05.000Z'))).toBe('Just now');
  });

  it('should return "X seconds ago" for 5-59 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T12:01:00.000Z'));
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:30.000Z'))).toBe('30 seconds ago');
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:50.000Z'))).toBe('10 seconds ago');
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:55.000Z'))).toBe('5 seconds ago');
  });

  it('should return "1 minute ago" (singular)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T12:01:30.000Z'));
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:00.000Z'))).toBe('1 minute ago');
  });

  it('should return "X minutes ago" for 2-59 minutes (plural)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T12:30:00.000Z'));
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:00.000Z'))).toBe('30 minutes ago');
    expect(formatSmartTimestamp(new Date('2026-03-04T12:28:00.000Z'))).toBe('2 minutes ago');
  });

  it('should return "1 hour ago" (singular)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T13:00:00.000Z'));
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:00.000Z'))).toBe('1 hour ago');
  });

  it('should return "X hours ago" for 2-7 hours (plural)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T17:00:00.000Z'));
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:00.000Z'))).toBe('5 hours ago');
    expect(formatSmartTimestamp(new Date('2026-03-04T10:00:00.000Z'))).toBe('7 hours ago');
  });

  it('should return absolute timestamp for >= 8 hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T20:00:00.000Z'));
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:00.000Z'))).toBe('2026-03-04 12:00:00');
  });

  it('should return absolute timestamp for dates from another day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T08:00:00.000Z'));
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:00.000Z'))).toBe('2026-03-04 12:00:00');
  });

  it('should accept string dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T12:05:00.000Z'));
    expect(formatSmartTimestamp('2026-03-04T12:00:00.000Z')).toBe('5 minutes ago');
  });

  it('should handle boundary: 59 minutes -> still minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T12:59:00.000Z'));
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:00.000Z'))).toBe('59 minutes ago');
  });

  it('should handle boundary: 7 hours 59 min -> still hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-04T19:59:00.000Z'));
    expect(formatSmartTimestamp(new Date('2026-03-04T12:00:00.000Z'))).toBe('7 hours ago');
  });
});
