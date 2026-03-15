"""Benchmark: 1 image vs 5 images in history (simulating multi-step agent)."""
import asyncio
import time
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()

SYSTEM_PROMPT = "You are a browser automation agent. Respond with a single JSON action."
client = genai.Client()


def load_image():
    with open("debug/tab28827762_step1.jpg", "rb") as f:
        return f.read()


async def run_history(num_steps, label):
    img_bytes = load_image()

    history = []
    # Simulate N previous steps (each with screenshot + model response)
    for i in range(num_steps):
        history.append(types.Content(
            role="user",
            parts=[
                types.Part(inline_data=types.Blob(data=img_bytes, mime_type="image/jpeg")),
                types.Part(text=f"Step {i+1}. Continue with the task."),
            ],
        ))
        history.append(types.Content(
            role="model",
            parts=[types.Part(text='{"action": "speak", "message": "I am working on it."}')],
        ))

    # Final step
    history.append(types.Content(
        role="user",
        parts=[
            types.Part(inline_data=types.Blob(data=img_bytes, mime_type="image/jpeg")),
            types.Part(text="The user said: 'What happens if I click off screen?'. Respond with a speak action."),
        ],
    ))

    t0 = time.monotonic()
    response = await client.aio.models.generate_content(
        model="gemini-3-flash-preview",
        contents=history,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
        ),
    )
    elapsed = (time.monotonic() - t0) * 1000
    print(f"{label}: {elapsed:.0f}ms  ->  {response.text[:80]}")


async def main():
    print("--- History length comparison ---")
    await run_history(0, "0 prev steps (1 img) ")
    await run_history(3, "3 prev steps (4 imgs)")
    await run_history(5, "5 prev steps (6 imgs)")
    await run_history(8, "8 prev steps (9 imgs)")


asyncio.run(main())
