#!/bin/bash
#
# Vox Local Development Script
#
# This script sets up a complete local development environment with all services:
# - vox-postgres: PostgreSQL database (always Docker)
# - vox-service: Main Vox web service (listening on 0.0.0.0:5000)
# - vox-eval-agent: Eval agent
#
# Usage:
#   ./script/dev-local-run.sh start        # Local process mode
#   ./script/dev-local-run.sh docker start # Docker mode
#
# Modes:
#   Local (default): vox-service and vox-eval-agent run as local processes
#   Docker:          vox-service and vox-eval-agent run in Docker containers
#
# Commands:
#   start       - Start all services (local process mode)
#   docker start - Start all services (Docker mode)
#   stop        - Stop all services
#   reset       - Reset database and restart all services
#   status      - Show service status
#   build-agent - Build eval agent Docker image
#   logs        - Show logs (server|agent)
#

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DB_CONTAINER="vox-postgres"
SERVICE_CONTAINER="vox-service"
EVAL_AGENT_CONTAINER="vox-eval-agent"
DB_URL="postgresql://vox:vox123@localhost:5432/vox"
SERVER_PORT=5000
# HOST can be set to machine's IP for remote access (e.g., HOST=192.168.1.100)
HOST="${HOST:-localhost}"
SERVER_URL="http://localhost:$SERVER_PORT"
SERVER_URL_DISPLAY="http://${HOST}:$SERVER_PORT"
INIT_CODE="VOX-DEBUG-2024"
EVAL_AGENT_TOKEN_FILE="/tmp/vox-eval-agent-token.txt"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if a command exists
check_command() {
    if ! command -v "$1" &> /dev/null; then
        log_error "$1 is required but not installed."
        exit 1
    fi
}

# Wait for a service to be ready
wait_for_service() {
    local url=$1
    local name=$2
    local max_attempts=${3:-30}
    local attempt=1

    log_info "Waiting for $name to be ready..."

    while [ $attempt -le $max_attempts ]; do
        if curl -s "$url" > /dev/null 2>&1; then
            log_success "$name is ready!"
            return 0
        fi
        echo -n "."
        sleep 1
        attempt=$((attempt + 1))
    done

    echo ""
    log_error "$name failed to start after $max_attempts attempts"
    return 1
}

# ==================== PostgreSQL (always Docker) ====================

start_postgres() {
    log_info "Starting PostgreSQL (Docker)..."

    cd "$PROJECT_DIR"

    # Check if container exists
    if docker ps -a --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
        # Start existing container
        docker start "$DB_CONTAINER" > /dev/null 2>&1 || true
    else
        # Create new container
        docker compose up -d postgres
    fi

    # Wait for PostgreSQL to be ready
    local attempt=1
    while [ $attempt -le 30 ]; do
        if docker exec "$DB_CONTAINER" pg_isready -U vox -d vox > /dev/null 2>&1; then
            log_success "PostgreSQL is ready!"
            return 0
        fi
        echo -n "."
        sleep 1
        attempt=$((attempt + 1))
    done

    echo ""
    log_error "PostgreSQL failed to start"
    return 1
}

stop_postgres() {
    log_info "Stopping PostgreSQL..."
    docker stop "$DB_CONTAINER" > /dev/null 2>&1 || true
    log_success "PostgreSQL stopped"
}

# ==================== Database Operations ====================

push_schema() {
    log_info "Pushing database schema..."
    cd "$PROJECT_DIR"
    DATABASE_URL="$DB_URL" npm run db:push
    log_success "Database schema pushed"
}

seed_data() {
    log_info "Seeding data..."
    cd "$PROJECT_DIR"
    DATABASE_URL="$DB_URL" npx tsx script/seed-data.ts
    log_success "Data seeded"
}

# ==================== Vox Service (Local Process Mode) ====================

start_service_local() {
    log_info "Starting Vox service (local process)..."
    cd "$PROJECT_DIR"

    # Kill any existing process on port 5000
    lsof -ti:$SERVER_PORT | xargs kill -9 2>/dev/null || true

    # Start service in background
    DATABASE_URL="$DB_URL" \
    SESSION_SECRET="local-test-secret-123" \
    INIT_CODE="$INIT_CODE" \
    npm run dev > /tmp/vox-server.log 2>&1 &

    echo $! > /tmp/vox-server.pid

    # Wait for service to be ready
    wait_for_service "$SERVER_URL/api/auth/status" "Vox service"
}

stop_service_local() {
    log_info "Stopping Vox service (local)..."
    if [ -f /tmp/vox-server.pid ]; then
        kill $(cat /tmp/vox-server.pid) 2>/dev/null || true
        rm /tmp/vox-server.pid
    fi
    lsof -ti:$SERVER_PORT | xargs kill -9 2>/dev/null || true
    log_success "Vox service stopped"
}

# ==================== Vox Service (Docker Mode) ====================

start_service_docker() {
    log_info "Starting Vox service (Docker)..."

    # Stop any existing container
    docker stop $SERVICE_CONTAINER 2>/dev/null || true
    docker rm $SERVICE_CONTAINER 2>/dev/null || true

    cd "$PROJECT_DIR"

    # Export env vars for docker-compose (use same session secret as local mode)
    export SESSION_SECRET="local-test-secret-123"
    export INIT_CODE="$INIT_CODE"
    export VOX_TAG="${VOX_TAG:-latest}"

    # Build and run via docker compose
    docker compose up -d --build vox-service

    # Wait for service to be ready
    wait_for_service "$SERVER_URL/api/auth/status" "Vox service" 60

    # Extra wait for session store to be ready
    sleep 2
}

stop_service_docker() {
    log_info "Stopping Vox service (Docker)..."
    docker stop $SERVICE_CONTAINER 2>/dev/null || true
    docker rm $SERVICE_CONTAINER 2>/dev/null || true
    log_success "Vox service stopped"
}

# ==================== System Initialization ====================

init_system() {
    log_info "Initializing system..."

    # Check if already initialized
    local status=$(curl -s "$SERVER_URL/api/auth/status")
    local initialized=$(echo "$status" | grep -o '"initialized":[^,}]*' | cut -d: -f2)

    if [ "$initialized" = "true" ]; then
        log_warn "System already initialized"
        return 0
    fi

    # Initialize system
    local response=$(curl -s -X POST "$SERVER_URL/api/auth/init" \
        -H "Content-Type: application/json" \
        -d "{
            \"code\": \"$INIT_CODE\",
            \"adminEmail\": \"admin@vox.local\",
            \"adminPassword\": \"admin123456\",
            \"adminUsername\": \"Admin\"
        }")

    if echo "$response" | grep -q "error"; then
        log_error "Failed to initialize system: $response"
        return 1
    fi

    log_success "System initialized!"
    echo "  Admin: admin@vox.local / admin123456"
}

# ==================== Auth Helpers ====================

login() {
    local email=$1
    local password=$2

    log_info "Logging in as $email..." >&2

    local cookie_jar="/tmp/vox-cookies-$(echo $email | md5sum | cut -d' ' -f1).txt"

    local response=$(curl -s -c "$cookie_jar" -X POST "$SERVER_URL/api/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\": \"$email\", \"password\": \"$password\"}")

    if echo "$response" | grep -q "error"; then
        log_error "Login failed: $response" >&2
        return 1
    fi

    log_success "Logged in as $email" >&2
    echo "$cookie_jar"
}

create_eval_agent_token() {
    local cookie_jar=$1
    local name=$2
    local region=$3

    log_info "Creating eval agent token: $name ($region)..." >&2

    local response=$(curl -s -b "$cookie_jar" -X POST "$SERVER_URL/api/admin/eval-agent-tokens" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"$name\", \"region\": \"$region\"}")

    local token=$(echo "$response" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

    if [ -z "$token" ]; then
        log_error "Failed to create token: $response" >&2
        return 1
    fi

    log_success "Eval agent token created" >&2
    echo "$token"
}

get_or_create_eval_agent_token() {
    # Check if we have a saved token
    if [ -f "$EVAL_AGENT_TOKEN_FILE" ]; then
        local saved_token=$(cat "$EVAL_AGENT_TOKEN_FILE" | tr -d '\n')
        if [ -n "$saved_token" ]; then
            log_info "Using saved eval agent token" >&2
            echo "$saved_token"
            return 0
        fi
    fi

    # Retry logic for token creation (handles timing issues in Docker mode)
    local max_retries=3
    local retry=0

    while [ $retry -lt $max_retries ]; do
        retry=$((retry + 1))

        # Login as admin
        local admin_cookies=$(login "admin@vox.local" "admin123456")
        if [ -z "$admin_cookies" ]; then
            log_warn "Login attempt $retry failed, retrying..." >&2
            sleep 2
            continue
        fi

        # Create new token
        local token=$(create_eval_agent_token "$admin_cookies" "Local-Eval-Agent" "na")
        if [ -n "$token" ]; then
            # Save token for future use (ensure no newlines)
            echo -n "$token" > "$EVAL_AGENT_TOKEN_FILE"
            echo "$token"
            return 0
        fi

        log_warn "Token creation attempt $retry failed, retrying..." >&2
        sleep 2
    done

    log_error "Failed to create eval agent token after $max_retries attempts"
    return 1
}

# ==================== Eval Agent (Local Process Mode) ====================

start_eval_agent_local() {
    local token=$1
    local name=$2

    log_info "Starting eval agent (local process): $name..."

    cd "$PROJECT_DIR"
    npx tsx script/vox-eval-agent.ts \
        --token "$token" \
        --server "$SERVER_URL" \
        --name "$name" \
        > /tmp/vox-eval-agent.log 2>&1 &

    echo $! > /tmp/vox-eval-agent.pid

    sleep 2

    if [ -f /tmp/vox-eval-agent.pid ] && kill -0 $(cat /tmp/vox-eval-agent.pid) 2>/dev/null; then
        log_success "Eval agent started (PID: $(cat /tmp/vox-eval-agent.pid))"
    else
        log_error "Eval agent failed to start"
        cat /tmp/vox-eval-agent.log
        return 1
    fi
}

stop_eval_agent_local() {
    log_info "Stopping eval agent (local)..."
    if [ -f /tmp/vox-eval-agent.pid ]; then
        kill $(cat /tmp/vox-eval-agent.pid) 2>/dev/null || true
        rm /tmp/vox-eval-agent.pid
    fi
    log_success "Eval agent stopped"
}

# ==================== Eval Agent (Docker Mode) ====================

ensure_eval_agent_image() {
    if ! docker images | grep -q "vox_eval_agentd"; then
        log_info "Eval agent Docker image not found, building..."
        build_eval_agent_docker
    else
        log_info "Eval agent Docker image exists"
    fi
}

build_eval_agent_docker() {
    log_info "Building eval agent Docker image..."
    cd "$PROJECT_DIR"

    # Initialize and update submodules (voice-agent-tester)
    log_info "Initializing submodules..."
    git submodule update --init --recursive

    cd "$PROJECT_DIR/vox_eval_agentd"
    docker build -t vox_eval_agentd .
    log_success "Docker image built: vox_eval_agentd"
}

start_eval_agent_docker() {
    local token=$1
    local name=$2

    log_info "Starting eval agent (Docker): $name..."

    # Stop any existing container
    docker stop $EVAL_AGENT_CONTAINER 2>/dev/null || true
    docker rm $EVAL_AGENT_CONTAINER 2>/dev/null || true

    # Run Docker container with host network access
    docker run -d \
        --name $EVAL_AGENT_CONTAINER \
        --add-host=host.docker.internal:host-gateway \
        -e VOX_TOKEN="$token" \
        -e VOX_SERVER="http://host.docker.internal:$SERVER_PORT" \
        -e VOX_AGENT_NAME="$name" \
        -e HEADLESS=true \
        -v /tmp/vox-eval-output:/app/output \
        vox_eval_agentd

    sleep 5

    if docker ps | grep -q $EVAL_AGENT_CONTAINER; then
        log_success "Eval agent started in Docker container"
    else
        log_error "Eval agent failed to start"
        docker logs $EVAL_AGENT_CONTAINER
        return 1
    fi
}

stop_eval_agent_docker() {
    log_info "Stopping eval agent (Docker)..."
    docker stop $EVAL_AGENT_CONTAINER 2>/dev/null || true
    docker rm $EVAL_AGENT_CONTAINER 2>/dev/null || true
    log_success "Eval agent stopped"
}

# ==================== Status Display ====================

show_status() {
    local mode=${1:-local}

    echo ""
    echo "=== Vox Local Dev Status (${mode} mode) ==="
    echo ""

    # Service Status
    echo -e "${BLUE}Services:${NC}"

    # PostgreSQL (always Docker)
    if docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
        echo -e "  vox-postgres:    ${GREEN}Running${NC} (Docker)"
    else
        echo -e "  vox-postgres:    ${RED}Stopped${NC}"
    fi

    # Vox Service
    if [ "$mode" = "docker" ]; then
        if docker ps --format '{{.Names}}' | grep -q "^${SERVICE_CONTAINER}$"; then
            echo -e "  vox-service:     ${GREEN}Running${NC} (Docker)"
        else
            echo -e "  vox-service:     ${RED}Stopped${NC}"
        fi
    else
        if [ -f /tmp/vox-server.pid ] && kill -0 $(cat /tmp/vox-server.pid) 2>/dev/null; then
            echo -e "  vox-service:     ${GREEN}Running${NC} (PID: $(cat /tmp/vox-server.pid))"
        else
            echo -e "  vox-service:     ${RED}Stopped${NC}"
        fi
    fi

    # Eval Agent
    if [ "$mode" = "docker" ]; then
        if docker ps --format '{{.Names}}' | grep -q "^${EVAL_AGENT_CONTAINER}$"; then
            echo -e "  vox-eval-agent:  ${GREEN}Running${NC} (Docker)"
        else
            echo -e "  vox-eval-agent:  ${RED}Stopped${NC}"
        fi
    else
        if [ -f /tmp/vox-eval-agent.pid ] && kill -0 $(cat /tmp/vox-eval-agent.pid) 2>/dev/null; then
            echo -e "  vox-eval-agent:  ${GREEN}Running${NC} (PID: $(cat /tmp/vox-eval-agent.pid))"
        else
            echo -e "  vox-eval-agent:  ${RED}Stopped${NC}"
        fi
    fi

    # Running Docker containers
    echo ""
    echo -e "${BLUE}Running Docker Containers:${NC}"
    local containers=$(docker ps --format '{{.ID}}\t{{.Names}}\t{{.Status}}' 2>/dev/null | grep -E "(vox|postgres)" || true)
    if [ -n "$containers" ]; then
        echo "  ID            NAME                STATUS"
        echo "$containers" | while read line; do
            echo "  $line"
        done
    else
        echo "  (none)"
    fi

    # URLs and Connection Info
    echo ""
    echo -e "${BLUE}Connection Info:${NC}"
    echo "  Main App URL:  $SERVER_URL_DISPLAY"
    echo "  Database URI:  $DB_URL"

    # Credentials
    echo ""
    echo -e "${BLUE}Credentials:${NC}"
    echo "  Admin: admin@vox.local / admin123456"
    echo "  Scout: scout@vox.ai / scout123"

    # Available APIs
    echo ""
    echo -e "${BLUE}Available APIs:${NC}"
    echo "  Auth:"
    echo "    GET  $SERVER_URL_DISPLAY/api/auth/status        - Check auth status"
    echo "    POST $SERVER_URL_DISPLAY/api/auth/login         - Login"
    echo "    POST $SERVER_URL_DISPLAY/api/auth/logout        - Logout"
    echo "    POST $SERVER_URL_DISPLAY/api/auth/register      - Register new user"
    echo ""
    echo "  Resources:"
    echo "    GET  $SERVER_URL_DISPLAY/api/providers          - List providers"
    echo "    GET  $SERVER_URL_DISPLAY/api/projects           - List projects"
    echo "    GET  $SERVER_URL_DISPLAY/api/workflows          - List workflows"
    echo "    POST $SERVER_URL_DISPLAY/api/workflows          - Create workflow"
    echo "    POST $SERVER_URL_DISPLAY/api/workflows/:id/run  - Run workflow"
    echo "    GET  $SERVER_URL_DISPLAY/api/eval-sets          - List eval sets"
    echo "    GET  $SERVER_URL_DISPLAY/api/eval-agents        - List eval agents"
    echo ""
    echo "  Metrics:"
    echo "    GET  $SERVER_URL_DISPLAY/api/metrics/realtime   - Real-time metrics"
    echo "    GET  $SERVER_URL_DISPLAY/api/metrics/leaderboard - Leaderboard data"
    echo ""
    echo "  Admin (requires admin auth):"
    echo "    GET  $SERVER_URL_DISPLAY/api/admin/users        - List users"
    echo "    GET  $SERVER_URL_DISPLAY/api/admin/eval-agent-tokens - List agent tokens"
    echo "    POST $SERVER_URL_DISPLAY/api/admin/eval-agent-tokens - Create agent token"
    echo ""
}

# ==================== Combined Start/Stop ====================

do_start_local() {
    # 1. Start PostgreSQL (Docker)
    start_postgres

    # 2. Push database schema
    push_schema

    # 3. Start Vox service (local)
    start_service_local

    # 4. Initialize system
    init_system

    # 5. Seed data
    seed_data

    # 6. Get or create eval agent token and start agent (local)
    local agent_token=$(get_or_create_eval_agent_token)
    if [ -n "$agent_token" ]; then
        start_eval_agent_local "$agent_token" "Local-Eval-Agent" || log_warn "Eval agent failed to start, continuing..."
    else
        log_warn "Skipping eval agent startup (no token)"
    fi

    show_status "local"
}

do_start_docker() {
    # 1. Start PostgreSQL (Docker)
    start_postgres

    # 2. Push database schema
    push_schema

    # 3. Start Vox service (Docker)
    start_service_docker

    # 4. Initialize system
    init_system

    # 5. Seed data
    seed_data

    # 6. Ensure eval agent Docker image exists
    ensure_eval_agent_image

    # 7. Get or create eval agent token and start agent (Docker)
    local agent_token=$(get_or_create_eval_agent_token)
    if [ -n "$agent_token" ]; then
        start_eval_agent_docker "$agent_token" "Local-Eval-Agent" || log_warn "Eval agent failed to start, continuing..."
    else
        log_warn "Skipping eval agent startup (no token)"
    fi

    show_status "docker"
}

do_stop() {
    # Stop eval agent (both modes)
    stop_eval_agent_local 2>/dev/null || true
    stop_eval_agent_docker 2>/dev/null || true

    # Stop service (both modes)
    stop_service_local 2>/dev/null || true
    stop_service_docker 2>/dev/null || true

    # Stop PostgreSQL
    stop_postgres
}

do_reset() {
    local mode=${1:-local}

    do_stop

    # Remove database
    docker rm -f "$DB_CONTAINER" 2>/dev/null || true
    docker volume rm vox_vox_postgres_data 2>/dev/null || true
    rm -f "$EVAL_AGENT_TOKEN_FILE"

    # Restart
    if [ "$mode" = "docker" ]; then
        do_start_docker
    else
        do_start_local
    fi
}

# ==================== Main ====================

main() {
    check_command docker
    check_command curl

    case "${1:-}" in
        start)
            check_command npm
            do_start_local
            ;;
        docker)
            case "${2:-}" in
                start)
                    do_start_docker
                    ;;
                stop)
                    do_stop
                    ;;
                reset)
                    do_reset "docker"
                    ;;
                status)
                    show_status "docker"
                    ;;
                *)
                    echo "Usage: $0 docker [start|stop|reset|status]"
                    ;;
            esac
            ;;
        stop)
            do_stop
            ;;
        reset)
            check_command npm
            do_reset "local"
            ;;
        build-agent)
            build_eval_agent_docker
            ;;
        status)
            show_status "local"
            ;;
        logs)
            case "${2:-server}" in
                server)
                    if [ -f /tmp/vox-server.log ]; then
                        tail -f /tmp/vox-server.log
                    else
                        docker logs -f $SERVICE_CONTAINER 2>/dev/null || echo "No logs available"
                    fi
                    ;;
                agent)
                    if [ -f /tmp/vox-eval-agent.log ]; then
                        tail -f /tmp/vox-eval-agent.log
                    else
                        docker logs -f $EVAL_AGENT_CONTAINER 2>/dev/null || echo "No logs available"
                    fi
                    ;;
                *)
                    echo "Usage: $0 logs [server|agent]"
                    ;;
            esac
            ;;
        *)
            echo "Vox Local Development Script"
            echo ""
            echo "Usage: $0 <command>"
            echo ""
            echo "Local Process Mode (vox-service and vox-eval-agent as local processes):"
            echo "  start       - Start all services"
            echo "  stop        - Stop all services"
            echo "  reset       - Reset database and restart"
            echo ""
            echo "Docker Mode (vox-service and vox-eval-agent in Docker):"
            echo "  docker start  - Start all services in Docker"
            echo "  docker stop   - Stop all services"
            echo "  docker reset  - Reset database and restart in Docker"
            echo "  docker status - Show status"
            echo ""
            echo "Common Commands:"
            echo "  status      - Show service status"
            echo "  build-agent - Build eval agent Docker image"
            echo "  logs        - Show logs (server|agent)"
            echo ""
            echo "Environment Variables:"
            echo "  HOST        - Host/IP for display URLs (default: localhost)"
            echo "                Set to machine's IP for remote access:"
            echo "                  HOST=192.168.1.100 $0 start"
            echo ""
            echo "Note: vox-postgres always runs as a standalone Docker container."
            echo "      Server always listens on 0.0.0.0 (all interfaces)."
            echo ""
            ;;
    esac
}

main "$@"
