#!/bin/bash
#
# Vox Local Testing Script
#
# This script sets up a complete local testing environment:
# 1. Starts PostgreSQL via Docker
# 2. Initializes the database schema
# 3. Starts the main Vox service
# 4. Initializes the system (creates admin/Scout)
# 5. Creates eval agent token and starts eval agent
# 6. Runs evaluation tests
#
# Usage:
#   ./script/local-test.sh [command]
#
# Commands:
#   start     - Start all services
#   stop      - Stop all services
#   reset     - Reset database and restart
#   test      - Run evaluation test
#   status    - Show service status
#

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DB_CONTAINER="vox-postgres"
DB_URL="postgresql://vox:vox123@localhost:5432/vox"
SERVER_PORT=5000
SERVER_URL="http://localhost:$SERVER_PORT"
INIT_CODE="VOX-DEBUG-2024"

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

# Start PostgreSQL
start_postgres() {
    log_info "Starting PostgreSQL..."

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

# Stop PostgreSQL
stop_postgres() {
    log_info "Stopping PostgreSQL..."
    docker stop "$DB_CONTAINER" > /dev/null 2>&1 || true
    log_success "PostgreSQL stopped"
}

# Push database schema
push_schema() {
    log_info "Pushing database schema..."
    cd "$PROJECT_DIR"
    DATABASE_URL="$DB_URL" npm run db:push
    log_success "Database schema pushed"
}

# Seed data
seed_data() {
    log_info "Seeding data..."
    cd "$PROJECT_DIR"
    DATABASE_URL="$DB_URL" npx tsx script/seed-data.ts
    log_success "Data seeded"
}

# Start main service
start_service() {
    log_info "Starting Vox service..."
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

# Stop main service
stop_service() {
    log_info "Stopping Vox service..."
    if [ -f /tmp/vox-server.pid ]; then
        kill $(cat /tmp/vox-server.pid) 2>/dev/null || true
        rm /tmp/vox-server.pid
    fi
    lsof -ti:$SERVER_PORT | xargs kill -9 2>/dev/null || true
    log_success "Vox service stopped"
}

# Initialize system (create admin)
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

# Login and get session cookie
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

# Create eval agent token (requires admin)
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

# Start eval agent
start_eval_agent() {
    local token=$1
    local name=$2

    log_info "Starting eval agent: $name..."

    cd "$PROJECT_DIR"
    npx tsx script/vox-eval-agent.ts --token "$token" --name "$name" --server "$SERVER_URL" > /tmp/vox-eval-agent.log 2>&1 &

    echo $! > /tmp/vox-eval-agent.pid

    sleep 2

    if kill -0 $(cat /tmp/vox-eval-agent.pid) 2>/dev/null; then
        log_success "Eval agent started (PID: $(cat /tmp/vox-eval-agent.pid))"
    else
        log_error "Eval agent failed to start"
        cat /tmp/vox-eval-agent.log
        return 1
    fi
}

# Stop eval agent
stop_eval_agent() {
    log_info "Stopping eval agent..."
    if [ -f /tmp/vox-eval-agent.pid ]; then
        kill $(cat /tmp/vox-eval-agent.pid) 2>/dev/null || true
        rm /tmp/vox-eval-agent.pid
    fi
    # Also stop Docker container if running
    docker stop vox-eval-agent 2>/dev/null || true
    docker rm vox-eval-agent 2>/dev/null || true
    log_success "Eval agent stopped"
}

# Build eval agent Docker image
build_eval_agent_docker() {
    log_info "Building eval agent Docker image..."
    cd "$PROJECT_DIR/vox_eval_agentd"
    docker build -t vox_eval_agentd .
    log_success "Docker image built: vox_eval_agentd"
}

# Start eval agent (Docker mode)
start_eval_agent_docker() {
    local token=$1
    local name=$2

    log_info "Starting eval agent (Docker): $name..."

    # Stop any existing container
    docker stop vox-eval-agent 2>/dev/null || true
    docker rm vox-eval-agent 2>/dev/null || true

    # Get host IP for Docker to access the host network
    # On Linux, we need to add host.docker.internal explicitly
    local host_ip=$(ip route | grep default | awk '{print $3}')

    # Run Docker container with host network access
    docker run -d \
        --name vox-eval-agent \
        --add-host=host.docker.internal:host-gateway \
        -e VOX_TOKEN="$token" \
        -e VOX_SERVER="http://host.docker.internal:$SERVER_PORT" \
        -e VOX_AGENT_NAME="$name" \
        -e HEADLESS=true \
        -v /tmp/vox-eval-output:/app/output \
        vox_eval_agentd

    sleep 5

    if docker ps | grep -q vox-eval-agent; then
        log_success "Eval agent started in Docker container"
    else
        log_error "Eval agent failed to start"
        docker logs vox-eval-agent
        return 1
    fi
}

# Create workflow (as Scout)
create_workflow() {
    local cookie_jar=$1
    local name=$2

    log_info "Creating workflow: $name..." >&2

    local response=$(curl -s -b "$cookie_jar" -X POST "$SERVER_URL/api/workflows" \
        -H "Content-Type: application/json" \
        -d "{
            \"name\": \"$name\",
            \"description\": \"LiveKit Agents evaluation workflow\",
            \"visibility\": \"public\"
        }")

    local id=$(echo "$response" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

    if [ -z "$id" ]; then
        log_error "Failed to create workflow: $response" >&2
        return 1
    fi

    log_success "Workflow created (ID: $id)" >&2
    echo "$id"
}

# Run workflow (create job)
run_workflow() {
    local cookie_jar=$1
    local workflow_id=$2
    local region=$3

    log_info "Running workflow $workflow_id in region $region..." >&2

    local response=$(curl -s -b "$cookie_jar" -X POST "$SERVER_URL/api/workflows/$workflow_id/run" \
        -H "Content-Type: application/json" \
        -d "{\"region\": \"$region\"}")

    local job_id=$(echo "$response" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

    if [ -z "$job_id" ]; then
        log_error "Failed to run workflow: $response" >&2
        return 1
    fi

    log_success "Job created (ID: $job_id)" >&2
    echo "$job_id"
}

# Wait for job to complete
wait_for_job() {
    local cookie_jar=$1
    local job_id=$2
    local max_attempts=${3:-60}
    local attempt=1

    log_info "Waiting for job $job_id to complete..."

    while [ $attempt -le $max_attempts ]; do
        local response=$(curl -s -b "$cookie_jar" "$SERVER_URL/api/v1/jobs/$job_id")
        local status=$(echo "$response" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)

        case "$status" in
            "completed")
                log_success "Job $job_id completed!"
                return 0
                ;;
            "failed")
                log_error "Job $job_id failed!"
                return 1
                ;;
            "running")
                echo -n "R"
                ;;
            "pending")
                echo -n "."
                ;;
        esac

        sleep 2
        attempt=$((attempt + 1))
    done

    echo ""
    log_error "Job timed out"
    return 1
}

# Show status
show_status() {
    echo ""
    echo "=== Vox Local Test Status ==="
    echo ""

    # PostgreSQL
    if docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
        echo -e "PostgreSQL: ${GREEN}Running${NC}"
    else
        echo -e "PostgreSQL: ${RED}Stopped${NC}"
    fi

    # Vox Service
    if [ -f /tmp/vox-server.pid ] && kill -0 $(cat /tmp/vox-server.pid) 2>/dev/null; then
        echo -e "Vox Service: ${GREEN}Running${NC} (PID: $(cat /tmp/vox-server.pid))"
    else
        echo -e "Vox Service: ${RED}Stopped${NC}"
    fi

    # Eval Agent
    if [ -f /tmp/vox-eval-agent.pid ] && kill -0 $(cat /tmp/vox-eval-agent.pid) 2>/dev/null; then
        echo -e "Eval Agent: ${GREEN}Running${NC} (PID: $(cat /tmp/vox-eval-agent.pid))"
    else
        echo -e "Eval Agent: ${RED}Stopped${NC}"
    fi

    echo ""
    echo "URLs:"
    echo "  - Web UI: $SERVER_URL"
    echo "  - API: $SERVER_URL/api"
    echo ""
    echo "Credentials:"
    echo "  - Admin: admin@vox.local / admin123456"
    echo "  - Scout: scout@vox.ai / scout123"
    echo ""
}

# Full test flow (simulation mode)
run_full_test() {
    log_info "Starting full local test (simulation mode)..."
    echo ""

    # 1. Start PostgreSQL
    start_postgres

    # 2. Push schema
    push_schema

    # 3. Start service
    start_service

    # 4. Initialize system
    init_system

    # 5. Seed data (creates Scout user)
    seed_data

    # 6. Login as admin
    local admin_cookies=$(login "admin@vox.local" "admin123456")

    # 7. Create eval agent token for NA region
    local agent_token=$(create_eval_agent_token "$admin_cookies" "NA-Test-Agent" "na")
    log_info "Agent token: $agent_token"

    # 8. Start eval agent (simulation)
    start_eval_agent "$agent_token" "NA-Test-Agent"

    # 9. Login as Scout
    local scout_cookies=$(login "scout@vox.ai" "scout123")

    # 10. Create LiveKit workflow
    local workflow_id=$(create_workflow "$scout_cookies" "LiveKit Agents Test")

    # 11. Run workflow in NA region
    local job_id=$(run_workflow "$scout_cookies" "$workflow_id" "na")

    # 12. Wait for job to complete
    wait_for_job "$scout_cookies" "$job_id"

    echo ""
    log_success "Full test completed!"
    echo ""
    show_status
}

# Full test flow with Docker eval agent (real browser tests)
run_docker_test() {
    log_info "Starting full local test (Docker mode with real browser)..."
    echo ""

    # 1. Build Docker image first
    build_eval_agent_docker

    # 2. Start PostgreSQL
    start_postgres

    # 3. Push schema
    push_schema

    # 4. Start service
    start_service

    # 5. Initialize system
    init_system

    # 6. Seed data (creates Scout user)
    seed_data

    # 7. Login as admin
    local admin_cookies=$(login "admin@vox.local" "admin123456")

    # 8. Create eval agent token for NA region
    local agent_token=$(create_eval_agent_token "$admin_cookies" "NA-Test-Agent" "na")
    log_info "Agent token: $agent_token"

    # 9. Start eval agent (Docker mode)
    start_eval_agent_docker "$agent_token" "NA-Test-Agent"

    # 10. Login as Scout
    local scout_cookies=$(login "scout@vox.ai" "scout123")

    # 11. Create LiveKit workflow
    local workflow_id=$(create_workflow "$scout_cookies" "LiveKit Agents Test")

    # 12. Run workflow in NA region
    local job_id=$(run_workflow "$scout_cookies" "$workflow_id" "na")

    # 13. Wait for job to complete (longer timeout for real tests)
    wait_for_job "$scout_cookies" "$job_id" 180

    echo ""
    echo "=== Docker Agent Logs ==="
    docker logs vox-eval-agent 2>&1 | tail -50
    echo ""

    log_success "Docker test completed!"
    echo ""
    show_status
}

# Main
main() {
    check_command docker
    check_command curl
    check_command npm

    case "${1:-}" in
        start)
            start_postgres
            push_schema
            start_service
            init_system
            seed_data
            show_status
            ;;
        stop)
            stop_eval_agent
            stop_service
            stop_postgres
            ;;
        reset)
            stop_eval_agent
            stop_service
            docker rm -f "$DB_CONTAINER" 2>/dev/null || true
            docker volume rm vox_vox_postgres_data 2>/dev/null || true
            start_postgres
            push_schema
            start_service
            init_system
            seed_data
            show_status
            ;;
        test)
            run_full_test
            ;;
        docker-test)
            run_docker_test
            ;;
        build-agent)
            build_eval_agent_docker
            ;;
        status)
            show_status
            ;;
        logs)
            case "${2:-server}" in
                server)
                    tail -f /tmp/vox-server.log
                    ;;
                agent)
                    tail -f /tmp/vox-eval-agent.log
                    ;;
                docker)
                    docker logs -f vox-eval-agent
                    ;;
            esac
            ;;
        *)
            echo "Vox Local Testing Script"
            echo ""
            echo "Usage: $0 <command>"
            echo ""
            echo "Commands:"
            echo "  start       - Start all services (PostgreSQL, Vox)"
            echo "  stop        - Stop all services"
            echo "  reset       - Reset database and restart"
            echo "  test        - Run full evaluation test (simulation mode)"
            echo "  docker-test - Run full evaluation test (Docker mode with real browser)"
            echo "  build-agent - Build eval agent Docker image"
            echo "  status      - Show service status"
            echo "  logs        - Show logs (server|agent|docker)"
            echo ""
            ;;
    esac
}

main "$@"
