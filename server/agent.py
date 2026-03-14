import asyncio
import base64
import io
import json
import os
from google import genai
from google.genai import types
from PIL import Image, ImageDraw


SYSTEM_PROMPT = """\
You are a browser automation agent. You receive a task and a screenshot of the current page.

Analyze the screenshot and respond with a single JSON action:
- {"action": "click", "box_2d": [y_min, x_min, y_max, x_max], "label": "<element>"} — click the element. Coordinates are normalized 0-1000.
- {"action": "type", "text": "<string>"} — type text into the currently focused element
- {"action": "navigate", "url": "<url>"} — navigate to a specific URL
- {"action": "scroll", "direction": "up|down"} — scroll the page
- {"action": "speak", "message": "<string>"} — say something to the user. Keep it to 1 sentence.
- {"action": "done", "summary": "<string>"} — task is complete

Speech system:
You are one of multiple agents running in parallel. You all share a single audio channel to \
speak to the user. Only one agent can speak at a time — just like humans in a conversation.

When you want to say something, use {"action": "speak", "message": "..."}. \
If another agent is already speaking, your message won't go through — you'll be told it was \
rejected. Just try again later. Continue doing your browser task in the meantime.

Rules:
- When you see "unread_messages", these are messages from other agents. Read them and respond if appropriate.
- If your speech is rejected, don't keep retrying immediately — do some work first, then try again.
- Do NOT mark the task as done if you still need to speak. Speak first, then done.

Rules:
- If the tab shows a blank page, use navigate to go to the right URL first. \
  If the tab already has content, continue working from the current page.
- For click, return a bounding box with exactly 4 values using normalized coordinates (0-1000 range)
- Format is [y_min, x_min, y_max, x_max] where top-left is origin — always provide all 4 values
- Refer to elements by their position on the page (e.g. "first result", "search box"), NOT by guessing their text content
- Perform ONE action at a time
- After each action you'll see an updated screenshot
- Think about the overall task — decide what the next step should be
- If you are stuck and cannot make progress, respond with done and an error summary
- If you have confidently completed the task, respond with done immediately — do not keep going
- Respond with ONLY valid JSON
"""


class Agent:
    def __init__(self, server, tab_id, multiplexer=None, agent_id=None):
        self.server = server
        self.tab_id = tab_id
        self.client = genai.Client()
        self.multiplexer = multiplexer
        self.agent_id = agent_id or f"tab_{tab_id}"

    async def run(self, task, max_steps=100):
        history = []

        if self.multiplexer:
            self.multiplexer.register(self.agent_id)

        await self.server.send_status(f"[Tab {self.tab_id}] Starting: {task}")

        try:
            return await self._run_loop(task, history, max_steps)
        finally:
            if self.multiplexer:
                self.multiplexer.unregister(self.agent_id)

    async def _run_loop(self, task, history, max_steps):
        self._speech_rejected = False
        for step in range(max_steps):
            if self.multiplexer:
                await self.multiplexer.wait_if_paused()
            print(f"[agent:{self.tab_id}] Step {step + 1}/{max_steps} for: {task}")
            screenshot_b64 = await self.server.request_screenshot(self.tab_id)
            raw_bytes = base64.b64decode(screenshot_b64)
            img = Image.open(io.BytesIO(raw_bytes))
            vw = img.width // 2
            vh = img.height // 2
            img = img.resize((vw, vh), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=70)
            screenshot_bytes = buf.getvalue()

            text = (
                f"Task: {task}\n\nThis is the current page. What is the next action?"
                if step == 0
                else "Updated page. Continue with the task or respond with done."
            )

            # Inject multiplexer context
            extra_parts = []
            if self.multiplexer:
                ctx = self.multiplexer.get_context(self.agent_id)
                if self._speech_rejected:
                    text += "\n\nYour speech was rejected — another agent is speaking right now. Try again later."
                    self._speech_rejected = False
                if ctx["unread_messages"]:
                    text += "\n\nRecent messages from other agents:"
                    for msg in ctx["unread_messages"]:
                        text += f"\n- [{msg['agent']}]: {msg['message']}"
                if ctx["user_audio"]:
                    text += "\n\n[USER INSTRUCTION]: The user has spoken. Listen to the audio below and follow the instruction if it is relevant to your current task."
                    for audio_bytes, mime_type in ctx["user_audio"]:
                        extra_parts.append(types.Part(
                            inline_data=types.Blob(data=audio_bytes, mime_type=mime_type)
                        ))

            history.append(
                types.Content(
                    role="user",
                    parts=[
                        types.Part(
                            inline_data=types.Blob(
                                data=screenshot_bytes, mime_type="image/jpeg"
                            )
                        ),
                        types.Part(text=text),
                        *extra_parts,
                    ],
                )
            )

            response = await self.client.aio.models.generate_content(
                model="gemini-3-flash-preview",
                contents=history,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    response_mime_type="application/json",
                ),
            )

            response_text = response.text
            print(f"[agent:{self.tab_id}] Model response: {response_text}")
            history.append(
                types.Content(
                    role="model", parts=[types.Part(text=response_text)]
                )
            )

            try:
                action = json.loads(response_text)
            except json.JSONDecodeError:
                print(f"[agent:{self.tab_id}] JSON parse error: {response_text}")
                continue

            if "action" not in action:
                print(f"[agent:{self.tab_id}] Missing 'action' key: {response_text}")
                continue

            # Handle speak
            if action["action"] == "speak":
                if self.multiplexer:
                    message = action.get("message", "")
                    success, _ = await self.multiplexer.try_speak(self.agent_id, message)
                    if success:
                        print(f"[agent:{self.tab_id}] Spoke: {message}")
                        await self.server.send_status(f"[Tab {self.tab_id}] Spoke: {message}")
                    else:
                        self._speech_rejected = True
                        print(f"[agent:{self.tab_id}] Speech rejected — channel busy")
                continue

            if action["action"] == "done":
                summary = action.get("summary", "Completed")
                print(f"[agent:{self.tab_id}] Done: {summary}")
                await self.server.send_status(f"[Tab {self.tab_id}] Done: {summary}")
                return summary

            label = action.get('label', action.get('text', action.get('direction', '')))
            await self.server.send_status(
                f"[Tab {self.tab_id}] Step {step + 1}: {action['action']} {label}"
            )

            if action["action"] == "click" and "box_2d" in action and len(action["box_2d"]) == 4:
                box = action["box_2d"]
                x = int(((box[1] + box[3]) / 2) / 1000 * vw)
                y = int(((box[0] + box[2]) / 2) / 1000 * vh)
                print(f"[agent:{self.tab_id}] BBox {box} -> click at ({x}, {y})")
                self._save_debug_screenshot(screenshot_bytes, x, y, step)
                await self.server.send_action(self.tab_id, {
                    "action": "click",
                    "x": x,
                    "y": y,
                })
            elif action["action"] == "click":
                x, y = action.get("x", 0), action.get("y", 0)
                self._save_debug_screenshot(screenshot_bytes, x, y, step)
                await self.server.send_action(self.tab_id, {
                    "action": "click",
                    "x": x,
                    "y": y,
                })
            else:
                await self.server.send_action(self.tab_id, {
                    "action": action["action"],
                    **{k: v for k, v in action.items() if k != "action"},
                })

            await asyncio.sleep(1)

        await self.server.send_status(f"[Tab {self.tab_id}] Max steps reached")
        return "Max steps reached"

    def _save_debug_screenshot(self, screenshot_bytes, x, y, step):
        try:
            img = Image.open(io.BytesIO(screenshot_bytes))
            draw = ImageDraw.Draw(img)
            r = 12
            draw.ellipse([x - r, y - r, x + r, y + r], fill="red", outline="white", width=2)
            os.makedirs("debug", exist_ok=True)
            path = f"debug/tab{self.tab_id}_step{step}.jpg"
            img.save(path)
            print(f"[agent:{self.tab_id}] Debug screenshot: {path}")
        except Exception as e:
            print(f"[agent:{self.tab_id}] Debug screenshot error: {e}")
