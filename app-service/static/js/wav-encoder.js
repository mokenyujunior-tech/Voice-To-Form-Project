/**
 * wav-encoder.js — Convert recorded audio to WAV (16 kHz mono 16-bit PCM)
 *
 * WHY THIS EXISTS:
 * The browser's MediaRecorder produces webm/opus (or mp4 on iOS). The Azure
 * Speech SDK's file input only accepts WAV/PCM and throws
 * SPXERR_INVALID_HEADER on anything else. So we decode the recording with the
 * Web Audio API and re-encode it as a WAV the Speech SDK can read.
 *
 * Exposes: window.WAV.fromBlob(blob) -> Promise<Blob>  (a WAV blob)
 */

window.WAV = (() => {
  const TARGET_SAMPLE_RATE = 16000;   // Azure Speech wants 16 kHz

  /**
   * Decode an audio Blob (webm/opus/mp4/…) into an AudioBuffer, downmix to
   * mono, resample to 16 kHz, and encode as a 16-bit PCM WAV Blob.
   */
  async function fromBlob(blob) {
    const arrayBuffer = await blob.arrayBuffer();

    // Decode using an AudioContext (handles whatever format the browser recorded)
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const decodeCtx = new AudioCtx();
    let audioBuffer;
    try {
      audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
    } finally {
      // Close decode context to free resources
      if (decodeCtx.state !== 'closed') decodeCtx.close();
    }

    // Downmix to mono
    const mono = downmixToMono(audioBuffer);

    // Resample to 16 kHz using an OfflineAudioContext
    const resampled = await resample(mono, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);

    // Encode to 16-bit PCM WAV
    const wavBytes = encodeWav(resampled, TARGET_SAMPLE_RATE);
    return new Blob([wavBytes], { type: 'audio/wav' });
  }

  function downmixToMono(audioBuffer) {
    const chs = audioBuffer.numberOfChannels;
    if (chs === 1) return audioBuffer.getChannelData(0);

    const len = audioBuffer.length;
    const out = new Float32Array(len);
    for (let c = 0; c < chs; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < len; i++) out[i] += data[i] / chs;
    }
    return out;
  }

  async function resample(monoFloat32, fromRate, toRate) {
    if (fromRate === toRate) return monoFloat32;

    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const frames = Math.ceil(monoFloat32.length * toRate / fromRate);
    const offline = new OfflineCtx(1, frames, toRate);

    // Put the mono data into a buffer at the source rate
    const srcBuffer = offline.createBuffer(1, monoFloat32.length, fromRate);
    srcBuffer.copyToChannel(monoFloat32, 0);

    const src = offline.createBufferSource();
    src.buffer = srcBuffer;
    src.connect(offline.destination);
    src.start(0);

    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  function encodeWav(samples, sampleRate) {
    // 16-bit PCM
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample;           // mono
    const dataSize = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    let off = 0;
    const writeStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i)); };
    const writeU32 = (v) => { view.setUint32(off, v, true); off += 4; };
    const writeU16 = (v) => { view.setUint16(off, v, true); off += 2; };

    // RIFF header
    writeStr('RIFF');
    writeU32(36 + dataSize);
    writeStr('WAVE');
    // fmt chunk
    writeStr('fmt ');
    writeU32(16);                 // PCM chunk size
    writeU16(1);                  // audio format = PCM
    writeU16(1);                  // channels = mono
    writeU32(sampleRate);
    writeU32(sampleRate * blockAlign); // byte rate
    writeU16(blockAlign);
    writeU16(16);                 // bits per sample
    // data chunk
    writeStr('data');
    writeU32(dataSize);

    // PCM samples (clamp float -1..1 → int16)
    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(off, s, true);
      off += 2;
    }

    return new Uint8Array(buffer);
  }

  return { fromBlob };
})();
