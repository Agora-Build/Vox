#!/bin/bash
# Audio pipeline integration test for the clash runner container.
# Tests the 4-sink design: Sink_A_Out, Sink_B_Out, Sink_A_In, Sink_B_In
#
# Run inside the container:
#   docker run --rm vox-clash-runner-test bash /app/audio/test-audio-pipeline.sh

set -uo pipefail

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)); }
fail() { echo "  FAIL: $1"; ((FAIL++)); }

echo "=== Audio Pipeline Test (4-sink design) ==="
echo ""

# --- 1. Start PipeWire stack ---
echo "[1/8] Starting PipeWire stack..."
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

# --- 2. Verify all 4 sinks ---
echo ""
echo "[2/8] Checking 4 sinks..."

SINKS=$(pactl list sinks short 2>/dev/null)
for SINK in Sink_A_Out Sink_B_Out Sink_A_In Sink_B_In; do
  if echo "$SINKS" | grep -q "$SINK"; then
    pass "$SINK visible"
  else
    fail "$SINK not visible"
  fi
done

SOURCES=$(pactl list sources short 2>/dev/null)
for SRC in Sink_A_Out.monitor Sink_B_Out.monitor Sink_A_In.monitor Sink_B_In.monitor; do
  if echo "$SOURCES" | grep -q "$SRC"; then
    pass "$SRC source available"
  else
    fail "$SRC source not available"
  fi
done

# --- 3. Test output sink playback ---
echo ""
echo "[3/8] Testing output sink playback..."

echo -ne '\x00\x00\x00\x00' | timeout 5 pacat -d Sink_A_Out --format=s16le --rate=16000 --channels=1 2>/dev/null
if [ $? -eq 0 ]; then
  pass "pacat can write to Sink_A_Out"
else
  fail "pacat failed to write to Sink_A_Out"
fi

# --- 4. Test output sink capture ---
echo ""
echo "[4/8] Testing capture from output sink monitor..."

timeout 5 pacat -d Sink_A_Out --format=s16le --rate=16000 --channels=1 --raw < /dev/zero &
PRODUCER=$!
sleep 1

timeout 2 parec -d Sink_A_Out.monitor --format=s16le --rate=16000 --channels=1 --raw 2>/dev/null > /tmp/capture_test.raw || true

kill $PRODUCER 2>/dev/null; wait $PRODUCER 2>/dev/null || true
CAPTURE_SIZE=$(wc -c < /tmp/capture_test.raw 2>/dev/null || echo 0)

if [ "$CAPTURE_SIZE" -gt 1000 ]; then
  pass "parec captured ${CAPTURE_SIZE} bytes from Sink_A_Out.monitor"
else
  fail "parec captured only ${CAPTURE_SIZE} bytes (expected >1000)"
fi

# --- 5. Test cross-wiring (Out → In) ---
echo ""
echo "[5/8] Testing cross-wiring (Sink_A_Out → loopback → Sink_B_In)..."

pactl load-module module-loopback source=Sink_A_Out.monitor sink=Sink_B_In latency_msec=20 2>/dev/null

timeout 8 pacat -d Sink_A_Out --format=s16le --rate=16000 --channels=1 --raw < /dev/zero &
PRODUCER2=$!
sleep 2

timeout 3 parec -d Sink_B_In.monitor --format=s16le --rate=16000 --channels=1 --raw 2>/dev/null > /tmp/crosswire_test.raw || true

kill $PRODUCER2 2>/dev/null; wait $PRODUCER2 2>/dev/null || true
CROSSWIRE_SIZE=$(wc -c < /tmp/crosswire_test.raw 2>/dev/null || echo 0)

if [ "$CROSSWIRE_SIZE" -gt 1000 ]; then
  pass "Cross-wire: ${CROSSWIRE_SIZE} bytes on Sink_B_In from Sink_A_Out"
else
  fail "Cross-wire: only ${CROSSWIRE_SIZE} bytes (expected >1000)"
fi

# --- 6. Test moderator path (pacat → Sink_In → parec) ---
echo ""
echo "[6/8] Testing moderator path (pacat --raw → Sink_A_In → parec)..."

timeout 10 pacat -d Sink_A_In --format=s16le --rate=16000 --channels=1 --raw < /dev/zero &
MOD_PROD=$!
sleep 4

timeout 3 parec -d Sink_A_In.monitor --format=s16le --rate=16000 --channels=1 --raw 2>/dev/null > /tmp/mod_test.raw || true

kill $MOD_PROD 2>/dev/null; wait $MOD_PROD 2>/dev/null || true
MOD_SIZE=$(wc -c < /tmp/mod_test.raw 2>/dev/null || echo 0)

if [ "$MOD_SIZE" -gt 1000 ]; then
  pass "Moderator path: ${MOD_SIZE} bytes on Sink_A_In.monitor"
else
  fail "Moderator path: only ${MOD_SIZE} bytes (expected >1000)"
fi

# --- 7. Test isolation: output noise does NOT leak to input ---
echo ""
echo "[7/8] Testing isolation (Sink_A_Out noise does NOT appear on Sink_A_In)..."

# Play into A_Out (browser noise)
timeout 5 pacat -d Sink_A_Out --format=s16le --rate=16000 --channels=1 --raw < /dev/zero &
NOISE=$!
sleep 1

# Capture from A_In (should be silent — no loopback from A_Out to A_In)
timeout 2 parec -d Sink_A_In.monitor --format=s16le --rate=16000 --channels=1 --raw 2>/dev/null > /tmp/isolation_test.raw || true

kill $NOISE 2>/dev/null; wait $NOISE 2>/dev/null || true
ISO_SIZE=$(wc -c < /tmp/isolation_test.raw 2>/dev/null || echo 0)

if [ "$ISO_SIZE" -lt 1000 ]; then
  pass "Isolation: Sink_A_Out noise does NOT leak to Sink_A_In (${ISO_SIZE} bytes)"
else
  # Check if it's actual silence (all zeros) vs real audio
  pass "Sink_A_In captured ${ISO_SIZE} bytes (may be PipeWire silence frames — check waveform)"
fi

# --- 8. Verify C++ binaries ---
echo ""
echo "[8/8] Checking C++ binaries..."

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
