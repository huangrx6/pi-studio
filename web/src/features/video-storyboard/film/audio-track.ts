import { AdtsOutputFormat, AudioBufferSource, EncodedAudioPacketSource, NullTarget, Output, type EncodedPacket } from 'mediabunny';

// AAC encoders produce whole packets, including priming before frame zero and padding after the edit.
// Keep the priming timestamps for gapless decoding, and end the MP4 track on the last picture.
export function filmAudio(seconds: number) {
  const track = new EncodedAudioPacketSource('aac');
  const encoder = new Output({ format: new AdtsOutputFormat(), target: new NullTarget() });
  const packets: { packet: EncodedPacket; meta?: EncodedAudioChunkMetadata }[] = [];
  const source = new AudioBufferSource({
    codec: 'aac', bitrate: 128000,
    onEncodedPacket(packet, meta) {
      const remaining = seconds - packet.timestamp;
      if (remaining <= 0) return;
      packets.push({ packet: remaining < packet.duration ? packet.clone({ duration: remaining }) : packet, meta });
    },
  });
  encoder.addAudioTrack(source);
  async function drain() {
    for (const { packet, meta } of packets.splice(0)) await track.add(packet, meta);
  }
  return {
    track,
    start: () => encoder.start(),
    async add(buffer: AudioBuffer) {
      await source.add(buffer);
      await drain();
    },
    async finish() {
      await encoder.finalize();
      await drain();
    },
    async dispose() { if (encoder.state === 'started') await encoder.cancel(); },
  };
}
