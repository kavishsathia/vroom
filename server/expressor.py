import asyncio
import base64
from google import genai
from google.genai import types
from executor import Executor


class Expressor:
    def __init__(self, server):
        self.server = server
        self.client = genai.Client()
        self.session = None
        self._audio_log_count = 0

    async def run(self):
        tools = [
            types.Tool(
                function_declarations=[
                    types.FunctionDeclaration(
                        name="ui_intent",
                        description="Send a natural language UI instruction to be executed on the browser. Be specific: 'click the Add Skill button', 'type Python in the search field'.",
                        parameters=types.Schema(
                            type="OBJECT",
                            properties={
                                "instruction": types.Schema(
                                    type="STRING",
                                    description="Specific UI instruction to execute",
                                )
                            },
                            required=["instruction"],
                        ),
                    ),
                    types.FunctionDeclaration(
                        name="complete",
                        description="Call when the entire task is done",
                        parameters=types.Schema(
                            type="OBJECT",
                            properties={
                                "summary": types.Schema(
                                    type="STRING",
                                    description="Summary of what was accomplished",
                                )
                            },
                            required=["summary"],
                        ),
                    ),
                ]
            )
        ]

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            tools=tools,
            system_instruction=(
                "You are a browser automation agent. You can see the browser screen "
                "in real-time via video and hear the user via audio. The user will tell "
                "you what task to accomplish on the current webpage. Break the task into "
                "small, specific UI interactions and use ui_intent to execute each one. "
                "Watch the screen to verify each action completed successfully before "
                "moving to the next. Call complete when the entire task is done. "
                "Speak back to confirm what you're doing."
            ),
        )

        # Reconnect loop — if the session drops, restart it
        while True:
            try:
                print("[expressor] Connecting to Live API...")
                async with self.client.aio.live.connect(
                    model="gemini-2.5-flash-native-audio-preview-12-2025",
                    config=config,
                ) as session:
                    self.session = session
                    print("[expressor] Live API session started")
                    await self.server.send_status("Live session ready - speak or type your task")

                    async for response in session.receive():
                        try:
                            await self._handle_response(response)
                        except Exception as e:
                            import traceback
                            traceback.print_exc()
                            print(f"[expressor] Error handling response: {e}")

                print("[expressor] Session ended, reconnecting...")
                self.session = None

            except asyncio.CancelledError:
                print("[expressor] Cancelled")
                return
            except Exception as e:
                import traceback
                traceback.print_exc()
                print(f"[expressor] Error: {e}")
                self.session = None
                try:
                    await self.server.send_status(f"Expressor error: {e}, reconnecting...")
                except Exception:
                    pass

            await asyncio.sleep(1)

    async def _handle_response(self, response):
        # Handle tool calls
        if hasattr(response, "tool_call") and response.tool_call:
            for fc in response.tool_call.function_calls:
                if fc.name == "ui_intent":
                    instruction = fc.args.get("instruction", "")
                    await self.server.send_status(f"Intent: {instruction}")

                    executor = Executor(self.server)
                    result = await executor.run(instruction)

                    await self.server.send_status(f"Result: {result}")
                    await self.session.send_tool_response(
                        function_responses=[
                            types.FunctionResponse(
                                name="ui_intent",
                                id=fc.id,
                                response={"result": result},
                            )
                        ]
                    )

                elif fc.name == "complete":
                    summary = fc.args.get("summary", "Task completed")
                    await self.server.send_complete(summary)

        # Handle text/audio responses
        if hasattr(response, "server_content") and response.server_content:
            sc = response.server_content
            if hasattr(sc, "model_turn") and sc.model_turn:
                for part in sc.model_turn.parts:
                    if hasattr(part, "text") and part.text:
                        await self.server.send_status(f"Agent: {part.text}")
                    # Skip audio inline_data parts for now

    async def send_audio(self, audio_b64):
        """Forward mic audio to Live API."""
        if self.session:
            audio_bytes = base64.b64decode(audio_b64)
            await self.session.send_realtime_input(
                media=types.Blob(
                    data=audio_bytes, mime_type="audio/pcm;rate=16000"
                )
            )
            self._audio_log_count += 1
            if self._audio_log_count % 10 == 1:
                print(f"[expressor] Sent {self._audio_log_count} audio chunks ({len(audio_bytes)} bytes)")

    async def send_frame(self, frame_b64):
        """Forward a video frame to Live API."""
        if self.session:
            frame_bytes = base64.b64decode(frame_b64)
            await self.session.send_realtime_input(
                media=types.Blob(
                    data=frame_bytes, mime_type="image/jpeg"
                )
            )

    async def send_text(self, text):
        """Send a text message to the Live API session."""
        if self.session:
            await self.session.send_client_content(
                turns=[
                    types.Content(
                        role="user",
                        parts=[types.Part(text=text)],
                    )
                ]
            )
