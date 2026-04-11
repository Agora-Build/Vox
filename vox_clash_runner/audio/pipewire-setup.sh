#!/bin/bash
# PipeWire setup for Clash Runner (headless container)
#
# Audio stack: dbus -> PipeWire -> WirePlumber -> PipeWire-Pulse
# Sinks created via pactl (PulseAudio API) so Chromium can route audio.
#
# 4-sink design (separate output and input to prevent noise bleed):
#   Sink_A_Out: Browser A audio output (PULSE_SINK)
#   Sink_B_Out: Browser B audio output (PULSE_SINK)
#   Sink_A_In:  Browser A mic input (PULSE_SOURCE=Sink_A_In.monitor)
#   Sink_B_In:  Browser B mic input (PULSE_SOURCE=Sink_B_In.monitor)
#
# Cross-wiring (done later by observer.ts via module-loopback):
#   Sink_A_Out.monitor -> Sink_B_In  (A speaks -> B hears)
#   Sink_B_Out.monitor -> Sink_A_In  (B speaks -> A hears)
#
# Moderator audio (done by broadcaster.ts via pacat):
#   receiver -> pacat -> Sink_A_In  (A hears moderator)
#   receiver -> pacat -> Sink_B_In  (B hears moderator)

set -euo pipefail

export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/tmp/pipewire-run}
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

echo "[PipeWire] Starting audio stack..."

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

echo "[PipeWire] Creating virtual sinks (4-sink design)..."

pactl load-module module-null-sink sink_name=Sink_A_Out sink_properties=device.description=AgentA_Output
pactl load-module module-null-sink sink_name=Sink_B_Out sink_properties=device.description=AgentB_Output
pactl load-module module-null-sink sink_name=Sink_A_In sink_properties=device.description=AgentA_Input
pactl load-module module-null-sink sink_name=Sink_B_In sink_properties=device.description=AgentB_Input

sleep 0.3

echo "[PipeWire] Sinks:"
pactl list sinks short

echo "[PipeWire] PID: dbus=$DBUS_PID, pipewire=$PIPEWIRE_PID, wireplumber=$WIREPLUMBER_PID, pulse=$PULSE_PID"

echo "$DBUS_PID" > /tmp/dbus.pid
echo "$PIPEWIRE_PID" > /tmp/pipewire.pid
echo "$WIREPLUMBER_PID" > /tmp/wireplumber.pid
echo "$PULSE_PID" > /tmp/pipewire-pulse.pid

echo "export DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS" > /tmp/pipewire-env.sh
