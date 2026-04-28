#!/bin/bash
#
# Upgrade vox-eval-agentd and/or vox-clash-runner containers.
#
# Reads tokens from .env file. If AGENT_TOKEN is set, upgrades vox-eval-agentd.
# If RUNNER_TOKEN is set, upgrades vox-clash-runner. Both can be set.
#
# Before stopping a container, checks the /health endpoint to ensure it's idle.
# If busy, polls every 10s for up to 5 minutes before prompting to force stop.
#
# Usage:
#   ./scripts/vox-upgrade.sh              # uses .env in current directory
#   ./scripts/vox-upgrade.sh /path/.env   # uses specified env file
#

set -euo pipefail

HEALTH_PORT="${HEALTH_PORT:-8099}"
WAIT_TIMEOUT=300  # 5 minutes
POLL_INTERVAL=10

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: env file not found: $ENV_FILE"
    echo "Usage: $0 [path/to/.env]"
    exit 1
fi

# Load env file
set -a
source "$ENV_FILE"
set +a

VOX_SERVER="${VOX_SERVER:-https://vox.agora.build}"
REGISTRY="ghcr.io/agora-build"

declare -A images
declare -A env_configs

if [ -n "${AGENT_TOKEN:-}" ]; then
    images["vox-eval-agentd"]="${REGISTRY}/vox-eval-agentd:latest"
    env_configs["vox-eval-agentd"]="AGENT_TOKEN=${AGENT_TOKEN} VOX_SERVER=${VOX_SERVER}"
    echo "Found AGENT_TOKEN — will upgrade vox-eval-agentd"
fi

if [ -n "${RUNNER_TOKEN:-}" ]; then
    images["vox-clash-runner"]="${REGISTRY}/vox-clash-runner:latest"
    env_configs["vox-clash-runner"]="RUNNER_TOKEN=${RUNNER_TOKEN} VOX_SERVER=${VOX_SERVER}"
    echo "Found RUNNER_TOKEN — will upgrade vox-clash-runner"
fi

if [ ${#images[@]} -eq 0 ]; then
    echo "Error: No AGENT_TOKEN or RUNNER_TOKEN found in $ENV_FILE"
    echo ""
    echo "Expected .env format:"
    echo "  AGENT_TOKEN=ev74a4...    # for vox-eval-agentd"
    echo "  RUNNER_TOKEN=cr8bbd...   # for vox-clash-runner"
    echo "  VOX_SERVER=https://vox.agora.build"
    exit 1
fi

echo "-----------------------------------"

# Wait for container to become idle via /health endpoint
wait_for_idle() {
    local container_id="$1"
    local name="$2"

    # Try to get the mapped health port
    local health_url=""
    local mapped_port=$(docker port "$container_id" "$HEALTH_PORT" 2>/dev/null | head -1 | sed 's/.*://')
    if [ -n "$mapped_port" ]; then
        health_url="http://localhost:${mapped_port}/health"
    else
        # Try direct container IP (works on same host)
        local container_ip=$(docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container_id" 2>/dev/null)
        if [ -n "$container_ip" ]; then
            health_url="http://${container_ip}:${HEALTH_PORT}/health"
        fi
    fi

    if [ -z "$health_url" ]; then
        echo "  No health endpoint available — stopping immediately."
        return 0
    fi

    # Check health
    local status=""
    status=$(curl -s --max-time 3 "$health_url" 2>/dev/null | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4) || true

    if [ "$status" = "idle" ] || [ -z "$status" ]; then
        [ -n "$status" ] && echo "  Status: idle — safe to stop."
        return 0
    fi

    echo "  Status: $status — waiting for idle..."
    local waited=0
    while [ "$waited" -lt "$WAIT_TIMEOUT" ]; do
        sleep "$POLL_INTERVAL"
        waited=$((waited + POLL_INTERVAL))
        status=$(curl -s --max-time 3 "$health_url" 2>/dev/null | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4) || true

        if [ "$status" = "idle" ] || [ -z "$status" ]; then
            echo "  Status: idle after ${waited}s — safe to stop."
            return 0
        fi
        echo "  Still $status... (${waited}s / ${WAIT_TIMEOUT}s)"
    done

    echo "  Timeout: container still $status after ${WAIT_TIMEOUT}s."
    read -p "  Force stop? (y/n): " choice
    case "$choice" in
        y|Y ) return 0 ;;
        * ) return 1 ;;
    esac
}

declare -A new_containers

for name in "${!images[@]}"; do
    image="${images[$name]}"
    echo "Checking $name ($image)..."

    # Find running container BEFORE pulling
    running_id=$(docker ps -q --filter "ancestor=$image" 2>/dev/null || true)

    # Pull latest
    echo "Pulling latest image..."
    docker pull "$image"

    latest_image_id=$(docker image inspect "$image" --format='{{.Id}}')

    if [ -n "$running_id" ]; then
        running_image_id=$(docker inspect --format='{{.Image}}' "$running_id")

        if [ "$running_image_id" == "$latest_image_id" ]; then
            echo "Already running the latest image. Skipping."
            echo "-----------------------------------"
            continue
        else
            echo "New image detected."

            # Wait for idle before stopping
            if ! wait_for_idle "$running_id" "$name"; then
                echo "Skipping $name (user chose not to force stop)."
                echo "-----------------------------------"
                continue
            fi

            echo "Stopping ${running_id:0:12}..."
            docker stop "$running_id" > /dev/null
            docker rm "$running_id" > /dev/null
        fi
    else
        echo "No running container found."
        read -p "Start a new container? (y/n): " choice
        case "$choice" in
            y|Y ) echo "Starting new container..." ;;
            * )
                echo "Skipping $name."
                echo "-----------------------------------"
                continue
                ;;
        esac
    fi

    # Build env args
    env_args=""
    for var in ${env_configs[$name]}; do
        env_args+="-e $var "
    done

    # Pass through optional env vars if set
    [ -n "${LOCAL_DEBUG:-}" ] && env_args+="-e LOCAL_DEBUG=$LOCAL_DEBUG "
    [ -n "${HEADLESS:-}" ] && env_args+="-e HEADLESS=$HEADLESS "
    [ -n "${EVAL_FRAMEWORK:-}" ] && env_args+="-e EVAL_FRAMEWORK=$EVAL_FRAMEWORK "
    [ -n "${VOX_AGENT_NAME:-}" ] && env_args+="-e VOX_AGENT_NAME=$VOX_AGENT_NAME "

    # Expose health port for future upgrades
    new_container_id=$(docker run -d -p "${HEALTH_PORT}:${HEALTH_PORT}" $env_args "$image")
    short_id="${new_container_id:0:12}"
    new_containers[$name]=$short_id
    echo "Started $name: $short_id"
    echo "-----------------------------------"
done

echo ""
echo "Running containers:"
docker container ls --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"
echo ""

for name in "${!new_containers[@]}"; do
    echo "View logs: docker logs -f ${new_containers[$name]}"
done

echo ""
echo "Done."
