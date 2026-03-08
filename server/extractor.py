import json
from google import genai
from google.genai import types


SYSTEM_PROMPT = """\
You decompose a user's task into independent subtasks that can run in parallel on separate browser tabs.

Rules:
- Each subtask must be self-contained and executable independently
- Each subtask will run on a separate browser tab starting from the same page
- If the task cannot be parallelized, return a single subtask
- Return a JSON array of subtask description strings
- Keep subtasks specific and actionable

Example:
Task: "Search for Python, JavaScript, and Rust on Google and open the first result for each"
Output: ["Search for Python on Google and click the first result", "Search for JavaScript on Google and click the first result", "Search for Rust on Google and click the first result"]

Example:
Task: "Click the search bar and type hello"
Output: ["Click the search bar and type hello"]
"""


class Extractor:
    def __init__(self):
        self.client = genai.Client()

    async def decompose(self, task):
        """Break a task into independent subtasks. Returns a list of subtask strings."""
        print(f"[extractor] Decomposing: {task}")

        response = await self.client.aio.models.generate_content(
            model="gemini-3-flash-preview",
            contents=[f"Task: {task}"],
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                response_mime_type="application/json",
            ),
        )

        try:
            subtasks = json.loads(response.text)
            print(f"[extractor] Decomposed into {len(subtasks)} subtasks: {subtasks}")
            return subtasks
        except json.JSONDecodeError:
            print(f"[extractor] Parse error, using task as-is")
            return [task]
