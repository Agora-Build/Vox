#!/bin/bash

# Full Test Runner for Vox
# Runs all tests (unit, integration, E2E) with proper environment setup
#
# Usage:
#   ./script/full-tests-run.sh           # Run all tests
#   ./script/full-tests-run.sh unit      # Run only unit/integration tests
#   ./script/full-tests-run.sh e2e       # Run only E2E tests
#   ./script/full-tests-run.sh --help    # Show help

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# =============================================================================
# Test Credentials & Accounts
# =============================================================================
# These are loaded from .env.dev and tests/tests.dev.data
#
# Environment Variables (from .env.dev):
#   GOOGLE_CLIENT_ID     - Google OAuth client ID
#   GOOGLE_CLIENT_SECRET - Google OAuth client secret
#   STRIPE_PUBLISHABLE_KEY - Stripe test publishable key (pk_test_*)
#   STRIPE_SECRET_KEY    - Stripe test secret key (sk_test_*)
#
# Test Accounts (created by dev-local-run.sh init):
#   Admin: admin@vox.local / admin123456
#   Scout: scout@vox.ai / scout123
#
# Google OAuth Test Account (for manual OAuth flow testing):
#   Email: john.ag.81192@gmail.com
#   Password: pOKfCDLVSRGH&09
# =============================================================================

show_help() {
    cat << EOF
Vox Full Test Runner

Usage: $0 [command] [options]

Commands:
  (none)    Run all tests (unit + E2E)
  unit      Run only unit/integration tests (Vitest)
  e2e       Run only E2E tests (Playwright)
  help      Show this help message

Options:
  --no-server    Skip server check (assume server is already running)
  --verbose      Show detailed output

Environment:
  Tests require the following environment variables (loaded from .env.dev):
  - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
  - STRIPE_PUBLISHABLE_KEY / STRIPE_SECRET_KEY

Test Accounts:
  - Admin: admin@vox.local / admin123456
  - Scout: scout@vox.ai / scout123

Examples:
  $0                  # Run all tests
  $0 unit             # Run only Vitest tests
  $0 e2e              # Run only Playwright tests
  $0 e2e --verbose    # Run E2E tests with detailed output

EOF
}

# Load environment variables
load_env() {
    local env_file="$1"
    if [ -f "$env_file" ]; then
        set -a
        source "$env_file"
        set +a
        return 0
    fi
    return 1
}

# Check if server is running
check_server() {
    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -s "http://localhost:5000/api/auth/status" > /dev/null 2>&1; then
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    return 1
}

# Verify environment
verify_env() {
    local missing=0

    if [ -z "$GOOGLE_CLIENT_ID" ]; then
        log_warn "GOOGLE_CLIENT_ID not set (Google OAuth tests may be skipped)"
    fi

    if [ -z "$STRIPE_SECRET_KEY" ]; then
        log_warn "STRIPE_SECRET_KEY not set (Stripe tests may fail)"
    fi

    # Check if using test keys
    if [[ "$STRIPE_SECRET_KEY" == sk_test_* ]]; then
        log_info "Using Stripe test keys (test mode enabled)"
    elif [[ -n "$STRIPE_SECRET_KEY" ]]; then
        log_warn "Using Stripe live keys - be careful!"
    fi
}

# Run unit/integration tests
run_unit_tests() {
    log_info "Running unit/integration tests (Vitest)..."
    cd "$PROJECT_DIR"

    if npm test; then
        log_success "Unit/integration tests passed!"
        return 0
    else
        log_error "Unit/integration tests failed!"
        return 1
    fi
}

# Run E2E tests
run_e2e_tests() {
    local verbose=""
    if [ "$1" = "--verbose" ]; then
        verbose="--reporter=list"
    fi

    log_info "Running E2E tests (Playwright)..."
    cd "$PROJECT_DIR"

    # Check if Playwright browsers are installed
    if ! npx playwright --version > /dev/null 2>&1; then
        log_info "Installing Playwright browsers..."
        npx playwright install chromium
    fi

    if npx playwright test $verbose; then
        log_success "E2E tests passed!"
        return 0
    else
        log_error "E2E tests failed!"
        return 1
    fi
}

# Main
main() {
    local command="${1:-all}"
    local skip_server=false
    local verbose=""

    # Parse arguments
    for arg in "$@"; do
        case $arg in
            --no-server)
                skip_server=true
                ;;
            --verbose)
                verbose="--verbose"
                ;;
            --help|help)
                show_help
                exit 0
                ;;
        esac
    done

    echo ""
    echo "========================================"
    echo "     Vox Full Test Runner"
    echo "========================================"
    echo ""

    # Load environment
    log_info "Loading environment..."
    cd "$PROJECT_DIR"

    if load_env "$PROJECT_DIR/.env"; then
        log_info "Loaded .env"
    fi

    if load_env "$PROJECT_DIR/.env.dev"; then
        log_info "Loaded .env.dev"
    fi

    # Copy .env.dev to .env if .env doesn't exist or is empty
    if [ ! -s "$PROJECT_DIR/.env" ] && [ -f "$PROJECT_DIR/.env.dev" ]; then
        log_info "Copying .env.dev to .env..."
        cp "$PROJECT_DIR/.env.dev" "$PROJECT_DIR/.env"
    fi

    verify_env

    # Check server
    if [ "$skip_server" = false ]; then
        log_info "Checking if server is running..."
        if ! check_server; then
            log_error "Server not running on http://localhost:5000"
            log_info "Start the server with: ./script/dev-local-run.sh start"
            exit 1
        fi
        log_success "Server is running"
    fi

    echo ""
    log_info "Test Accounts:"
    echo "  Admin: admin@vox.local / admin123456"
    echo "  Scout: scout@vox.ai / scout123"
    echo ""

    # Run tests based on command
    local unit_result=0
    local e2e_result=0

    case "$command" in
        unit)
            run_unit_tests || unit_result=$?
            ;;
        e2e)
            run_e2e_tests $verbose || e2e_result=$?
            ;;
        all|*)
            run_unit_tests || unit_result=$?
            echo ""
            run_e2e_tests $verbose || e2e_result=$?
            ;;
    esac

    # Summary
    echo ""
    echo "========================================"
    echo "     Test Summary"
    echo "========================================"

    if [ "$command" = "unit" ] || [ "$command" = "all" ]; then
        if [ $unit_result -eq 0 ]; then
            echo -e "  Unit/Integration: ${GREEN}PASSED${NC}"
        else
            echo -e "  Unit/Integration: ${RED}FAILED${NC}"
        fi
    fi

    if [ "$command" = "e2e" ] || [ "$command" = "all" ]; then
        if [ $e2e_result -eq 0 ]; then
            echo -e "  E2E (Playwright):  ${GREEN}PASSED${NC}"
        else
            echo -e "  E2E (Playwright):  ${RED}FAILED${NC}"
        fi
    fi

    echo "========================================"
    echo ""

    # Exit with failure if any tests failed
    if [ $unit_result -ne 0 ] || [ $e2e_result -ne 0 ]; then
        exit 1
    fi

    log_success "All tests passed!"
}

main "$@"
