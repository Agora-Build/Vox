#!/bin/bash
# Audio pipeline integration test for the clash runner container.
# Tests the 4-sink design (Sink_A_Out, Sink_B_Out, Sink_A_In, Sink_B_In) with
# REAL audio signal: sox-generated tones + RMS non-silence assertions — a
# byte-count of silence proves only that bytes flowed, not that sound was heard.
#
# Run inside the container:
#   docker run --rm vox-clash-runner-test bash /app/audio/test-audio-pipeline.sh

set -uo pipefail

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)); }
fail() { echo "  FAIL: $1"; ((FAIL++)); }

RATE=16000
FMT_ARGS="--format=s16le --rate=${RATE} --channels=1"
SOX_RAW="-r ${RATE} -e signed -b 16 -c 1"

# RMS amplitude (0..1) of a raw s16le capture; 0 for missing/empty files.
rms_of() {
  local f="$1"
  if [ ! -s "$f" ]; then echo 0; return; fi
  sox ${SOX_RAW} "$f" -n stat 2>&1 | awk '/RMS.*amplitude/ {print $3; exit}'
}

# assert_rms <file> <op> <threshold> <label>   (op: gt | lt)
assert_rms() {
  local f="$1" op="$2" threshold="$3" label="$4"
  local rms
  rms=$(rms_of "$f")
  if awk -v r="$rms" -v t="$threshold" -v o="$op" 'BEGIN{ exit !((o=="gt" && r>t) || (o=="lt" && r<t)) }'; then
    pass "$label (RMS=$rms)"
  else
    fail "$label (RMS=$rms, wanted $op $threshold)"
  fi
}

loopback_count() {
  pactl list short modules 2>/dev/null | awk -F'\t' '$2=="module-loopback"' | wc -l
}

echo "=== Audio Pipeline Test (4-sink design, real-signal) ==="
echo ""

# --- 1. Start PipeWire stack ---
echo "[1/9] Starting PipeWire stack..."
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

# Test tones: distinct frequencies so cross-wire directions can't be confused.
sox -n ${SOX_RAW} /tmp/tone_a.raw synth 8 sine 440 vol 0.5
sox -n ${SOX_RAW} /tmp/tone_b.raw synth 8 sine 880 vol 0.5

# --- 2. Verify all 4 sinks ---
echo ""
echo "[2/9] Checking 4 sinks..."

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

# Mic capture sources (remap of the input-sink monitors) — the fix for silent
# agents: Chromium won't expose a raw .monitor as a microphone, so the agent's
# getUserMedia needs these named sources or it fails with NotFoundError.
for MIC in Mic_A Mic_B; do
  if echo "$SOURCES" | grep -q "$MIC"; then
    pass "$MIC capture source available"
  else
    fail "$MIC capture source missing (agent would have no microphone)"
  fi
done

# The remap must actually carry audio: a tone played into Sink_A_In has to appear
# on Mic_A — that is how the agent hears the moderator/opponent.
timeout 6 pacat -d Sink_A_In ${FMT_ARGS} --raw < /tmp/tone_a.raw &
MIC_PROD=$!
sleep 1
timeout 3 parec -d Mic_A ${FMT_ARGS} --raw 2>/dev/null > /tmp/mic_a_flow.raw || true
kill $MIC_PROD 2>/dev/null; wait $MIC_PROD 2>/dev/null || true
assert_rms /tmp/mic_a_flow.raw gt 0.05 "Mic_A carries audio played into Sink_A_In"

# --- 3. Output playback + monitor capture with REAL signal (both agents) ---
echo ""
echo "[3/9] Output sinks: real tone in, non-silent monitor capture out..."

for AGENT in A B; do
  TONE="/tmp/tone_a.raw"; [ "$AGENT" = "B" ] && TONE="/tmp/tone_b.raw"
  timeout 8 pacat -d "Sink_${AGENT}_Out" ${FMT_ARGS} --raw < "$TONE" &
  PRODUCER=$!
  sleep 1
  timeout 3 parec -d "Sink_${AGENT}_Out.monitor" ${FMT_ARGS} --raw 2>/dev/null > "/tmp/capture_${AGENT}.raw" || true
  kill $PRODUCER 2>/dev/null; wait $PRODUCER 2>/dev/null || true
  assert_rms "/tmp/capture_${AGENT}.raw" gt 0.05 "Sink_${AGENT}_Out.monitor carries real signal"
done

# --- 4. Cross-wire BOTH directions with distinct tones ---
echo ""
echo "[4/9] Cross-wiring both directions (A_Out→B_In @440Hz, B_Out→A_In @880Hz)..."

LOOP_AB=$(pactl load-module module-loopback source=Sink_A_Out.monitor sink=Sink_B_In latency_msec=20 2>/dev/null)
LOOP_BA=$(pactl load-module module-loopback source=Sink_B_Out.monitor sink=Sink_A_In latency_msec=20 2>/dev/null)

if [ -n "$LOOP_AB" ] && [ -n "$LOOP_BA" ]; then
  pass "Both loopback modules loaded (ids: $LOOP_AB, $LOOP_BA)"
else
  fail "Loopback load failed (ids: '$LOOP_AB', '$LOOP_BA')"
fi

# A speaks → B hears
timeout 8 pacat -d Sink_A_Out ${FMT_ARGS} --raw < /tmp/tone_a.raw &
PROD_A=$!
sleep 2
timeout 3 parec -d Sink_B_In.monitor ${FMT_ARGS} --raw 2>/dev/null > /tmp/crosswire_ab.raw || true
kill $PROD_A 2>/dev/null; wait $PROD_A 2>/dev/null || true
assert_rms /tmp/crosswire_ab.raw gt 0.05 "Cross-wire A→B: B hears A's tone"

# B speaks → A hears
timeout 8 pacat -d Sink_B_Out ${FMT_ARGS} --raw < /tmp/tone_b.raw &
PROD_B=$!
sleep 2
timeout 3 parec -d Sink_A_In.monitor ${FMT_ARGS} --raw 2>/dev/null > /tmp/crosswire_ba.raw || true
kill $PROD_B 2>/dev/null; wait $PROD_B 2>/dev/null || true
assert_rms /tmp/crosswire_ba.raw gt 0.05 "Cross-wire B→A: A hears B's tone"

# --- 5. Teardown / warm-pool leak guard ---
echo ""
echo "[5/9] Loopback teardown (warm-pool leak guard)..."

pactl unload-module "$LOOP_AB" 2>/dev/null
pactl unload-module "$LOOP_BA" 2>/dev/null

if [ "$(loopback_count)" -eq 0 ]; then
  pass "All loopbacks unloaded after match teardown"
else
  fail "Loopback modules leaked after unload ($(loopback_count) remain)"
fi

# Simulate two more warm-pool matches: wire → assert exactly 2 → unwire.
LEAK_OK=1
for MATCH in 2 3; do
  M1=$(pactl load-module module-loopback source=Sink_A_Out.monitor sink=Sink_B_In latency_msec=20 2>/dev/null)
  M2=$(pactl load-module module-loopback source=Sink_B_Out.monitor sink=Sink_A_In latency_msec=20 2>/dev/null)
  if [ "$(loopback_count)" -ne 2 ]; then
    LEAK_OK=0
    fail "Match #$MATCH: expected exactly 2 loopbacks, found $(loopback_count)"
  fi
  pactl unload-module "$M1" 2>/dev/null
  pactl unload-module "$M2" 2>/dev/null
done
if [ "$LEAK_OK" -eq 1 ] && [ "$(loopback_count)" -eq 0 ]; then
  pass "Warm-pool simulation: loopback count stable at 2 per match, 0 after"
else
  fail "Warm-pool simulation: loopback accumulation detected"
fi

# --- 6. Moderator path into BOTH agent mics ---
echo ""
echo "[6/9] Moderator path (pacat → Sink_A_In AND Sink_B_In → monitors)..."

for AGENT in A B; do
  timeout 8 pacat -d "Sink_${AGENT}_In" ${FMT_ARGS} --raw < /tmp/tone_a.raw &
  MOD_PROD=$!
  sleep 2
  timeout 3 parec -d "Sink_${AGENT}_In.monitor" ${FMT_ARGS} --raw 2>/dev/null > "/tmp/mod_${AGENT}.raw" || true
  kill $MOD_PROD 2>/dev/null; wait $MOD_PROD 2>/dev/null || true
  assert_rms "/tmp/mod_${AGENT}.raw" gt 0.05 "Agent ${AGENT} mic hears moderator tone"
done

# --- 7. Isolation: A's own output must NOT reach A's mic ---
echo ""
echo "[7/9] Isolation (Sink_A_Out tone must NOT appear on Sink_A_In)..."
# No loopbacks are loaded at this point (step 5 removed them), so A's mic
# monitor must be silent while A's output carries a loud tone. This is a REAL
# assertion — a leak (RMS above the silence floor) fails the suite.

timeout 6 pacat -d Sink_A_Out ${FMT_ARGS} --raw < /tmp/tone_a.raw &
NOISE=$!
sleep 1
timeout 2 parec -d Sink_A_In.monitor ${FMT_ARGS} --raw 2>/dev/null > /tmp/isolation_test.raw || true
kill $NOISE 2>/dev/null; wait $NOISE 2>/dev/null || true

assert_rms /tmp/isolation_test.raw lt 0.02 "Sink_A_Out audio does not leak into Sink_A_In"

# --- 8. sox stereo merge (recording pipeline) ---
echo ""
echo "[8/9] Recording merge (sox -M A B → stereo, + moderator mix)..."

sox -M ${SOX_RAW} /tmp/tone_a.raw ${SOX_RAW} /tmp/tone_b.raw /tmp/rec_stereo.wav 2>/dev/null
if [ -s /tmp/rec_stereo.wav ] && [ "$(soxi -c /tmp/rec_stereo.wav 2>/dev/null)" = "2" ]; then
  pass "Stereo merge produced a 2-channel WAV"
else
  fail "Stereo merge failed"
fi

# Moderator mixed into both channels (as stopRecording does)
sox ${SOX_RAW} /tmp/tone_a.raw /tmp/mod_stereo.wav remix 1 1 2>/dev/null
sox -m /tmp/rec_stereo.wav /tmp/mod_stereo.wav /tmp/rec_full.wav 2>/dev/null
if [ -s /tmp/rec_full.wav ] && [ "$(soxi -c /tmp/rec_full.wav 2>/dev/null)" = "2" ]; then
  pass "Moderator mix produced the whole-voice recording"
else
  fail "Moderator mix failed"
fi

# --- 9. Verify C++ binaries ---
echo ""
echo "[9/9] Checking C++ binaries..."

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

if echo "$RECV_OUT" | grep -qi "filterUid"; then
  pass "agora-receiver supports --filterUid (moderator→agents contract)"
else
  fail "agora-receiver missing --filterUid support"
fi

# --- Summary ---
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
