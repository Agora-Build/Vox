import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5000';
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'admin@vox.local';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin123456';

interface AuthSession {
  cookie: string;
}

interface ClashAgentProfile {
  id: number;
  name: string;
  agentUrl: string;
  visibility: string;
}

interface ClashEvent {
  id: number;
  name: string;
  status: string;
  region: string;
  matches?: any[];
}

interface ClashSchedule {
  id: number;
  eventName: string;
  matchups: any[];
  isEnabled: boolean;
}

async function login(email: string, password: string): Promise<AuthSession> {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Login failed: ${response.status}`);
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('No session cookie');
  return { cookie: setCookie.split(';')[0] };
}

async function authFetch(session: AuthSession, url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Cookie': session.cookie,
      'Content-Type': 'application/json',
    },
  });
}

describe('Clash v2 API Tests', () => {
  let adminSession: AuthSession;
  let testProviderId: string;

  let profileAId: number;
  let profileBId: number;
  let profileToDeleteId: number;
  let eventId: number;
  let cancelEventId: number;
  let scheduleId: number;

  beforeAll(async () => {
    adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    // Fetch a valid provider ID
    const providerResponse = await fetch(`${BASE_URL}/api/providers`);
    const providers = await providerResponse.json();
    testProviderId = providers[0].id;
  });

  // ==================== Agent Profiles ====================

  describe('Agent Profiles', () => {
    it('POST /api/clash/profiles — should create profile A', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/profiles`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Event Agent A',
          agentUrl: 'https://agent-a.example.com',
          providerId: testProviderId,
          setupSteps: [],
          visibility: 'public',
        }),
      });

      expect(response.status).toBe(201);
      const profile: ClashAgentProfile = await response.json();
      expect(profile.name).toBe('Event Agent A');
      expect(profile.visibility).toBe('public');
      profileAId = profile.id;
    });

    it('POST /api/clash/profiles — should create profile B', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/profiles`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Event Agent B',
          agentUrl: 'https://agent-b.example.com',
          providerId: testProviderId,
          setupSteps: [],
          visibility: 'public',
        }),
      });

      expect(response.status).toBe(201);
      const profile: ClashAgentProfile = await response.json();
      expect(profile.name).toBe('Event Agent B');
      profileBId = profile.id;
    });

    it('POST /api/clash/profiles — should create a profile to delete later', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/profiles`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Disposable Agent',
          agentUrl: 'https://disposable.example.com',
          visibility: 'private',
        }),
      });

      expect(response.status).toBe(201);
      const profile: ClashAgentProfile = await response.json();
      profileToDeleteId = profile.id;
    });

    it('GET /api/clash/profiles — should list own + public profiles', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/profiles`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ownProfiles).toBeDefined();
      expect(Array.isArray(data.ownProfiles)).toBe(true);
      expect(data.ownProfiles.length).toBeGreaterThanOrEqual(3);
      expect(data.publicProfiles).toBeDefined();
      expect(Array.isArray(data.publicProfiles)).toBe(true);
    });

    it('PATCH /api/clash/profiles/:id — should update profile', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/profiles/${profileAId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Event Agent A Updated' }),
      });

      expect(response.status).toBe(200);
      const profile: ClashAgentProfile = await response.json();
      expect(profile.name).toBe('Event Agent A Updated');
    });

    it('DELETE /api/clash/profiles/:id — should delete profile', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/profiles/${profileToDeleteId}`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });

  // ==================== Events ====================

  describe('Events', () => {
    it('POST /api/clash/events — should create event with 1 matchup', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/events`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Clash Event',
          region: 'na',
          visibility: 'public',
          matchups: [
            {
              agentAProfileId: profileAId,
              agentBProfileId: profileBId,
              topic: 'Best programming language for beginners',
              maxDurationSeconds: 120,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      const event: ClashEvent = await response.json();
      expect(event.name).toBe('Test Clash Event');
      expect(event.status).toBe('upcoming');
      expect(event.region).toBe('na');
      expect(event.matches).toBeDefined();
      expect(Array.isArray(event.matches)).toBe(true);
      expect(event.matches!.length).toBe(1);
      eventId = event.id;
    });

    it('GET /api/clash/events/:id — should get event detail with matches', async () => {
      const response = await fetch(`${BASE_URL}/api/clash/events/${eventId}`);

      expect(response.status).toBe(200);
      const event = await response.json();
      expect(event.id).toBe(eventId);
      expect(event.name).toBe('Test Clash Event');
      expect(event.matches).toBeDefined();
      expect(Array.isArray(event.matches)).toBe(true);
      expect(event.matches.length).toBe(1);
      expect(event.matches[0].agentAName).toBeDefined();
      expect(event.matches[0].agentBName).toBeDefined();
    });

    it('GET /api/clash/events — should list user events', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/events`);

      expect(response.status).toBe(200);
      const events = await response.json();
      expect(Array.isArray(events)).toBe(true);
      const found = events.find((e: ClashEvent) => e.id === eventId);
      expect(found).toBeDefined();
    });

    it('POST /api/clash/events/:id/start — should start upcoming event', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/events/${eventId}/start`, {
        method: 'POST',
      });

      expect(response.status).toBe(200);
      const event = await response.json();
      expect(event.status).toBe('live');
    });

    it('POST /api/clash/events/:id/cancel — should cancel a live/upcoming event', async () => {
      // Create a fresh event to cancel
      const createResponse = await authFetch(adminSession, `${BASE_URL}/api/clash/events`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Event To Cancel',
          region: 'na',
          matchups: [
            {
              agentAProfileId: profileAId,
              agentBProfileId: profileBId,
              topic: 'Test topic',
            },
          ],
        }),
      });
      expect(createResponse.status).toBe(201);
      const newEvent: ClashEvent = await createResponse.json();
      cancelEventId = newEvent.id;

      const cancelResponse = await authFetch(adminSession, `${BASE_URL}/api/clash/events/${cancelEventId}/cancel`, {
        method: 'POST',
      });

      expect(cancelResponse.status).toBe(200);
      const cancelled = await cancelResponse.json();
      expect(cancelled.status).toBe('cancelled');
    });

    it('POST /api/clash/events — should reject self-clash (same agent in matchup)', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/events`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Self Clash Event',
          region: 'na',
          matchups: [
            {
              agentAProfileId: profileAId,
              agentBProfileId: profileAId,
              topic: 'Self-clash attempt',
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('itself');
    });

    it('POST /api/clash/events — should create multi-match event (2 matchups)', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/events`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Multi-Match Event',
          region: 'na',
          matchups: [
            {
              agentAProfileId: profileAId,
              agentBProfileId: profileBId,
              topic: 'First match topic',
              maxDurationSeconds: 120,
            },
            {
              agentAProfileId: profileBId,
              agentBProfileId: profileAId,
              topic: 'Second match topic',
              maxDurationSeconds: 120,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      const event: ClashEvent = await response.json();
      expect(event.matches).toBeDefined();
      expect(event.matches!.length).toBe(2);
    });
  });

  // ==================== Public Feed ====================

  describe('Public Feed', () => {
    it('GET /api/clash/feed — should return array of events', async () => {
      const response = await fetch(`${BASE_URL}/api/clash/feed`);

      expect(response.status).toBe(200);
      const events = await response.json();
      expect(Array.isArray(events)).toBe(true);
    });

    it('GET /api/clash/leaderboard — should return array', async () => {
      const response = await fetch(`${BASE_URL}/api/clash/leaderboard`);

      expect(response.status).toBe(200);
      const leaderboard = await response.json();
      expect(Array.isArray(leaderboard)).toBe(true);
    });
  });

  // ==================== Match Detail ====================

  describe('Match Detail', () => {
    let testMatchId: number;

    it('GET /api/clash/events/:id — sets up match ID for detail tests', async () => {
      const response = await fetch(`${BASE_URL}/api/clash/events/${eventId}`);
      expect(response.status).toBe(200);
      const event = await response.json();
      expect(event.matches.length).toBeGreaterThan(0);
      testMatchId = event.matches[0].id;
    });

    it('GET /api/clash/matches/:id — should return match detail', async () => {
      const response = await fetch(`${BASE_URL}/api/clash/matches/${testMatchId}`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe(testMatchId);
      expect(data.agentA).toBeDefined();
      expect(data.agentB).toBeDefined();
      expect(data.results).toBeDefined();
      expect(Array.isArray(data.results)).toBe(true);
    });

    it('GET /api/clash/matches/99999 — should return 404', async () => {
      const response = await fetch(`${BASE_URL}/api/clash/matches/99999`);
      expect(response.status).toBe(404);
    });

    it('GET /api/clash/matches/:id/transcript — should return array (empty initially)', async () => {
      const response = await fetch(`${BASE_URL}/api/clash/matches/${testMatchId}/transcript`);

      expect(response.status).toBe(200);
      const transcript = await response.json();
      expect(Array.isArray(transcript)).toBe(true);
    });
  });

  // ==================== Scheduling ====================

  describe('Scheduling', () => {
    it('POST /api/clash/schedules — should create with matchups JSONB', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/schedules`, {
        method: 'POST',
        body: JSON.stringify({
          eventName: 'Scheduled Clash Event',
          region: 'na',
          matchups: [
            {
              agentAProfileId: profileAId,
              agentBProfileId: profileBId,
              topic: 'Scheduled debate topic',
            },
          ],
          maxDurationSeconds: 180,
          cronExpression: '0 */6 * * *',
        }),
      });

      expect(response.status).toBe(201);
      const schedule: ClashSchedule = await response.json();
      expect(schedule.eventName).toBe('Scheduled Clash Event');
      expect(schedule.isEnabled).toBe(true);
      expect(Array.isArray(schedule.matchups)).toBe(true);
      expect(schedule.matchups.length).toBe(1);
      scheduleId = schedule.id;
    });

    it('GET /api/clash/schedules — should list schedules', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/schedules`);

      expect(response.status).toBe(200);
      const schedules = await response.json();
      expect(Array.isArray(schedules)).toBe(true);

      const found = schedules.find((s: ClashSchedule) => s.id === scheduleId);
      expect(found).toBeDefined();
      expect(found.eventName).toBe('Scheduled Clash Event');
    });

    it('PATCH /api/clash/schedules/:id — should toggle enabled', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/schedules/${scheduleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: false }),
      });

      expect(response.status).toBe(200);
      const schedule: ClashSchedule = await response.json();
      expect(schedule.isEnabled).toBe(false);
    });

    it('DELETE /api/clash/schedules/:id — should delete schedule', async () => {
      const response = await authFetch(adminSession, `${BASE_URL}/api/clash/schedules/${scheduleId}`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });
});
