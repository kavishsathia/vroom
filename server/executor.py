import asyncio
import base64
import io
import json
import os
from google import genai
from google.genai import types
from PIL import Image, ImageDraw


SYSTEM_PROMPT = """\
You are a browser UI executor. You receive a screenshot and a specific UI instruction.

Analyze the screenshot and respond with a single JSON action:
- {"action": "click", "box_2d": [y_min, x_min, y_max, x_max], "label": "<element>"} — click the element. Coordinates are normalized 0-1000.
- {"action": "type", "text": "<string>"} — type text into the currently focused element
- {"action": "scroll", "direction": "up|down"} — scroll the page
- {"action": "done", "summary": "<string>"} — instruction is complete

Rules:
- For click, return a bounding box around the target element using normalized coordinates (0-1000 range)
- Format is [y_min, x_min, y_max, x_max] where top-left is origin
- Perform ONE action at a time
- After each action you'll see an updated screenshot
- Respond with ONLY valid JSON
"""


class Executor:
    def __init__(self, server):
        self.server = server
        self.client = genai.Client()

    async def run(self, instruction, max_steps=10):
        history = []

        for step in range(max_steps):
            print(f"[executor] Step {step + 1}/{max_steps} for: {instruction}")
            screenshot_b64 = await self.server.request_screenshot()
            raw_bytes = base64.b64decode(screenshot_b64)
            # Get viewport dimensions from the downscaled image
            screenshot_bytes, vw, vh = self._downscale(raw_bytes)
            print(f"[executor] Got screenshot ({len(screenshot_bytes)} bytes, viewport {vw}x{vh})")

            text = (
                f"Execute this UI instruction: {instruction}"
                if step == 0
                else "Updated page. Continue or respond with done."
            )

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
            print(f"[executor] Model response: {response_text}")
            history.append(
                types.Content(
                    role="model", parts=[types.Part(text=response_text)]
                )
            )

            try:
                action = json.loads(response_text)
            except json.JSONDecodeError:
                print(f"[executor] JSON parse error: {response_text}")
                return f"Parse error: {response_text}"

            if action["action"] == "done":
                print(f"[executor] Done: {action.get('summary', 'Completed')}")
                return action.get("summary", "Completed")

            if action["action"] == "click" and "box_2d" in action:
                # Convert normalized 0-1000 coords to viewport pixels
                box = action["box_2d"]  # [y_min, x_min, y_max, x_max]
                x = int(((box[1] + box[3]) / 2) / 1000 * vw)
                y = int(((box[0] + box[2]) / 2) / 1000 * vh)
                print(f"[executor] BBox {box} -> click at viewport ({x}, {y})")

                self._save_debug_screenshot(screenshot_bytes, x, y, step)

                await self.server.send_action({
                    "type": "action",
                    "action": "click",
                    "x": x,
                    "y": y,
                })
            elif action["action"] == "click":
                # Fallback: raw x, y coordinates
                x, y = action.get("x", 0), action.get("y", 0)
                print(f"[executor] Raw click at ({x}, {y})")
                self._save_debug_screenshot(screenshot_bytes, x, y, step)
                await self.server.send_action({
                    "type": "action",
                    "action": "click",
                    "x": x,
                    "y": y,
                })
            else:
                await self.server.send_action({
                    "type": "action",
                    "action": action["action"],
                    **{k: v for k, v in action.items() if k != "action"},
                })

            await asyncio.sleep(0.5)

        return "Max steps reached"

    def _downscale(self, screenshot_bytes):
        """Downscale retina screenshot to viewport dimensions. Returns (bytes, width, height)."""
        img = Image.open(io.BytesIO(screenshot_bytes))
        new_w = img.width // 2
        new_h = img.height // 2
        img = img.resize((new_w, new_h), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70)
        return buf.getvalue(), new_w, new_h

    def _save_debug_screenshot(self, screenshot_bytes, x, y, step):
        """Save screenshot with a red dot at click coordinates."""
        try:
            img = Image.open(io.BytesIO(screenshot_bytes))
            draw = ImageDraw.Draw(img)
            r = 12
            draw.ellipse([x - r, y - r, x + r, y + r], fill="red", outline="white", width=2)
            os.makedirs("debug", exist_ok=True)
            path = f"debug/click_step_{step}.jpg"
            img.save(path)
            print(f"[executor] Debug screenshot saved: {path} (click at {x},{y}, image size {img.size})")
        except Exception as e:
            print(f"[executor] Debug screenshot error: {e}")
