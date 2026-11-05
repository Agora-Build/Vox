#!/usr/bin/env bash
# Compatibility entry point. New installations should use vox-manager.sh.
set -euo pipefail

usage() {
    echo "Usage: $0 [vox_agent] [--version TAG|sha256:DIGEST] [--env path/to/.env]"
    echo "       $0 self   # update the management script only"
    echo "       $0 vox    # not supported yet"
    echo "No arguments installs/upgrades vox_agent using latest images and .env in the current directory."
    echo "A positional env-file path is still accepted for compatibility."
    echo "New installations should use vox-manager.sh."
}

case "${1:-}" in
    -h|--help|help)
        usage
        exit 0
        ;;
    vox)
        echo "Error: Vox server installation/upgrade ('vox') is not supported yet." >&2
        exit 2
        ;;
    self)
        if [ "$#" -ne 1 ]; then echo "Usage: $0 self" >&2; exit 2; fi
        ;;
    vox_agent|""|--version|--version=*|--env|--env=*) ;;
    *)
        if [ ! -f "$1" ] && [[ "$1" != */* && "$1" != .env* ]]; then
            echo "Error: unknown command: $1" >&2
            usage >&2
            exit 2
        fi
        ;;
esac

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
manager="$script_dir/vox-manager.sh"
if [ ! -f "$manager" ]; then
    # Reject bad install arguments before downloading the standalone manager.
    validate_install_args() {
        local version=latest seen_version="" env_file=""
        if [ "${1:-}" = vox_agent ]; then shift; fi
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --version|--version=*)
                    if [ -n "$seen_version" ]; then return 2; fi
                    seen_version=1
                    if [ "$1" = --version ]; then
                        if [ "$#" -lt 2 ]; then return 2; fi
                        version="$2"; shift 2
                    else
                        version="${1#--version=}"; shift
                    fi
                    ;;
                --env|--env=*)
                    if [ -n "$env_file" ]; then return 2; fi
                    if [ "$1" = --env ]; then
                        if [ "$#" -lt 2 ]; then return 2; fi
                        env_file="$2"; shift 2
                    else
                        env_file="${1#--env=}"; shift
                    fi
                    if [ -z "$env_file" ] || [[ "$env_file" = -* ]]; then return 2; fi
                    ;;
                -h|--help) usage; exit 0 ;;
                -*) return 2 ;;
                *)
                    if [ -n "$env_file" ] || [ -z "$1" ]; then return 2; fi
                    env_file="$1"; shift
                    ;;
            esac
        done
        [[ "$version" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ || "$version" =~ ^sha256:[a-f0-9]{64}$ ]]
    }
    if [ "${1:-}" != self ] && ! validate_install_args "$@"; then
        echo "Error: invalid install arguments or Docker image version." >&2
        usage >&2; exit 2
    fi
    # Keep the historical download URL usable on hosts without a checkout.
    if [ -e "$manager" ] || [ -L "$manager" ]; then
        echo "Error: cannot install vox-manager.sh over an existing path: $manager" >&2
        exit 1
    fi
    update_tmp=$(mktemp "$script_dir/.vox-manager-bootstrap.XXXXXX")
    trap 'rm -f -- "$update_tmp"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
        --connect-timeout 10 --max-time 120 --output "$update_tmp" \
        https://raw.githubusercontent.com/Agora-Build/Vox/main/scripts/vox-manager.sh; then
        echo "Error: could not download vox-manager.sh; no containers were changed." >&2
        exit 1
    fi
    if [ "$(head -n 1 "$update_tmp")" != '#!/usr/bin/env bash' ] || \
        ! grep -qxF '# vox-manager-script: 1' "$update_tmp" || ! bash -n "$update_tmp"; then
        echo "Error: downloaded file is not a valid Vox management script." >&2
        exit 1
    fi
    chmod 755 "$update_tmp"
    mv -- "$update_tmp" "$manager"
    trap - EXIT INT TERM
    if [ "${1:-}" = self ]; then
        echo "Installed the latest management script: $manager"
        echo "vox-upgrade.sh remains a compatibility entry point; use vox-manager.sh for new commands."
        exit 0
    fi
fi

exec bash "$manager" "$@"
