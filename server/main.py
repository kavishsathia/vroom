import asyncio
import base64
import json
import os
from urllib.parse import urlparse, parse_qs
from dotenv import load_dotenv
import websockets
import db
from extractor import Extractor
from multiplexer import Multiplexer
from skills import SkillStore

load_dotenv()

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")


def _verify_google_token_sync(token_str):
    from google.oauth2 import id_token
    from google.auth.transport import requests as google_requests
    return id_token.verify_oauth2_token(token_str, google_requests.Request(), GOOGLE_CLIENT_ID)


async def verify_google_token(token_str):
    """Verify a Google ID token. Returns claims dict or None."""
    if not GOOGLE_CLIENT_ID:
        return None
    try:
        return await asyncio.get_event_loop().run_in_executor(
            None, _verify_google_token_sync, token_str,
        )
    except Exception as e:
        print(f"[auth] Token verification failed: {e}")
        return None


class Session:
    """Per-connection state: one WebSocket, one user, one multiplexer."""

    def __init__(self, ws, pool, user_id):
        self.ws = ws
        self.pool = pool
        self.user_id = user_id
        self._pending = {}
        self._request_counter = 0
        self.skill_store = SkillStore(pool, user_id)
        self.multiplexer = Multiplexer(
            on_message=self._on_agent_message,
            on_audio_chunk=self._on_agent_audio_chunk,
            on_state_change=self._on_agent_state_change,
            on_clear_audio=self._on_clear_audio,
            on_log=self._on_log,
        )

    # --- Multiplexer callbacks ---

    def _on_agent_message(self, agent_id, message):
        print(f"[mux] {agent_id}: {message}")
        asyncio.ensure_future(self.send_status(f"[{agent_id}] {message}"))

    async def _on_agent_state_change(self, agent_id, state):
        await self.ws.send(json.dumps({
            "type": "speech_state",
            "agentId": agent_id,
            "state": state,
        }))

    async def _on_agent_audio_chunk(self, agent_id, audio_b64, done):
        await self.ws.send(json.dumps({
            "type": "audio_chunk",
            "agentId": agent_id,
            "data": audio_b64,
            "done": done,
        }))

    async def _on_clear_audio(self):
        await self.ws.send(json.dumps({"type": "clear_audio"}))

    async def _on_log(self, agent_id, message):
        await self.ws.send(json.dumps({
            "type": "log",
            "agentId": agent_id,
            "message": message,
        }))

    # --- Request / response helpers ---

    def _next_id(self):
        self._request_counter += 1
        return str(self._request_counter)

    async def _request(self, msg):
        rid = self._next_id()
        msg["requestId"] = rid
        future = asyncio.get_event_loop().create_future()
        self._pending[rid] = future
        await self.ws.send(json.dumps(msg))
        return await future

    # --- Message loop ---

    async def run(self):
        print(f"[session] User {self.user_id} connected")
        await self.send_status("Connected")

        try:
            async for message in self.ws:
                data = json.loads(message)
                print(f"[ws] Received: {data.get('type', '?')}")

                rid = data.get("requestId")
                if rid and rid in self._pending:
                    self._pending.pop(rid).set_result(data)
                elif data["type"] == "task":
                    audio = None
                    if data.get("audio"):
                        audio = (base64.b64decode(data["audio"]), data.get("audioMimeType", "audio/webm"))
                    asyncio.create_task(self._run_task(data["text"], data.get("existingTabs"), audio=audio))
                elif data["type"] == "preempt_start":
                    await self.multiplexer.preempt()
                    await self.send_status("User is speaking...")
                elif data["type"] == "preempt_end":
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
            print(f"[session] User {self.user_id} disconnected")
            self.multiplexer.stop()

    async def _handle_preempt_audio(self, audio_b64, mime_type):
        audio_bytes = base64.b64decode(audio_b64)
        self.multiplexer.broadcast_user_audio(audio_bytes, mime_type)
        self.multiplexer.resume()
        await self.send_status("User finished speaking")

    async def _run_task(self, text, existing_tabs=None, audio=None):
        try:
            extractor = Extractor(self, pool=self.pool, user_id=self.user_id,
                                  multiplexer=self.multiplexer, skill_store=self.skill_store)
            await extractor.run(text, existing_tabs=existing_tabs, audio=audio)
        except Exception as e:
            import traceback
            traceback.print_exc()
            await self.send_status(f"Error: {e}")

    # --- Extension API (called by Extractor / Agent) ---

    async def request_screenshot(self, tab_id):
        result = await self._request({
            "type": "screenshot_request",
            "tabId": tab_id,
        })
        return result["data"]

    async def send_action(self, tab_id, action_data):
        return await self._request({
            "type": "action",
            "tabId": tab_id,
            **action_data,
        })

    async def open_tabs(self, count, url, task=""):
        result = await self._request({
            "type": "open_tabs",
            "count": count,
            "url": url,
            "task": task,
        })
        tab_ids = result["tabIds"]
        print(f"[session] Opened {len(tab_ids)} tabs: {tab_ids}")
        return tab_ids

    async def close_tabs(self, tab_ids):
        await self.ws.send(json.dumps({
            "type": "close_tabs",
            "tabIds": tab_ids,
        }))

    async def send_status(self, message):
        print(f"[session] {message}")
        await self.ws.send(json.dumps({"type": "status", "message": message}))

    async def send_complete(self, summary):
        print(f"[session] Complete: {summary}")
        await self.ws.send(json.dumps({"type": "complete", "summary": summary}))

    async def send_contract_update(self, contract):
        await self.ws.send(json.dumps({
            "type": "contract_update",
            **contract.to_dict(),
        }))


class VroomServer:
    """Multi-tenant WebSocket server. Creates a Session per connection."""

    def __init__(self, pool):
        self.pool = pool

    async def handle_connection(self, websocket):
        raw_token = self._extract_query_param(websocket, "token")

        if GOOGLE_CLIENT_ID:
            if not raw_token:
                await websocket.close(4001, "Missing token")
                return
            claims = await verify_google_token(raw_token)
            if not claims:
                await websocket.close(4001, "Invalid token")
                return
            user_token = claims["sub"]
            email = claims.get("email")
            name = claims.get("name")
            picture = claims.get("picture")
        else:
            # Dev mode — no verification, accept any token
            user_token = raw_token or "default"
            email = name = picture = None

        user_id = await db.get_or_create_user(
            self.pool, user_token, email=email, name=name, picture=picture,
        )
        session = Session(websocket, self.pool, user_id)
        await session.run()

    def _extract_query_param(self, websocket, key):
        parsed = urlparse(websocket.request.path)
        params = parse_qs(parsed.query)
        values = params.get(key, [])
        return values[0] if values else None


async def main():
    pool = await db.create_pool()
    await db.ensure_schema(pool)
    server = VroomServer(pool)
    host = os.environ.get("HOST", "localhost")
    port = int(os.environ.get("PORT", "8765"))
    async with websockets.serve(server.handle_connection, host, port):
        print(f"[vroom] Server running on ws://{host}:{port}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
