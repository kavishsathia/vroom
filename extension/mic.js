let micStream = null;
let audioContext = null;
let processor = null;
let chunkCount = 0;

const port = chrome.runtime.connect({ name: 'mic' });
const statusEl = document.getElementById('status');

startMic();

// Listen for stop command
port.onMessage.addListener((msg) => {
  if (msg.type === 'stop_mic') {
    stopMic();
    window.close();
  }
});

async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext({ sampleRate: 16000 });
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
      port.postMessage({ type: 'audio_chunk', data: base64 });
      chunkCount++;
    };

    statusEl.textContent = 'Recording...';
    statusEl.className = 'recording';
    port.postMessage({ type: 'mic_started' });
  } catch (err) {
    statusEl.textContent = 'Mic error: ' + err.message;
    port.postMessage({ type: 'mic_error', error: err.message });
  }
}

function stopMic() {
  if (processor) { processor.disconnect(); processor = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
