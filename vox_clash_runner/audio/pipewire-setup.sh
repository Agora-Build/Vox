#!/bin/bash
# PipeWire setup for Clash Runner
# Creates two virtual null sinks for cross-routing audio between browsers.
#
# Virtual_Sink_A: Browser A's audio output → .monitor feeds Browser B's mic
# Virtual_Sink_B: Browser B's audio output → .monitor feeds Browser A's mic

set -euo pipefail

# PipeWire requires a runtime directory for its socket
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/pipewire-run}
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

echo "[PipeWire] Starting PipeWire..."

pipewire &
PIPEWIRE_PID=$!
sleep 1

echo "[PipeWire] Creating virtual sinks..."

pw-cli create-node adapter \
  factory.name=support.null-audio-sink \
  node.name=Virtual_Sink_A \
  media.class=Audio/Sink \
  audio.position="FL,FR" \
  object.linger=true

pw-cli create-node adapter \
  factory.name=support.null-audio-sink \
  node.name=Virtual_Sink_B \
  media.class=Audio/Sink \
  audio.position="FL,FR" \
  object.linger=true

pw-cli create-node adapter \
  factory.name=support.null-audio-sink \
  node.name=Mixed_Sink \
  media.class=Audio/Sink \
  audio.position="FL,FR" \
  object.linger=true

sleep 0.5

pw-link Virtual_Sink_A:monitor_FL Mixed_Sink:input_FL 2>/dev/null || true
pw-link Virtual_Sink_B:monitor_FL Mixed_Sink:input_FR 2>/dev/null || true

echo "[PipeWire] Virtual sinks created (A, B, Mixed). Cross-wiring will happen after browsers connect."
echo "[PipeWire] PID: pipewire=$PIPEWIRE_PID"

echo "$PIPEWIRE_PID" > /tmp/pipewire.pid
