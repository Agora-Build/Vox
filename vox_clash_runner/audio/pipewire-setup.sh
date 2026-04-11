#!/bin/bash
# PipeWire setup for Clash Runner (headless container)
#
# Audio stack: dbus -> PipeWire -> WirePlumber -> PipeWire-Pulse
# Sinks created via pactl (PulseAudio API) so Chromium can route audio via PULSE_SINK.
#
# Virtual_Sink_A: Browser A audio output -> .monitor feeds Browser B's mic
# Virtual_Sink_B: Browser B audio output -> .monitor feeds Browser A's mic

set -euo pipefail

export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/pipewire-run}
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

echo "[PipeWire] Starting audio stack..."

# D-Bus session bus — required by WirePlumber to drive the audio graph
dbus-daemon --session --address=unix:path=$XDG_RUNTIME_DIR/bus --nofork --nopidfile &
DBUS_PID=$!
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
sleep 0.3

pipewire &
PIPEWIRE_PID=$!
sleep 0.5

wireplumber &
WIREPLUMBER_PID=$!
sleep 1

pipewire-pulse &
PULSE_PID=$!
sleep 0.5

echo "[PipeWire] Creating virtual sinks..."

pactl load-module module-null-sink sink_name=Virtual_Sink_A sink_properties=device.description=VirtualSinkA
pactl load-module module-null-sink sink_name=Virtual_Sink_B sink_properties=device.description=VirtualSinkB

sleep 0.3

echo "[PipeWire] Sinks:"
pactl list sinks short

echo "[PipeWire] PID: dbus=$DBUS_PID, pipewire=$PIPEWIRE_PID, wireplumber=$WIREPLUMBER_PID, pulse=$PULSE_PID"

echo "$DBUS_PID" > /tmp/dbus.pid
echo "$PIPEWIRE_PID" > /tmp/pipewire.pid
echo "$WIREPLUMBER_PID" > /tmp/wireplumber.pid
echo "$PULSE_PID" > /tmp/pipewire-pulse.pid

# Export DBUS address so child processes (browsers, parec) inherit it
echo "export DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" > /tmp/pipewire-env.sh
