import pytest
import asyncio
from unittest.mock import patch
from multiplexer import Multiplexer, AGENT_POOL


def make_mux(**kwargs):
    """Create a Multiplexer with the genai client mocked out."""
    with patch("multiplexer.genai.Client"):
        return Multiplexer(**kwargs)


class TestMultiplexerSync:
    """Tests for synchronous multiplexer operations."""

    def test_agent_pool_rotation(self):
        mux = make_mux()
        name1, voice1 = mux.next_agent()
        name2, voice2 = mux.next_agent()
        assert name1 == "Alice"
        assert name2 == "Bob"
        assert voice1 != voice2

    def test_agent_pool_wraps_around(self):
        mux = make_mux()
        for _ in range(len(AGENT_POOL)):
            mux.next_agent()
        name, _ = mux.next_agent()
        assert name == "Alice"

    def test_register_unregister(self):
        mux = make_mux()
        mux.register("agent_1", voice="Kore")
        assert "agent_1" in mux.read_pointers
        mux.unregister("agent_1")
        assert "agent_1" not in mux.read_pointers

    def test_has_unread_empty(self):
        mux = make_mux()
        mux.register("agent_1")
        assert not mux.has_unread("agent_1")

    def test_has_unread_own_messages_ignored(self):
        mux = make_mux()
        mux.register("agent_1")
        mux.conversation.append({
            "agent_id": "agent_1",
            "message": "hello",
            "timestamp": 0,
        })
        assert not mux.has_unread("agent_1")

    def test_has_unread_other_messages(self):
        mux = make_mux()
        mux.register("agent_1")
        mux.conversation.append({
            "agent_id": "agent_2",
            "message": "hello",
            "timestamp": 0,
        })
        assert mux.has_unread("agent_1")

    def test_get_context_consumes_messages(self):
        mux = make_mux()
        mux.register("agent_1")
        mux.conversation.append({
            "agent_id": "agent_2",
            "message": "hello",
            "timestamp": 0,
        })
        ctx = mux.get_context("agent_1")
        assert len(ctx["unread_messages"]) == 1
        assert ctx["unread_messages"][0]["agent"] == "agent_2"
        ctx2 = mux.get_context("agent_1")
        assert len(ctx2["unread_messages"]) == 0

    def test_broadcast_user_audio(self):
        mux = make_mux()
        mux.broadcast_user_audio(b"audio_data", "audio/webm")
        assert len(mux._pending_user_audio) == 1
        assert mux.conversation[-1]["agent_id"] == "user"

    def test_drain_user_audio(self):
        mux = make_mux()
        mux.broadcast_user_audio(b"audio1", "audio/webm")
        mux.broadcast_user_audio(b"audio2", "audio/webm")
        drained = mux.drain_user_audio()
        assert len(drained) == 2
        assert len(mux._pending_user_audio) == 0

    def test_pause_resume(self):
        mux = make_mux()
        assert mux._resume_event.is_set()
        mux.pause()
        assert not mux._resume_event.is_set()
        mux.resume()
        assert mux._resume_event.is_set()

    def test_visual_preempt_blocks_agent(self):
        mux = make_mux()
        mux.visual_preempt("agent_1")
        assert "agent_1" in mux._agent_blocked
        assert not mux._agent_blocked["agent_1"].is_set()

    def test_visual_preempt_end_unblocks(self):
        mux = make_mux()
        mux.visual_preempt("agent_1")
        interactions = [{"x": 100, "y": 200}]
        mux.visual_preempt_end("agent_1", interactions)
        assert "agent_1" not in mux._agent_blocked
        assert mux._visual_preempt_data["agent_1"] == interactions

    def test_stop_resets_state(self):
        mux = make_mux()
        mux.next_agent()
        mux.next_agent()
        mux.aol.append({"agent_id": "a", "message": "x", "timestamp": 0})
        mux.stop()
        assert mux._agent_pool_index == 0
        assert len(mux.aol) == 0


@pytest.mark.asyncio
class TestMultiplexerAsync:
    """Tests for async multiplexer operations."""

    async def test_append_log(self):
        logs = []

        async def on_log(agent_id, message):
            logs.append((agent_id, message))

        mux = make_mux(on_log=on_log)
        await mux.append_log("agent_1", "Starting task")
        assert len(mux.aol) == 1
        assert logs[0] == ("agent_1", "Starting task")

    async def test_get_log_context(self):
        mux = make_mux()
        mux.register("agent_1")
        await mux.append_log("agent_2", "Found result")
        entries = mux.get_log_context("agent_1")
        assert len(entries) == 1
        assert entries[0]["agent"] == "agent_2"
        assert len(mux.get_log_context("agent_1")) == 0

    async def test_wait_if_paused_returns_immediately(self):
        mux = make_mux()
        await asyncio.wait_for(mux.wait_if_paused(), timeout=1.0)

    async def test_wait_if_paused_blocks_when_paused(self):
        mux = make_mux()
        mux.pause()
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(mux.wait_if_paused(), timeout=0.1)

    async def test_wait_if_paused_blocks_visual_preempt(self):
        mux = make_mux()
        mux.visual_preempt("agent_1")
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(mux.wait_if_paused("agent_1"), timeout=0.1)

    async def test_preempt_clears_spotlight(self):
        async def noop():
            pass

        mux = make_mux(on_clear_audio=noop)
        mux._spotlight = "agent_1"
        await mux.preempt()
        assert mux._spotlight is None
        assert not mux._resume_event.is_set()

    async def test_try_speak_rejected_when_paused(self):
        mux = make_mux()
        mux.pause()
        success, _ = await mux.try_speak("agent_1", "hello")
        assert not success

    async def test_try_speak_rejected_when_spotlight_taken(self):
        mux = make_mux()
        mux._spotlight = "agent_2"
        success, _ = await mux.try_speak("agent_1", "hello")
        assert not success
