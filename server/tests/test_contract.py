import pytest
from contract import Contract


class TestContract:
    def test_create_with_commitments(self):
        c = Contract("exec_1", "Alice", "Search Google", [
            {"text": "Navigate to google.com", "status": "pending"},
            {"text": "Type search query", "status": "pending"},
        ])
        assert c.executor_id == "exec_1"
        assert c.agent_name == "Alice"
        assert len(c.commitments) == 2
        assert all(cm["status"] == "pending" for cm in c.commitments)

    def test_create_without_commitments(self):
        c = Contract("exec_1", "Bob", "Simple task")
        assert c.commitments == []
        assert c.memos == []

    def test_update_commitment(self):
        c = Contract("exec_1", "Alice", "Task", [
            {"text": "Step 1", "status": "pending"},
            {"text": "Step 2", "status": "pending"},
        ])
        c.update_commitment(0, "done")
        assert c.commitments[0]["status"] == "done"
        assert c.commitments[1]["status"] == "pending"

    def test_update_commitment_failed(self):
        c = Contract("exec_1", "Alice", "Task", [
            {"text": "Step 1", "status": "pending"},
        ])
        c.update_commitment(0, "failed")
        assert c.commitments[0]["status"] == "failed"

    def test_update_commitment_out_of_range(self):
        c = Contract("exec_1", "Alice", "Task", [
            {"text": "Step 1", "status": "pending"},
        ])
        c.update_commitment(5, "done")  # should not crash
        assert c.commitments[0]["status"] == "pending"

    def test_add_memo(self):
        c = Contract("exec_1", "Alice", "Task")
        c.add_memo("Found a blocker")
        c.add_memo("Workaround applied")
        assert len(c.memos) == 2
        assert c.memos[0]["text"] == "Found a blocker"
        assert "timestamp" in c.memos[0]

    def test_to_dict(self):
        c = Contract("exec_1", "Alice", "Task", [
            {"text": "Step 1", "status": "done"},
        ])
        c.add_memo("Note")
        d = c.to_dict()
        assert d["executorId"] == "exec_1"
        assert d["agentName"] == "Alice"
        assert d["task"] == "Task"
        assert len(d["commitments"]) == 1
        assert len(d["memos"]) == 1

    def test_to_agent_prompt(self):
        c = Contract("exec_1", "Alice", "Task", [
            {"text": "Navigate to site", "status": "pending"},
            {"text": "Click button", "status": "done"},
            {"text": "Fill form", "status": "failed"},
        ])
        c.add_memo("Button was hidden")
        prompt = c.to_agent_prompt()
        assert "[ ]" in prompt  # pending
        assert "[x]" in prompt  # done
        assert "[!]" in prompt  # failed
        assert "Navigate to site" in prompt
        assert "Button was hidden" in prompt

    def test_summary_for_extractor(self):
        c = Contract("exec_1", "Alice", "Task", [
            {"text": "Step 1", "status": "done"},
            {"text": "Step 2", "status": "failed"},
        ])
        c.add_memo("Step 2 had issues")
        summary = c.summary_for_extractor()
        assert "exec_1" in summary
        assert "Alice" in summary
        assert "[done]" in summary
        assert "[failed]" in summary
        assert "Step 2 had issues" in summary
