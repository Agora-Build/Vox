import fs from "fs";
import path from "path";

// A real stereo conversation for Tools → Analyze tests, built from corpus
// speech: the user's question on the left channel, a spoken reply on the right
// starting REPLY_GAP_S after the question ends, three turns. aeval measures a
// real response latency from it.

const AUDIO = path.resolve(__dirname, "../../vox_eval_agentd/aeval-data/corpus/turn_taking/en/audio");
const RATE = 16000;
export const REPLY_GAP_S = 0.8;

function readMono16k(file: string): Int16Array {
  const buf = fs.readFileSync(path.join(AUDIO, file));
  const v = new DataView(buf.buffer, buf.byteOffset, buf.length);
  let off = 12;
  let channels = 0, rate = 0, bits = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(off + 10, true);
      rate = v.getUint32(off + 12, true);
      bits = v.getUint16(off + 22, true);
    } else if (id === "data") {
      if (channels !== 1 || rate !== RATE || bits !== 16) throw new Error(`${file}: expected mono 16 kHz 16-bit`);
      return new Int16Array(buf.buffer.slice(buf.byteOffset + off + 8, buf.byteOffset + off + 8 + size));
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

/** Stereo 16 kHz 16-bit WAV bytes: left = user, right = agent. */
export function makeConversationWav(): Uint8Array {
  const user = readMono16k("en_question_short10.wav");
  const agent = readMono16k("Short10Wordswav6.wav");
  const s = (sec: number) => Math.round(sec * RATE);
  const turns: Array<{ userAt: number; agentAt: number }> = [];
  let t = s(0.5);
  for (let i = 0; i < 3; i++) {
    const agentAt = t + user.length + s(REPLY_GAP_S);
    turns.push({ userAt: t, agentAt });
    t = agentAt + agent.length + s(1.5);
  }
  const frames = t + s(0.5);
  const pcm = new Int16Array(frames * 2);
  for (const { userAt, agentAt } of turns) {
    user.forEach((x, i) => { pcm[(userAt + i) * 2] = x; });
    agent.forEach((x, i) => { pcm[(agentAt + i) * 2 + 1] = x; });
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}
