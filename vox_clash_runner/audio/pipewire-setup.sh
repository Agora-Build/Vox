#!/bin/bash
# PipeWire setup for Clash Runner
# Creates two virtual null sinks for cross-routing audio between browsers.
#
# Virtual_Sink_A: Browser A's audio output → .monitor feeds Browser B's mic
# Virtual_Sink_B: Browser B's audio output → .monitor feeds Browser A's mic

set -euo pipefail

echo "[PipeWire] Starting PipeWire and WirePlumber..."

# Start PipeWire (runs in background)
pipewire &
PIPEWIRE_PID=$!
sleep 0.5

# Start WirePlumber (session manager)
wireplumber &
WIREPLUMBER_PID=$!
sleep 1

echo "[PipeWire] Creating virtual sinks..."

# Create Virtual_Sink_A (Agent A's audio output)
pw-cli create-node adapter \
  factory.name=support.null-audio-sink \
  node.name=Virtual_Sink_A \
  media.class=Audio/Sink \
  audio.position="FL,FR" \
  object.linger=true

# Create Virtual_Sink_B (Agent B's audio output)
pw-cli create-node adapter \
  factory.name=support.null-audio-sink \
  node.name=Virtual_Sink_B \
  media.class=Audio/Sink \
  audio.position="FL,FR" \
  object.linger=true

# Create Mixed_Sink (captures both agents for RTC broadcast)
# Agent A → left channel, Agent B → right channel
pw-cli create-node adapter \
  factory.name=support.null-audio-sink \
  node.name=Mixed_Sink \
  media.class=Audio/Sink \
  audio.position="FL,FR" \
  object.linger=true

sleep 0.5

# Link both agent monitors into Mixed_Sink for the broadcaster
pw-link Virtual_Sink_A:monitor_FL Mixed_Sink:input_FL 2>/dev/null || true
pw-link Virtual_Sink_B:monitor_FL Mixed_Sink:input_FR 2>/dev/null || true

echo "[PipeWire] Virtual sinks created (A, B, Mixed). Cross-wiring will happen after browsers connect."
echo "[PipeWire] PID: pipewire=$PIPEWIRE_PID, wireplumber=$WIREPLUMBER_PID"

# Output PIDs for the parent process to track
echo "$PIPEWIRE_PID" > /tmp/pipewire.pid
echo "$WIREPLUMBER_PID" > /tmp/wireplumber.pid
