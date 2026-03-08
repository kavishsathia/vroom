import asyncio
import json
from dotenv import load_dotenv
import websockets
from expressor import Expressor

load_dotenv()


class VroomServer:
    def __init__(self):
        self.ws = None
        self._screenshot_future = None
        self._action_future = None
        self.latest_frame = None
        self.frame_event = asyncio.Event()
        self.expressor = None

    async def handle_connection(self, websocket):
        self.ws = websocket
        print("[vroom] Extension connected")

        # Start the expressor session immediately
        self.expressor = Expressor(self)
        expressor_task = asyncio.create_task(self.expressor.run())

        try:
            async for message in websocket:
                data = json.loads(message)

                if data["type"] == "task":
                    # Send text task to the live session
                    if self.expressor and self.expressor.session:
                        await self.expressor.send_text(data["text"])

                elif data["type"] == "audio":
                    # Forward mic audio to the live session
                    if self.expressor and self.expressor.session:
                        await self.expressor.send_audio(data["data"])
                    else:
                        print("[vroom] Audio received but no expressor session")

                elif data["type"] == "frame":
                    self.latest_frame = data["data"]
                    self.frame_event.set()
                    # Also forward to live session
                    if self.expressor and self.expressor.session:
                        await self.expressor.send_frame(data["data"])

                elif data["type"] == "screenshot_response":
                    if self._screenshot_future and not self._screenshot_future.done():
                        self._screenshot_future.set_result(data["data"])

                elif data["type"] == "action_result":
                    if self._action_future and not self._action_future.done():
                        self._action_future.set_result(data)

        except websockets.exceptions.ConnectionClosed:
            print("[vroom] Extension disconnected")
        finally:
            expressor_task.cancel()
            self.expressor = None

    async def request_screenshot(self):
        self._screenshot_future = asyncio.get_event_loop().create_future()
        await self.ws.send(json.dumps({"type": "screenshot_request"}))
        return await self._screenshot_future

    async def send_action(self, action):
        self._action_future = asyncio.get_event_loop().create_future()
        await self.ws.send(json.dumps(action))
        return await self._action_future

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
