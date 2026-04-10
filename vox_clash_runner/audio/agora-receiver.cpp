// agora-receiver.cpp — Subscribes to an Agora RTC channel and writes received
// audio as raw PCM (s16le) to stdout. Used to route the moderator's voice
// into PipeWire virtual sinks so agent browsers can hear it.
//
// Usage:
//   agora-receiver --appId <id> --token <token> --channelId <channel> --userId <uid> \
//     | pacat -d Virtual_Sink_A --format=s16le --rate=16000 --channels=1
//
// Exits on SIGTERM, SIGINT, or connection loss.

#include <csignal>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <sstream>
#include <string>
#include <unistd.h>
#include <atomic>
#include <mutex>

#include "AgoraBase.h"
#include "AgoraRefCountedObject.h"
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
#include "common/sample_local_user_observer.h"

#define DEFAULT_CONNECT_TIMEOUT_MS (5000)
#define DEFAULT_SAMPLE_RATE (16000)
#define DEFAULT_NUM_OF_CHANNELS (1)

struct Options {
  std::string appId;
  std::string token;
  std::string channelId;
  std::string userId;
  std::string filterUid;  // Only output audio from this UID (empty = all)
  int sampleRate = DEFAULT_SAMPLE_RATE;
  int numOfChannels = DEFAULT_NUM_OF_CHANNELS;
};

static volatile bool g_running = true;

static void signalHandler(int sigNo) {
  AG_LOG(INFO, "Signal %d received, shutting down...", sigNo);
  g_running = false;
}

// Audio frame observer: writes received PCM to stdout, filtered by UID
class StdoutPcmObserver : public agora::media::IAudioFrameObserverBase {
 public:
  StdoutPcmObserver(const std::string& filterUid = "")
      : frameCount_(0), filterUid_(filterUid) {}

  bool onPlaybackAudioFrameBeforeMixing(
      const char* channelId,
      agora::media::base::user_id_t userId,
      AudioFrame& audioFrame) override {
    // If filter is set, only output audio from that specific user
    if (!filterUid_.empty() && std::string(userId) != filterUid_) {
      return true;
    }

    size_t writeBytes =
        audioFrame.samplesPerChannel * audioFrame.channels * sizeof(int16_t);
    if (fwrite(audioFrame.buffer, 1, writeBytes, stdout) != writeBytes) {
      AG_LOG(ERROR, "Failed to write PCM to stdout");
      return false;
    }
    fflush(stdout);
    frameCount_++;
    if (frameCount_ % 1000 == 0) {
      AG_LOG(INFO, "Received %lu audio frames from user %s (%lu total)",
             frameCount_, userId, frameCount_);
    }
    return true;
  }

  bool onPlaybackAudioFrame(const char* channelId, AudioFrame& audioFrame) override { return true; }
  bool onRecordAudioFrame(const char* channelId, AudioFrame& audioFrame) override { return true; }
  bool onMixedAudioFrame(const char* channelId, AudioFrame& audioFrame) override { return true; }
  bool onEarMonitoringAudioFrame(AudioFrame& audioFrame) override { return true; }
  AudioParams getEarMonitoringAudioParams() override { return AudioParams(); }
  int getObservedAudioFramePosition() override { return 0; }
  AudioParams getPlaybackAudioParams() override { return AudioParams(); }
  AudioParams getRecordAudioParams() override { return AudioParams(); }
  AudioParams getMixedAudioParams() override { return AudioParams(); }

 private:
  uint64_t frameCount_;
  std::string filterUid_;
};


int main(int argc, char* argv[]) {
  Options opts;
  opt_parser optParser;

  optParser.add_long_opt("appId", &opts.appId, "Agora App ID / must");
  optParser.add_long_opt("token", &opts.token, "Agora RTC token / must");
  optParser.add_long_opt("channelId", &opts.channelId, "Channel name / must");
  optParser.add_long_opt("userId", &opts.userId, "User ID / must");
  optParser.add_long_opt("filterUid", &opts.filterUid, "Only output audio from this UID (default: all)");
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

  std::signal(SIGTERM, signalHandler);
  std::signal(SIGINT, signalHandler);
  std::signal(SIGQUIT, signalHandler);

  // --- Initialize Agora Service ---
  int buildNum = 0;
  const char* sdkVersion = getAgoraSdkVersion(&buildNum);
  AG_LOG(INFO, "Agora SDK version: %s, build: %d", sdkVersion, buildNum);
  AG_LOG(INFO, "Initializing receiver (appId=%.8s...)", opts.appId.c_str());

  agora::base::IAgoraService* service = createAndInitAgoraService(
      false, true, false, false, false, opts.appId.c_str());
  if (!service) {
    AG_LOG(ERROR, "Failed to create Agora service");
    return 1;
  }

  // --- Create RTC Connection (audience, subscribe audio) ---
  agora::rtc::RtcConnectionConfiguration ccfg;
  ccfg.clientRoleType = agora::rtc::CLIENT_ROLE_AUDIENCE;
  ccfg.autoSubscribeAudio = true;
  ccfg.autoSubscribeVideo = false;
  ccfg.enableAudioRecordingOrPlayout = false;

  agora::agora_refptr<agora::rtc::IRtcConnection> connection =
      service->createRtcConnection(ccfg);
  if (!connection) {
    AG_LOG(ERROR, "Failed to create RTC connection");
    service->release();
    return 1;
  }

  auto connObserver = std::make_shared<SampleConnectionObserver>();
  connection->registerObserver(connObserver.get());

  // --- Setup audio frame observer ---
  auto localUserObserver =
      std::make_shared<SampleLocalUserObserver>(connection->getLocalUser());

  auto pcmObserver = std::make_shared<StdoutPcmObserver>(opts.filterUid);
  if (!opts.filterUid.empty()) {
    AG_LOG(INFO, "Filtering audio to UID: %s only", opts.filterUid.c_str());
  }
  if (connection->getLocalUser()->setPlaybackAudioFrameBeforeMixingParameters(
          opts.numOfChannels, opts.sampleRate)) {
    AG_LOG(ERROR, "Failed to set audio frame parameters");
    service->release();
    return 1;
  }
  localUserObserver->setAudioFrameObserver(pcmObserver.get());

  // --- Connect ---
  AG_LOG(INFO, "Connecting to channel '%s' as userId '%s' (audience)...",
         opts.channelId.c_str(), opts.userId.c_str());
  if (connection->connect(opts.token.c_str(), opts.channelId.c_str(),
                          opts.userId.c_str())) {
    AG_LOG(ERROR, "Failed to connect to channel");
    service->release();
    return 1;
  }

  if (connObserver->waitUntilConnected(DEFAULT_CONNECT_TIMEOUT_MS) != 0) {
    AG_LOG(ERROR, "Connection timeout after %d ms", DEFAULT_CONNECT_TIMEOUT_MS);
    connection->disconnect();
    service->release();
    return 1;
  }
  AG_LOG(INFO, "Connected! Receiving audio (rate=%d, channels=%d)...",
         opts.sampleRate, opts.numOfChannels);

  // --- Wait for shutdown ---
  while (g_running) {
    usleep(100000);  // 100ms
  }

  // --- Cleanup ---
  AG_LOG(INFO, "Shutting down receiver...");
  localUserObserver->unsetAudioFrameObserver();
  connection->unregisterObserver(connObserver.get());
  connection->disconnect();

  localUserObserver.reset();
  pcmObserver.reset();
  connObserver.reset();
  connection = nullptr;
  service->release();

  AG_LOG(INFO, "Clean shutdown complete");
  return 0;
}
