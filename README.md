# Vox

**Vox for every engagement.** Real-time experience evaluation for conversational AI agents: measure how voice agents actually behave for users, on the web and over the phone, from regions around the world.

**Live:** [vox.agora.build](https://vox.agora.build) · **API docs:** [vox.agora.build/api-docs](https://vox.agora.build/api-docs)

Distributed eval agents hold real conversations with AI voice agents and measure turn success rate, response latency, interrupt latency, network resilience, naturalness, and noise reduction, then track the results over time on a public dashboard and leaderboard.

---

## Screenshots

| Real-time dashboard | Global leaderboard |
|---|---|
| ![Real-time dashboard](screenshots/realtime-dashboard.png) | ![Global leaderboard](screenshots/leaderboard.png) |
| **Home** | **API docs** |
| ![Home](screenshots/home.png) | ![API docs](screenshots/api-docs.png) |

More in [`screenshots/`](screenshots/).

---

## Features

### Automated Evals
Evals run automatically every 3 hours across all selected providers and regions, using distributed eval agents.

### Web and Phone
Every eval flow has an **Evaluation Mode**: *web* (the agent is reached in a browser) or *phone* (Vox places a real call over PSTN through [DialF](https://github.com/Agora-Build/DialF)). Web and phone results are kept as separate partitions and never mixed. Native apps are planned.

### Setup and Teardown Steps
How to reach an agent is described as steps rather than hard-coded integrations: log in, open the page, dial the number, hang up. The same Setup/Teardown step model is used in both modes and follows the [Libretto](https://github.com/Agora-Build/libretto) action-script protocol.

### Multi-Region Coverage
Test from North America, Asia Pacific, Europe, and South America to see how each provider performs where your users are.

### Real-Time Dashboard
Live dashboard with zoom/pan charts, per-provider series with gap detection, and the latest metrics (median, SD, P95).

### Global Leaderboard
Compare providers across regions with sortable rankings, P95 latency columns, and composite scoring.

### Job Detail & Artifacts
Per-job metrics, turn-level latency, recorded audio playback, and full artifact bundles from S3-compatible storage.

### Schedules
Recurring evaluations with cron expressions. Pause, resume, edit, run now, and delete from the console.

### Clash
Head-to-head matches between two agents on a shared topic, with a live moderator, match metrics, and Elo ratings.

### Organizations
Team collaboration with seat-based pricing, member management, and shared eval flows and secrets.

### 6 Key Metrics
- **Turn Success Rate** - Share of turns handled correctly: responded, stopped on interrupt, no false barge-in (%) - *Higher is better*
- **Response Latency** - Time for AI to generate initial response (ms) - *Lower is better*
- **Interrupt Latency** - Time to process and respond to interruptions (ms) - *Lower is better*
- **Network Resilience** - Stability under varying network conditions (%) - *Higher is better*
- **Naturalness** - Quality and fluency of AI responses (0-5.0 score) - *Higher is better*
- **Noise Reduction** - Effectiveness at filtering background noise (%) - *Higher is better*

---

## Supported Providers

| Product | Provider | Platform ID |
|---------|----------|-------------|
| Agora ConvoAI Engine | Agora | `agora` |
| LiveKit Agents | LiveKit | `livekit` |
| ElevenLabs Agents | ElevenLabs | `elevenlabs` |
| Custom | User-defined | — |

---

## How It Fits Together

| Part | Role |
|------|------|
| **Vox** (this repo) | Decides what to measure, dispatches jobs to eval agents, stores and ranks the results |
| **[aeval](https://github.com/Agora-Build/aeval)** | The eval engine: runs the conversation and scores it (`metrics.json`) |
| **[DialF](https://github.com/Agora-Build/DialF)** | Places and answers real phone calls for phone-mode evals |
| **[Libretto](https://github.com/Agora-Build/libretto)** | The action-script protocol behind Setup/Teardown steps |

---

## Tech Stack

### Frontend
- **React 19** with TypeScript
- **Vite**, **Tailwind CSS** with shadcn/ui
- **Wouter** routing, **TanStack React Query**
- **Recharts** (with custom zoom/pan)

### Backend
- **Node.js 22** with Express, TypeScript (ESM)
- **Drizzle ORM** with PostgreSQL
- **Passport.js** for OAuth (Google, GitHub)
- **Stripe** for organization seat billing
- **@aws-sdk/client-s3** for S3-compatible artifact storage

---

## Getting Started

### Prerequisites
- Node.js 22
- Docker (runs PostgreSQL for local dev, and the eval agent / broker images)

### Quick Start (Recommended)

```bash
git clone https://github.com/Agora-Build/Vox.git
cd Vox
npm install

# PostgreSQL + Vox server + eval agent
./scripts/dev-local-run.sh start

# Or with eval agents for every region
./scripts/dev-local-run.sh --multi-region start
```

Open `http://localhost:5000`.

**Default credentials (after init):**
- Admin: `admin@vox.local` / `admin123456`
- Scout: `scout@vox.ai` / `scout123`

### Manual Setup

1. **Set environment variables** in `.env.dev`:
   ```bash
   DATABASE_URL=postgresql://user:password@localhost:5432/vox
   SESSION_SECRET=your-session-secret
   INIT_CODE=your-initialization-code
   VOX_PLUGINS=credits,shared-agents,organizations,oauth
   ```
2. **Push the schema** (local development only, never production):
   ```bash
   DATABASE_URL=... npm run db:push
   ```
3. **Start the dev server:** `npm run dev`

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Session encryption key |
| `INIT_CODE` | System initialization code |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5000` | Server port |
| `VOX_PLUGINS` | none | Comma-separated plugins to load: `credits`, `shared-agents`, `organizations`, `oauth`, `sample`. An unknown id stops the server at startup, so treat it like a required setting. |
| `CREDENTIAL_ENCRYPTION_KEY` | - | 32-byte hex key (AES-256-GCM) for stored secrets. Generate with `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | - | Google sign-in (needs the `oauth` plugin). Redirect URI: `<your site>/api/plugins/oauth/google/callback` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL` | - | GitHub sign-in (needs the `oauth` plugin). Callback URL: `<your site>/auth/github/callback` |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` | - | Organization seat billing |
| `APP_URL` | `http://localhost:5000` | Public base URL, used for billing return links |
| `AGORA_APP_ID` / `AGORA_APP_CERTIFICATE` / `AGORA_CONVOAI_CONFIG` | - | Agora RTC and the Clash live moderator |
| `WEB_SESSION_TTL_HOURS` | `1` | How long a minted login session stays fresh |
| `WEB_SESSION_MINT_TIMEOUT_SECONDS` | `180` | Upper bound on minting one login session |
| `GEOIP_DB_DIR` | `./geoip` | GeoIP databases for eval-agent region detection |
| `MAXMIND_LICENSE_KEY` | - | Fallback only; the key is normally set in Console → Regions. Without one, the free DB-IP Lite database is used |
| `VOX_CONTACT_EMAIL` | `vox@agora.build` | Footer contact link |
| `VOX_GITHUB_URL` | `https://github.com/Agora-Build/Vox` | Footer GitHub link |
| `VOX_X_URL` | - | Footer X link (hidden when unset) |

### S3-Compatible Storage (server only)

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_ENDPOINT` | - | S3/R2 endpoint (e.g. `https://<account>.r2.cloudflarestorage.com`) |
| `S3_BUCKET` | - | Bucket name |
| `S3_ACCESS_KEY_ID` | - | Access key |
| `S3_SECRET_ACCESS_KEY` | - | Secret key |
| `S3_REGION` | `auto` | Region (`auto` for Cloudflare R2) |

Set these on the Vox server only; eval agents get their storage config from the server. Without them, artifact upload is disabled and everything else still works. Premium+ users can use their own bucket via Console → Storage Settings.

### Environment Files

`dev-local-run.sh` loads `.env` and then `.env.dev` (both gitignored). Test account data lives in `tests/tests.dev.data` (gitignored). CI uses its own secrets.

---

## Database Migrations

Vox uses its own version-based migration runner (`server/migrate.ts`); `npm start` runs `node dist/migrate.cjs` before the app starts, so migrations apply automatically on deploy.

**Every change to `shared/schema.ts` ships with a migration, committed together:**
1. Edit `shared/schema.ts`
2. Write the SQL in a new numbered file in `migrations/`, by hand. `npm run db:generate` no longer works for this project.
3. Register it in the `MIGRATIONS` array in `server/migrate.ts`. An unregistered file is never applied.

Keep migration SQL plain (`CREATE TABLE`, `ALTER TABLE`); each migration runs exactly once. Never use `db:push` against production.

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the development server |
| `npm run build` | Build for production |
| `npm start` | Run migrations, then start the production server |
| `npm run check` | TypeScript type checking |
| `npm run lint` | ESLint |
| `npm test` | Unit and integration tests (Vitest) |
| `./scripts/full-tests-run.sh` | The full gate: unit + audio + E2E |
| `./scripts/dev-local-run.sh start` | Start the local environment |
| `./scripts/dev-local-run.sh clean-test-data --yes` | Remove leftover test data from the local database |
| `./scripts/vox-upgrade.sh` | Upgrade eval agent and/or clash runner containers |

### Upgrading Eval Agents / Clash Runners

```bash
cat > .env << 'EOF'
AGENT_TOKEN=your-eval-agent-token
RUNNER_TOKEN=your-clash-runner-token
VOX_SERVER=https://vox.agora.build
EOF

./scripts/vox-upgrade.sh             # uses .env in the current directory
./scripts/vox-upgrade.sh /path/.env  # or a specific file
```

Only containers with a token in the file are upgraded, and a container already on the latest image is left alone. On a phone host it also detects a running DialF daemon and mounts it into the eval agent.

---

## API

The REST API lives under `/api/v1`. Full guide: [vox.agora.build/api-docs](https://vox.agora.build/api-docs). Interactive reference: `/api/docs` (Swagger UI).

**Getting a key:** sign in, open **Console → API Keys**, and create one. It is shown once; Vox stores only a hash.

```bash
curl -H "Authorization: Bearer vox_live_xxxxxxxxxxxx" \
  https://vox.agora.build/api/v1/eval-flows
```

| Endpoint | Key needed | Description |
|----------|------------|-------------|
| `GET /api/v1/user` | Yes | Current user |
| `GET /api/v1/projects` · `POST` | Yes | List / create projects |
| `GET /api/v1/eval-flows` · `POST` | Yes | List / create eval flows |
| `GET` · `PUT` · `DELETE /api/v1/eval-flows/:id` | Yes | Read / update / delete an eval flow |
| `POST /api/v1/eval-flows/:id/run` | Yes | Run an eval flow (creates a job) |
| `GET /api/v1/eval-sets` · `POST` | Yes | List / create eval sets |
| `GET /api/v1/eval-sets/:id` | Yes | Read an eval set |
| `GET /api/v1/jobs` | Yes | List jobs |
| `GET` · `DELETE /api/v1/jobs/:id` | Yes | Job status / cancel a pending job |
| `GET /api/v1/results` | Yes | List results (with P95) |
| `GET /api/v1/results/:id` | Yes | Result details |
| `GET /api/v1/providers` | No | All providers |
| `GET /api/v1/metrics/realtime` | No | Real-time metrics (median/SD/P95) |
| `GET /api/v1/metrics/leaderboard` | No | Leaderboard |

A **Native API**, for building evals and running them locally, is planned.

---

## User Plans

| Plan | Projects | Eval flows (console) | Eval flows (API) | Private resources | Own storage |
|------|----------|----------------------|------------------|-------------------|-------------|
| **Basic** | 5 | 10 per project | 50 total | No | No |
| **Premium** | 20 | 20 per project | 200 total | Yes | Yes |
| **Principal** | 20 | 20 per project | 200 total | Yes | Yes |
| **Fellow** | 20 | 20 per project | 200 total | Yes | Yes |

Principal and Fellow can also mark evals as *mainline*, which makes them eligible for the public dashboard.

---

## Console Pages

| Path | Description |
|------|-------------|
| `/console/projects` | Projects |
| `/console/eval-flows` | Eval flows (and `/console/eval-flows/:id` for detail) |
| `/console/eval-sets` | Eval sets |
| `/console/eval-jobs` | Schedules and jobs |
| `/console/eval-jobs/:id` | Job detail: metrics, turn data, audio, downloads |
| `/console/eval-agents` | Eval agents and agent tokens |
| `/console/secrets` | Encrypted secrets |
| `/console/api-keys` | API keys |
| `/console/storage-settings` | Own S3 storage (Premium+) |
| `/console/clash` | Clash: profiles, events, schedules, runners |
| `/console/organization` | Organization, members, billing, settings |
| `/console/users` · `providers` · `regions` · `brokers` · `organizations` | Admin only |

---

## Eval Agent System

1. Admins and non-basic users mint eval agent tokens.
2. Agents register with a token and send heartbeats. Vox detects an agent's region itself rather than trusting what the agent says; public-tier tokens can also be assigned a region.
3. Agents claim pending jobs for their region atomically. Phone jobs only go to agents that report the `phone` capability (a working DialF setup).
4. Agents run the eval with aeval and report median, SD, and P95 metrics. A failed run is reported as failed; partial results are never recorded.
5. Artifacts (recordings, logs, metrics) are uploaded to S3.

Some evals need a logged-in web session. Those credentials never reach an eval agent: a separate **auth-session broker** logs in on the server side and hands the agent a ready session instead. A **REST broker** runs any API calls a Setup step needs, under the same rule. See [vox_eval_agentd/README.md](vox_eval_agentd/README.md).

---

## Plugins

Optional backends load from `VOX_PLUGINS`. Each gets its own PostgreSQL schema, its own migrations, and routes under `/api/plugins/<id>/`.

| Plugin | Adds |
|--------|------|
| `organizations` | Organizations, membership, and org secrets |
| `oauth` | Sign in with GitHub and Google (each on when its credentials are set) |
| `credits` | Credit ledger for paid dispatch |
| `shared-agents` | A marketplace for running evals on other people's eval agents |
| `sample` | A minimal example plugin |

`GET /api/plugins` lists what loaded.

---

## Project Structure

```
Vox/
├── client/              # React frontend
├── server/              # Express backend (routes, storage, auth, migrations)
├── shared/              # Drizzle schema and types shared by client and server
├── plugins/             # Built-in plugins (organizations, credits, shared-agents, sample)
├── packages/            # Plugin SDK
├── vox_eval_agentd/     # Eval agent daemon, plus the auth-session and REST broker images
├── vox_rest_broker/     # REST broker
├── vox_clash_runner/    # Clash match runner
├── migrations/          # SQL migrations
├── docs/                # OpenAPI spec, legal pages
├── tests/               # Vitest suites and Playwright E2E (tests/e2e)
└── scripts/             # Dev, test, and upgrade scripts
```

---

## Tests

```bash
./scripts/dev-local-run.sh start   # integration and E2E tests need the local server running
./scripts/full-tests-run.sh        # the full gate: unit/integration + audio + E2E
./scripts/full-tests-run.sh unit   # or e2e / audio, one part at a time
npm test                           # Vitest only
```

A passing gate means all three parts pass. Run `./scripts/dev-local-run.sh clean-test-data --yes` if leftover test data from earlier runs starts tripping per-user limits.

---

## License

MIT — see [LICENSE](LICENSE).
