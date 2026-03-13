import asyncio
import base64
from google import genai
from google.genai import types
from agent import Agent


SYSTEM_PROMPT = """\
You are a browser task coordinator. You receive a task from the user and break it into \
subtasks that run in parallel on separate browser tabs.

You have these tools:
- spawn_executor(task): Launch an executor on a new browser tab to perform a specific subtask. \
  This is async — the executor runs in the background. Be specific in the task description.
- spawn_executor_on_tab(task, tab_id): Launch an executor on an EXISTING browser tab. \
  The tab is already open with content — the executor will see the current page and continue from there. \
  Use this when the user has attached existing tabs to their prompt.
- wait_for_results(): Wait for ALL running executors to finish and get their summaries.
- wait_for_one(executor_id): Wait for a specific executor to finish and get its summary.
- wait_for_any(): Wait for the next executor to finish (whichever completes first) and get its summary.
- complete(summary): Signal that the entire task is done and report the final summary to the user.

Workflow:
1. Analyze the user's task and break it into independent subtasks
2. Call spawn_executor for each subtask (they run in parallel)
3. Call wait_for_results to collect their summaries
4. Review the results — spawn more executors if needed, or call complete

Rules:
- Each subtask must be self-contained and specific
- You can spawn multiple rounds of executors based on previous results
- Always call wait_for_results before reviewing what executors did
- If the task is simple and cannot be parallelized, spawn a single executor
- Pay attention to temporal dependencies — if the user says "after X, do Y" or \
  "wait for X then do Y", spawn X first, call wait_for_results, THEN spawn Y
- Only parallelize subtasks that are truly independent
- Executors can speak to the user. If the user wants something spoken or communicated, \
  include that in the executor's task description (e.g. "then say hello to the user"). \
  Pass speech instructions through faithfully — do not strip them out.
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
                        )
                    },
                    required=["task"],
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
                    },
                    required=["task", "tab_id"],
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
    def __init__(self, server, multiplexer=None):
        self.server = server
        self.client = genai.Client()
        self.multiplexer = multiplexer
        self._executor_counter = 0
        self._running = {}  # executor_id -> asyncio.Task
        self._results = {}  # executor_id -> summary string

    async def run(self, task, existing_tabs=None):
        print(f"[extractor] Starting: {task}")
        await self.server.send_status(f"Extractor starting: {task}")

        parts = []
        prompt = f"Task: {task}"

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
                    executor_id = self._spawn(subtask)
                    await self.server.send_status(f"Spawned executor {executor_id}: {subtask}")
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="spawn_executor",
                                response={"executor_id": executor_id, "status": "spawned"},
                            )
                        )
                    )

                elif fc.name == "spawn_executor_on_tab":
                    subtask = fc.args.get("task", "")
                    tab_id = int(fc.args.get("tab_id", 0))
                    executor_id = self._spawn_on_tab(subtask, tab_id)
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
                    await self.server.send_status(f"Results: {results}")
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="wait_for_results",
                                response={"results": results},
                            )
                        )
                    )

                elif fc.name == "wait_for_one":
                    executor_id = fc.args.get("executor_id", "")
                    result = await self._wait_for_one(executor_id)
                    await self.server.send_status(f"Result [{executor_id}]: {result}")
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="wait_for_one",
                                response={"executor_id": executor_id, "summary": result},
                            )
                        )
                    )

                elif fc.name == "wait_for_any":
                    executor_id, result = await self._wait_for_any()
                    await self.server.send_status(f"Result [{executor_id}]: {result}")
                    function_responses.append(
                        types.Part(
                            function_response=types.FunctionResponse(
                                name="wait_for_any",
                                response={"executor_id": executor_id, "summary": result},
                            )
                        )
                    )

                elif fc.name == "complete":
                    summary = fc.args.get("summary", "Task completed")
                    print(f"[extractor] Complete: {summary}")
                    await self._cleanup()
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

            # Add tool responses to history
            history.append(
                types.Content(role="user", parts=function_responses)
            )

            if done:
                return

    def _spawn(self, subtask):
        self._executor_counter += 1
        executor_id = f"exec_{self._executor_counter}"

        async def _run_executor():
            tab_ids = await self.server.open_tabs(1, "about:blank", subtask)
            tab_id = tab_ids[0]
            try:
                agent = Agent(self.server, tab_id, multiplexer=self.multiplexer, agent_id=executor_id)
                result = await agent.run(subtask)
                self._results[executor_id] = result
            except Exception as e:
                self._results[executor_id] = f"Error: {e}"
            finally:
                await self.server.close_tabs([tab_id])

        self._running[executor_id] = asyncio.create_task(_run_executor())
        print(f"[extractor] Spawned {executor_id}: {subtask}")
        return executor_id

    def _spawn_on_tab(self, subtask, tab_id):
        """Spawn an executor on an existing tab — no new tab is opened or closed."""
        self._executor_counter += 1
        executor_id = f"exec_{self._executor_counter}"

        async def _run_executor():
            try:
                agent = Agent(self.server, tab_id, multiplexer=self.multiplexer, agent_id=executor_id)
                result = await agent.run(subtask)
                self._results[executor_id] = result
            except Exception as e:
                self._results[executor_id] = f"Error: {e}"
            # Note: we do NOT close the tab — it was pre-existing

        self._running[executor_id] = asyncio.create_task(_run_executor())
        print(f"[extractor] Spawned {executor_id} on existing tab {tab_id}: {subtask}")
        return executor_id

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
