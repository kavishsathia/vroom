import asyncio
import base64
import db
from google import genai
from google.genai import types
from agent import Agent
from contract import Contract


SYSTEM_PROMPT = """\
You are a browser task coordinator. You receive a task from the user and break it into \
subtasks that run in parallel on separate browser tabs.

You have these tools:
- spawn_executor(task, commitments): Launch an executor on a new browser tab to perform a specific subtask. \
  This is async — the executor runs in the background. Be specific in the task description. \
  You MUST provide a list of commitments — concrete, verifiable deliverables the executor must complete.
- spawn_executor_on_tab(task, commitments, tab_id): Launch an executor on an EXISTING browser tab. \
  The tab is already open with content — the executor will see the current page and continue from there. \
  Use this when the user has attached existing tabs to their prompt.
- wait_for_results(): Wait for ALL running executors to finish and get their summaries AND updated contracts.
- wait_for_one(executor_id): Wait for a specific executor to finish and get its summary and contract.
- wait_for_any(): Wait for the next executor to finish (whichever completes first) and get its summary and contract.
- list_tabs(): List all open tabs and which executor is running on each. Use this to find available tabs \
  for reattachment (e.g. if a previous executor failed, you can spawn a new one on the same tab).
- complete(summary): Signal that the entire task is done and report the final summary to the user.

Contracts:
Each executor receives a contract with commitments you define. As it works, the executor will:
- Mark commitments as "done" or "failed"
- Add memos for anything unexpected (blockers, corrections, extra info)
When results come back, review the updated contract carefully:
- If commitments are failed or memos indicate issues, spawn a new executor to retry or fix
- Use memo content to inform your next steps

Workflow:
1. Analyze the user's task and break it into independent subtasks
2. Call spawn_executor for each subtask with specific commitments (they run in parallel)
3. Call wait_for_results to collect their summaries and contracts
4. Review contracts — spawn more executors if needed, or call complete

Rules:
- Each subtask must be self-contained and specific
- Commitments must be concrete and verifiable (e.g. "Navigate to google.com", "Click the first search result")
- You can spawn multiple rounds of executors based on previous results
- Always call wait_for_results before reviewing what executors did
- If the task is simple and cannot be parallelized, spawn a single executor
- Pay attention to temporal dependencies — if the user says "after X, do Y" or \
  "wait for X then do Y", spawn X first, call wait_for_results, THEN spawn Y
- Only parallelize subtasks that are truly independent
- Executors can speak to the user. If the user wants something spoken or communicated, \
  include that in the executor's task description (e.g. "then say hello to the user"). \
  Pass speech instructions through faithfully — do not strip them out.
- When an executor fails, use list_tabs() to find its tab, then spawn_executor_on_tab to retry \
  on the same tab — the page state is preserved, so the new executor can continue where the old one left off.
- Results include tab_id so you can easily reattach. Prefer reusing tabs over opening new ones.
- You will receive chat log updates between tool calls. The user may send messages via chat — \
  treat these as corrections or instructions and adapt your plan accordingly.

Skills:
The browser has a global skill library — reusable procedures and knowledge learned from previous tasks. \
You can see the available skills (names + descriptions) and attach relevant ones to executors when spawning them. \
Executors can read_skill, replace_text_in_skill, and add_skill during execution. When executors finish, \
their results include which skills they used or added. You can then attach these skills (including newly \
added ones) to future executors in the same or subsequent rounds. Think of skills as institutional memory \
— if an executor discovers a login flow, a site quirk, or a useful procedure, it can save it as a skill \
for everyone to benefit from.
"""

TOOLS = [
    types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="spawn_executor",
                description="Launch an executor on a new browser tab to perform a subtask. "
                "The executor runs asynchronously in the background. "
                "Be specific: 'search for Python on Google and click the first result'.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "task": types.Schema(
                            type="STRING",
                            description="Specific task for the executor to perform",
                        ),
                        "commitments": types.Schema(
                            type="ARRAY",
                            items=types.Schema(type="STRING"),
                            description="List of concrete, verifiable deliverables the executor must complete",
                        ),
                        "skills": types.Schema(
                            type="ARRAY",
                            items=types.Schema(type="STRING"),
                            description="Names of skills to attach to this executor (from the available skills list)",
                        ),
                    },
                    required=["task", "commitments"],
                ),
            ),
            types.FunctionDeclaration(
                name="spawn_executor_on_tab",
                description="Launch an executor on an EXISTING browser tab (already open with content). "
                "Use this when the user has attached tabs to their prompt. The executor will see "
                "the current page on that tab and continue from there — no need to navigate.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "task": types.Schema(
                            type="STRING",
                            description="Specific task for the executor to perform on the existing tab",
                        ),
                        "tab_id": types.Schema(
                            type="INTEGER",
                            description="The ID of the existing tab to use",
                        ),
                        "commitments": types.Schema(
                            type="ARRAY",
                            items=types.Schema(type="STRING"),
                            description="List of concrete, verifiable deliverables the executor must complete",
                        ),
                        "skills": types.Schema(
                            type="ARRAY",
                            items=types.Schema(type="STRING"),
                            description="Names of skills to attach to this executor (from the available skills list)",
                        ),
                    },
                    required=["task", "tab_id", "commitments"],
                ),
            ),
            types.FunctionDeclaration(
                name="wait_for_results",
                description="Wait for ALL running executors to finish and return their summaries.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={},
                ),
            ),
            types.FunctionDeclaration(
                name="wait_for_one",
                description="Wait for a specific executor to finish and return its summary.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "executor_id": types.Schema(
                            type="STRING",
                            description="The executor ID to wait for (e.g. 'exec_1')",
                        )
                    },
                    required=["executor_id"],
                ),
            ),
            types.FunctionDeclaration(
                name="wait_for_any",
                description="Wait for the next executor to finish (whichever completes first) "
                "and return its summary. Other executors keep running.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={},
                ),
            ),
            types.FunctionDeclaration(
                name="list_tabs",
                description="List all open tabs and which executor (if any) is currently running on each one. "
                "Use this to see available tabs before spawning an executor on an existing tab.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={},
                ),
            ),
            types.FunctionDeclaration(
                name="complete",
                description="Signal that the entire task is done and report the final summary.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "summary": types.Schema(
                            type="STRING",
                            description="Final summary of what was accomplished",
                        )
                    },
                    required=["summary"],
                ),
            ),
        ]
    )
]


class Extractor:
    def __init__(self, server, pool=None, user_id=None, multiplexer=None, skill_store=None):
        self.server = server
        self.pool = pool
        self.user_id = user_id
        self.client = genai.Client()
        self.multiplexer = multiplexer
        self.skill_store = skill_store
        self.task_db_id = None
        self._executor_counter = 0
        self._running = {}  # executor_id -> asyncio.Task
        self._results = {}  # executor_id -> {summary, used_skills}
        self._contracts = {}  # executor_id -> Contract
        self._tab_ids = {}  # executor_id -> tab_id

    async def run(self, task, existing_tabs=None, audio=None):
        print(f"[extractor] Starting: {task}")
        await self.server.send_status(f"Extractor starting: {task}")

        # Persist task
        if self.pool and self.user_id:
            self.task_db_id = await db.create_task(self.pool, self.user_id, task)

        # Register extractor with multiplexer so it can read chat log
        if self.multiplexer:
            self.multiplexer.register("extractor")

        parts = []
        prompt = f"Task: {task}"

        if self.skill_store:
            skills_list = await self.skill_store.list_skills()
            if skills_list:
                prompt += "\n\nAvailable skills in the browser library:"
                for s in skills_list:
                    prompt += f"\n- {s['name']}: {s['description']}"
                prompt += "\n\nAttach relevant skills to executors using the 'skills' parameter."

        if existing_tabs:
            tab_descriptions = []
            for tab in existing_tabs:
                tab_id = tab.get("id")
                title = tab.get("title", "Unknown")
                url = tab.get("url", "")
                tab_descriptions.append(f"- Tab {tab_id}: \"{title}\" ({url})")
            prompt += "\n\nThe user has attached these existing tabs:\n" + "\n".join(tab_descriptions)
            prompt += "\n\nUse spawn_executor_on_tab to run tasks on these tabs instead of opening new ones."
            prompt += "\nScreenshots of each tab follow in order:"

            parts.append(types.Part(text=prompt))

            for tab in existing_tabs:
                screenshot_b64 = tab.get("screenshot")
                tab_id = tab.get("id")
                if screenshot_b64:
                    parts.append(types.Part(text=f"Screenshot of Tab {tab_id}:"))
                    parts.append(types.Part(
                        inline_data=types.Blob(
                            data=base64.b64decode(screenshot_b64),
                            mime_type="image/jpeg",
                        )
                    ))
        else:
            parts.append(types.Part(text=prompt))

        # Include audio instruction if provided
        if audio:
            audio_bytes, mime_type = audio
            parts.append(types.Part(text="The user also provided an audio instruction. Listen to it and follow it:"))
            parts.append(types.Part(
                inline_data=types.Blob(data=audio_bytes, mime_type=mime_type)
            ))

        history = [
            types.Content(role="user", parts=parts)
        ]

        while True:
            response = await self.client.aio.models.generate_content(
                model="gemini-3-flash-preview",
                contents=history,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    tools=TOOLS,
                ),
            )

            # Collect all function calls from the response
            function_calls = []
            text_parts = []
            for candidate in response.candidates:
                for part in candidate.content.parts:
                    if part.function_call:
                        function_calls.append(part.function_call)
                    if part.text:
                        text_parts.append(part.text)

            # Add model response to history
            history.append(response.candidates[0].content)

            if text_parts:
                for t in text_parts:
                    print(f"[extractor] Says: {t}")
                    await self.server.send_status(f"Extractor: {t}")

            if not function_calls:
                # Model responded with text only, no tool calls — prompt it to act
                history.append(
                    types.Content(
                        role="user",
                        parts=[types.Part(text="Please use your tools to proceed with the task.")],
                    )
                )
                continue

            # Process all function calls, collect responses
            function_responses = []
            done = False

            for fc in function_calls:
                if fc.name == "spawn_executor":
                    subtask = fc.args.get("task", "")
                    commitments = fc.args.get("commitments", [])
                    skill_names = fc.args.get("skills", [])
                    executor_id = await self._spawn(subtask, commitments, skill_names=skill_names)
                    await self.server.send_status(f"Spawned executor {executor_id}: {subtask}")
                    response_data = {"executor_id": executor_id, "status": "spawned"}
                    if executor_id in self._tab_ids:
                        response_data["tab_id"] = self._tab_ids[executor_id]
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="spawn_executor",
                                response=response_data,
                            )
                        )
                    )

                elif fc.name == "spawn_executor_on_tab":
                    subtask = fc.args.get("task", "")
                    tab_id = int(fc.args.get("tab_id", 0))
                    commitments = fc.args.get("commitments", [])
                    skill_names = fc.args.get("skills", [])
                    executor_id = await self._spawn_on_tab(subtask, commitments, tab_id, skill_names=skill_names)
                    await self.server.send_status(f"Spawned executor {executor_id} on tab {tab_id}: {subtask}")
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="spawn_executor_on_tab",
                                response={"executor_id": executor_id, "tab_id": tab_id, "status": "spawned"},
                            )
                        )
                    )

                elif fc.name == "wait_for_results":
                    results = await self._wait_for_results()
                    # Build contract summaries and attach tab_ids
                    contract_summaries = []
                    results_with_tabs = {}
                    all_used_skills = set()
                    for eid in results:
                        result = results[eid]
                        summary = result["summary"] if isinstance(result, dict) else result
                        used_skills = result.get("used_skills", []) if isinstance(result, dict) else []
                        all_used_skills.update(used_skills)
                        entry = {"summary": summary}
                        if used_skills:
                            entry["used_skills"] = used_skills
                        if eid in self._tab_ids:
                            entry["tab_id"] = self._tab_ids[eid]
                        results_with_tabs[eid] = entry
                        if eid in self._contracts:
                            contract_summaries.append(self._contracts[eid].summary_for_extractor())
                    response_data = {"results": results_with_tabs}
                    if contract_summaries:
                        response_data["contracts"] = "\n\n".join(contract_summaries)
                    if all_used_skills:
                        response_data["skills_used_or_added"] = list(all_used_skills)
                        if self.skill_store:
                            response_data["available_skills"] = await self.skill_store.list_skills()
                    await self.server.send_status(f"Results: {results}")
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="wait_for_results",
                                response=response_data,
                            )
                        )
                    )

                elif fc.name == "wait_for_one":
                    eid = fc.args.get("executor_id", "")
                    result = await self._wait_for_one(eid)
                    summary = result["summary"] if isinstance(result, dict) else result
                    used_skills = result.get("used_skills", []) if isinstance(result, dict) else []
                    response_data = {"executor_id": eid, "summary": summary}
                    if used_skills:
                        response_data["used_skills"] = used_skills
                        if self.skill_store:
                            response_data["available_skills"] = await self.skill_store.list_skills()
                    if eid in self._tab_ids:
                        response_data["tab_id"] = self._tab_ids[eid]
                    if eid in self._contracts:
                        response_data["contract"] = self._contracts[eid].summary_for_extractor()
                    await self.server.send_status(f"Result [{eid}]: {summary}")
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="wait_for_one",
                                response=response_data,
                            )
                        )
                    )

                elif fc.name == "wait_for_any":
                    eid, result = await self._wait_for_any()
                    summary = result["summary"] if isinstance(result, dict) else result
                    used_skills = result.get("used_skills", []) if isinstance(result, dict) else []
                    response_data = {"executor_id": eid, "summary": summary}
                    if used_skills:
                        response_data["used_skills"] = used_skills
                        if self.skill_store:
                            response_data["available_skills"] = await self.skill_store.list_skills()
                    if eid in self._tab_ids:
                        response_data["tab_id"] = self._tab_ids[eid]
                    if eid in self._contracts:
                        response_data["contract"] = self._contracts[eid].summary_for_extractor()
                    await self.server.send_status(f"Result [{eid}]: {summary}")
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="wait_for_any",
                                response=response_data,
                            )
                        )
                    )

                elif fc.name == "list_tabs":
                    tab_info = self._get_tab_info()
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="list_tabs",
                                response={"tabs": tab_info},
                            )
                        )
                    )

                elif fc.name == "complete":
                    summary = fc.args.get("summary", "Task completed")
                    print(f"[extractor] Complete: {summary}")
                    await self._cleanup()
                    if self.pool and self.task_db_id:
                        await db.update_task_status(self.pool, self.task_db_id, "complete")
                    await self.server.send_complete(summary)
                    done = True
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="complete",
                                response={"status": "done"},
                            )
                        )
                    )

            # Inject user preemptions (audio + chat log)
            if self.multiplexer:
                user_audio = self.multiplexer.drain_user_audio()
                if user_audio:
                    function_responses.append(types.Part(text=(
                        "[USER CORRECTION]: The user interrupted and spoke while executors were running. "
                        "Listen to the audio below. IMPORTANT: The running executors also heard this audio "
                        "in real-time and may have already adapted their behavior. Check the executor results "
                        "— if an executor already completed the corrected task, do NOT spawn a duplicate."
                    )))
                    for audio_bytes, mime_type in user_audio:
                        function_responses.append(types.Part(
                            inline_data=types.Blob(data=audio_bytes, mime_type=mime_type)
                        ))

                log_entries = self.multiplexer.get_log_context("extractor")
                if log_entries:
                    chat_text = "[CHAT UPDATE]: New messages in the shared chat log:\n"
                    for entry in log_entries:
                        chat_text += f"- [{entry['agent']}]: {entry['message']}\n"
                    chat_text += "If the user posted a message, treat it as a correction or instruction. Adapt your plan accordingly."
                    function_responses.append(types.Part(text=chat_text))

            # Add tool responses to history
            history.append(
                types.Content(role="user", parts=function_responses)
            )

            if done:
                if self.multiplexer:
                    self.multiplexer.unregister("extractor")
                return

    async def _resolve_skills(self, skill_names):
        """Resolve skill names to [{name, description}] for attaching to an agent."""
        if not self.skill_store or not skill_names:
            return []
        return await self.skill_store.resolve_skills(skill_names)

    async def _spawn(self, subtask, commitments=None, skill_names=None):
        self._executor_counter += 1
        executor_id = f"exec_{self._executor_counter}"
        name, voice = self.multiplexer.next_agent() if self.multiplexer else (executor_id, None)
        attached_skills = await self._resolve_skills(skill_names)

        contract = Contract(
            executor_id, name, subtask,
            [{"text": c, "status": "pending"} for c in (commitments or [])],
        )
        self._contracts[executor_id] = contract

        # Persist executor and commitments
        executor_db_id = None
        if self.pool and self.task_db_id:
            executor_db_id = await db.create_executor(
                self.pool, self.task_db_id, executor_id, name, subtask,
            )
            if commitments:
                await db.create_commitments(
                    self.pool, executor_db_id,
                    [{"text": c} for c in commitments],
                )

        async def _run_executor():
            tab_ids = await self.server.open_tabs(1, "about:blank", subtask)
            tab_id = tab_ids[0]
            self._tab_ids[executor_id] = tab_id
            if self.pool and executor_db_id:
                await db.update_executor(self.pool, executor_db_id, tab_id=tab_id)
            await self._send_contract(contract)
            try:
                agent = Agent(self.server, tab_id, multiplexer=self.multiplexer,
                              agent_id=executor_id, name=name, voice=voice,
                              contract=contract, skill_store=self.skill_store,
                              attached_skills=attached_skills,
                              pool=self.pool, executor_db_id=executor_db_id)
                result = await agent.run(subtask)
                self._results[executor_id] = result
                if self.pool and executor_db_id:
                    summary = result["summary"] if isinstance(result, dict) else str(result)
                    await db.update_executor(self.pool, executor_db_id, status="complete", summary=summary)
            except Exception as e:
                self._results[executor_id] = f"Error: {e}"
                if self.pool and executor_db_id:
                    await db.update_executor(self.pool, executor_db_id, status="error", summary=str(e))

        self._running[executor_id] = asyncio.create_task(_run_executor())
        print(f"[extractor] Spawned {executor_id} ({name}): {subtask}" +
              (f" with skills: {skill_names}" if skill_names else ""))
        return executor_id

    async def _spawn_on_tab(self, subtask, commitments=None, tab_id=0, skill_names=None):
        """Spawn an executor on an existing tab — no new tab is opened or closed."""
        self._executor_counter += 1
        executor_id = f"exec_{self._executor_counter}"
        name, voice = self.multiplexer.next_agent() if self.multiplexer else (executor_id, None)
        attached_skills = await self._resolve_skills(skill_names)

        contract = Contract(
            executor_id, name, subtask,
            [{"text": c, "status": "pending"} for c in (commitments or [])],
        )
        self._contracts[executor_id] = contract
        self._tab_ids[executor_id] = tab_id

        # Persist executor and commitments
        executor_db_id = None
        if self.pool and self.task_db_id:
            executor_db_id = await db.create_executor(
                self.pool, self.task_db_id, executor_id, name, subtask, tab_id=tab_id,
            )
            if commitments:
                await db.create_commitments(
                    self.pool, executor_db_id,
                    [{"text": c} for c in commitments],
                )

        async def _run_executor():
            await self._send_contract(contract)
            try:
                agent = Agent(self.server, tab_id, multiplexer=self.multiplexer,
                              agent_id=executor_id, name=name, voice=voice,
                              contract=contract, skill_store=self.skill_store,
                              attached_skills=attached_skills,
                              pool=self.pool, executor_db_id=executor_db_id)
                result = await agent.run(subtask)
                self._results[executor_id] = result
                if self.pool and executor_db_id:
                    summary = result["summary"] if isinstance(result, dict) else str(result)
                    await db.update_executor(self.pool, executor_db_id, status="complete", summary=summary)
            except Exception as e:
                self._results[executor_id] = f"Error: {e}"
                if self.pool and executor_db_id:
                    await db.update_executor(self.pool, executor_db_id, status="error", summary=str(e))

        self._running[executor_id] = asyncio.create_task(_run_executor())
        print(f"[extractor] Spawned {executor_id} ({name}) on existing tab {tab_id}: {subtask}" +
              (f" with skills: {skill_names}" if skill_names else ""))
        return executor_id

    async def _send_contract(self, contract):
        """Send contract to frontend for display."""
        await self.server.send_contract_update(contract)

    def _get_tab_info(self):
        """List all tabs with their executor assignments."""
        tab_executors = {}
        for eid, tid in self._tab_ids.items():
            is_running = eid in self._running and not self._running[eid].done()
            tab_executors[tid] = {
                "tab_id": tid,
                "executor_id": eid,
                "status": "running" if is_running else "finished",
            }
        return list(tab_executors.values())

    async def _wait_for_results(self):
        if not self._running:
            return self._results

        print(f"[extractor] Waiting for {len(self._running)} executors...")
        await asyncio.gather(*self._running.values(), return_exceptions=True)
        self._running.clear()

        results = dict(self._results)
        self._results.clear()
        return results

    async def _wait_for_one(self, executor_id):
        if executor_id in self._results:
            result = self._results.pop(executor_id)
            self._running.pop(executor_id, None)
            return result

        if executor_id not in self._running:
            return f"Unknown executor: {executor_id}"

        print(f"[extractor] Waiting for {executor_id}...")
        await self._running[executor_id]
        del self._running[executor_id]
        result = self._results.pop(executor_id, "No result")
        return result

    async def _wait_for_any(self):
        # Return an already-completed result if available
        for eid in list(self._results.keys()):
            if eid not in self._running or self._running[eid].done():
                self._running.pop(eid, None)
                return eid, self._results.pop(eid)

        if not self._running:
            return "none", "No executors running"

        # Wait for the first one to complete
        print(f"[extractor] Waiting for any of {list(self._running.keys())}...")
        done, _ = await asyncio.wait(
            self._running.values(), return_when=asyncio.FIRST_COMPLETED
        )

        # Find which executor finished
        for eid, task in list(self._running.items()):
            if task in done:
                del self._running[eid]
                result = self._results.pop(eid, "No result")
                return eid, result

        return "unknown", "No result"

    async def _cleanup(self):
        for task in self._running.values():
            task.cancel()
        self._running.clear()
