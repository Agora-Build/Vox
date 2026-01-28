# Launch Local Dev Server

## Recommended Method

Use the `dev-local-run.sh` script to start a complete local development environment:

```bash
# Start all services (PostgreSQL in Docker, Vox service and eval agent as local processes)
./script/dev-local-run.sh start

# Stop all services
./script/dev-local-run.sh stop

# Show status
./script/dev-local-run.sh status
```

The script automatically loads environment from `.env` and `.env.dev` files.

**Default Credentials (after init):**
- Admin: `admin@vox.local` / `admin123456`
- Scout: `scout@vox.ai` / `scout123`

## Environment Files

| Context | Environment Variables | Test Data |
|---------|----------------------|-----------|
| Local Dev | `.env.dev` (gitignored) | `tests/tests.dev.data` (gitignored) |
| CI/CD | CI secrets/environment | CI secrets/environment |

## Testing

After starting the server, run tests:

```bash
npm test
```

## Manual Setup (Alternative)

If you prefer manual setup without Docker:

1. Install and initialize PostgreSQL locally
2. Set environment variables:

```bash
export PORT=5000
export INIT_CODE=VOX-DEBUG-2024
export DATABASE_URL=postgresql://vox:vox@127.0.0.1:5432/vox
export SESSION_SECRET=dev-secret
```

3. Start the server:

```bash
npm run dev
```
