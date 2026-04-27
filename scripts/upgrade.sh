#!/bin/bash
#
# Upgrade vox-eval-agentd and/or vox-clash-runner containers.
#
# Reads tokens from .env file. If AGENT_TOKEN is set, upgrades vox-eval-agentd.
# If RUNNER_TOKEN is set, upgrades vox-clash-runner. Both can be set.
#
# Usage:
#   ./scripts/upgrade.sh              # uses .env in current directory
#   ./scripts/upgrade.sh /path/.env   # uses specified env file
#

set -euo pipefail

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
            echo "New image detected. Stopping old container $running_id..."
            docker stop "$running_id"
            docker rm "$running_id"
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

    new_container_id=$(docker run -d $env_args "$image")
    new_containers[$name]=$new_container_id
    echo "Started $name: $new_container_id"
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
