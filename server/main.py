import asyncio
import base64
import json
from dotenv import load_dotenv
import websockets
from extractor import Extractor
from multiplexer import Multiplexer

load_dotenv()


class VroomServer:
    def __init__(self):
        self.ws = None
        self._pending = {}  # requestId -> future
        self._request_counter = 0
        self.multiplexer = Multiplexer(
            on_message=self._on_agent_message,
            on_audio_chunk=self._on_agent_audio_chunk,
            on_state_change=self._on_agent_state_change,
            on_clear_audio=self._on_clear_audio,
            on_log=self._on_log,
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

    async def _on_agent_audio_chunk(self, agent_id, audio_b64, done):
        """Called for each streamed TTS chunk — send to frontend for playback."""
        await self.ws.send(json.dumps({
            "type": "audio_chunk",
            "agentId": agent_id,
            "data": audio_b64,
            "done": done,
        }))

    async def _on_clear_audio(self):
        """Called during preempt — tell frontend to stop all audio."""
        await self.ws.send(json.dumps({"type": "clear_audio"}))

    async def _on_log(self, agent_id, message):
        """Called when an agent writes to the append-only log."""
        await self.ws.send(json.dumps({
            "type": "log",
            "agentId": agent_id,
            "message": message,
        }))

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
                print(f"[ws] Received: {data.get('type', '?')}")

                rid = data.get("requestId")
                if rid and rid in self._pending:
                    self._pending.pop(rid).set_result(data)
                elif data["type"] == "task":
                    asyncio.create_task(self._run_task(data["text"], data.get("existingTabs")))
                elif data["type"] == "preempt_start":
                    await self.multiplexer.preempt()
                    await self.send_status("User is speaking...")
                elif data["type"] == "preempt_end":
                    # Don't resume here — wait for preempt_audio so agents
                    # see the user's audio on their very first step after waking.
                    await self.send_status("Processing audio...")
                elif data["type"] == "preempt_audio":
                    asyncio.create_task(self._handle_preempt_audio(data["data"], data.get("mimeType", "audio/webm")))
                elif data["type"] == "user_log":
                    asyncio.create_task(self.multiplexer.append_log("user", data["message"]))
                elif data["type"] == "visual_preempt_start":
                    agent_id = data.get("agentId")
                    if agent_id:
                        self.multiplexer.visual_preempt(agent_id)
                        await self.send_status(f"User took control of {agent_id}")
                elif data["type"] == "visual_preempt_end":
                    agent_id = data.get("agentId")
                    interactions = data.get("interactions", [])
                    if agent_id:
                        self.multiplexer.visual_preempt_end(agent_id, interactions)
                        await self.send_status(f"Control returned to {agent_id}")
                elif data["type"] == "pause":
                    self.multiplexer.pause()
                    await self.send_status("Agents paused")
                elif data["type"] == "resume":
                    self.multiplexer.resume()
                    await self.send_status("Agents resumed")

        except websockets.exceptions.ConnectionClosed:
            print("[vroom] Extension disconnected")
            self.multiplexer.stop()

    async def _handle_preempt_audio(self, audio_b64, mime_type):
        """Store user audio for agents and extractor to consume directly, then resume."""
        audio_bytes = base64.b64decode(audio_b64)
        self.multiplexer.broadcast_user_audio(audio_bytes, mime_type)
        self.multiplexer.resume()
        await self.send_status("User finished speaking")

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

    async def send_contract_update(self, contract):
        await self.ws.send(json.dumps({
            "type": "contract_update",
            **contract.to_dict(),
        }))


async def main():
    server = VroomServer()
    async with websockets.serve(server.handle_connection, "localhost", 8765):
        print("[vroom] Server running on ws://localhost:8765")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
