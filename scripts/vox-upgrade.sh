#!/usr/bin/env bash
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

# Can this user drive Docker at all? Otherwise `docker ps` fails silently below
# (its errors are discarded), the script reports "No running container found",
# and only fails later at `docker pull` — say it plainly, before touching anything.
if ! docker_err=$(docker info 2>&1 >/dev/null); then
    if echo "$docker_err" | grep -qi "permission denied"; then
        echo "Error: no permission to use Docker as user '$(id -un)'."
        echo "       Add the user to the docker group (sudo usermod -aG docker $(id -un), then log out"
        echo "       and back in), or run this with sudo — but if this agent uses DialF, run it as the"
        echo "       user running dialfd, or set DIALF_SOCKET in .env (sudo can't see that user's socket)."
    else
        echo "Error: can't reach the Docker daemon: $(echo "$docker_err" | head -1)"
    fi
    exit 1
fi

# DialF's control socket on this host, or nothing. Honors DIALF_SOCKET, then
# looks where dialfd puts it for the invoking user — including under sudo,
# where `id -u` is 0 but dialfd runs as the user who ran sudo (SUDO_UID).
detect_dialf_socket() {
    if [ -n "${DIALF_SOCKET:-}" ]; then
        [ -S "$DIALF_SOCKET" ] && echo "$DIALF_SOCKET"
        return 0
    fi
    local uid cand
    for uid in $(id -u) ${SUDO_UID:-}; do
        for cand in "${XDG_RUNTIME_DIR:-/run/user/$uid}/dialfd.sock" "/run/user/$uid/dialfd.sock" "/tmp/dialfd-$uid.sock"; do
            [ -S "$cand" ] && echo "$cand" && return 0
        done
    done
    [ -S /run/dialf/dialfd.sock ] && echo /run/dialf/dialfd.sock
    return 0
}

# When no socket was found but dialfd IS running: why — most often it runs as
# another user, whose runtime dir this user can't read (no permission).
# Prints nothing when dialfd isn't running (every host without DialF).
dialf_not_found_reason() {
    local owner_uid owner me
    # By UID: `ps -o user=` truncates names longer than 8 characters
    # ("longuse+"), which would read as a different user.
    owner_uid=$(ps -o uid= -C dialfd 2>/dev/null | head -1 | tr -d ' ' || true)
    [ -z "$owner_uid" ] && return 0
    owner=$( (getent passwd "$owner_uid" 2>/dev/null || true) | cut -d: -f1)
    [ -z "$owner" ] && owner="uid $owner_uid"
    me=$(id -un)
    if [ "$owner_uid" != "$(id -u)" ]; then
        echo "dialfd is running as '$owner', but this script runs as '$me' and has no permission to see"
        echo "its socket. Run this as '$owner' (not with sudo), or set DIALF_SOCKET=/path/to/dialfd.sock in .env."
    else
        echo "dialfd is running, but its socket isn't in the usual places — set DIALF_SOCKET in .env to"
        echo "its control_socket (see ~/.config/dialf/config.yaml)."
    fi
}

# After starting the agent with DialF mounted: what its own DialF check says
# (the view that matters — a mounted socket can still be unusable, e.g. no
# permission inside the container). The daemon logs it once at start.
report_dialf_check() {
    # $2 (optional): only logs since this time — after a restart the container
    # still has its pre-restart log, whose DialF line is the stale answer.
    local name="$1" since="${2:-}" line="" i
    local since_args=()
    [ -n "$since" ] && since_args=(--since "$since")
    for i in $(seq 1 "${DIALF_CHECK_TRIES:-10}"); do
        line=$(docker logs ${since_args[@]+"${since_args[@]}"} "$name" 2>&1 | grep -m1 "DialF probe:" || true)
        [ -n "$line" ] && break
        sleep 2
    done
    if [ -z "$line" ]; then
        echo "NOTE: the agent hasn't reported its DialF check yet — see: docker logs $name 2>&1 | grep 'DialF probe'"
    elif echo "$line" | grep -q "DialF probe: ok"; then
        echo "DialF check inside the container: OK — this agent takes phone jobs."
    else
        echo "WARNING: DialF check inside the container FAILED: ${line#*DialF probe: }"
        echo "         This agent won't take phone jobs until it passes."
    fi
}

# The host's network link type for VOX_LINK_TYPE (design "Detection" → link):
# the daemon's own detectLinkType (vox_eval_agentd/link-type.ts), reimplemented
# here in bash because a container sees its own veth, not the host's NIC — the
# host must detect and pass its answer in. Same precedence as the daemon: a
# VOX_LINK_TYPE already in the environment (set in .env, or a test override —
# this doubles as the test hook: it's the least invasive way to make this
# deterministic in tests/vox-upgrade-dialf.test.ts without real network
# access) wins outright and skips detection. An invalid value there is
# ignored, same as the daemon: falls through to real autodetection below
# rather than being forwarded as-is. Echoes one of
# wifi/ethernet/cellular/satellite, or nothing on any failure — never aborts
# the run (every call is `|| true`-guarded, as elsewhere in this script,
# because of `set -euo pipefail`).
host_link_type() {
    case "${VOX_LINK_TYPE:-}" in
        wifi|ethernet|cellular|satellite) echo "$VOX_LINK_TYPE"; return 0 ;;
    esac
    local os iface driver
    os=$(uname -s 2>/dev/null || true)
    if [ "$os" = "Linux" ]; then
        iface=$( { ip route get 1.1.1.1 2>/dev/null || true; } | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
        [ -z "$iface" ] && return 0
        if [ -e "/sys/class/net/$iface/wireless" ]; then
            echo wifi; return 0
        fi
        case "$iface" in
            wwan*) echo cellular; return 0 ;;
        esac
        driver=""
        if [ -L "/sys/class/net/$iface/device/driver" ]; then
            driver=$(basename "$(readlink "/sys/class/net/$iface/device/driver" 2>/dev/null || true)")
        fi
        case "$driver" in
            qmi_wwan|cdc_mbim|cdc_ether) echo cellular; return 0 ;;
        esac
        echo ethernet
    elif [ "$os" = "Darwin" ]; then
        iface=$( { route -n get default 2>/dev/null || true; } | sed -n 's/^ *interface: //p' | head -1)
        [ -z "$iface" ] && return 0
        if { networksetup -listallhardwareports 2>/dev/null || true; } | grep -B1 "^Device: $iface\$" | grep -q "^Hardware Port: Wi-Fi$"; then
            echo wifi; return 0
        fi
        echo ethernet
    fi
    return 0
}

# The DialF socket a running container was started with (its VOX_DIALF_SOCKET), or nothing.
container_dialf_socket() {
    # `|| true`: under set -euo pipefail a failed inspect (container gone
    # mid-run) would otherwise abort the whole upgrade.
    { docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true; } | sed -n 's/^VOX_DIALF_SOCKET=//p' | head -1
}

# Inode of a path on this host / inside a container ("" if unknown). A file
# bind mount pins the inode at container start: if dialfd restarts and
# recreates its socket at the same path, the container keeps the dead one —
# same path, different inode.
host_inode() { stat -c %i "$1" 2>/dev/null || true; }
container_inode() { docker exec "$1" stat -c %i "$2" 2>/dev/null || true; }

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

    # Phone vs Agent: is dialfd here, and did the running container have it?
    host_dialf_socket=""
    prev_dialf_socket=""
    if [ "$name" = "vox-eval-agentd" ]; then
        host_dialf_socket=$(detect_dialf_socket)
        [ -n "$running_id" ] && prev_dialf_socket=$(container_dialf_socket "$running_id")
    fi
    # The running container lacks the DialF mount this host now offers (e.g.
    # dialfd wasn't running at the last upgrade): recreate it even on the same
    # image — a mount can't be added to an existing container, and without it
    # the agent never reports the phone capability, so phone jobs wait forever.
    dialf_missing_in_container=""
    if [ -n "$host_dialf_socket" ] && [ "$prev_dialf_socket" != "$host_dialf_socket" ]; then
        dialf_missing_in_container=1
    fi
    # Same path, but is it still dialfd's CURRENT socket inside the container?
    # (dialfd restarted since the container started → the mount is a dead
    # socket, the DialF check fails, and the agent stops reporting phone.)
    dialf_stale_in_container=""
    if [ -n "$host_dialf_socket" ] && [ "$prev_dialf_socket" = "$host_dialf_socket" ] && [ -n "$running_id" ]; then
        h_ino=$(host_inode "$host_dialf_socket")
        c_ino=$(container_inode "$running_id" "$host_dialf_socket")
        if [ -n "$h_ino" ] && [ -n "$c_ino" ] && [ "$h_ino" != "$c_ino" ]; then
            dialf_stale_in_container=1
        fi
    fi

    # The old container had DialF and this host no longer offers it: ask
    # BEFORE anything is stopped. Replacing it would silently drop the phone
    # capability — the agent keeps heartbeating, but every phone job then waits
    # for nobody (what happened to a phone host after an upgrade, 2026-10).
    running_image_id=""
    [ -n "$running_id" ] && running_image_id=$(docker inspect --format='{{.Image}}' "$running_id" 2>/dev/null || true)
    if [ -n "$prev_dialf_socket" ] && [ -z "$host_dialf_socket" ] && [ "$running_image_id" == "$latest_image_id" ]; then
        # Not replacing (same image), but say it: the running container's socket
        # is gone too, so it isn't taking phone jobs either.
        echo "WARNING: the running container was started with DialF ($prev_dialf_socket), but that"
        echo "         socket is gone — it can't take phone jobs. Start dialfd (with the same socket"
        echo "         path, or set DIALF_SOCKET) and re-run this, or restart the container."
    elif [ -n "$prev_dialf_socket" ] && [ -z "$host_dialf_socket" ]; then
        echo "WARNING: the running container was started with DialF ($prev_dialf_socket),"
        echo "         but no dialfd socket is found now — a new container WON'T take phone jobs."
        reason=$(dialf_not_found_reason)
        if [ -n "$reason" ]; then echo "$reason" | sed 's/^/         /'
        else echo "         Is dialfd running? Start it, or set DIALF_SOCKET=/path/to/dialfd.sock in .env."; fi
        # No terminal (cron, `ssh host ... < /dev/null`): EOF means "no" — the
        # safe answer — instead of set -e ending the whole run here.
        read -p "         Replace it anyway, without DialF? (y/n): " choice || choice=n
        case "$choice" in
            y|Y ) ;;
            * ) echo "Leaving the running $name as it is. Start dialfd (or set DIALF_SOCKET), then re-run."
                echo "-----------------------------------"
                continue ;;
        esac
    fi

    if [ -n "$running_id" ]; then
        if [ "$running_image_id" == "$latest_image_id" ] && [ -n "$dialf_missing_in_container" ]; then
            echo "Already on the latest image, but DialF is on this host ($host_dialf_socket) and the"
            echo "running container wasn't started with it — recreating it so it can take phone jobs."
            if ! wait_for_idle "$running_id"; then
                echo "Skipping $name (user chose not to force stop)."
                echo "-----------------------------------"
                continue
            fi
            echo "Stopping ${running_id:0:12}..."
            docker stop "$running_id" > /dev/null
            docker rm "$running_id" > /dev/null
        elif [ "$running_image_id" == "$latest_image_id" ] && [ -n "$dialf_stale_in_container" ]; then
            # A restart re-mounts the host path, picking up dialfd's current
            # socket; no new container needed.
            echo "Already on the latest image, but its DialF socket is stale: dialfd recreated"
            echo "$host_dialf_socket since the container started. Restarting it to pick up the new one."
            if ! wait_for_idle "$running_id"; then
                echo "Skipping $name (user chose not to force stop)."
            else
                # Unix seconds: unambiguous. A bare UTC datetime would be read as
                # the client's LOCAL time, shifting the window by the TZ offset.
                restarted_at=$(date +%s)
                docker restart "$running_id" > /dev/null
                echo "Restarted ${running_id:0:12}."
                report_dialf_check "$running_id" "$restarted_at"
            fi
            echo "-----------------------------------"
            continue
        elif [ "$running_image_id" == "$latest_image_id" ]; then
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
    # The daemon warns and falls back to aeval on an unsupported value, so
    # forwarding a stale one only produces a confusing log line every start.
    # Drop it here instead, with the same warning; aeval is the default.
    if [ -n "${EVAL_FRAMEWORK:-}" ]; then
        if [ "$EVAL_FRAMEWORK" = "aeval" ]; then
            env_args+="-e EVAL_FRAMEWORK=$EVAL_FRAMEWORK "
        else
            echo "WARNING: EVAL_FRAMEWORK='$EVAL_FRAMEWORK' is not supported (voice-agent-tester was"
            echo "         removed; aeval is the only framework) — ignoring it and using aeval."
            echo "         Remove the line from your .env to silence this."
        fi
    fi
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
    mount_args=""
    dialf_detected=""
    if [ "$name" = "vox-eval-agentd" ]; then
        # Persistent model cache (whisper/HF/VAD downloads) across container
        # upgrades — without it, the first analyze after every upgrade re-pays
        # the model download on top of CPU transcription.
        mount_args+="-v vox-aeval-cache:/root/.cache "
        if [ -d /dev/snd ]; then
            device_args="--device /dev/snd --security-opt systempaths=unconfined"
        fi

        # Network tags (design "Detection" → link): pass the HOST's own link
        # type in, since the container only sees its own veth. Not needed for
        # vox-clash-runner — it doesn't report network tags.
        link_type=$(host_link_type)
        [ -n "$link_type" ] && env_args+="-e VOX_LINK_TYPE=$link_type "

        # ------------------------------------------------------------------
        # DialF bridge (Phone vs Agent): dialfd runs on the HOST; the daemon
        # runs in this container. Auto-detect the control socket and bind-mount
        # it plus an exchange dir (identical path on both sides) so audio.play
        # files staged by the daemon are readable by dialfd, and dialfd's
        # recordings are readable by the daemon. .env config (all optional):
        #   DIALF_SOCKET=/path/to/dialfd.sock   # skip auto-detection
        #   DIALF_EXCHANGE_DIR=/path/dir        # default: $HOME/vox-phone-exchange
        # Caveat: the socket is bind-mounted as a FILE — if dialfd restarts and
        # recreates it, restart this container (or re-run the upgrade). For a
        # restart-proof setup, set `control_socket` in ~/.config/dialf/config.yaml
        # to a path INSIDE the exchange dir and set DIALF_SOCKET to match.
        # ------------------------------------------------------------------
        dialf_socket="$host_dialf_socket"
        if [ -n "$dialf_socket" ] && [ -S "$dialf_socket" ]; then
            dialf_detected=1
            exchange_dir="${DIALF_EXCHANGE_DIR:-$HOME/vox-phone-exchange}"
            mkdir -p "$exchange_dir/corpus" "$exchange_dir/recordings"
            mount_args="-v $dialf_socket:$dialf_socket -v $exchange_dir:$exchange_dir"
            env_args+="-e VOX_DIALF_SOCKET=$dialf_socket -e VOX_DIALF_EXCHANGE_DIR=$exchange_dir "
            echo "DialF detected: socket $dialf_socket mounted; exchange dir $exchange_dir"
            echo "  -> recordings are routed into the exchange automatically (per-run"
            echo "     record_dir; requires dialfd >= 0.3.16 — run 'dialf --version' to check)."
        elif [ -n "$prev_dialf_socket" ]; then
            echo "WARNING: continuing WITHOUT DialF — this agent won't take phone jobs until dialfd is"
            echo "         found and this is re-run."
        elif [ -n "${DIALF_SOCKET:-}" ]; then
            echo "WARNING: DIALF_SOCKET=$DIALF_SOCKET is set, but nothing is listening there — is dialfd"
            echo "         running? This agent won't take phone jobs until it is; then re-run this."
        else
            reason=$(dialf_not_found_reason)
            if [ -n "$reason" ]; then
                echo "WARNING: DialF not detected — this agent won't take phone jobs."
                echo "$reason" | sed 's/^/         /'
            else
                echo "DialF not detected: this agent won't take Phone vs Agent jobs (fine if it only runs"
                echo "web evals). To enable them, start dialfd with a phone connected and re-run this, or set"
                echo "DIALF_SOCKET=/path/to/dialfd.sock in .env."
            fi
        fi

        if ! grep -q VirtualAudio /proc/asound/cards 2>/dev/null; then
            if [ -n "$dialf_detected" ]; then
                echo "NOTE: no VirtualAudio ALSA card — WEB (browser) eval jobs would fail on this"
                echo "      host, but DialF was detected: Phone vs Agent jobs are unaffected."
                echo "      Ignore this if the agent only runs phone evals; otherwise see the"
                echo "      snd-aloop setup in this script's header."
            else
                echo "WARNING: no VirtualAudio ALSA card on this host — aeval jobs WILL FAIL."
                echo "         One-time setup (see header of this script):"
                echo "           sudo modprobe snd-aloop id=VirtualAudio pcm_substreams=1"
                echo "           echo snd-aloop | sudo tee /etc/modules-load.d/vox-virtual-audio.conf"
                echo "           echo 'options snd-aloop id=VirtualAudio pcm_substreams=1' | sudo tee /etc/modprobe.d/vox-virtual-audio.conf"
                echo "         Then re-run this upgrade (or restart the container)."
            fi
        fi
    fi

    # Expose health port for future upgrades; --restart so it survives reboots;
    # --name gives it a stable identity independent of the (movable) image tag,
    # so future upgrades always find it and it never shows as a bare image ID.
    new_container_id=$(docker run -d --name "$name" --restart "$RESTART_POLICY" -p "${HEALTH_PORT}:${HEALTH_PORT}" $device_args $mount_args $env_args "$image")
    short_id="${new_container_id:0:12}"
    new_containers[$name]=$short_id
    echo "Started $name: $short_id"
    [ "$name" = "vox-eval-agentd" ] && [ -n "$dialf_detected" ] && report_dialf_check "$name"

    # Post-start audio check, from INSIDE the container — the view that
    # matters. The host having the card proves nothing about the container:
    # a masked /proc/asound (missing systempaths=unconfined) or a missing
    # --device passes every host-side check and still fails every aeval job.
    if [ "$name" = "vox-eval-agentd" ] && grep -q VirtualAudio /proc/asound/cards 2>/dev/null; then
        sleep 2
        if docker exec "$name" grep -q VirtualAudio /proc/asound/cards 2>/dev/null; then
            echo "Audio check: VirtualAudio visible inside the container — OK"
        else
            echo "WARNING: VirtualAudio is NOT visible INSIDE the container — aeval jobs WILL FAIL."
            echo "         The host has the card, so this is a container-config problem:"
            echo "         the run needs BOTH --device /dev/snd and --security-opt systempaths=unconfined."
            echo "         (Are you running an old copy of this script? Re-download it — see header.)"
        fi
    fi
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
