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
# Containers are started with `--restart unless-stopped` so they relaunch
# automatically after a host reboot (override with RESTART_POLICY=...). A
# container already on the latest image is updated in place to the same policy.
# Note: this only works if the Docker daemon itself starts on boot
# (`sudo systemctl enable docker`); the script warns if it isn't.
#
# HOST REQUIREMENT (vox-eval-agentd, aeval >=0.4): evals record/play through a
# virtual ALSA soundcard. One-time host setup (a container cannot modprobe):
#   sudo modprobe snd-aloop id=VirtualAudio pcm_substreams=1
#   echo snd-aloop | sudo tee /etc/modules-load.d/vox-virtual-audio.conf
#   echo 'options snd-aloop id=VirtualAudio pcm_substreams=1' | sudo tee /etc/modprobe.d/vox-virtual-audio.conf
# The script passes --device /dev/snd AND --security-opt systempaths=unconfined
# to vox-eval-agentd (not clash-runner — its PipeWire graph is self-contained)
# and warns if the card is missing. The security opt is load-bearing: Docker
# masks /proc/asound by default and aeval reads it to resolve the card.
#
# Get this script on a server (public repo, no auth needed):
#   curl -fsSL -o vox-upgrade.sh \
#     https://raw.githubusercontent.com/Agora-Build/Vox/main/scripts/vox-upgrade.sh
#   chmod +x vox-upgrade.sh
#
# Usage:
#   ./vox-upgrade.sh              # uses .env in current directory
#   ./vox-upgrade.sh /path/.env   # uses specified env file
#

set -euo pipefail

HEALTH_PORT="${HEALTH_PORT:-8099}"
WAIT_TIMEOUT=300  # 5 minutes
POLL_INTERVAL=10

# Docker restart policy so containers auto-launch after a host reboot.
# "unless-stopped" survives reboots but respects a manual `docker stop`.
RESTART_POLICY="${RESTART_POLICY:-unless-stopped}"

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

    # Find the managed container BEFORE pulling. The pull re-points the :latest
    # tag to the new image, after which `ancestor=<tag>` no longer matches a
    # container started from the OLD image (and `docker ps` then shows that
    # container's image as a bare sha256 ID instead of the tag). So prefer the
    # stable --name; fall back to ancestor for containers started by older
    # versions of this script that had no name.
    running_id=$(docker ps -q --filter "name=^/${name}$" 2>/dev/null | head -1 || true)
    if [ -z "$running_id" ]; then
        running_id=$(docker ps -q --filter "ancestor=$image" 2>/dev/null | head -1 || true)
    fi

    echo "Pulling latest image..."
    docker pull "$image"

    latest_image_id=$(docker image inspect "$image" --format='{{.Id}}')

    if [ -n "$running_id" ]; then
        running_image_id=$(docker inspect --format='{{.Image}}' "$running_id")

        if [ "$running_image_id" == "$latest_image_id" ]; then
            echo "Already running the latest image. Skipping upgrade."
            # Still ensure it auto-starts after a host reboot, even though we
            # aren't recreating it (docker update applies without a restart).
            current_policy=$(docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' "$running_id" 2>/dev/null || true)
            if [ "$current_policy" != "$RESTART_POLICY" ]; then
                echo "Applying restart policy '$RESTART_POLICY' (was '${current_policy:-none}')..."
                docker update --restart "$RESTART_POLICY" "$running_id" > /dev/null
            fi
            echo "-----------------------------------"
            continue
        else
            echo "New image detected."

            if ! wait_for_idle "$running_id"; then
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

    # Clear any leftover container holding the stable name (e.g. a stopped one
    # from a prior run) so `docker run --name` can't fail with a name conflict.
    docker rm -f "$name" > /dev/null 2>&1 || true

    # vox-eval-agentd needs the host's virtual soundcard (aeval >=0.4): pass
    # /dev/snd through and warn if the snd-aloop card isn't loaded yet.
    # systempaths=unconfined is required alongside the device: Docker masks
    # /proc/asound by default, and aeval resolves the card ID by reading it —
    # with the mask in place every job fails with SOUNDCARD_DEVICE_NOT_FOUND
    # ("No ALSA card has the ID 'VirtualAudio'") even though /dev/snd is
    # present and aplay works (alsa-utils resolve via /dev/snd ioctls instead).
    device_args=""
    if [ "$name" = "vox-eval-agentd" ]; then
        if [ -d /dev/snd ]; then
            device_args="--device /dev/snd --security-opt systempaths=unconfined"
        fi
        if ! grep -q VirtualAudio /proc/asound/cards 2>/dev/null; then
            echo "WARNING: no VirtualAudio ALSA card on this host — aeval jobs WILL FAIL."
            echo "         One-time setup (see header of this script):"
            echo "           sudo modprobe snd-aloop id=VirtualAudio pcm_substreams=1"
            echo "           echo snd-aloop | sudo tee /etc/modules-load.d/vox-virtual-audio.conf"
            echo "           echo 'options snd-aloop id=VirtualAudio pcm_substreams=1' | sudo tee /etc/modprobe.d/vox-virtual-audio.conf"
            echo "         Then re-run this upgrade (or restart the container)."
        fi
    fi

    # Expose health port for future upgrades; --restart so it survives reboots;
    # --name gives it a stable identity independent of the (movable) image tag,
    # so future upgrades always find it and it never shows as a bare image ID.
    new_container_id=$(docker run -d --name "$name" --restart "$RESTART_POLICY" -p "${HEALTH_PORT}:${HEALTH_PORT}" $device_args $env_args "$image")
    short_id="${new_container_id:0:12}"
    new_containers[$name]=$short_id
    echo "Started $name: $short_id"
    echo "-----------------------------------"
done

echo ""
echo "Running containers:"
docker container ls --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"
echo ""

# A restart policy only helps if the Docker daemon itself starts on boot.
echo "Auto-restart: containers use '--restart $RESTART_POLICY' (relaunch after a host reboot)."
if command -v systemctl > /dev/null 2>&1; then
    if ! systemctl is-enabled docker > /dev/null 2>&1; then
        echo "WARNING: the Docker service is NOT enabled at boot — containers will stay down"
        echo "         after a reboot until Docker starts. Enable it once with:"
        echo "           sudo systemctl enable docker"
    fi
fi
echo ""

for name in "${!new_containers[@]}"; do
    echo "View logs: docker logs -f ${new_containers[$name]}"
done

echo ""
echo "Done."
