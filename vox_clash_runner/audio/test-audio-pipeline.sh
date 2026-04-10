#!/bin/bash
# Audio pipeline integration test for the clash runner container.
# Verifies: PipeWire stack -> sink creation -> audio flow -> capture -> cross-wiring
#
# Run inside the container:
#   docker run --rm vox-clash-runner-test bash /app/audio/test-audio-pipeline.sh

set -uo pipefail

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)); }
fail() { echo "  FAIL: $1"; ((FAIL++)); }

echo "=== Audio Pipeline Test ==="
echo ""

# --- 1. Start PipeWire stack ---
echo "[1/6] Starting PipeWire stack..."
bash /app/audio/pipewire-setup.sh 2>/dev/null
source /tmp/pipewire-env.sh

if [ -S "$XDG_RUNTIME_DIR/bus" ]; then
  pass "D-Bus session bus socket exists"
else
  fail "D-Bus session bus socket missing"
fi

if kill -0 $(cat /tmp/pipewire.pid) 2>/dev/null; then
  pass "PipeWire is running"
else
  fail "PipeWire is not running"
fi

if kill -0 $(cat /tmp/pipewire-pulse.pid) 2>/dev/null; then
  pass "PipeWire-Pulse is running"
else
  fail "PipeWire-Pulse is not running"
fi

# --- 2. Verify sinks visible via PulseAudio ---
echo ""
echo "[2/6] Checking sinks..."

SINKS=$(pactl list sinks short 2>/dev/null)
if echo "$SINKS" | grep -q "Virtual_Sink_A"; then
  pass "Virtual_Sink_A visible in PulseAudio"
else
  fail "Virtual_Sink_A not visible"
fi

if echo "$SINKS" | grep -q "Virtual_Sink_B"; then
  pass "Virtual_Sink_B visible in PulseAudio"
else
  fail "Virtual_Sink_B not visible"
fi

SOURCES=$(pactl list sources short 2>/dev/null)
if echo "$SOURCES" | grep -q "Virtual_Sink_A.monitor"; then
  pass "Virtual_Sink_A.monitor source available"
else
  fail "Virtual_Sink_A.monitor source not available"
fi

if echo "$SOURCES" | grep -q "Virtual_Sink_B.monitor"; then
  pass "Virtual_Sink_B.monitor source available"
else
  fail "Virtual_Sink_B.monitor source not available"
fi

# --- 3. Test audio playback into sink ---
echo ""
echo "[3/6] Testing playback (pacat -> sink)..."

echo -ne '\x00\x00\x00\x00' | timeout 5 pacat -d Virtual_Sink_A --format=s16le --rate=16000 --channels=1 2>/dev/null
if [ $? -eq 0 ]; then
  pass "pacat can write to Virtual_Sink_A"
else
  fail "pacat failed to write to Virtual_Sink_A"
fi

# --- 4. Test audio capture from monitor ---
echo ""
echo "[4/6] Testing capture (parec <- monitor)..."

# Sustained producer -> capture
timeout 5 pacat -d Virtual_Sink_A --format=s16le --rate=16000 --channels=1 --raw < /dev/zero &
PRODUCER=$!
sleep 1

timeout 2 parec -d Virtual_Sink_A.monitor --format=s16le --rate=16000 --channels=1 --raw 2>/dev/null > /tmp/capture_test.raw || true

kill $PRODUCER 2>/dev/null; wait $PRODUCER 2>/dev/null || true
CAPTURE_SIZE=$(wc -c < /tmp/capture_test.raw 2>/dev/null || echo 0)

if [ "$CAPTURE_SIZE" -gt 1000 ]; then
  pass "parec captured ${CAPTURE_SIZE} bytes from Virtual_Sink_A.monitor"
else
  fail "parec captured only ${CAPTURE_SIZE} bytes (expected >1000)"
fi

# --- 5. Test cross-wiring via loopback ---
echo ""
echo "[5/6] Testing cross-wiring (A -> loopback -> B)..."

pactl load-module module-loopback source=Virtual_Sink_A.monitor sink=Virtual_Sink_B latency_msec=20 2>/dev/null

# Producer on Sink A — loopback routes it to Sink B
timeout 8 pacat -d Virtual_Sink_A --format=s16le --rate=16000 --channels=1 --raw < /dev/zero &
PRODUCER2=$!
sleep 2

timeout 3 parec -d Virtual_Sink_B.monitor --format=s16le --rate=16000 --channels=1 --raw 2>/dev/null > /tmp/crosswire_test.raw || true

kill $PRODUCER2 2>/dev/null; wait $PRODUCER2 2>/dev/null || true
CROSSWIRE_SIZE=$(wc -c < /tmp/crosswire_test.raw 2>/dev/null || echo 0)

if [ "$CROSSWIRE_SIZE" -gt 1000 ]; then
  pass "Cross-wire: ${CROSSWIRE_SIZE} bytes captured on Sink B from Sink A"
else
  fail "Cross-wire captured only ${CROSSWIRE_SIZE} bytes (expected >1000)"
fi

# --- 6. Verify C++ binaries ---
echo ""
echo "[6/6] Checking C++ binaries..."

BCAST_OUT=$(/app/agora-broadcaster 2>&1 || true)
if echo "$BCAST_OUT" | grep -qi "appid"; then
  pass "agora-broadcaster binary runs"
else
  fail "agora-broadcaster binary failed"
fi

RECV_OUT=$(/app/agora-receiver 2>&1 || true)
if echo "$RECV_OUT" | grep -qi "appid"; then
  pass "agora-receiver binary runs"
else
  fail "agora-receiver binary failed"
fi

# --- Summary ---
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
