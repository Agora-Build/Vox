# Vox - AI Latency Evaluation Platform

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
Test from North America, Europe, and Asia-Pacific to understand regional performance characteristics.

### Real-Time Dashboard
Live data dashboard showing the latest metrics and performance trends as tests complete.

### Global Leaderboard
Compare provider performance across regions with sortable rankings and detailed metrics.

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
| Custom Products | User-defined | convoai/rtc |

---

## Tech Stack

### Frontend
- **React 19** with TypeScript
- **Vite** for development and production builds
- **Tailwind CSS** with shadcn/ui component library
- **Wouter** for lightweight client-side routing
- **TanStack React Query** for server state management
- **Recharts** for data visualization

### Backend
- **Node.js** with Express
- **TypeScript** with ESM modules
- **Drizzle ORM** with PostgreSQL
- **Passport.js** for OAuth (Google)
- **express-rate-limit** for API protection

---

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL database

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/guohai/vox.git
   cd vox
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**

   For local development, create a `.env.dev` file:
   ```bash
   # .env.dev - Local development (gitignored)
   DATABASE_URL=postgresql://user:password@localhost:5432/vox
   SESSION_SECRET=your-session-secret
   INIT_CODE=your-initialization-code

   # Optional - Google OAuth
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   ```

   For CI/CD, environment variables are loaded from CI secrets (no files needed).

4. **Push database schema**
   ```bash
   npm run db:push
   ```

5. **Start development server**
   ```bash
   npm run dev
   ```

The application will be available at `http://localhost:5000`.

### First-Time Setup

1. Navigate to `/setup` to initialize the system
2. Enter your `INIT_CODE` to create the admin user
3. The system will also create a Scout user (needs activation via email token)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Session encryption key |
| `INIT_CODE` | Yes | System initialization code |
| `PORT` | No | Server port (default: 5000) |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret |
| `GOOGLE_CALLBACK_URL` | No | OAuth callback URL (default: /api/auth/google/callback) |

### Environment & Test Data Files

| Context | Environment Variables | Test Data |
|---------|----------------------|-----------|
| Local Dev | `.env.dev` (file, gitignored) | `tests/tests.dev.data` (file, gitignored) |
| CI/CD | CI secrets/environment | CI secrets/environment |

**Local Development:**
- `.env.dev` - Environment variables (DATABASE_URL, GOOGLE_*, STRIPE_*, etc.)
- `tests/tests.dev.data` - Test accounts and credentials for manual testing

**CI/CD:**
- No files needed - environment variables loaded from CI secrets
- Test data injected via CI environment

The `dev-local-run.sh` script automatically loads `.env` and `.env.dev` files.

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm start` | Start production server |
| `npm run check` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm run db:push` | Push database schema changes |
| `npm test` | Run unit/integration tests (requires running server) |
| `./script/full-tests-run.sh` | Run all tests (unit + E2E) |

---

## API Documentation

### Authentication

All authenticated API endpoints accept either:
- **Session authentication** - Cookie-based sessions from web login
- **API Key authentication** - Bearer token with `vox_live_` prefix

```bash
# API Key usage
curl -H "Authorization: Bearer vox_live_xxxxxxxxxxxx" \
  https://your-domain.com/api/v1/workflows
```

### API v1 Endpoints

#### User
| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/v1/user` | Required | Get current user info |

#### Workflows
| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/v1/workflows` | Required | List user's workflows |
| `POST /api/v1/workflows` | Required | Create workflow |
| `GET /api/v1/workflows/:id` | Required | Get workflow details |
| `PUT /api/v1/workflows/:id` | Required | Update workflow |
| `DELETE /api/v1/workflows/:id` | Required | Delete workflow |
| `POST /api/v1/workflows/:id/run` | Required | Run workflow (create job) |

#### Eval Sets
| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/v1/eval-sets` | Required | List user's eval sets |
| `POST /api/v1/eval-sets` | Required | Create eval set |
| `GET /api/v1/eval-sets/:id` | Required | Get eval set details |

#### Jobs
| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/v1/jobs` | Required | List user's jobs |
| `GET /api/v1/jobs/:id` | Required | Get job status |
| `DELETE /api/v1/jobs/:id` | Required | Cancel pending job |

#### Results
| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/v1/results` | Required | List user's results |
| `GET /api/v1/results/:id` | Required | Get result details |

#### Projects
| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/v1/projects` | Required | List user's projects |
| `POST /api/v1/projects` | Required | Create project |

#### Public Endpoints
| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/v1/metrics/realtime` | None | Real-time metrics |
| `GET /api/v1/metrics/leaderboard` | None | Leaderboard data |
| `GET /api/v1/providers` | None | List all providers |

---

## User Plans

| Plan | Features |
|------|----------|
| **Basic** | 5 projects, 10 workflows each, public only |
| **Premium** | 20 projects, 20 workflows each, private allowed |
| **Principal** | Scout internal users, can mark mainline |
| **Fellow** | External prestige, can mark mainline |

### Organization Limits
- 100 projects max
- 20 workflows per project
- Max 4 org admins
- Volume seat pricing (10-25% discounts)

---

## Project Structure

```
vox/
├── client/                 # Frontend React application
│   ├── src/
│   │   ├── components/     # Reusable UI components
│   │   ├── hooks/          # Custom React hooks
│   │   ├── lib/            # Utilities and helpers
│   │   └── pages/          # Page components
│   └── public/             # Static assets
├── server/                 # Backend Express server
│   ├── index.ts            # Server entry point
│   ├── routes.ts           # Main API routes
│   ├── routes-api-v1.ts    # Versioned public API routes
│   ├── storage.ts          # Data access layer
│   ├── auth.ts             # Authentication utilities
│   ├── pricing.ts          # Seat pricing calculations
│   └── stripe.ts           # Stripe integration (optional)
├── shared/                 # Shared code between client/server
│   └── schema.ts           # Database schema definitions
├── tests/                  # Test files
│   ├── api.test.ts         # API integration tests
│   └── tests.dev.data      # Local dev test accounts (gitignored)
├── designs/                # Design documents
└── script/                 # Build scripts
```

---

## Console Pages

### User Console (`/console`)
- `/console/projects` - Manage projects
- `/console/workflows` - Manage workflows
- `/console/eval-sets` - Manage eval sets
- `/console/eval-agents` - View eval agents
- `/console/eval-agent-tokens` - Manage agent tokens (admin)
- `/console/organization` - Organization dashboard
- `/console/organization/members` - Member management
- `/console/organization/billing` - Billing and seats
- `/console/organization/settings` - Organization settings

### Admin Console (`/admin/console`)
- User management
- Organization verification
- Fund return requests
- System configuration

---

## Eval Agent System

Distributed eval agents run evaluation tests across regions:

1. Admin creates eval agent tokens with region assignments
2. Agents register using tokens and heartbeat regularly
3. Agents claim pending jobs atomically (no race conditions)
4. Results reported back with detailed metrics

Background worker handles:
- Stale job detection and release (5 minute threshold)
- Offline agent marking
- Job retry logic

---

## License

This project is licensed under the MIT License.
