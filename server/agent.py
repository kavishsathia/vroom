import asyncio
import base64
import io
import os
import db
from google import genai
from google.genai import types
from PIL import Image, ImageDraw


SYSTEM_PROMPT = """\
You are a browser automation agent. You receive a task and a screenshot of the current page.

Analyze the screenshot and use the provided tools to interact with the browser.

Skills:
You may have been given skills to reference. Skills are reusable procedures or knowledge from \
previous tasks. Use read_skill to read one when it's relevant to your current work. If you discover \
something reusable (a login flow, a site-specific trick, a workaround), save it as a new skill with \
add_skill. If a skill is outdated or wrong, read it first then use replace_text_in_skill to fix it.

Speech system:
You are one of multiple agents running in parallel. You all share a single audio channel to \
speak to the user. Only one agent can speak at a time — just like humans in a conversation.

When you want to say something, use the speak tool. \
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
- If you are stuck and cannot make progress, use done with an error summary
- If you have confidently completed the task, use done immediately — do not keep going
"""

TOOLS = [
    types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="click",
                description="Click an element on the page. Coordinates are normalized 0-1000.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "box_2d": types.Schema(
                            type="ARRAY",
                            items=types.Schema(type="INTEGER"),
                            description="Bounding box [y_min, x_min, y_max, x_max] in normalized 0-1000 coordinates",
                        ),
                        "label": types.Schema(
                            type="STRING",
                            description="Description of the element being clicked",
                        ),
                    },
                    required=["box_2d"],
                ),
            ),
            types.FunctionDeclaration(
                name="type",
                description="Type text into the currently focused element.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "text": types.Schema(
                            type="STRING",
                            description="Text to type",
                        ),
                    },
                    required=["text"],
                ),
            ),
            types.FunctionDeclaration(
                name="key_press",
                description="Press a keyboard key. Supports: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space. Can combine with modifiers.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "key": types.Schema(
                            type="STRING",
                            description="Key to press (e.g. 'Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown')",
                        ),
                        "ctrl": types.Schema(
                            type="BOOLEAN",
                            description="Hold Ctrl/Cmd",
                        ),
                        "shift": types.Schema(
                            type="BOOLEAN",
                            description="Hold Shift",
                        ),
                        "alt": types.Schema(
                            type="BOOLEAN",
                            description="Hold Alt",
                        ),
                    },
                    required=["key"],
                ),
            ),
            types.FunctionDeclaration(
                name="hover",
                description="Hover over an element to reveal tooltips, dropdowns, or hidden menus.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "box_2d": types.Schema(
                            type="ARRAY",
                            items=types.Schema(type="INTEGER"),
                            description="Bounding box [y_min, x_min, y_max, x_max] in normalized 0-1000 coordinates",
                        ),
                        "label": types.Schema(
                            type="STRING",
                            description="Description of the element being hovered",
                        ),
                    },
                    required=["box_2d"],
                ),
            ),
            types.FunctionDeclaration(
                name="navigate",
                description="Navigate to a specific URL. Waits for the page to finish loading.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "url": types.Schema(
                            type="STRING",
                            description="The URL to navigate to",
                        ),
                    },
                    required=["url"],
                ),
            ),
            types.FunctionDeclaration(
                name="scroll",
                description="Scroll the page. Supports up, down, left, right. Can specify pixel amount.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "direction": types.Schema(
                            type="STRING",
                            description="Scroll direction: 'up', 'down', 'left', or 'right'",
                        ),
                        "amount": types.Schema(
                            type="INTEGER",
                            description="Pixels to scroll (default 400)",
                        ),
                    },
                    required=["direction"],
                ),
            ),
            types.FunctionDeclaration(
                name="wait",
                description="Do nothing and wait for messages from other agents. Use this when you are waiting for another agent to act before you can proceed.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={},
                ),
            ),
            types.FunctionDeclaration(
                name="speak",
                description="Say something to the user via audio. Keep it to 1 sentence.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "message": types.Schema(
                            type="STRING",
                            description="The message to speak",
                        ),
                    },
                    required=["message"],
                ),
            ),
            types.FunctionDeclaration(
                name="log",
                description="Write to the shared chat log (visible to all agents and the user). Use this for structured data, URLs, numbers, comparisons — anything better read than heard. No audio is produced. This is an informal chat — feel free to be friendly, crack jokes, react to what other agents say, or just vibe.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "message": types.Schema(
                            type="STRING",
                            description="The message to log",
                        ),
                    },
                    required=["message"],
                ),
            ),
            types.FunctionDeclaration(
                name="update_commitment",
                description="Update a single commitment in your contract.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "index": types.Schema(
                            type="INTEGER",
                            description="The index of the commitment to update",
                        ),
                        "status": types.Schema(
                            type="STRING",
                            description="New status: 'done' or 'failed'",
                        ),
                    },
                    required=["index", "status"],
                ),
            ),
            types.FunctionDeclaration(
                name="update_commitments",
                description="Update multiple commitments at once.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "updates": types.Schema(
                            type="ARRAY",
                            items=types.Schema(
                                type="OBJECT",
                                properties={
                                    "index": types.Schema(type="INTEGER"),
                                    "status": types.Schema(type="STRING"),
                                },
                            ),
                            description="List of {index, status} updates",
                        ),
                    },
                    required=["updates"],
                ),
            ),
            types.FunctionDeclaration(
                name="add_memo",
                description="Add a memo to your contract. Use this for unexpected findings, blockers, corrections, or extra context the coordinator should know.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "text": types.Schema(
                            type="STRING",
                            description="The memo text",
                        ),
                    },
                    required=["text"],
                ),
            ),
            types.FunctionDeclaration(
                name="read_skill",
                description="Read the full text of a skill. You must read a skill before you can replace text in it.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "name": types.Schema(
                            type="STRING",
                            description="Name of the skill to read",
                        ),
                    },
                    required=["name"],
                ),
            ),
            types.FunctionDeclaration(
                name="replace_text_in_skill",
                description="Replace text in a skill you've already read. Use this when you've learned something new.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "name": types.Schema(
                            type="STRING",
                            description="Name of the skill to update",
                        ),
                        "old_text": types.Schema(
                            type="STRING",
                            description="Text to find and replace",
                        ),
                        "new_text": types.Schema(
                            type="STRING",
                            description="Replacement text",
                        ),
                    },
                    required=["name", "old_text", "new_text"],
                ),
            ),
            types.FunctionDeclaration(
                name="add_skill",
                description="Create a new skill in the global browser skill library. Use this when you've discovered a reusable procedure, workflow, or piece of knowledge that future agents could benefit from.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "name": types.Schema(
                            type="STRING",
                            description="Name for the new skill",
                        ),
                        "description": types.Schema(
                            type="STRING",
                            description="Brief description of what the skill does",
                        ),
                        "text": types.Schema(
                            type="STRING",
                            description="Full text content of the skill",
                        ),
                    },
                    required=["name", "description", "text"],
                ),
            ),
            types.FunctionDeclaration(
                name="done",
                description="Task is complete. Make sure all commitments are updated before finishing.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "summary": types.Schema(
                            type="STRING",
                            description="Summary of what was accomplished",
                        ),
                    },
                    required=["summary"],
                ),
            ),
        ]
    )
]


class Agent:
    def __init__(self, server, tab_id, multiplexer=None, agent_id=None, name=None, voice=None,
                 contract=None, skill_store=None, attached_skills=None, pool=None, executor_db_id=None):
        self.server = server
        self.tab_id = tab_id
        self.client = genai.Client()
        self.multiplexer = multiplexer
        self.agent_id = agent_id or f"tab_{tab_id}"
        self.name = name or self.agent_id
        self.voice = voice
        self.contract = contract
        self.skill_store = skill_store
        self.attached_skills = attached_skills or []  # [{name, description}]
        self.pool = pool
        self.executor_db_id = executor_db_id
        self.used_skills = set()  # skill names read/added/modified during run
        self._read_skills = set()  # skills that have been read (required before replace)

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
                await self.multiplexer.wait_if_paused(self.agent_id)
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
                if self.attached_skills:
                    text += "\n\nAvailable skills (use read_skill to read any that seem relevant):"
                    for s in self.attached_skills:
                        text += f"\n- {s['name']}: {s['description']}"
                text += "\n\nThis is the current page. What is the next action?"
            else:
                text = "Updated page. Continue with the task or use done when finished."
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
                if ctx.get("visual_preempt"):
                    vp = ctx["visual_preempt"]
                    text += f"\n\n[USER TOOK MANUAL CONTROL]: The user paused you and manually interacted with the browser. "
                    text += f"They performed {len(vp)} click(s). Screenshots after each click are attached below. "
                    text += "Continue from the current page state — the user may have navigated, filled forms, or changed the page."
                    for i, interaction in enumerate(vp):
                        text += f"\n- Click {i+1} at viewport position ({interaction['x']}, {interaction['y']})"
                        if interaction.get("screenshot"):
                            extra_parts.append(types.Part(
                                inline_data=types.Blob(
                                    data=base64.b64decode(interaction["screenshot"]),
                                    mime_type="image/jpeg"
                                )
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
                    tools=TOOLS,
                ),
            )
            _t4 = _time.monotonic()
            print(f"[agent:{self.tab_id}] inference: {(_t4-_t3)*1000:.0f}ms, total step: {(_t4-_step_start)*1000:.0f}ms")

            # Extract function call from response
            fc = None
            for part in response.candidates[0].content.parts:
                if part.function_call:
                    fc = part.function_call
                    break

            if not fc:
                # Model returned text instead of a function call — log and retry
                response_text = response.text if response.text else "(no response)"
                print(f"[agent:{self.tab_id}] No function call, got text: {response_text}")
                history.append(response.candidates[0].content)
                history.append(types.Content(
                    role="user",
                    parts=[types.Part(text="Please use one of the available tools to take an action.")],
                ))
                continue

            print(f"[agent:{self.tab_id}] Function call: {fc.name}({dict(fc.args) if fc.args else {}})")
            history.append(response.candidates[0].content)

            # --- Handle each function ---
            fn = fc.name
            args = fc.args or {}

            if fn == "update_commitment":
                response_data = {"status": "ok"}
                if self.contract:
                    idx = int(args.get("index", 0))
                    status = args.get("status", "done")
                    self.contract.update_commitment(idx, status)
                    if self.pool and self.executor_db_id:
                        await db.update_commitment(self.pool, self.executor_db_id, idx, status)
                    print(f"[agent:{self.tab_id}] Commitment {idx} -> {status}")
                    await self.server.send_contract_update(self.contract)
                history.append(types.Content(role="user", parts=[
                    types.Part(function_response=types.FunctionResponse(name=fn, response=response_data))
                ]))
                continue

            if fn == "update_commitments":
                response_data = {"status": "ok"}
                if self.contract:
                    for update in args.get("updates", []):
                        idx = int(update.get("index", 0))
                        status = update.get("status", "done")
                        self.contract.update_commitment(idx, status)
                        if self.pool and self.executor_db_id:
                            await db.update_commitment(self.pool, self.executor_db_id, idx, status)
                        print(f"[agent:{self.tab_id}] Commitment {idx} -> {status}")
                    await self.server.send_contract_update(self.contract)
                history.append(types.Content(role="user", parts=[
                    types.Part(function_response=types.FunctionResponse(name=fn, response=response_data))
                ]))
                continue

            if fn == "add_memo":
                response_data = {"status": "ok"}
                if self.contract:
                    memo_text = args.get("text", "")
                    self.contract.add_memo(memo_text)
                    print(f"[agent:{self.tab_id}] Memo: {memo_text}")
                    await self.server.send_contract_update(self.contract)
                history.append(types.Content(role="user", parts=[
                    types.Part(function_response=types.FunctionResponse(name=fn, response=response_data))
                ]))
                continue

            if fn == "read_skill":
                skill_name = args.get("name", "")
                if self.skill_store:
                    text_content = await self.skill_store.get_skill(skill_name)
                    if text_content:
                        self._read_skills.add(skill_name)
                        self.used_skills.add(skill_name)
                        response_data = {"skill": text_content}
                        print(f"[agent:{self.tab_id}] Read skill: {skill_name}")
                    else:
                        response_data = {"error": f"Skill '{skill_name}' not found."}
                else:
                    response_data = {"error": "No skill store available."}
                history.append(types.Content(role="user", parts=[
                    types.Part(function_response=types.FunctionResponse(name=fn, response=response_data))
                ]))
                continue

            if fn == "replace_text_in_skill":
                skill_name = args.get("name", "")
                if self.skill_store:
                    if skill_name not in self._read_skills:
                        response_data = {"error": f"You must read_skill '{skill_name}' before replacing text in it."}
                    else:
                        old_text = args.get("old_text", "")
                        new_text = args.get("new_text", "")
                        success = await self.skill_store.replace_text(skill_name, old_text, new_text)
                        if success:
                            self.used_skills.add(skill_name)
                            response_data = {"status": "ok"}
                            print(f"[agent:{self.tab_id}] Updated skill: {skill_name}")
                        else:
                            response_data = {"error": f"Failed to update skill '{skill_name}' — old_text not found."}
                else:
                    response_data = {"error": "No skill store available."}
                history.append(types.Content(role="user", parts=[
                    types.Part(function_response=types.FunctionResponse(name=fn, response=response_data))
                ]))
                continue

            if fn == "add_skill":
                skill_name = args.get("name", "")
                if self.skill_store and skill_name:
                    description = args.get("description", "")
                    skill_text = args.get("text", "")
                    await self.skill_store.add_skill(skill_name, description, skill_text)
                    self.used_skills.add(skill_name)
                    response_data = {"status": "ok"}
                    print(f"[agent:{self.tab_id}] Added skill: {skill_name}")
                else:
                    response_data = {"error": "Missing skill name or no skill store."}
                history.append(types.Content(role="user", parts=[
                    types.Part(function_response=types.FunctionResponse(name=fn, response=response_data))
                ]))
                continue

            if fn == "log":
                response_data = {"status": "ok"}
                if self.multiplexer:
                    message = args.get("message", "")
                    await self.multiplexer.append_log(self.agent_id, message)
                    print(f"[agent:{self.tab_id}] Logged: {message}")
                history.append(types.Content(role="user", parts=[
                    types.Part(function_response=types.FunctionResponse(name=fn, response=response_data))
                ]))
                continue

            if fn == "speak":
                if self.multiplexer:
                    message = args.get("message", "")
                    success, _ = await self.multiplexer.try_speak(self.agent_id, message)
                    if success:
                        response_data = {"status": "delivered"}
                        print(f"[agent:{self.tab_id}] Spoke: {message}")
                        await self.server.send_status(f"[Tab {self.tab_id}] Spoke: {message}")
                    else:
                        response_data = {"status": "rejected", "reason": "Another agent is currently speaking. Your message was NOT delivered. Retry later."}
                        print(f"[agent:{self.tab_id}] Speech rejected — channel busy")
                else:
                    response_data = {"status": "ok"}
                history.append(types.Content(role="user", parts=[
                    types.Part(function_response=types.FunctionResponse(name=fn, response=response_data))
                ]))
                continue

            if fn == "wait":
                print(f"[agent:{self.tab_id}] Waiting for messages...")
                await asyncio.sleep(2)
                response_data = {"status": "waited"}
                if self.multiplexer:
                    ctx = self.multiplexer.get_context(self.agent_id)
                    if ctx["unread_messages"]:
                        response_data["new_messages"] = [
                            f"[{msg['agent']}]: {msg['message']}" for msg in ctx["unread_messages"]
                        ]
                    else:
                        response_data["new_messages"] = []
                history.append(types.Content(role="user", parts=[
                    types.Part(function_response=types.FunctionResponse(name=fn, response=response_data))
                ]))
                continue

            if fn == "done":
                # Check for unread user messages/audio before finishing
                if self.multiplexer:
                    ctx = self.multiplexer.get_context(self.agent_id)
                    log_entries = self.multiplexer.get_log_context(self.agent_id)
                    has_new = ctx["unread_messages"] or ctx["user_audio"] or log_entries
                    if has_new:
                        interrupt_text = "Before you finish — new input has arrived. Review and act on it if relevant, otherwise you can call done again.\n"
                        if ctx["unread_messages"]:
                            interrupt_text += "\nMessages from other agents:"
                            for msg in ctx["unread_messages"]:
                                interrupt_text += f"\n- [{msg['agent']}]: {msg['message']}"
                        if log_entries:
                            interrupt_text += "\nNew log entries:"
                            for entry in log_entries:
                                interrupt_text += f"\n- [{entry['agent']}]: {entry['message']}"
                        parts = [types.Part(function_response=types.FunctionResponse(
                            name=fn, response={"status": "interrupted", "reason": interrupt_text}
                        ))]
                        if ctx["user_audio"]:
                            for audio_bytes, mime_type in ctx["user_audio"]:
                                parts.append(types.Part(
                                    inline_data=types.Blob(data=audio_bytes, mime_type=mime_type)
                                ))
                        history.append(types.Content(role="user", parts=parts))
                        print(f"[agent:{self.tab_id}] Intercepted done — new input found, continuing")
                        continue

                summary = args.get("summary", "Completed")
                print(f"[agent:{self.tab_id}] Done: {summary}")
                await self.server.send_status(f"[Tab {self.tab_id}] Done: {summary}")
                return {"summary": summary, "used_skills": list(self.used_skills)}

            # Browser actions: click, type, navigate, scroll
            label = args.get('label', args.get('text', args.get('direction', '')))
            await self.server.send_status(
                f"[Tab {self.tab_id}] Step {step + 1}: {fn} {label}"
            )

            if fn == "click" and "box_2d" in args and len(args["box_2d"]) == 4:
                box = args["box_2d"]
                x = int(((box[1] + box[3]) / 2) / 1000 * vw)
                y = int(((box[0] + box[2]) / 2) / 1000 * vh)
                print(f"[agent:{self.tab_id}] BBox {box} -> click at ({x}, {y})")
                self._save_debug_screenshot(screenshot_bytes, x, y, step)
                await self.server.send_action(self.tab_id, {
                    "action": "click",
                    "x": x,
                    "y": y,
                })
            elif fn == "click":
                x, y = int(args.get("x", 0)), int(args.get("y", 0))
                self._save_debug_screenshot(screenshot_bytes, x, y, step)
                await self.server.send_action(self.tab_id, {
                    "action": "click",
                    "x": x,
                    "y": y,
                })
            elif fn == "hover" and "box_2d" in args and len(args["box_2d"]) == 4:
                box = args["box_2d"]
                x = int(((box[1] + box[3]) / 2) / 1000 * vw)
                y = int(((box[0] + box[2]) / 2) / 1000 * vh)
                print(f"[agent:{self.tab_id}] BBox {box} -> hover at ({x}, {y})")
                await self.server.send_action(self.tab_id, {
                    "action": "hover",
                    "x": x,
                    "y": y,
                })
            elif fn == "type":
                await self.server.send_action(self.tab_id, {
                    "action": "type",
                    "text": args.get("text", ""),
                })
            elif fn == "key_press":
                await self.server.send_action(self.tab_id, {
                    "action": "key_press",
                    "key": args.get("key", "Enter"),
                    "ctrl": args.get("ctrl", False),
                    "shift": args.get("shift", False),
                    "alt": args.get("alt", False),
                })
            elif fn == "navigate":
                await self.server.send_action(self.tab_id, {
                    "action": "navigate",
                    "url": args.get("url", ""),
                })
            elif fn == "scroll":
                await self.server.send_action(self.tab_id, {
                    "action": "scroll",
                    "direction": args.get("direction", "down"),
                    "amount": args.get("amount", 400),
                })

            # Send function response for browser actions
            history.append(types.Content(role="user", parts=[
                types.Part(function_response=types.FunctionResponse(name=fn, response={"status": "ok"}))
            ]))

            await asyncio.sleep(1)

        await self.server.send_status(f"[Tab {self.tab_id}] Max steps reached")
        return {"summary": "Max steps reached", "used_skills": list(self.used_skills)}

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
