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
- {"action": "wait"} — do nothing and wait for messages from other agents. Use this when you are waiting for another agent to act before you can proceed.
- {"action": "speak", "message": "<string>"} — say something to the user. Keep it to 1 sentence.
- {"action": "log", "message": "<string>"} — write to the shared chat log (visible to all agents and the user). Use this for structured data, URLs, numbers, comparisons — anything better read than heard. No audio is produced. This is an informal chat — feel free to be friendly, crack jokes, react to what other agents say, or just vibe. It's a group chat, not a formal report.
- {"action": "update_commitment", "index": <int>, "status": "done"|"failed"} — update a single commitment in your contract.
- {"action": "update_commitments", "updates": [{"index": <int>, "status": "done"|"failed"}, ...]} — update multiple commitments at once.
- {"action": "add_memo", "text": "<string>"} — add a memo to your contract. Use this for unexpected findings, blockers, corrections, or extra context the coordinator should know.
- {"action": "done", "summary": "<string>"} — task is complete. Make sure all commitments are updated before finishing.

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
- Respond with ONLY a single JSON object — never an array. Use update_commitments to batch multiple commitment updates in one action
- Do NOT combine different action types — one action per response
"""


class Agent:
    def __init__(self, server, tab_id, multiplexer=None, agent_id=None, name=None, voice=None, contract=None):
        self.server = server
        self.tab_id = tab_id
        self.client = genai.Client()
        self.multiplexer = multiplexer
        self.agent_id = agent_id or f"tab_{tab_id}"
        self.name = name or self.agent_id
        self.voice = voice
        self.contract = contract

    async def run(self, task, max_steps=100):
        history = []

        if self.multiplexer:
            self.multiplexer.register(self.agent_id, voice=self.voice)

        await self.server.send_status(f"[{self.name}] Starting: {task}")

        try:
            return await self._run_loop(task, history, max_steps)
        finally:
            if self.multiplexer:
                self.multiplexer.unregister(self.agent_id)

    async def _run_loop(self, task, history, max_steps):
        for step in range(max_steps):
            if self.multiplexer:
                await self.multiplexer.wait_if_paused()
            import time as _time
            _step_start = _time.monotonic()
            print(f"[agent:{self.tab_id}] Step {step + 1}/{max_steps} for: {task}")
            _t0 = _time.monotonic()
            screenshot_b64 = await self.server.request_screenshot(self.tab_id)
            _t1 = _time.monotonic()
            raw_bytes = base64.b64decode(screenshot_b64)
            img = Image.open(io.BytesIO(raw_bytes))
            vw = img.width // 2
            vh = img.height // 2
            img = img.resize((vw, vh), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=70)
            screenshot_bytes = buf.getvalue()
            _t2 = _time.monotonic()
            print(f"[agent:{self.tab_id}] screenshot: {(_t1-_t0)*1000:.0f}ms, resize: {(_t2-_t1)*1000:.0f}ms")

            if step == 0:
                text = f"Task: {task}"
                if self.contract:
                    text += f"\n\n{self.contract.to_agent_prompt()}"
                text += "\n\nThis is the current page. What is the next action?"
            else:
                text = "Updated page. Continue with the task or respond with done."
                if self.contract:
                    text += f"\n\n{self.contract.to_agent_prompt()}"

            # Inject multiplexer context
            extra_parts = []
            if self.multiplexer:
                ctx = self.multiplexer.get_context(self.agent_id)
                if ctx["unread_messages"]:
                    text += "\n\nRecent messages from other agents:"
                    for msg in ctx["unread_messages"]:
                        text += f"\n- [{msg['agent']}]: {msg['message']}"
                log_entries = self.multiplexer.get_log_context(self.agent_id)
                if log_entries:
                    text += "\n\nNew log entries:"
                    for entry in log_entries:
                        text += f"\n- [{entry['agent']}]: {entry['message']}"
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

            _t3 = _time.monotonic()
            response = await self.client.aio.models.generate_content(
                model="gemini-3-flash-preview",
                contents=history,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT + f"\n\nYour name is {self.name}.",
                    response_mime_type="application/json",
                ),
            )
            _t4 = _time.monotonic()
            print(f"[agent:{self.tab_id}] inference: {(_t4-_t3)*1000:.0f}ms, total step: {(_t4-_step_start)*1000:.0f}ms")

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

            if not isinstance(action, dict) or "action" not in action:
                print(f"[agent:{self.tab_id}] Missing 'action' key: {response_text}")
                continue

            # Handle contract actions
            if action["action"] == "update_commitment":
                if self.contract:
                    idx = action.get("index", 0)
                    status = action.get("status", "done")
                    self.contract.update_commitment(idx, status)
                    print(f"[agent:{self.tab_id}] Commitment {idx} -> {status}")
                    await self.server.send_contract_update(self.contract)
                continue

            if action["action"] == "update_commitments":
                if self.contract:
                    for update in action.get("updates", []):
                        idx = update.get("index", 0)
                        status = update.get("status", "done")
                        self.contract.update_commitment(idx, status)
                        print(f"[agent:{self.tab_id}] Commitment {idx} -> {status}")
                    await self.server.send_contract_update(self.contract)
                continue

            if action["action"] == "add_memo":
                if self.contract:
                    memo_text = action.get("text", "")
                    self.contract.add_memo(memo_text)
                    print(f"[agent:{self.tab_id}] Memo: {memo_text}")
                    await self.server.send_contract_update(self.contract)
                continue

            # Handle log
            if action["action"] == "log":
                if self.multiplexer:
                    message = action.get("message", "")
                    await self.multiplexer.append_log(self.agent_id, message)
                    print(f"[agent:{self.tab_id}] Logged: {message}")
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
                        print(f"[agent:{self.tab_id}] Speech rejected — channel busy")
                        # Tell the model its message didn't go through
                        history.append(types.Content(
                            role="user",
                            parts=[types.Part(text="Your speech was rejected — another agent is currently speaking. Your message was NOT delivered. Retry the same message later when the channel is free.")],
                        ))
                continue

            if action["action"] == "wait":
                print(f"[agent:{self.tab_id}] Waiting for messages...")
                await asyncio.sleep(2)
                # Feed back only unread messages — no screenshot, no heavy prompt
                if self.multiplexer:
                    ctx = self.multiplexer.get_context(self.agent_id)
                    wait_text = "You waited. "
                    if ctx["unread_messages"]:
                        wait_text += "New messages from other agents:"
                        for msg in ctx["unread_messages"]:
                            wait_text += f"\n- [{msg['agent']}]: {msg['message']}"
                    else:
                        wait_text += "No new messages yet."
                    history.append(types.Content(
                        role="user",
                        parts=[types.Part(text=wait_text)],
                    ))
                continue

            if action["action"] == "done":
                # Check for unread user messages/audio before finishing
                if self.multiplexer:
                    ctx = self.multiplexer.get_context(self.agent_id)
                    log_entries = self.multiplexer.get_log_context(self.agent_id)
                    has_new = ctx["unread_messages"] or ctx["user_audio"] or log_entries
                    if has_new:
                        interrupt_text = "Before you finish — new input has arrived. Review and act on it if relevant, otherwise you can done again.\n"
                        if ctx["unread_messages"]:
                            interrupt_text += "\nMessages from other agents:"
                            for msg in ctx["unread_messages"]:
                                interrupt_text += f"\n- [{msg['agent']}]: {msg['message']}"
                        if log_entries:
                            interrupt_text += "\nNew log entries:"
                            for entry in log_entries:
                                interrupt_text += f"\n- [{entry['agent']}]: {entry['message']}"
                        parts = [types.Part(text=interrupt_text)]
                        if ctx["user_audio"]:
                            interrupt_text += "\n[USER INSTRUCTION]: The user has spoken. Listen to the audio below."
                            for audio_bytes, mime_type in ctx["user_audio"]:
                                parts.append(types.Part(
                                    inline_data=types.Blob(data=audio_bytes, mime_type=mime_type)
                                ))
                        history.append(types.Content(role="user", parts=parts))
                        print(f"[agent:{self.tab_id}] Intercepted done — new input found, continuing")
                        continue

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
