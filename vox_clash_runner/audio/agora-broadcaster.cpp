// agora-broadcaster.cpp — Lightweight audio broadcaster using Agora Server Gateway SDK.
//
// Reads raw PCM audio from stdin (piped from pw-cat) and publishes it to an
// Agora RTC channel.
//
// Usage:
//   pw-cat --record --target=Virtual_Sink_A.monitor --format=s16 --rate=16000 --channels=1 - \
//     | agora-broadcaster --appId <id> --token <token> --channelId <channel> --userId <uid>
//
// Exits on SIGTERM, SIGINT, or stdin EOF.

#include <csignal>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <string>
#include <unistd.h>
#include <chrono>
#include <thread>

#include "AgoraBase.h"
#include "IAgoraService.h"
#include "NGIAgoraAudioTrack.h"
#include "NGIAgoraLocalUser.h"
#include "NGIAgoraMediaNode.h"
#include "NGIAgoraMediaNodeFactory.h"
#include "NGIAgoraRtcConnection.h"
#include "common/helper.h"
#include "common/log.h"
#include "common/opt_parser.h"
#include "common/sample_common.h"
#include "common/sample_connection_observer.h"

#define DEFAULT_CONNECT_TIMEOUT_MS (5000)
#define DEFAULT_SAMPLE_RATE (16000)
#define DEFAULT_NUM_OF_CHANNELS (1)
#define FRAME_DURATION_MS (10)

struct Options {
  std::string appId;
  std::string token;
  std::string channelId;
  std::string userId;
  int sampleRate = DEFAULT_SAMPLE_RATE;
  int numOfChannels = DEFAULT_NUM_OF_CHANNELS;
};

static volatile bool g_running = true;

static void signalHandler(int sigNo) {
  AG_LOG(INFO, "Signal %d received, shutting down...", sigNo);
  g_running = false;
}

// Read exactly `count` bytes from fd, handling partial reads.
// Returns number of bytes read (< count means EOF or error).
static size_t readExact(int fd, uint8_t* buf, size_t count) {
  size_t total = 0;
  while (total < count && g_running) {
    ssize_t n = read(fd, buf + total, count - total);
    if (n <= 0) break;  // EOF or error
    total += n;
  }
  return total;
}

int main(int argc, char* argv[]) {
  Options opts;
  opt_parser optParser;

  optParser.add_long_opt("appId", &opts.appId, "Agora App ID / must");
  optParser.add_long_opt("token", &opts.token, "Agora RTC token / must");
  optParser.add_long_opt("channelId", &opts.channelId, "Channel name / must");
  optParser.add_long_opt("userId", &opts.userId, "User ID / must");
  optParser.add_long_opt("sampleRate", &opts.sampleRate, "PCM sample rate (default 16000)");
  optParser.add_long_opt("numOfChannels", &opts.numOfChannels, "Number of channels (default 1)");

  if (argc <= 1 || !optParser.parse_opts(argc, argv)) {
    std::ostringstream ss;
    optParser.print_usage(argv[0], ss);
    fprintf(stderr, "%s\n", ss.str().c_str());
    return 1;
  }

  if (opts.appId.empty() || opts.token.empty() || opts.channelId.empty() || opts.userId.empty()) {
    AG_LOG(ERROR, "appId, token, channelId, and userId are all required");
    return 1;
  }

  // Signal handlers for graceful shutdown
  std::signal(SIGTERM, signalHandler);
  std::signal(SIGINT, signalHandler);
  std::signal(SIGQUIT, signalHandler);

  // --- Initialize Agora Service ---
  int buildNum = 0;
  const char* sdkVersion = getAgoraSdkVersion(&buildNum);
  AG_LOG(INFO, "Agora SDK version: %s, build: %d", sdkVersion, buildNum);
  AG_LOG(INFO, "Initializing Agora service (appId=%.8s...)", opts.appId.c_str());
  agora::base::IAgoraService* service = createAndInitAgoraService(
      false,  // enableAudioDevice — we push PCM manually
      true,   // enableAudioProcessor
      false,  // enableVideo
      false,  // enableuseStringUid
      false,  // enablelowDelay
      opts.appId.c_str()
  );
  if (!service) {
    AG_LOG(ERROR, "Failed to create Agora service");
    return 1;
  }

  // --- Create RTC Connection ---
  agora::rtc::RtcConnectionConfiguration ccfg;
  ccfg.autoSubscribeAudio = false;
  ccfg.autoSubscribeVideo = false;
  ccfg.clientRoleType = agora::rtc::CLIENT_ROLE_BROADCASTER;

  agora::agora_refptr<agora::rtc::IRtcConnection> connection =
      service->createRtcConnection(ccfg);
  if (!connection) {
    AG_LOG(ERROR, "Failed to create RTC connection");
    service->release();
    return 1;
  }

  // --- Register Connection Observer ---
  auto connObserver = std::make_shared<SampleConnectionObserver>();
  connection->registerObserver(connObserver.get());

  // --- Connect to Channel ---
  AG_LOG(INFO, "Connecting to channel '%s' as userId '%s'...",
         opts.channelId.c_str(), opts.userId.c_str());
  if (connection->connect(opts.token.c_str(), opts.channelId.c_str(),
                          opts.userId.c_str())) {
    AG_LOG(ERROR, "Failed to connect to channel");
    connection->unregisterObserver(connObserver.get());
    service->release();
    return 1;
  }

  // --- Create PCM Sender + Audio Track ---
  agora::agora_refptr<agora::rtc::IMediaNodeFactory> factory =
      service->createMediaNodeFactory();
  if (!factory) {
    AG_LOG(ERROR, "Failed to create media node factory");
    connection->disconnect();
    service->release();
    return 1;
  }

  agora::agora_refptr<agora::rtc::IAudioPcmDataSender> pcmSender =
      factory->createAudioPcmDataSender();
  if (!pcmSender) {
    AG_LOG(ERROR, "Failed to create PCM data sender");
    connection->disconnect();
    service->release();
    return 1;
  }

  agora::agora_refptr<agora::rtc::ILocalAudioTrack> audioTrack =
      service->createCustomAudioTrack(pcmSender);
  if (!audioTrack) {
    AG_LOG(ERROR, "Failed to create audio track");
    connection->disconnect();
    service->release();
    return 1;
  }

  // Enable and publish
  audioTrack->setEnabled(true);
  connection->getLocalUser()->publishAudio(audioTrack);

  // --- Wait for Connection ---
  if (connObserver->waitUntilConnected(DEFAULT_CONNECT_TIMEOUT_MS) != 0) {
    AG_LOG(ERROR, "Connection timeout after %d ms", DEFAULT_CONNECT_TIMEOUT_MS);
    connection->getLocalUser()->unpublishAudio(audioTrack);
    audioTrack->setEnabled(false);
    connection->disconnect();
    service->release();
    return 1;
  }
  AG_LOG(INFO, "Connected! Publishing audio (rate=%d, channels=%d)...",
         opts.sampleRate, opts.numOfChannels);

  // --- Read PCM from stdin and send ---
  // 10ms frame: sampleRate/100 samples * numOfChannels * 2 bytes (int16)
  const int samplesPerFrame = opts.sampleRate / 100;  // e.g., 160 samples @ 16kHz
  const int frameBytes = samplesPerFrame * opts.numOfChannels * sizeof(int16_t);
  uint8_t frameBuf[frameBytes];

  PacerInfo pacer = {0, FRAME_DURATION_MS, 0, std::chrono::steady_clock::now()};
  uint64_t frameCount = 0;

  while (g_running) {
    size_t bytesRead = readExact(STDIN_FILENO, frameBuf, frameBytes);
    if (bytesRead < (size_t)frameBytes) {
      if (bytesRead == 0) {
        AG_LOG(INFO, "stdin EOF — stopping");
      } else {
        AG_LOG(WARNING, "Partial read (%zu/%d bytes) — stopping", bytesRead, frameBytes);
      }
      break;
    }

    if (pcmSender->sendAudioPcmData(
            frameBuf, 0, 0, samplesPerFrame,
            agora::rtc::TWO_BYTES_PER_SAMPLE,
            opts.numOfChannels, opts.sampleRate) < 0) {
      AG_LOG(ERROR, "Failed to send audio frame");
    }

    frameCount++;
    if (frameCount % 1000 == 0) {  // Log every 10 seconds
      AG_LOG(INFO, "Sent %lu frames (%.1f seconds)",
             frameCount, (double)frameCount * FRAME_DURATION_MS / 1000.0);
    }

    waitBeforeNextSend(pacer);
  }

  // --- Cleanup ---
  AG_LOG(INFO, "Shutting down after %lu frames (%.1f seconds)...",
         frameCount, (double)frameCount * FRAME_DURATION_MS / 1000.0);

  connection->getLocalUser()->unpublishAudio(audioTrack);
  audioTrack->setEnabled(false);
  connection->unregisterObserver(connObserver.get());
  connection->disconnect();

  connObserver.reset();
  pcmSender = nullptr;
  audioTrack = nullptr;
  factory = nullptr;
  connection = nullptr;

  service->release();
  service = nullptr;

  AG_LOG(INFO, "Clean shutdown complete");
  return 0;
}
