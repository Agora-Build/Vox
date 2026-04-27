# Vox - AI Agent Experience Evaluation Platform

<p align="center">
  <strong>Track AI Performance Across the World</strong>
</p>

<p align="center">
  Automated evaluation testing for conversational AI products. Monitor response latency, interrupt latency, network resilience, naturalness, and noise reduction across multiple regions.
</p>

---

## Features

### Automated Testing
Comprehensive evaluations run automatically across all selected products and regions using distributed eval agents.

### Multi-Region Coverage
Test from North America, Asia Pacific, Europe, and South America to understand regional performance characteristics.

### Real-Time Dashboard
Live data dashboard with interactive zoom/pan charts, per-provider line segments with 2h gap detection, and latest test metrics (MED/SD/P95).

### Global Leaderboard
Compare provider performance across regions with sortable rankings, P95 latency columns, and composite scoring.

### Job Detail & Artifacts
View detailed per-job metrics, turn-level latency data, play back recorded audio, and download full artifact bundles from S3-compatible storage.

### Schedule Management
Create and manage recurring evaluation schedules with cron expressions. Pause, resume, edit, run-now, and delete from the console.

### Organization Support
Team collaboration with seat-based pricing, member management, and shared workflows.

### 5 Key Metrics
- **Response Latency** - Time for AI to generate initial response (ms) - *Lower is better*
- **Interrupt Latency** - Time to process and respond to interruptions (ms) - *Lower is better*
- **Network Resilience** - Stability under varying network conditions (%) - *Higher is better*
- **Naturalness** - Quality and fluency of AI responses (0-5.0 score) - *Higher is better*
- **Noise Reduction** - Effectiveness at filtering background noise (%) - *Higher is better*

---

## Supported Products

| Product | Provider | SKU |
|---------|----------|-----|
| Agora ConvoAI Engine | Agora | convoai |
| LiveKit Agents | LiveKit | convoai |
| ElevenLabs Agents | ElevenLabs | convoai |
| Custom Products | User-defined | convoai/rtc |

---

## Tech Stack

### Frontend
- **React 19** with TypeScript
- **Vite** for development and production builds
- **Tailwind CSS** with shadcn/ui component library
- **Wouter** for lightweight client-side routing
- **TanStack React Query** for server state management
- **Recharts** for data visualization (with custom zoom/pan)

### Backend
- **Node.js** with Express
- **TypeScript** with ESM modules
- **Drizzle ORM** with PostgreSQL
- **Passport.js** for OAuth (Google, GitHub)
- **express-rate-limit** for API protection
- **@aws-sdk/client-s3** for S3-compatible artifact storage

---

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL database
- Docker (for local dev PostgreSQL and eval agents)

### Quick Start (Recommended)

```bash
# Clone and install
git clone https://github.com/Agora-Build/Vox.git
cd Vox
npm install

# Start all services (PostgreSQL + Vox server + eval agent)
./scripts/dev-local-run.sh start

# Multi-region eval agents
./scripts/dev-local-run.sh --multi-region start
```

**Default Credentials (after init):**
- Admin: `admin@vox.local` / `admin123456`
- Scout: `scout@vox.ai` / `scout123`

### Manual Setup

1. **Set up environment variables** — create `.env.dev`:
   ```bash
   DATABASE_URL=postgresql://user:password@localhost:5432/vox
   SESSION_SECRET=your-session-secret
   INIT_CODE=your-initialization-code
   ```

2. **Push database schema**
   ```bash
   DATABASE_URL=... npm run db:push
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

The application will be available at `http://localhost:5000`.

---

## Environment Variables

### Server (Required)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Session encryption key |
| `INIT_CODE` | System initialization code |

### Server (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | Server port |
| `CREDENTIAL_ENCRYPTION_KEY` | - | 32-byte hex key for AES-256-GCM secret encryption. Generate: `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` | - | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | - | Google OAuth client secret |
| `GITHUB_CLIENT_ID` | - | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | - | GitHub OAuth client secret |

### S3-Compatible Storage (Server only)

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_ENDPOINT` | - | S3/R2 endpoint (e.g., `https://<account>.r2.cloudflarestorage.com`) |
| `S3_BUCKET` | - | Bucket name |
| `S3_ACCESS_KEY_ID` | - | Access key |
| `S3_SECRET_ACCESS_KEY` | - | Secret key |
| `S3_REGION` | `auto` | Region (`auto` for Cloudflare R2) |

Set these on the Vox server only. The daemon reads S3 config from the server via API — no S3 env vars needed on the daemon. If not set, artifact upload is disabled and Vox still works normally. Premium+ users can override with their own S3 config via Console > Storage Settings.

### Environment Files

| Context | Env Vars | Test Data |
|---------|----------|-----------|
| Local Dev | `.env.dev` (gitignored) | `tests/tests.dev.data` (gitignored) |
| CI/CD | CI secrets/environment | CI secrets/environment |

The `dev-local-run.sh` script automatically loads `.env` and `.env.dev`.

---

## Database Migrations

Vox uses a custom version-based migration runner (`server/migrate.ts`), not drizzle-orm's `migrate()`. The `npm start` script runs `node dist/migrate.cjs` before starting the app.

**Every schema change requires 3 files committed together:**
1. Edit `shared/schema.ts`
2. `DATABASE_URL=... npm run db:generate` — creates SQL file in `migrations/`
3. Append to `MIGRATIONS` array in `server/migrate.ts`

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm start` | Run migrations + start production server |
| `npm run check` | TypeScript type checking |
| `npm run lint` | ESLint |
| `npm run db:generate` | Generate migration from schema changes |
| `npm run db:push` | Push schema to local database (dev only) |
| `npm test` | Run unit/integration tests |
| `./scripts/full-tests-run.sh` | Run all tests (unit + audio + E2E) |
| `./scripts/dev-local-run.sh start` | Start local dev environment |
| `./scripts/dev-local-run.sh --multi-region start` | Start with agents for all regions |

---

## API Documentation

### Authentication

All authenticated endpoints accept either:
- **Session authentication** — Cookie-based sessions from web login
- **API Key authentication** — Bearer token with `vox_live_` prefix

```bash
curl -H "Authorization: Bearer vox_live_xxxxxxxxxxxx" \
  https://your-domain.com/api/v1/workflows
```

### API v1 Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/v1/user` | Required | Get current user info |
| `GET /api/v1/workflows` | Required | List workflows |
| `POST /api/v1/workflows` | Required | Create workflow |
| `POST /api/v1/workflows/:id/run` | Required | Run workflow (create job) |
| `GET /api/v1/eval-sets` | Required | List eval sets |
| `GET /api/v1/jobs` | Required | List jobs |
| `GET /api/v1/jobs/:id` | Required | Get job status |
| `GET /api/v1/results` | Required | List results with P95 metrics |
| `GET /api/v1/results/:id` | Required | Get result details |
| `GET /api/v1/projects` | Required | List projects |
| `GET /api/v1/providers` | None | List all providers |
| `GET /api/v1/metrics/realtime` | None | Real-time metrics (MED/SD/P95) |
| `GET /api/v1/metrics/leaderboard` | None | Leaderboard data (with P95) |

Full interactive documentation: `/api/docs` (Swagger UI)

---

## User Plans

| Plan | Projects | Workflows | Private | Storage Override | API Requests |
|------|----------|-----------|---------|-----------------|--------------|
| **Basic** | 5 | 10/project | No | No | 200/mo |
| **Premium** | 20 | 20/project | Yes | Yes | 1,000/mo |
| **Principal** | 20 | 20/project | Yes | Yes | 5,000/mo |
| **Fellow** | 20 | 20/project | Yes | Yes | 5,000/mo |

---

## Console Pages

| Path | Description |
|------|-------------|
| `/console/projects` | Manage projects |
| `/console/workflows` | Manage workflows |
| `/console/eval-sets` | Manage eval sets |
| `/console/eval-jobs` | Schedules tab + Jobs tab (with URL persistence) |
| `/console/eval-jobs/:id` | Job detail: metrics, turn data, audio player, downloads |
| `/console/eval-agents` | View eval agents |
| `/console/secrets` | Manage encrypted secrets |
| `/console/api-keys` | Create/revoke/delete API keys |
| `/console/storage-settings` | S3 storage override (Premium+) |
| `/console/clash` | Clash arena (profiles, events, schedules, runners) |
| `/console/organization` | Organization management |

---

## Eval Agent System

Distributed eval agents run evaluation tests across regions:

1. Admin or non-basic users create eval agent tokens with region assignments
2. Agents register using tokens and heartbeat regularly
3. Agents claim pending jobs atomically (no race conditions)
4. Agents execute tests via aeval or voice-agent-tester
5. Results reported with MED, SD, and P95 latency metrics
6. Artifacts (recordings, logs, metrics) uploaded to S3 when idle

Multiple agents in the same region compete for jobs — first to claim wins. See [vox_eval_agentd/README.md](vox_eval_agentd/README.md).

---

## Project Structure

```
vox/
├── client/                 # Frontend React application
│   └── src/
│       ├── components/     # UI components (shadcn/ui)
│       ├── pages/          # Page components
│       └── lib/            # Utilities
├── server/                 # Backend Express server
│   ├── index.ts            # Entry point
│   ├── routes.ts           # Main API routes
│   ├── routes-api-v1.ts    # Versioned public API
│   ├── storage.ts          # Data access layer
│   ├── auth.ts             # Authentication
│   ├── s3.ts               # S3 signed URL generation
│   └── migrate.ts          # Migration runner
├── shared/schema.ts        # Database schema (single source of truth)
├── vox_eval_agentd/        # Evaluation agent daemon
├── vox_clash_runner/       # Clash match runner
├── migrations/             # SQL migration files
├── tests/                  # Test files (420+ tests)
└── scripts/                 # Build and dev scripts
```

---

## Tests

| File | Type | Tests | Description |
|------|------|-------|-------------|
| `tests/api.test.ts` | Integration | 210+ | API endpoints, P95, storage config, API keys, schedules |
| `tests/eval-agent-daemon.test.ts` | Unit | 88 | Daemon parsing, MED/SD/P95, framework selection |
| `tests/s3.test.ts` | Integration | 11 | S3/R2 upload, signed URLs, storage config |
| `tests/auth.test.ts` | Unit | 26 | Password hashing, token generation |
| `tests/cron.test.ts` | Unit | 32 | Cron expression parsing |
| `tests/agora.test.ts` | Unit | 45 | Agora token gen, ConvoAI payload |
| `tests/clash-runner.test.ts` | Unit | 44 | Clash runner logic, Elo calculation |
| `tests/e2e/*.spec.ts` | E2E | 40 | Playwright browser tests |

---

## License

This project is licensed under the MIT License.
