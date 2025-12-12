# Vox - AI Latency Benchmark

## Overview

Vox is a web application for benchmarking and tracking performance metrics of conversational AI products. It provides real-time monitoring dashboards, global leaderboards, and self-testing capabilities to measure response latency, interrupt latency, network resilience, naturalness, and noise reduction across multiple AI providers and regions.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React with TypeScript
- **Routing**: Wouter for lightweight client-side routing
- **Styling**: Tailwind CSS with shadcn/ui component library (New York style)
- **State Management**: TanStack React Query for server state and data fetching
- **Build Tool**: Vite for development and production builds

The frontend follows a page-based structure with reusable UI components. Pages include Home, Real-time Dashboard, Leaderboard, Provider Guide, and Self-Test. The UI uses a consistent dark theme with a grid pattern background and responsive design for mobile support.

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript with ESM modules
- **Development**: tsx for TypeScript execution during development

The server uses a modular structure with:
- `server/index.ts`: Express app initialization and middleware setup
- `server/routes.ts`: API route registration (prefixed with `/api`)
- `server/storage.ts`: Data access layer with in-memory storage implementation
- `server/vite.ts`: Vite dev server integration for development
- `server/static.ts`: Static file serving for production

### Data Storage
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Schema**: Defined in `shared/schema.ts` using Drizzle's table definitions
- **Validation**: Zod schemas generated from Drizzle schemas via `drizzle-zod`
- **Current Storage**: In-memory storage implementation (`MemStorage` class) that can be swapped for database storage

The schema currently includes a users table with id, username, and password fields. The storage interface (`IStorage`) defines CRUD operations that can be implemented by different storage backends.

### Build Process
- Client: Vite builds to `dist/public`
- Server: esbuild bundles to `dist/index.cjs` with selective dependency bundling for cold start optimization

## External Dependencies

### Database
- **PostgreSQL**: Configured via `DATABASE_URL` environment variable
- **Drizzle Kit**: Database migrations stored in `./migrations` directory

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