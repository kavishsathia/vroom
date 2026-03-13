import asyncio
import base64
import json
from dotenv import load_dotenv
import websockets
from google import genai
from google.genai import types
from extractor import Extractor
from multiplexer import Multiplexer

load_dotenv()


class VroomServer:
    def __init__(self):
        self.ws = None
        self._pending = {}  # requestId -> future
        self._request_counter = 0
        self._genai_client = genai.Client()
        self.multiplexer = Multiplexer(
            on_message=self._on_agent_message,
            on_audio=self._on_agent_audio,
            on_state_change=self._on_agent_state_change,
            on_clear_audio=self._on_clear_audio,
        )

    def _on_agent_message(self, agent_id, message):
        """Called when an agent speaks through the multiplexer."""
        print(f"[mux] {agent_id}: {message}")
        asyncio.ensure_future(self.send_status(f"[{agent_id}] {message}"))

    async def _on_agent_state_change(self, agent_id, state):
        """Called when an agent's speech state changes (queued/spotlight/idle)."""
        await self.ws.send(json.dumps({
            "type": "speech_state",
            "agentId": agent_id,
            "state": state,
        }))

    async def _on_agent_audio(self, agent_id, audio_b64, duration):
        """Called when TTS audio is ready — send to frontend for playback."""
        await self.ws.send(json.dumps({
            "type": "audio",
            "agentId": agent_id,
            "data": audio_b64,
            "duration": duration,
        }))

    async def _on_clear_audio(self):
        """Called during preempt — tell frontend to stop all audio."""
        await self.ws.send(json.dumps({"type": "clear_audio"}))

    def _next_id(self):
        self._request_counter += 1
        return str(self._request_counter)

    async def _request(self, msg):
        """Send a message and wait for the response with matching requestId."""
        rid = self._next_id()
        msg["requestId"] = rid
        future = asyncio.get_event_loop().create_future()
        self._pending[rid] = future
        await self.ws.send(json.dumps(msg))
        result = await future
        return result

    async def handle_connection(self, websocket):
        self.ws = websocket
        print("[vroom] Extension connected")
        await self.send_status("Connected")

        try:
            async for message in websocket:
                data = json.loads(message)

                rid = data.get("requestId")
                if rid and rid in self._pending:
                    self._pending.pop(rid).set_result(data)
                elif data["type"] == "task":
                    asyncio.create_task(self._run_task(data["text"], data.get("existingTabs")))
                elif data["type"] == "preempt_start":
                    await self.multiplexer.preempt()
                    await self.send_status("User is speaking...")
                elif data["type"] == "preempt_audio":
                    asyncio.create_task(self._handle_preempt_audio(data["data"], data.get("mimeType", "audio/webm")))

        except websockets.exceptions.ConnectionClosed:
            print("[vroom] Extension disconnected")
            self.multiplexer.stop()

    async def _handle_preempt_audio(self, audio_b64, mime_type):
        """Transcribe user audio via Gemini and broadcast to agents."""
        try:
            audio_bytes = base64.b64decode(audio_b64)
            response = await self._genai_client.aio.models.generate_content(
                model="gemini-2.5-flash",
                contents=[
                    types.Content(role="user", parts=[
                        types.Part(inline_data=types.Blob(data=audio_bytes, mime_type=mime_type)),
                        types.Part(text="Transcribe this audio exactly. Return only the transcription, nothing else."),
                    ])
                ],
            )
            transcript = response.text.strip()
            print(f"[vroom] User said: {transcript}")
            await self.send_status(f"User: {transcript}")
            await self.ws.send(json.dumps({"type": "preempt_transcript", "text": transcript}))
            await self.multiplexer.broadcast_user_message(transcript)
        except Exception as e:
            print(f"[vroom] STT error: {e}")
            await self.send_status(f"STT error: {e}")
            self.multiplexer._resume_event.set()  # resume even on error

    async def _run_task(self, text, existing_tabs=None):
        try:
            extractor = Extractor(self, multiplexer=self.multiplexer)
            await extractor.run(text, existing_tabs=existing_tabs)

        except Exception as e:
            import traceback
            traceback.print_exc()
            await self.send_status(f"Error: {e}")

    # --- Extension API ---

    async def request_screenshot(self, tab_id):
        result = await self._request({
            "type": "screenshot_request",
            "tabId": tab_id,
        })
        return result["data"]

    async def send_action(self, tab_id, action_data):
        result = await self._request({
            "type": "action",
            "tabId": tab_id,
            **action_data,
        })
        return result

    async def open_tabs(self, count, url, task=""):
        result = await self._request({
            "type": "open_tabs",
            "count": count,
            "url": url,
            "task": task,
        })
        tab_ids = result["tabIds"]
        print(f"[vroom] Opened {len(tab_ids)} tabs: {tab_ids}")
        return tab_ids

    async def close_tabs(self, tab_ids):
        await self.ws.send(json.dumps({
            "type": "close_tabs",
            "tabIds": tab_ids,
        }))

    async def send_status(self, message):
        print(f"[vroom] {message}")
        await self.ws.send(json.dumps({"type": "status", "message": message}))

    async def send_complete(self, summary):
        print(f"[vroom] Complete: {summary}")
        await self.ws.send(json.dumps({"type": "complete", "summary": summary}))


async def main():
    server = VroomServer()
    async with websockets.serve(server.handle_connection, "localhost", 8765):
        print("[vroom] Server running on ws://localhost:8765")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
