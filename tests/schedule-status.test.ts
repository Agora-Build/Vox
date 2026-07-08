import { describe, it, expect } from 'vitest';
import { deriveScheduleStatus } from '../shared/schedule-status';

const NOW = 1_700_000_000_000; // fixed reference
const DAY = 24 * 60 * 60 * 1000;

describe('deriveScheduleStatus', () => {
  it('active when enabled and not near expiry', () => {
    expect(deriveScheduleStatus(true, new Date(NOW + 90 * DAY), NOW)).toEqual({ status: 'active', expiringSoon: false });
  });

  it('active + expiringSoon within 14 days of expiry', () => {
    expect(deriveScheduleStatus(true, new Date(NOW + 10 * DAY), NOW)).toEqual({ status: 'active', expiringSoon: true });
    // boundary: exactly 14 days is still "soon"
    expect(deriveScheduleStatus(true, new Date(NOW + 14 * DAY), NOW).expiringSoon).toBe(true);
    // just over 14 days is not
    expect(deriveScheduleStatus(true, new Date(NOW + 15 * DAY), NOW).expiringSoon).toBe(false);
  });

  it('inactive when expired, regardless of enabled', () => {
    expect(deriveScheduleStatus(true, new Date(NOW - DAY), NOW)).toEqual({ status: 'inactive', expiringSoon: false });
    expect(deriveScheduleStatus(false, new Date(NOW - DAY), NOW)).toEqual({ status: 'inactive', expiringSoon: false });
  });

  it('paused when disabled and not expired', () => {
    expect(deriveScheduleStatus(false, new Date(NOW + 30 * DAY), NOW)).toEqual({ status: 'paused', expiringSoon: false });
  });

  it('active with no expiry (null) never expires or warns', () => {
    expect(deriveScheduleStatus(true, null, NOW)).toEqual({ status: 'active', expiringSoon: false });
    expect(deriveScheduleStatus(false, null, NOW)).toEqual({ status: 'paused', expiringSoon: false });
  });
});
