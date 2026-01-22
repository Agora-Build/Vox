# Vox - AI Latency Evaluation

## Overview

Vox is a web application for evaluating and tracking performance metrics of conversational AI products. It provides real-time monitoring dashboards, global leaderboards, and self-testing capabilities to measure response latency, interrupt latency, network resilience, naturalness, and noise reduction across multiple AI providers and regions.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript
- **Routing**: Wouter for lightweight client-side routing
- **Styling**: Tailwind CSS with shadcn/ui component library (New York style)
- **State Management**: TanStack React Query for server state and data fetching
- **Build Tool**: Vite for development and production builds

The frontend follows a page-based structure with reusable UI components. Pages include:
- **Home**: Landing page with overview
- **Real-time Dashboard**: Live performance metrics
- **Leaderboard**: Global rankings by provider/region
- **Provider Guide**: Information about AI providers
- **Self-Test**: User-initiated evaluations
- **Login**: Authentication page
- **Console**: Management dashboard with sidebar navigation
  - `/console` - User Management (admin only, redirects non-admins to workflows)
  - `/console/workflows` - Test Workflows management (all authenticated users)
  - `/console/test-sets` - Test Sets management (all authenticated users)
- **Activate**: Account activation page for setting passwords via activation links

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript with ESM modules
- **Development**: tsx for TypeScript execution during development
- **Authentication**: Session-based with express-session and PostgreSQL session store (connect-pg-simple)

The server uses a modular structure with:
- `server/index.ts`: Express app initialization, session middleware, and server setup
- `server/routes.ts`: API route registration (prefixed with `/api`)
- `server/auth.ts`: Authentication helpers (password hashing, session management, middleware)
- `server/storage.ts`: Data access layer with PostgreSQL implementation
- `server/vite.ts`: Vite dev server integration for development
- `server/static.ts`: Static file serving for production

### Authentication & Authorization

**User Plans**:
- **Basic**: Default plan, can only create public content
- **Premium**: Can create private workflows and test sets
- **Principal**: Full mainline curation rights (can mark content as mainline)

**User Roles**:
- **Admin**: Can manage users, invite new users, enable/disable accounts, assign roles
- **Regular User**: Access based on plan level

**Special Users**:
- **Scout**: The platform's principal agent created during initialization. Scout has principal plan and is used for mainline content curation.

**Initialization Flow**:
1. Navigate to `/console` when system is not initialized
2. Enter initialization code (dev: `VOX-DEBUG-2024`, prod: from `INIT_CODE` env var)
3. Create admin account with email/username/password
4. Scout is automatically created as principal agent
5. System is marked as initialized

### Data Storage
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Schema**: Defined in `shared/schema.ts` using Drizzle's table definitions
- **Validation**: Zod schemas generated from Drizzle schemas via `drizzle-zod`
- **Session Store**: PostgreSQL via connect-pg-simple (table: `user_sessions`)

**Database Tables**:
- `users`: User accounts with plan, admin status, enabled status
- `email_verification_tokens`: Email verification for new accounts
- `invite_tokens`: Admin-created invitations for new users
- `activation_tokens`: Admin-generated links for users to set passwords and activate accounts
- `workflows`: Test workflows with visibility (public/private) and mainline flag
- `test_sets`: Test configurations with visibility and mainline flag
- `eval_results`: Performance measurements with optional workflow/test set references
- `system_config`: Key-value system configuration (including initialization status)

### API Routes

**Authentication**:
- `GET /api/auth/status`: Check if system is initialized and get current user
- `POST /api/auth/init`: Initialize system (first-time setup)
- `POST /api/auth/login`: Authenticate user
- `POST /api/auth/logout`: End session
- `POST /api/auth/register`: Register with invite token

**Admin** (requires admin role):
- `GET /api/admin/users`: List all users
- `PATCH /api/admin/users/:id`: Update user (enable/disable, role, plan)
- `POST /api/admin/invite`: Create invite token
- `POST /api/admin/users/:id/activation-link`: Generate activation link for user

**Activation** (public):
- `GET /api/auth/activation/:token`: Verify activation token validity
- `POST /api/auth/activate`: Set password and activate account

**Workflows** (requires auth):
- `GET /api/workflows`: List accessible workflows
- `POST /api/workflows`: Create workflow
- `PATCH /api/workflows/:id/mainline`: Toggle mainline status (principal only)

**Test Sets** (requires auth):
- `GET /api/test-sets`: List accessible test sets
- `POST /api/test-sets`: Create test set
- `PATCH /api/test-sets/:id/mainline`: Toggle mainline status (principal only)

**Metrics** (public):
- `GET /api/metrics/realtime`: Recent evaluation results
- `GET /api/metrics/leaderboard`: Aggregated provider rankings
- `GET /api/config`: System configuration

### Build Process
- Client: Vite builds to `dist/public`
- Server: esbuild bundles to `dist/index.cjs` with selective dependency bundling for cold start optimization

## Environment Variables

- `DATABASE_URL`: PostgreSQL connection string (required)
- `SESSION_SECRET`: Secret for signing sessions (defaults to dev secret if not set)
- `INIT_CODE`: Initialization code for first-time setup (required in production)
- `NODE_ENV`: Environment mode (development/production)

## External Dependencies

### Database
- **PostgreSQL**: Configured via `DATABASE_URL` environment variable
- **Drizzle Kit**: Database migrations stored in `./migrations` directory

### Authentication
- **bcryptjs**: Password hashing
- **express-session**: Session management
- **connect-pg-simple**: PostgreSQL session store

### UI Components
- **Radix UI**: Comprehensive set of accessible, unstyled primitives
- **Recharts**: Charting library for data visualization
- **Lucide React**: Icon library
- **cmdk**: Command menu component
- **embla-carousel-react**: Carousel component
- **date-fns**: Date utility library

### Development Tools
- **Replit Plugins**: 
  - `@replit/vite-plugin-runtime-error-modal`: Error overlay
  - `@replit/vite-plugin-cartographer`: Development tooling
  - `@replit/vite-plugin-dev-banner`: Development banner

### Fonts
- Google Fonts: Inter (sans-serif) and JetBrains Mono (monospace)
