// Regenerate the committed synthetic fixtures with FFmpeg (not needed to run tests).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const generate = (name, expression, duration, channels, extra = [], codec = ["-c:a", "libopus", "-b:a", "48k"]) => execFileSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
  `aevalsrc='${expression}':s=48000:d=${duration}:c=${channels}`,
  ...codec, ...extra, `${directory}${name}`,
]);
const stereo = "if(lt(t,6),0.6*sin(2*PI*220*t),0)|if(gte(t,6),0.3*sin(2*PI*440*t),0)";
generate("stereo.webm", stereo, 12, "stereo");
generate("stereo-live.webm", stereo, 12, "stereo", ["-live", "1"]);
generate("six-channel.webm", Array.from({ length: 6 }, (_, channel) => `${0.1 * (channel + 1)}*sin(2*PI*${220 + channel * 100}*t)`).join("|"), 3, "5.1");
generate("long-stereo.webm", "if(lt(mod(t,8),4),0.6*sin(2*PI*220*t),0)|if(gte(mod(t,8),4),0.3*sin(2*PI*440*t),0)", 82, "stereo", ["-live", "1"]);
for (const [extension, codec] of [
  ["mp3", ["-c:a", "libmp3lame", "-b:a", "64k"]],
  ["mp4", ["-c:a", "aac", "-b:a", "64k"]],
  ["m4a", ["-c:a", "aac", "-b:a", "64k"]],
  ["aac", ["-c:a", "aac", "-b:a", "64k"]],
  ["ogg", ["-c:a", "libopus", "-b:a", "48k"]],
  ["flac", ["-c:a", "flac"]],
]) generate(`stereo.${extension}`, stereo.replaceAll("t,6", "t,1.5"), 3, "stereo", [], codec);
