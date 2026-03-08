let micStream = null;
let audioContext = null;
let processor = null;
let chunkCount = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start_mic') {
    startMic();
    sendResponse({ success: true });
  } else if (msg.type === 'stop_mic') {
    stopMic();
    sendResponse({ success: true });
  }
  return true;
});

async function startMic() {
  try {
    console.log('[offscreen] Requesting mic...');
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log('[offscreen] Got mic stream, tracks:', micStream.getAudioTracks().length);
    audioContext = new AudioContext({ sampleRate: 16000 });
    console.log('[offscreen] AudioContext state:', audioContext.state, 'sampleRate:', audioContext.sampleRate);
    const source = audioContext.createMediaStreamSource(micStream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    chunkCount = 0;
    processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      const base64 = arrayBufferToBase64(int16.buffer);
      chrome.runtime.sendMessage({ type: 'audio_chunk', data: base64 });
      chunkCount++;
      if (chunkCount % 10 === 0) console.log(`[offscreen] Sent ${chunkCount} audio chunks`);
    };

    console.log('[offscreen] Mic started');
  } catch (err) {
    console.error('[offscreen] Mic error:', err);
  }
}

function stopMic() {
  if (processor) { processor.disconnect(); processor = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  console.log('[offscreen] Mic stopped');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
