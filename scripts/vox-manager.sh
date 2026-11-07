#!/usr/bin/env bash
# vox-manager-script: 1
#
# Install, upgrade or roll back vox-eval-agentd and/or vox-clash-runner containers.
#
# EVAL_TOKEN selects vox-eval-agentd; CLASH_TOKEN selects vox-clash-runner.
#
# Busy/unknown health requires confirmation after 5 minutes; --force bypasses it.
# VOX_INSTANCE_DISABLED=true skips container management, even with --force.
# Run with --help for commands and options.
#
# HOST REQUIREMENT (vox-eval-agentd, aeval >=0.4): evals record/play through a
# virtual ALSA soundcard. One-time host setup (a container cannot modprobe):
#   sudo modprobe snd-aloop id=VirtualAudio pcm_substreams=1
#   echo snd-aloop | sudo tee /etc/modules-load.d/vox-virtual-audio.conf
#   echo 'options snd-aloop id=VirtualAudio pcm_substreams=1' | sudo tee /etc/modprobe.d/vox-virtual-audio.conf
# Get this script on a server (public repo, no auth needed):
#   curl -fsSL -o vox-manager.sh \
#     https://raw.githubusercontent.com/Agora-Build/Vox/main/scripts/vox-manager.sh
#   chmod +x vox-manager.sh

set -euo pipefail
# Keep tokens in shell variables, not host helper environments, even under bash -a.
set +a
export -n EVAL_TOKEN CLASH_TOKEN AGENT_TOKEN RUNNER_TOKEN

usage() {
    echo "Usage: $0 [vox_agent] [--env path/to/.env] [--force]"
    echo "       $0 self"
    echo "       $0 vox"
    echo ""
    echo "  vox_agent  Install, upgrade or roll back agent/runner containers (default command)."
    echo "  --env      Env file to load (default: .env in the current working directory)."
    echo "  --force    Skip health waits and confirm install/replacement; may interrupt evals or remove DialF support."
    echo "  self       Update this script from the official Vox main branch; no Docker or .env needed."
    echo "  vox        Vox server installation/upgrade is not supported yet."
    echo "  No arguments installs/upgrades vox_agent using .env in the current directory."
    echo "  EVAL_TOKEN selects eval; CLASH_TOKEN selects Clash. Missing/empty tokens leave that service untouched."
    echo "  EVAL_VERSION / CLASH_VERSION select each service's image tag or sha256 manifest digest (default: latest)."
    echo "  A positional env-file path is still accepted for compatibility."
    echo "  Maintenance: VOX_INSTANCE_DISABLED=true in the env file skips all container operations, even with --force."
}

print_env_sample() {
    printf '%s\n' \
        'Sample .env (placeholders only; no file is created):' \
        '# Omit or leave a token empty to leave that service untouched.' \
        'EVAL_TOKEN=your-eval-agent-token' \
        'EVAL_VERSION=latest' \
        'CLASH_TOKEN=your-clash-runner-token' \
        'CLASH_VERSION=latest' \
        'VOX_SERVER=https://vox.agora.build' \
        'VOX_INSTANCE_DISABLED=false' \
        'RESTART_POLICY=unless-stopped' \
        'HEALTH_PORT=8099' \
        '' \
        'Use KEY=value assignments; quote values containing spaces. Keep .env private (chmod 600 .env).'
}

env_config_error() {
    echo "Error: $1" >&2
    print_env_sample >&2
    exit 1
}

print_manual_download_instructions() {
    printf '%s\n' \
        'Manual download (saves vox-manager.sh in the current directory):' \
        "  curl -fsSL --proto '=https' --proto-redir '=https' \\" \
        '    -o vox-manager.sh \' \
        '    https://raw.githubusercontent.com/Agora-Build/Vox/main/scripts/vox-manager.sh' \
        '  chmod +x vox-manager.sh' \
        ''
}

self_update() (
    print_manual_download_instructions
    script_path="${BASH_SOURCE[0]}"
    if [ -L "$script_path" ]; then
        echo "Error: self-update through a symlink is not supported; run the real script path." >&2
        exit 1
    fi
    script_dir=$(cd -- "$(dirname -- "$script_path")" && pwd -P)
    script_path="$script_dir/$(basename -- "$script_path")"
    if [ ! -f "$script_path" ] || [ ! -w "$script_path" ] || [ ! -w "$script_dir" ]; then
        echo "Error: self-update requires a writable script file and directory: $script_path" >&2
        exit 1
    fi

    update_tmp=$(mktemp "$script_dir/.vox-manager-update.XXXXXX")
    trap 'rm -f -- "$update_tmp"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    # Keep the installed permissions; stage beside the target for an atomic rename.
    cp -p -- "$script_path" "$update_tmp"
    echo "Downloading the latest Vox management script..."
    if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --connect-timeout 10 --max-time 120 --output "$update_tmp" \
        https://raw.githubusercontent.com/Agora-Build/Vox/main/scripts/vox-manager.sh; then
        echo "Error: download failed; the installed script is unchanged." >&2
        exit 1
    fi
    if [ "$(head -n 1 "$update_tmp")" != '#!/usr/bin/env bash' ] || \
        ! grep -qxF '# vox-manager-script: 1' "$update_tmp" || ! bash -n "$update_tmp"; then
        echo "Error: downloaded file is not a valid Vox management script; the installed script is unchanged." >&2
        exit 1
    fi
    if cmp -s -- "$script_path" "$update_tmp"; then
        echo "Already running the latest script: $script_path"
        exit 0
    fi
    mv -f -- "$update_tmp" "$script_path"
    echo "Updated script: $script_path"
    echo "No containers were changed. Run '$0 vox_agent' to install or upgrade agents."
)

case "${1:-}" in
    -h|--help|help)
        usage
        print_manual_download_instructions
        exit 0
        ;;
    self)
        if [ "$#" -ne 1 ]; then usage >&2; exit 2; fi
        self_update
        exit 0
        ;;
    vox)
        echo "Error: Vox server installation/upgrade ('vox') is not supported yet." >&2
        exit 2
        ;;
    vox_agent)
        shift
        ;;
    ""|-*) ;;
    *)
        # Preserve the original positional env-file invocation, not unknown commands.
        if [ ! -f "$1" ] && [[ "$1" != */* && "$1" != .env* ]]; then
            echo "Error: unknown command: $1" >&2
            usage >&2
            exit 2
        fi
        ;;
esac

manager_env_file=""
manager_force=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --force)
            if [ -n "$manager_force" ]; then
                echo "Error: --force may only be specified once." >&2
                usage >&2; exit 2
            fi
            manager_force=1
            shift
            ;;
        --version|--version=*)
            echo "Error: --version is not supported; set EVAL_VERSION and CLASH_VERSION in the env file." >&2
            usage >&2; exit 2 ;;
        --env|--env=*)
            if [ -n "$manager_env_file" ]; then
                echo "Error: env file may only be specified once (use --env or a positional path)." >&2
                usage >&2; exit 2
            fi
            if [ "$1" = --env ]; then
                if [ "$#" -lt 2 ]; then
                    echo "Error: --env requires a file path." >&2
                    usage >&2; exit 2
                fi
                manager_env_file="$2"
                shift 2
            else
                manager_env_file="${1#--env=}"
                shift
            fi
            if [ -z "$manager_env_file" ] || [[ "$manager_env_file" = -* ]]; then
                echo "Error: --env requires a file path (prefix paths starting with '-' with './')." >&2
                usage >&2; exit 2
            fi
            ;;
        -h|--help) usage; print_manual_download_instructions; exit 0 ;;
        -*) echo "Error: unknown option: $1" >&2; usage >&2; exit 2 ;;
        *)
            if [ -n "$manager_env_file" ] || [ -z "$1" ]; then
                echo "Error: env file may only be specified once (use --env or a positional path)." >&2
                usage >&2; exit 2
            fi
            manager_env_file="$1"
            shift
            ;;
    esac
done
readonly manager_env_file manager_force

WAIT_TIMEOUT=300  # 5 minutes
POLL_INTERVAL=10
readonly WAIT_TIMEOUT POLL_INTERVAL

ENV_FILE="${manager_env_file:-.env}"

if [ ! -f "$ENV_FILE" ]; then
    env_config_error "env file not found: $ENV_FILE"
fi

# Explicit relative paths keep Bash from searching PATH for an env file.
if [[ "$ENV_FILE" != */* ]]; then ENV_FILE="./$ENV_FILE"; fi
readonly ENV_FILE

if ! bash -n -- "$ENV_FILE" 2>/dev/null; then
    env_config_error "invalid env-file syntax; expected KEY=value assignments."
fi
# Preserve a diagnostic stream if sourcing fails while its output is suppressed.
exec {manager_config_error_fd}>&2
trap 'env_config_error "cannot load env file; use KEY=value assignments without overriding reserved CLI settings." >&"$manager_config_error_fd" 2>&1' EXIT
source "$ENV_FILE" >/dev/null 2>&1
set +a
export -n EVAL_TOKEN CLASH_TOKEN AGENT_TOKEN RUNNER_TOKEN
trap - EXIT
exec {manager_config_error_fd}>&-

case "${VOX_INSTANCE_DISABLED:-false}" in
    true|1)
        echo "VOX_INSTANCE_DISABLED=true: skipping all container operations, including --force."
        exit 0
        ;;
    false|0) ;;
    *) env_config_error "VOX_INSTANCE_DISABLED must be true, false, 1 or 0. No containers were changed." ;;
esac

if [ -z "${EVAL_TOKEN:-}${CLASH_TOKEN:-}" ]; then
    echo "No EVAL_TOKEN or CLASH_TOKEN configured; nothing to manage."
    if [ -n "${AGENT_TOKEN:-}${RUNNER_TOKEN:-}" ]; then
        echo "Manager input names changed: use EVAL_TOKEN instead of AGENT_TOKEN, and CLASH_TOKEN instead of RUNNER_TOKEN."
    fi
    print_env_sample
    exit 0
fi

for token_name in EVAL_TOKEN CLASH_TOKEN; do
    if [[ "${!token_name:-}" = *$'\n'* || "${!token_name:-}" = *$'\r'* ]]; then
        env_config_error "$token_name must not contain line breaks. No containers were changed."
    fi
done

# Validate before any Docker operation, including same-image policy updates.
RESTART_POLICY="${RESTART_POLICY:-unless-stopped}"
if [[ ! "$RESTART_POLICY" =~ ^(no|always|unless-stopped|on-failure(:[0-9]+)?)$ ]]; then
    env_config_error "RESTART_POLICY must be no, always, unless-stopped, or on-failure[:N]. No containers were changed."
fi
if [[ "$RESTART_POLICY" = on-failure:* ]]; then
    restart_retries="${RESTART_POLICY#on-failure:}"
    restart_retries="${restart_retries#"${restart_retries%%[!0]*}"}"
    restart_retries="${restart_retries:-0}"
    if [ "${#restart_retries}" -gt 19 ] ||
        { [ "${#restart_retries}" -eq 19 ] && [[ "$restart_retries" > 9223372036854775807 ]]; }; then
        env_config_error "RESTART_POLICY retry count exceeds Docker's integer limit. No containers were changed."
    fi
    RESTART_POLICY="on-failure:$restart_retries"
fi

HEALTH_PORT="${HEALTH_PORT:-8099}"
if [[ ! "$HEALTH_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$HEALTH_PORT" -gt 65535 ]; then
    env_config_error "HEALTH_PORT must be an integer from 1 to 65535."
fi

VOX_SERVER="${VOX_SERVER:-https://vox.agora.build}"
REGISTRY="ghcr.io/agora-build"
declare -A images=()
declare -A image_versions=()
for name in vox-eval-agentd vox-clash-runner; do
    if [ "$name" = vox-eval-agentd ]; then token_name=EVAL_TOKEN; version_name=EVAL_VERSION
    else token_name=CLASH_TOKEN; version_name=CLASH_VERSION; fi
    [ -n "${!token_name:-}" ] || continue
    selected_version="${!version_name:-latest}"
    if [[ ! "$selected_version" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ &&
          ! "$selected_version" =~ ^sha256:[a-f0-9]{64}$ ]]; then
        env_config_error "$version_name must be a Docker image tag or sha256 manifest digest, not a full image URL. No containers were changed."
    fi
    image_versions[$name]="$selected_version"
    image_separator=:
    [[ "$selected_version" = sha256:* ]] && image_separator=@
    images[$name]="${REGISTRY}/${name}${image_separator}${selected_version}"
    echo "Found $token_name - will install/upgrade $name"
done

echo "-----------------------------------"

# Old containers may have a different internal health port from the new config.
container_health_url() {
    local container_id="$1" container_port mapped_port container_ip
    container_port=$({ docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" 2>/dev/null || true; } | sed -n 's/^HEALTH_PORT=//p' | head -1)
    container_port="${container_port:-8099}"
    [[ "$container_port" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$container_port" -le 65535 ] || return 1
    mapped_port=$(docker port "$container_id" "$container_port/tcp" 2>/dev/null | head -1 | sed 's/.*://') || true
    if [[ "$mapped_port" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$mapped_port" -le 65535 ]; then
        echo "http://127.0.0.1:${mapped_port}/health"
    else
        container_ip=$(docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container_id" 2>/dev/null) || true
        [ -n "$container_ip" ] || return 1
        echo "http://${container_ip}:${container_port}/health"
    fi
}

# Validate the complete flat JSON health object without a new host dependency.
# Nested/duplicate fields or a failed HTTP request are unknown, never idle.
health_status() {
    local response body key value status=""
    response=$(curl --fail --silent --show-error --noproxy '*' --max-time 3 --write-out '\n%{http_code}' "$1" 2>/dev/null) || return 1
    [ "${response##*$'\n'}" = 200 ] || return 1
    body="${response%$'\n'*}"
    local space=$'[ \t\r\n]'
    local string='"([^"\\[:cntrl:]]|\\(["\\/bfnrt]|u[[:xdigit:]]{4}))*"'
    local number='-?(0|[1-9][0-9]*)([.][0-9]+)?([eE][+-]?[0-9]+)?'
    local field="^${space}*\"([A-Za-z_][A-Za-z0-9_]*)\"${space}*:${space}*($string|$number|true|false|null)"
    local opening="^${space}*\\{" closing="^${space}*\\}${space}*$" comma="^${space}*,"
    local -A seen=()
    [[ "$body" =~ $opening ]] || return 1
    body="${body:${#BASH_REMATCH[0]}}"
    while [[ "$body" =~ $field ]]; do
        key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
        body="${body:${#BASH_REMATCH[0]}}"
        [ -z "${seen[$key]:-}" ] || return 1
        seen[$key]=1
        if [ "$key" = status ]; then
            status="${value#\"}"
            status="${status%\"}"
        fi
        if [[ "$body" =~ $closing ]]; then
            case "$status" in idle|occupied|uploading) echo "$status"; return 0 ;; esac
            return 1
        fi
        [[ "$body" =~ $comma ]] || return 1
        body="${body:${#BASH_REMATCH[0]}}"
    done
    return 1
}

wait_for_idle() {
    local container_id="$1" status="unknown" waited=0 choice docker_state
    local health_url=""
    while :; do
        docker_state=$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null) || docker_state="unknown"
        case "$docker_state" in
            created|exited|dead|restarting)
                echo "  Docker state: $docker_state — checking again in ${POLL_INTERVAL}s."
                sleep "$POLL_INTERVAL"
                waited=$((waited + POLL_INTERVAL))
                docker_state=$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null) || docker_state="unknown"
                case "$docker_state" in
                    created|exited|dead|restarting)
                        echo "  Docker state: $docker_state after recheck — proceeding without a health wait."
                        return 0
                        ;;
                esac
                echo "  Docker state after recheck: $docker_state — checking health."
                ;;
        esac
        if [ -n "$manager_force" ]; then
            echo "  WARNING: --force bypasses idle checks; active evaluations may be interrupted."
            return 0
        fi
        [ -n "$health_url" ] || health_url=$(container_health_url "$container_id") || true
        status="unknown"
        if [ -n "$health_url" ]; then
            status=$(health_status "$health_url") || status="unknown"
        fi
        if [ "$status" = "idle" ]; then
            echo "  Status: idle after ${waited}s — safe to stop."
            return 0
        fi
        echo "  Status: $status — waiting for explicit idle... (${waited}s / ${WAIT_TIMEOUT}s)"
        [ "$waited" -lt "$WAIT_TIMEOUT" ] || break
        sleep "$POLL_INTERVAL"
        waited=$((waited + POLL_INTERVAL))
    done

    echo "  Timeout: container is $status after ${WAIT_TIMEOUT}s; stopping may interrupt active work."
    read -r -p "  Force stop? (y/n): " choice || choice=n
    case "$choice" in
        y|Y ) return 0 ;;
        * ) return 1 ;;
    esac
}

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

# Search the invoking and sudo users' sockets unless DIALF_SOCKET is explicit.
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

dialf_not_found_reason() {
    local owner_uid owner me
    # Usernames from ps can be truncated; compare UIDs instead.
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

report_dialf_check() {
    # Optional $2 excludes stale probe logs from before a container restart.
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

# Route output is untrusted before use in paths, patterns or command arguments.
# Keep validation aligned with the daemon's link-type.ts and net-signals.ts.
valid_iface_name() {
    case "$1" in
        ""|.|..|-*) return 1 ;;
    esac
    [ "${#1}" -le 32 ] || return 1
    # Whole-string match (unlike grep -x, which would accept "eth0<newline>x").
    local LC_ALL=C re='^[A-Za-z0-9._@:-]+$'
    [[ "$1" =~ $re ]]
}

# Detect on the host: the container only sees its veth. Valid env overrides win.
host_link_type() {
    case "${VOX_LINK_TYPE:-}" in
        wifi|ethernet|cellular|satellite) echo "$VOX_LINK_TYPE"; return 0 ;;
    esac
    local os iface driver
    os=$(uname -s 2>/dev/null || true)
    if [ "$os" = "Linux" ]; then
        iface=$( { ip route get 1.1.1.1 2>/dev/null || true; } | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
        valid_iface_name "$iface" || return 0
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
        valid_iface_name "$iface" || return 0
        if { networksetup -listallhardwareports 2>/dev/null || true; } | grep -F -x -B1 "Device: $iface" | grep -q "^Hardware Port: Wi-Fi$"; then
            echo wifi; return 0
        fi
        echo ethernet
    fi
    return 0
}

host_public_ip_on_iface() {
    case "${VOX_PUBLIC_IP_ON_IFACE:-}" in
        true|false) echo "$VOX_PUBLIC_IP_ON_IFACE"; return 0 ;;
    esac
    local os iface out
    os=$(uname -s 2>/dev/null || true)
    if [ "$os" = "Linux" ]; then
        iface=$( { ip route get 1.1.1.1 2>/dev/null || true; } | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
        valid_iface_name "$iface" || return 0
        out=$(ip -o addr show dev "$iface" 2>/dev/null || true)
    elif [ "$os" = "Darwin" ]; then
        iface=$( { route -n get default 2>/dev/null || true; } | sed -n 's/^ *interface: //p' | head -1)
        valid_iface_name "$iface" || return 0
        out=$(ifconfig "$iface" 2>/dev/null || true)
    else
        return 0
    fi
    [ -z "$out" ] && return 0
    local rc=0
    host_addr_is_public "$out" || rc=$?
    case "$rc" in
        0) echo true ;;
        1) echo false ;;
    esac
    return 0
}

# Return 0 for public IPv4, 1 for private-only IPv4, 2 for no IPv4.
# Global IPv6 also occurs behind home routers, so it cannot prove datacenter access.
host_addr_is_public() {
    local line a b seen=""
    for line in $(echo "$1" | grep -oE 'inet [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | awk '{print $2}'); do
        seen=1
        a=${line%%.*}
        b=$(echo "$line" | cut -d. -f2)
        case "$a" in 10|127) continue ;; esac
        [ "$a" = "172" ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && continue
        [ "$a" = "192" ] && [ "$b" = "168" ] && continue
        [ "$a" = "100" ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && continue
        [ "$a" = "169" ] && [ "$b" = "254" ] && continue
        return 0
    done
    [ -n "$seen" ] && return 1
    return 2
}

container_dialf_socket() {
    { docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true; } | sed -n 's/^VOX_DIALF_SOCKET=//p' | head -1
}

# File bind mounts retain the old inode when dialfd recreates its socket.
host_inode() { stat -c %i "$1" 2>/dev/null || true; }
container_inode() { docker exec "$1" stat -c %i "$2" 2>/dev/null || true; }

declare -A new_containers
declare -A running_containers=()
declare -A target_images=()
declare -A target_refs=()

official_image_ref() {
    case "$1" in "$2"|"$2":*|"$2"@*) return 0 ;; *) return 1 ;; esac
}

# Recorded references survive retagging; bare IDs need their local repository
# metadata. Never use the newly selected version to identify an old container.
discover_container() {
    local component="$1" repo="${REGISTRY}/$1" id metadata recorded image_id state alias aliases container_env
    local named="" repository_match bare_id token_name container_token_name
    local -a fields=() live=() inactive=()
    case "$component" in
        vox-eval-agentd) token_name=EVAL_TOKEN; container_token_name=AGENT_TOKEN ;;
        *) token_name=CLASH_TOKEN; container_token_name=RUNNER_TOKEN ;;
    esac
    while IFS= read -r id; do
        [ -n "$id" ] || continue
        if ! metadata=$(docker inspect --format '{{.Name}}{{println}}{{.Config.Image}}{{println}}{{.Image}}{{println}}{{.State.Status}}' "$id"); then
            echo "Error: cannot inspect container $id during discovery. No containers were changed." >&2
            return 1
        fi
        mapfile -t fields <<< "$metadata"
        if [ "${#fields[@]}" -ne 4 ]; then
            echo "Error: incomplete container metadata for $id. No containers were changed." >&2
            return 1
        fi
        recorded="${fields[1]}" image_id="${fields[2]}" state="${fields[3]}"
        repository_match="" bare_id=""
        official_image_ref "$recorded" "$repo" && repository_match=1
        if [[ "$recorded" =~ ^(sha256:)?[a-f0-9]{12,64}$ ]]; then
            bare_id=1
            if ! aliases=$(docker image inspect "$image_id" --format '{{range .RepoTags}}{{println .}}{{end}}{{range .RepoDigests}}{{println .}}{{end}}'); then
                echo "Error: cannot identify the image for container $id. No containers were changed." >&2
                return 1
            fi
            while IFS= read -r alias; do
                official_image_ref "$alias" "$repo" && repository_match=1
            done <<< "$aliases"
        fi
        if [ "${fields[0]}" = "/$component" ]; then
            if [ -n "$named" ]; then
                echo "Error: ambiguous named $component containers. No containers were changed." >&2
                return 1
            fi
            # A matching name (or a bare image ID) does not prove ownership.
            if [ -z "$repository_match" ]; then
                echo "Error: name $component belongs to another image ($id). No containers were changed." >&2
                return 1
            fi
            named="$id"
            continue
        fi
        [ -n "$repository_match$bare_id" ] || continue
        # Legacy adoption requires this instance's credential; never log its value.
        if ! container_env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id"); then
            echo "Error: cannot check legacy container $id credentials. No containers were changed." >&2
            return 1
        fi
        if [[ $'\n'"$container_env"$'\n' != *$'\n'"$container_token_name=${!token_name}"$'\n'* ]]; then
            continue
        fi
        if [ -z "$repository_match" ]; then
            echo "Error: container $id uses the configured credential but its image repository is unknown. No containers were changed." >&2
            return 1
        fi
        case "$state" in
            running|restarting|paused|removing) live+=("$id") ;;
            created|exited|dead) inactive+=("$id") ;;
            *) echo "Error: unknown legacy container state for $id. No containers were changed." >&2; return 1 ;;
        esac
    done <<< "$container_inventory"
    if [ "${#live[@]}" -gt 1 ] || { [ -n "$named" ] && [ "${#live[@]}" -gt 0 ]; }; then
        echo "Error: ambiguous $component containers; select the intended container manually. No containers were changed." >&2
        return 1
    fi
    if [ -n "$named" ]; then printf '%s\n' "$named"
    elif [ "${#live[@]}" -eq 1 ]; then printf '%s\n' "${live[0]}"
    elif [ "${#inactive[@]}" -gt 1 ]; then
        echo "Error: ambiguous inactive $component containers. No containers were changed." >&2
        return 1
    elif [ "${#inactive[@]}" -eq 1 ]; then printf '%s\n' "${inactive[0]}"
    fi
    return 0
}

if ! container_inventory=$(docker ps -aq --no-trunc); then
    echo "Error: could not list existing containers. No containers were changed." >&2
    exit 1
fi
for name in "${!images[@]}"; do
    running_containers[$name]=$(discover_container "$name") || exit 1
done

# Resolve every requested image before stopping anything. A missing rollback
# version must not leave a multi-container installation partially replaced.
for name in "${!images[@]}"; do
    image="${images[$name]}"
    selected_version="${image_versions[$name]}"
    echo "Checking $name ($image)..."

    echo "Pulling selected image: $image..."
    if ! docker pull "$image"; then
        echo "Error: could not pull $image. No containers were changed." >&2
        exit 1
    fi
    if ! selected_image_id=$(docker image inspect "$image" --format='{{.Id}}') ||
        [[ ! "$selected_image_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
        echo "Error: could not resolve $image to an image ID. No containers were changed." >&2
        exit 1
    fi
    target_images[$name]="$selected_image_id"

    # Keep the official repository name without trusting a movable tag at launch.
    pinned_image=""
    if [[ "$selected_version" = sha256:* ]]; then
        pinned_image="$image"
    else
        if ! repo_digests=$(docker image inspect "$selected_image_id" --format='{{range .RepoDigests}}{{println .}}{{end}}'); then
            echo "Error: could not inspect registry digests for $image. No containers were changed." >&2
            exit 1
        fi
        while IFS= read -r repo_digest; do
            digest="${repo_digest#"${REGISTRY}/${name}@"}"
            if [ "$digest" != "$repo_digest" ] && [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
                pinned_image="$repo_digest"
                break
            fi
        done <<< "$repo_digests"
    fi
    if [ -z "$pinned_image" ] ||
        ! pinned_id=$(docker image inspect "$pinned_image" --format='{{.Id}}') ||
        [ "$pinned_id" != "$selected_image_id" ]; then
        echo "Error: could not verify an immutable ${REGISTRY}/${name} reference for $image. No containers were changed." >&2
        exit 1
    fi
    target_refs[$name]="$pinned_image"
    echo "Verified $image ($pinned_image -> $selected_image_id)"
done

# Prepare credentials before stopping anything; never put token values in argv.
manager_env_dir=""
previous_container_id=""
previous_container_name=""
previous_container_renamed=""
candidate_id_file=""
manager_failed=0

candidate_container_id() {
    local id
    [ -n "$candidate_id_file" ] && [ -f "$candidate_id_file" ] || return 1
    id=$(< "$candidate_id_file")
    [[ "$id" =~ ^[a-f0-9]{64}$ ]] || return 1
    printf '%s\n' "$id"
}

recover_failed_start() {
    local candidate_id
    # A failed run may leave a container. Only remove the ID Docker wrote for us,
    # never a stable name that another process might have claimed.
    if candidate_id=$(candidate_container_id); then
        if ! docker rm -f "$candidate_id" > /dev/null; then
            echo "WARNING: could not remove failed replacement $candidate_id; inspect it before recovery." >&2
        fi
    elif [ -n "$candidate_id_file" ] && [ -s "$candidate_id_file" ]; then
        echo "WARNING: invalid replacement ID file; no container was removed by name." >&2
    fi
    candidate_id_file=""
    if [ -n "$previous_container_id" ]; then
        if [ -n "$previous_container_renamed" ] &&
            ! docker rename "$previous_container_id" "$previous_container_name"; then
            echo "WARNING: could not restore the old container's name; recover it by ID." >&2
        fi
        echo "Old container preserved: $previous_container_id (image $running_image_id)." >&2
        echo "To start the old image with its original configuration:" >&2
        echo "  docker start $previous_container_id" >&2
    fi
    previous_container_id=""
    previous_container_renamed=""
}

retain_previous_container() {
    local original_name
    if ! original_name=$(docker inspect --format '{{.Name}}' "$running_id") ||
        [[ ! "$original_name" =~ ^/[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
        echo "Error: cannot determine the old container's name; leaving $name unchanged." >&2
        return 1
    fi
    previous_container_id="$running_id"
    previous_container_name="${original_name#/}"
    echo "Stopping ${running_id:0:12}..."
    if ! docker stop "$running_id" > /dev/null; then
        echo "Error: could not stop $name; skipping replacement." >&2
        recover_failed_start
        return 1
    fi
    if [ "$previous_container_name" = "$name" ]; then
        if ! docker rename "$running_id" "$name-previous-${manager_env_dir##*/}"; then
            echo "Error: could not free the service name; skipping replacement." >&2
            recover_failed_start
            return 1
        fi
        previous_container_renamed=1
    fi
    echo "Keeping old container $running_id until the replacement starts."
}

cleanup_container_env() {
    recover_failed_start
    if [ -n "$manager_env_dir" ]; then
        rm -f -- "$manager_env_dir/vox-eval-agentd.env" "$manager_env_dir/vox-clash-runner.env"
        rm -f -- "$manager_env_dir/vox-eval-agentd.cid" "$manager_env_dir/vox-clash-runner.cid"
        rmdir -- "$manager_env_dir"
    fi
}
trap cleanup_container_env EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! manager_env_dir=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/vox-manager-env.XXXXXX"); then
    echo "Error: cannot create private container env directory. No containers were changed." >&2
    exit 1
fi
declare -A token_env_files=()
for name in "${!images[@]}"; do
    token_env_files[$name]="$manager_env_dir/$name.env"
    # Existing images retain their runtime env names, including rollback versions.
    if [ "$name" = vox-eval-agentd ]; then token_name=EVAL_TOKEN; container_token_name=AGENT_TOKEN
    else token_name=CLASH_TOKEN; container_token_name=RUNNER_TOKEN; fi
    if ! (umask 077; printf '%s\n' "$container_token_name=${!token_name}" > "${token_env_files[$name]}"); then
        echo "Error: cannot write private container env file. No containers were changed." >&2
        exit 1
    fi
done

for name in "${!images[@]}"; do
    image="${images[$name]}"
    selected_version="${image_versions[$name]}"
    selected_image_id="${target_images[$name]}"
    pinned_image="${target_refs[$name]}"
    running_id="${running_containers[$name]}"
    echo "Applying $name ($image)..."

    host_dialf_socket=""
    prev_dialf_socket=""
    if [ "$name" = "vox-eval-agentd" ]; then
        host_dialf_socket=$(detect_dialf_socket)
        [ -n "$running_id" ] && prev_dialf_socket=$(container_dialf_socket "$running_id")
    fi
    # Adding a missing DialF mount requires recreation, even on the same image.
    dialf_missing_in_container=""
    if [ -n "$host_dialf_socket" ] && [ "$prev_dialf_socket" != "$host_dialf_socket" ]; then
        dialf_missing_in_container=1
    fi
    dialf_stale_in_container=""
    if [ -n "$host_dialf_socket" ] && [ "$prev_dialf_socket" = "$host_dialf_socket" ] && [ -n "$running_id" ]; then
        h_ino=$(host_inode "$host_dialf_socket")
        c_ino=$(container_inode "$running_id" "$host_dialf_socket")
        if [ -n "$h_ino" ] && [ -n "$c_ino" ] && [ "$h_ino" != "$c_ino" ]; then
            dialf_stale_in_container=1
        fi
    fi

    # Confirm loss of phone capability before stopping the old container.
    running_image_id=""
    [ -n "$running_id" ] && running_image_id=$(docker inspect --format='{{.Image}}' "$running_id" 2>/dev/null || true)
    recovery_needed=""
    docker_state=""
    if [ -n "$running_id" ]; then
        docker_state=$(docker inspect --format '{{.State.Status}}' "$running_id" 2>/dev/null) || docker_state="unknown"
        case "$docker_state" in created|exited|dead|restarting) recovery_needed=1 ;; esac
    fi
    if [ -n "$prev_dialf_socket" ] && [ -z "$host_dialf_socket" ] && [ "$running_image_id" == "$selected_image_id" ] && [ -z "$recovery_needed" ]; then
        echo "WARNING: the running container was started with DialF ($prev_dialf_socket), but that"
        echo "         socket is gone — it can't take phone jobs. Start dialfd (with the same socket"
        echo "         path, or set DIALF_SOCKET) and re-run this, or restart the container."
    elif [ -n "$prev_dialf_socket" ] && [ -z "$host_dialf_socket" ]; then
        echo "WARNING: the running container was started with DialF ($prev_dialf_socket),"
        echo "         but no dialfd socket is found now — a new container WON'T take phone jobs."
        reason=$(dialf_not_found_reason)
        if [ -n "$reason" ]; then echo "$reason" | sed 's/^/         /'
        else echo "         Is dialfd running? Start it, or set DIALF_SOCKET=/path/to/dialfd.sock in .env."; fi
        if [ -n "$manager_force" ]; then
            echo "         --force confirms replacement without DialF support."
            choice=y
        else
            read -p "         Replace it anyway, without DialF? (y/n): " choice || choice=n
        fi
        case "$choice" in
            y|Y ) ;;
            * ) echo "Leaving the running $name as it is. Start dialfd (or set DIALF_SOCKET), then re-run."
                echo "-----------------------------------"
                continue ;;
        esac
    fi

    if [ -n "$running_id" ]; then
        if [ "$running_image_id" == "$selected_image_id" ] && [ -n "$dialf_missing_in_container" ]; then
            echo "Already on the selected image, but DialF is on this host ($host_dialf_socket) and the"
            echo "running container wasn't started with it — recreating it so it can take phone jobs."
            if ! wait_for_idle "$running_id"; then
                echo "Skipping $name (user chose not to force stop)."
                echo "-----------------------------------"
                continue
            fi
        elif [ "$running_image_id" == "$selected_image_id" ] && [ -n "$dialf_stale_in_container" ] && [ -z "$recovery_needed" ]; then
            # Restarting refreshes the bind mount without recreating the container.
            echo "Already on the selected image, but its DialF socket is stale: dialfd recreated"
            echo "$host_dialf_socket since the container started. Restarting it to pick up the new one."
            if ! wait_for_idle "$running_id"; then
                echo "Skipping $name (user chose not to force stop)."
            else
                # Epoch seconds avoid Docker interpreting UTC text in local time.
                restarted_at=$(date +%s)
                if ! docker restart "$running_id" > /dev/null; then
                    echo "Error: could not restart $name; continuing with other services." >&2
                    manager_failed=1
                    echo "-----------------------------------"
                    continue
                fi
                echo "Restarted ${running_id:0:12}."
                report_dialf_check "$running_id" "$restarted_at"
            fi
            echo "-----------------------------------"
            continue
        elif [ "$running_image_id" == "$selected_image_id" ] && [ -z "$recovery_needed" ]; then
            echo "Already running the selected image ($image). Skipping replacement."
            current_policy=$(docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' "$running_id" 2>/dev/null || true)
            if [ "$current_policy" != "$RESTART_POLICY" ]; then
                echo "Applying restart policy '$RESTART_POLICY' (was '${current_policy:-none}')..."
                if ! docker update --restart "$RESTART_POLICY" "$running_id" > /dev/null; then
                    echo "Error: could not update restart policy for $name; continuing with other services." >&2
                    manager_failed=1
                fi
            fi
            echo "-----------------------------------"
            continue
        else
            if [ "$running_image_id" == "$selected_image_id" ]; then
                echo "Selected image is already installed, but Docker state is $docker_state; recreating container."
            else
                echo "Selected image differs from running image ($running_image_id)."
            fi

            if ! wait_for_idle "$running_id"; then
                echo "Skipping $name (user chose not to force stop)."
                echo "-----------------------------------"
                continue
            fi

        fi
    else
        echo "No existing container found."
        if [ -n "$manager_force" ]; then
            echo "--force confirms starting a new container."
            choice=y
        else
            read -p "Start a new container? (y/n): " choice || choice=n
        fi
        case "$choice" in
            y|Y ) echo "Starting new container..." ;;
            * )
                echo "Skipping $name."
                echo "-----------------------------------"
                continue
                ;;
        esac
    fi

    env_args=(-e "HEALTH_PORT=$HEALTH_PORT" -e "VOX_SERVER=$VOX_SERVER")

    [ -n "${LOCAL_DEBUG:-}" ] && env_args+=(-e "LOCAL_DEBUG=$LOCAL_DEBUG")
    [ -n "${HEADLESS:-}" ] && env_args+=(-e "HEADLESS=$HEADLESS")
    if [ -n "${EVAL_FRAMEWORK:-}" ]; then
        if [ "$EVAL_FRAMEWORK" = "aeval" ]; then
            env_args+=(-e "EVAL_FRAMEWORK=$EVAL_FRAMEWORK")
        else
            echo "WARNING: EVAL_FRAMEWORK='$EVAL_FRAMEWORK' is not supported (voice-agent-tester was"
            echo "         removed; aeval is the only framework) — ignoring it and using aeval."
            echo "         Remove the line from your .env to silence this."
        fi
    fi
    [ -n "${VOX_AGENT_NAME:-}" ] && env_args+=(-e "VOX_AGENT_NAME=$VOX_AGENT_NAME")

    device_args=()
    mount_args=()
    dialf_detected=""
    if [ "$name" = "vox-eval-agentd" ]; then
        mount_args+=(-v vox-aeval-cache:/root/.cache)
        if [ -d /dev/snd ]; then
            # aeval resolves card IDs through /proc/asound, which Docker masks by default.
            device_args=(--device /dev/snd --security-opt systempaths=unconfined)
        fi

        link_type=$(host_link_type)
        [ -n "$link_type" ] && env_args+=(-e "VOX_LINK_TYPE=$link_type")

        public_ip_on_iface=$(host_public_ip_on_iface)
        [ -n "$public_ip_on_iface" ] && env_args+=(-e "VOX_PUBLIC_IP_ON_IFACE=$public_ip_on_iface")

        # Optional live host sampler. Mount the directory, not the atomically
        # replaced file, so updates remain visible inside Docker.
        network_status_dir="${VOX_NETWORK_STATUS_DIR:-}"
        if [ -n "$network_status_dir" ]; then
            if [[ "$network_status_dir" =~ ^/[A-Za-z0-9_./-]+$ && -f "$network_status_dir/status.json" ]]; then
                mount_args+=(-v "$network_status_dir:/run/vox-network:ro")
                env_args+=(-e VOX_NETWORK_STATUS_FILE=/run/vox-network/status.json)
            else
                echo "WARNING: VOX_NETWORK_STATUS_DIR must be an absolute directory using letters, numbers, dot, dash, slash or underscore, containing status.json."
            fi
        fi

        # Identical host/container paths let dialfd and the agent share audio files.
        dialf_socket="$host_dialf_socket"
        if [ -n "$dialf_socket" ] && [ -S "$dialf_socket" ]; then
            dialf_detected=1
            exchange_dir="${DIALF_EXCHANGE_DIR:-$HOME/vox-phone-exchange}"
            if ! mkdir -p "$exchange_dir/corpus" "$exchange_dir/recordings"; then
                echo "Error: cannot prepare DialF exchange directories; leaving $name unchanged." >&2
                manager_failed=1
                echo "-----------------------------------"
                continue
            fi
            mount_args+=(-v "$dialf_socket:$dialf_socket" -v "$exchange_dir:$exchange_dir")
            env_args+=(-e "VOX_DIALF_SOCKET=$dialf_socket" -e "VOX_DIALF_EXCHANGE_DIR=$exchange_dir")
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

    if [ -n "$running_id" ] && ! retain_previous_container; then
        manager_failed=1
        continue
    fi

    # Pin the image, allocate a loopback health port, and track partial starts by ID.
    candidate_id_file="$manager_env_dir/$name.cid"
    start_succeeded=""
    if docker run -d --name "$name" --restart "$RESTART_POLICY" --pull=never \
        --label "org.agora.vox.image=$image" --label "org.agora.vox.version=$selected_version" \
        -p "127.0.0.1::${HEALTH_PORT}" ${device_args[@]+"${device_args[@]}"} ${mount_args[@]+"${mount_args[@]}"} \
        --cidfile "$candidate_id_file" --env-file "${token_env_files[$name]}" "${env_args[@]}" "$pinned_image" > /dev/null; then
        if new_container_id=$(candidate_container_id) &&
            new_state=$(docker inspect --format '{{.State.Status}}' "$new_container_id") &&
            [ "$new_state" = running ]; then
            start_succeeded=1
        fi
    fi
    rm -f -- "${token_env_files[$name]}"
    if [ -z "$start_succeeded" ]; then
        echo "Error: $name did not start successfully." >&2
        recover_failed_start
        manager_failed=1
        echo "-----------------------------------"
        continue
    fi

    candidate_id_file=""
    retained_id="$previous_container_id"
    previous_container_id=""
    previous_container_renamed=""
    if [ -n "$retained_id" ]; then
        if ! docker rm "$retained_id" > /dev/null; then
            echo "WARNING: replacement is running, but old container $retained_id could not be removed." >&2
            manager_failed=1
        fi
    fi
    short_id="${new_container_id:0:12}"
    new_containers[$name]=$short_id
    echo "Started $name: $short_id ($image -> $selected_image_id)"
    [ "$name" = "vox-eval-agentd" ] && [ -n "$dialf_detected" ] && report_dialf_check "$name"

    # Host audio availability does not prove the device is visible inside Docker.
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
docker container ls --format 'table {{.ID}}\t{{.Image}}\t{{.Label "org.agora.vox.version"}}\t{{.Status}}\t{{.Names}}'
echo ""

echo "Restart policy: containers use '--restart $RESTART_POLICY'."
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
if [ "$manager_failed" -ne 0 ]; then
    echo "Finished with errors. Review the recovery instructions above." >&2
    exit 1
fi
echo "Done."
