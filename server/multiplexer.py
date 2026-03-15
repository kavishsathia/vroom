import asyncio
import base64
import time
from google import genai
from google.genai import types


SAMPLE_RATE = 24000
SAMPLE_WIDTH = 2  # 16-bit
CHANNELS = 1
BYTES_PER_SECOND = SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS  # 48000


AGENT_POOL = [
    {"name": "Alice", "voice": "Kore"},
    {"name": "Bob", "voice": "Puck"},
    {"name": "Carol", "voice": "Aoede"},
    {"name": "Dave", "voice": "Orus"},
    {"name": "Eve", "voice": "Leda"},
    {"name": "Frank", "voice": "Fenrir"},
    {"name": "Grace", "voice": "Sadachbia"},
    {"name": "Hank", "voice": "Achird"},
]


class Multiplexer:
    def __init__(self, on_message=None, on_audio_chunk=None, on_state_change=None, on_clear_audio=None, on_log=None):
        self.conversation = []  # [{agent_id, message, timestamp}]
        self.read_pointers = {}  # agent_id -> int
        self.aol = []  # [{agent_id, message, timestamp}]
        self.aol_read_pointers = {}  # agent_id -> int
        self._spotlight = None  # agent_id currently generating TTS
        self._audio_free_at = 0  # monotonic time when current audio finishes
        self._on_message = on_message  # callback(agent_id, message)
        # async callback(agent_id, audio_b64, done)
        self._on_audio_chunk = on_audio_chunk
        # async callback(agent_id, state)
        self._on_state_change = on_state_change
        self._on_clear_audio = on_clear_audio  # async callback()
        self._on_log = on_log  # async callback(agent_id, message)
        self._agent_voices = {}  # agent_id -> voice name
        self._agent_pool_index = 0
        self._client = genai.Client()
        self._voice_sessions = {}  # voice -> {session, ctx}
        self._live_lock = asyncio.Lock()
        self._resume_event = asyncio.Event()
        self._resume_event.set()  # starts unpaused
        # set when preempt fires, to cancel sleeps
        self._preempt_event = asyncio.Event()
        self._stream_task = None  # task running try_speak, cancelled on preempt
        # [(audio_bytes, mime_type)] buffered for extractor
        self._pending_user_audio = []
        # Visual preempt: per-agent blocking
        self._agent_blocked = {}  # agent_id -> asyncio.Event (clear=blocked)
        self._visual_preempt_data = {}  # agent_id -> list of interactions

    def next_agent(self):
        """Get the next agent name/voice from the pool."""
        info = AGENT_POOL[self._agent_pool_index % len(AGENT_POOL)]
        self._agent_pool_index += 1
        return info["name"], info["voice"]

    def register(self, agent_id, voice=None):
        self.read_pointers[agent_id] = len(self.conversation)
        self.aol_read_pointers[agent_id] = len(self.aol)
        if voice:
            self._agent_voices[agent_id] = voice

    def unregister(self, agent_id):
        self.read_pointers.pop(agent_id, None)
        self.aol_read_pointers.pop(agent_id, None)

    def has_unread(self, agent_id):
        """Check if there are unread messages/audio for an agent (without consuming)."""
        pointer = self.read_pointers.get(agent_id, 0)
        for m in self.conversation[pointer:]:
            if m["agent_id"] != agent_id:
                return True
        return False

    def get_context(self, agent_id):
        """Get unread messages/audio for an agent."""
        pointer = self.read_pointers.get(agent_id, 0)
        unread = self.conversation[pointer:]
        self.read_pointers[agent_id] = len(self.conversation)
        messages = []
        audio_parts = []
        for m in unread:
            if m["agent_id"] == agent_id:
                continue
            if m["agent_id"] == "user" and "audio_bytes" in m:
                audio_parts.append((m["audio_bytes"], m["mime_type"]))
            elif "message" in m:
                messages.append(
                    {"agent": m["agent_id"], "message": m["message"]})
        visual_preempt = self._visual_preempt_data.pop(agent_id, None)
        return {
            "unread_messages": messages,
            "user_audio": audio_parts,
            "visual_preempt": visual_preempt,
        }

    def get_log_context(self, agent_id):
        """Get unread log entries for an agent."""
        pointer = self.aol_read_pointers.get(agent_id, 0)
        unread = self.aol[pointer:]
        self.aol_read_pointers[agent_id] = len(self.aol)
        return [{"agent": m["agent_id"], "message": m["message"]} for m in unread]

    async def append_log(self, agent_id, message):
        """Append a log entry and notify the frontend."""
        self.aol.append({
            "agent_id": agent_id,
            "message": message,
            "timestamp": time.time(),
        })
        if self._on_log:
            await self._on_log(agent_id, message)

    async def try_speak(self, agent_id, message):
        """Try to claim spotlight and speak with streaming TTS.
        Returns (success, None)."""
        if not self._resume_event.is_set():
            print(f"[mux] {agent_id} rejected — pipeline is paused")
            return False, None
        if self._spotlight is not None:
            print(
                f"[mux] {agent_id} rejected — {self._spotlight} is generating TTS")
            return False, None

        # Claim spotlight
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

        try:
            # Wait for previous audio to finish before streaming ours
            loop = asyncio.get_event_loop()
            now = loop.time()
            if self._audio_free_at > now:
                wait = self._audio_free_at - now
                print(
                    f"[mux] Waiting {wait:.1f}s for previous audio to finish")
                if await self._interruptible_sleep(wait):
                    print(f"[mux] {agent_id} interrupted during audio wait")
                    self._spotlight = None
                    if self._on_state_change:
                        await self._on_state_change(agent_id, "idle")
                    return True, None

            if not self._resume_event.is_set():
                print(f"[mux] {agent_id} audio discarded — pipeline paused")
                self._spotlight = None
                if self._on_state_change:
                    await self._on_state_change(agent_id, "idle")
                return True, None

            # Stream TTS — run as a task so preempt() can cancel it
            cancelled = False
            try:
                self._stream_task = asyncio.current_task()
                total_bytes = 0
                chunk_count = 0
                stream_start = time.monotonic()
                voice = self._agent_voices.get(agent_id, "Kore")
                async for chunk_bytes in self._stream_tts(message, voice=voice):
                    chunk_count += 1
                    if chunk_count == 1:
                        ttfb = (time.monotonic() - stream_start) * 1000
                        print(
                            f"[mux] {agent_id} TTFB: {ttfb:.0f}ms ({len(chunk_bytes)} bytes)")
                    chunk_b64 = base64.b64encode(chunk_bytes).decode()
                    total_bytes += len(chunk_bytes)
                    if self._on_audio_chunk:
                        await self._on_audio_chunk(agent_id, chunk_b64, False)
            except asyncio.CancelledError:
                cancelled = True
                print(
                    f"[mux] {agent_id} stream cancelled at chunk {chunk_count}")
            finally:
                self._stream_task = None

            total_duration = total_bytes / BYTES_PER_SECOND
            stream_elapsed = (time.monotonic() - stream_start) * 1000
            print(
                f"[mux] TTS stream for {agent_id}: {total_duration:.1f}s audio, {stream_elapsed:.0f}ms wall, {chunk_count} chunks, cancelled={cancelled}")

            if cancelled:
                # Reset Live session to discard buffered audio
                await self._reset_live_session()
                self._audio_free_at = 0
                self._spotlight = None
                print(f"[mux] Spotlight released by {agent_id} (preempted)")
                if self._on_state_change:
                    await self._on_state_change(agent_id, "idle")
            else:
                # Send done signal
                if self._on_audio_chunk:
                    await self._on_audio_chunk(agent_id, "", True)
                self._audio_free_at = loop.time() + total_duration
                self._spotlight = None
                print(f"[mux] Spotlight released by {agent_id}")
                # Don't block — let the agent pre-generate its next message
                # while audio plays. Next try_speak() will wait via _audio_free_at.
                if self._on_state_change:
                    await self._on_state_change(agent_id, "idle")
        except Exception as e:
            print(f"[mux] TTS error: {e}")
            self._spotlight = None
            if self._on_state_change:
                await self._on_state_change(agent_id, "idle")

        return True, None

    async def _reset_live_session(self, voice=None):
        """Close Live API session(s). If voice given, only that one; otherwise all."""
        if voice:
            entry = self._voice_sessions.pop(voice, None)
            if entry:
                try:
                    await entry["ctx"].__aexit__(None, None, None)
                except Exception:
                    pass
                print(f"[mux] Live session reset for voice={voice}")
        else:
            for _, entry in list(self._voice_sessions.items()):
                try:
                    await entry["ctx"].__aexit__(None, None, None)
                except Exception:
                    pass
            self._voice_sessions.clear()
            print("[mux] All Live sessions reset")

    async def _get_live_session(self, voice="Kore"):
        """Get or create a persistent Live API session for a specific voice."""
        if voice not in self._voice_sessions:
            config = {
                "response_modalities": ["AUDIO"],
                "system_instruction": "You are a text-to-speech engine. Your ONLY job is to speak the exact text the user provides. Do not paraphrase, summarize, comment on, or add anything. Just say the words exactly as given, in a cheerful tone.",
                "speech_config": {
                    "voice_config": {
                        "prebuilt_voice_config": {"voice_name": voice}
                    },
                },
            }
            ctx = self._client.aio.live.connect(
                model="gemini-2.5-flash-native-audio-preview-12-2025",
                config=config,
            )
            session = await ctx.__aenter__()
            self._voice_sessions[voice] = {"session": session, "ctx": ctx}
            print(f"[mux] Live API session created (voice={voice})")
        return self._voice_sessions[voice]["session"]

    async def _stream_tts(self, text, voice="Kore", retries=3):
        """Stream TTS audio chunks via Live API."""
        for attempt in range(retries):
            try:
                async with self._live_lock:
                    session = await self._get_live_session(voice=voice)
                    await session.send_client_content(
                        turns=types.Content(
                            role="user",
                            parts=[types.Part(
                                text=f"Repeat this exactly: {text}")],
                        ),
                        turn_complete=True,
                    )
                    async for response in session.receive():
                        if response.server_content and response.server_content.model_turn:
                            for part in response.server_content.model_turn.parts:
                                if part.inline_data and part.inline_data.data:
                                    audio_data = part.inline_data.data
                                    if isinstance(audio_data, str):
                                        yield base64.b64decode(audio_data)
                                    else:
                                        yield audio_data
                        if response.server_content and response.server_content.turn_complete:
                            break
                return  # success
            except Exception as e:
                print(
                    f"[mux] Live TTS attempt {attempt + 1}/{retries} failed: {e}")
                await self._reset_live_session(voice=voice)
                if attempt < retries - 1:
                    await asyncio.sleep(1)
                else:
                    raise

    async def _interruptible_sleep(self, seconds):
        """Sleep that can be interrupted by preempt. Returns True if interrupted."""
        self._preempt_event.clear()
        try:
            await asyncio.wait_for(self._preempt_event.wait(), timeout=seconds)
            return True  # was interrupted
        except asyncio.TimeoutError:
            return False  # completed naturally

    async def preempt(self):
        """Pause all agents, clear audio, cancel active TTS stream."""
        print(f"[mux] PREEMPT: pausing pipeline")
        self._resume_event.clear()
        self._spotlight = None
        self._audio_free_at = 0
        self._preempt_event.set()  # interrupt any sleeping agents
        # Cancel the active TTS stream task immediately
        if self._stream_task and not self._stream_task.done():
            self._stream_task.cancel()
            print(f"[mux] Cancelled stream task")
        if self._on_clear_audio:
            await self._on_clear_audio()

    def pause(self):
        """Pause all agents (they block at wait_if_paused)."""
        self._resume_event.clear()
        print(f"[mux] Pipeline paused")

    def resume(self):
        """Resume the pipeline."""
        self._resume_event.set()
        print(f"[mux] Pipeline resumed")

    def broadcast_user_audio(self, audio_bytes, mime_type):
        """Store user audio for agents and extractor to pick up."""
        print(f"[mux] USER AUDIO: {len(audio_bytes)} bytes ({mime_type})")
        self.conversation.append({
            "agent_id": "user",
            "audio_bytes": audio_bytes,
            "mime_type": mime_type,
            "timestamp": time.time(),
        })
        self._pending_user_audio.append((audio_bytes, mime_type))

    def drain_user_audio(self):
        """Drain buffered user audio (called by extractor)."""
        audio = list(self._pending_user_audio)
        self._pending_user_audio.clear()
        return audio

    async def wait_if_paused(self, agent_id=None):
        """Agents call this before each step. Blocks while paused or visually preempted."""
        await self._resume_event.wait()
        if agent_id and agent_id in self._agent_blocked:
            await self._agent_blocked[agent_id].wait()

    def visual_preempt(self, agent_id):
        """Block a specific agent for visual preemption."""
        event = asyncio.Event()
        # Event starts clear (blocked)
        self._agent_blocked[agent_id] = event
        print(f"[mux] Visual preempt: {agent_id} blocked")

    def visual_preempt_end(self, agent_id, interactions):
        """Unblock agent and store visual preempt data for it to consume."""
        self._visual_preempt_data[agent_id] = interactions
        event = self._agent_blocked.pop(agent_id, None)
        if event:
            event.set()
        print(f"[mux] Visual preempt: {agent_id} unblocked with {len(interactions)} interactions")

    def stop(self):
        self._spotlight = None
        self._resume_event.set()
        self._agent_pool_index = 0
        self.aol.clear()
        self.aol_read_pointers.clear()
