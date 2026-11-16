// Generates e2e/fixtures/tone-440hz-16k-mono.wav: 2 s of a 440 Hz sine, 16 kHz, mono, 16-bit PCM.
// Synthesised here, so there is no third-party licence to track. Run: node e2e/fixtures/make-tone.mjs
import { writeFileSync } from "node:fs";

const sampleRate = 16000;
const seconds = 2;
const samples = sampleRate * seconds;
const data = Buffer.alloc(samples * 2);
for (let i = 0; i < samples; i++) {
  data.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), i * 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16); // fmt chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write("data", 36);
header.writeUInt32LE(data.length, 40);
writeFileSync(new URL("./tone-440hz-16k-mono.wav", import.meta.url), Buffer.concat([header, data]));
