import asyncio
import json
from dotenv import load_dotenv
import websockets
from agent import Agent
from extractor import Extractor

load_dotenv()


class VroomServer:
    def __init__(self):
        self.ws = None
        self._pending = {}  # requestId -> future
        self._request_counter = 0

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

                # Route responses back to pending futures
                rid = data.get("requestId")
                if rid and rid in self._pending:
                    self._pending.pop(rid).set_result(data)
                elif data["type"] == "task":
                    asyncio.create_task(self._run_task(data["text"]))

        except websockets.exceptions.ConnectionClosed:
            print("[vroom] Extension disconnected")

    async def _run_task(self, text):
        try:
            # Get current tab info
            tab_info = await self._request({"type": "get_tab_info"})
            current_tab_id = tab_info["tabId"]
            current_url = tab_info["url"]
            print(f"[vroom] Current tab: {current_tab_id}, URL: {current_url}")

            # Decompose task
            extractor = Extractor()
            subtasks = await extractor.decompose(text)

            if len(subtasks) == 1:
                # Single subtask — run on the current tab
                agent = Agent(self, current_tab_id)
                result = await agent.run(subtasks[0])
                await self.send_complete(result)
            else:
                # Multiple subtasks — open new tabs and run in parallel
                await self.send_status(f"Decomposed into {len(subtasks)} subtasks")
                tab_ids = await self.open_tabs(len(subtasks), current_url)

                agents = [Agent(self, tid) for tid in tab_ids]
                tasks = [
                    agent.run(subtask)
                    for agent, subtask in zip(agents, subtasks)
                ]
                results = await asyncio.gather(*tasks, return_exceptions=True)

                summaries = []
                for i, result in enumerate(results):
                    if isinstance(result, Exception):
                        summaries.append(f"Subtask {i+1} failed: {result}")
                    else:
                        summaries.append(f"Subtask {i+1}: {result}")

                await self.close_tabs(tab_ids)
                await self.send_complete("\n".join(summaries))

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

    async def open_tabs(self, count, url):
        result = await self._request({
            "type": "open_tabs",
            "count": count,
            "url": url,
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
