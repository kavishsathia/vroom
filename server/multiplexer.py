import asyncio
import base64
import time
from google import genai
from google.genai import types


SAMPLE_RATE = 24000
SAMPLE_WIDTH = 2  # 16-bit
CHANNELS = 1
BYTES_PER_SECOND = SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS  # 48000


class Multiplexer:
    def __init__(self, on_message=None, on_audio=None, on_state_change=None, voice="Kore"):
        self.conversation = []  # [{agent_id, message, timestamp}]
        self.read_pointers = {}  # agent_id -> int
        self._spotlight = None  # agent_id currently generating TTS
        self._audio_free_at = 0  # monotonic time when current audio finishes
        self._on_message = on_message  # callback(agent_id, message)
        self._on_audio = on_audio  # async callback(agent_id, audio_b64, duration)
        self._on_state_change = on_state_change  # async callback(agent_id, state)
        self._voice = voice
        self._client = genai.Client()

    def register(self, agent_id):
        self.read_pointers[agent_id] = len(self.conversation)

    def unregister(self, agent_id):
        self.read_pointers.pop(agent_id, None)

    def get_context(self, agent_id):
        """Get unread messages for an agent."""
        pointer = self.read_pointers.get(agent_id, 0)
        unread = self.conversation[pointer:]
        self.read_pointers[agent_id] = len(self.conversation)
        return {
            "unread_messages": [
                {"agent": m["agent_id"], "message": m["message"]}
                for m in unread
                if m["agent_id"] != agent_id
            ],
        }

    async def try_speak(self, agent_id, message):
        """Try to claim spotlight and speak. Returns (success, None).
        Spotlight covers TTS generation only. While previous audio plays,
        one agent can generate TTS in parallel. A third agent is rejected."""
        if self._spotlight is not None:
            print(f"[mux] {agent_id} rejected — {self._spotlight} is generating TTS")
            return False, None

        # Claim spotlight (for TTS generation)
        self._spotlight = agent_id
        print(f"[mux] Spotlight -> {agent_id}")
        if self._on_state_change:
            await self._on_state_change(agent_id, "spotlight")

        # Record message
        self.conversation.append({
            "agent_id": agent_id,
            "message": message,
            "timestamp": time.time(),
        })
        if self._on_message:
            self._on_message(agent_id, message)

        # Generate TTS (can overlap with previous audio playback)
        try:
            audio_bytes, duration = await self._generate_tts(message)
            audio_b64 = base64.b64encode(audio_bytes).decode()
            print(f"[mux] TTS for {agent_id}: {duration:.1f}s")

            # Wait for previous audio to finish before sending ours
            loop = asyncio.get_event_loop()
            now = loop.time()
            if self._audio_free_at > now:
                wait = self._audio_free_at - now
                print(f"[mux] Waiting {wait:.1f}s for previous audio to finish")
                await asyncio.sleep(wait)

            # Send audio and track when it finishes
            if self._on_audio:
                await self._on_audio(agent_id, audio_b64, duration)
            self._audio_free_at = asyncio.get_event_loop().time() + duration

            # Release spotlight — next agent can start generating TTS
            self._spotlight = None
            print(f"[mux] Spotlight released by {agent_id}")
            if self._on_state_change:
                await self._on_state_change(agent_id, "idle")

            # Block this agent until its own audio finishes playing
            await asyncio.sleep(duration)
        except Exception as e:
            print(f"[mux] TTS error: {e}")
            self._spotlight = None
            if self._on_state_change:
                await self._on_state_change(agent_id, "idle")

        return True, None

    async def _generate_tts(self, text, retries=3):
        """Generate TTS audio and return (audio_bytes, duration_seconds)."""
        for attempt in range(retries):
            try:
                response = await self._client.aio.models.generate_content(
                    model="gemini-2.5-flash-preview-tts",
                    contents=[{"parts": [{"text": f"Say cheerfully: {text}"}]}],
                    config=types.GenerateContentConfig(
                        response_modalities=["AUDIO"],
                        speech_config=types.SpeechConfig(
                            voice_config=types.VoiceConfig(
                                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                                    voice_name=self._voice
                                ),
                            ),
                        ),
                    ),
                )
                audio_data = response.candidates[0].content.parts[0].inline_data.data
                if isinstance(audio_data, str):
                    audio_bytes = base64.b64decode(audio_data)
                else:
                    audio_bytes = audio_data
                duration = len(audio_bytes) / BYTES_PER_SECOND
                return audio_bytes, duration
            except Exception as e:
                print(f"[mux] TTS attempt {attempt + 1}/{retries} failed: {e}")
                if attempt < retries - 1:
                    await asyncio.sleep(1)
                else:
                    raise

    def stop(self):
        self._spotlight = None
