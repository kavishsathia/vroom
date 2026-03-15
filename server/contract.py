import time
import json


class Contract:
    def __init__(self, executor_id, agent_name, task, commitments=None):
        self.executor_id = executor_id
        self.agent_name = agent_name
        self.task = task
        self.commitments = commitments or []  # [{"text": str, "status": "pending"|"done"|"failed"}]
        self.memos = []  # [{"text": str, "timestamp": float}]
        self.created_at = time.time()

    def update_commitment(self, index, status):
        if 0 <= index < len(self.commitments):
            self.commitments[index]["status"] = status

    def add_memo(self, text):
        self.memos.append({"text": text, "timestamp": time.time()})

    def to_dict(self):
        return {
            "executorId": self.executor_id,
            "agentName": self.agent_name,
            "task": self.task,
            "commitments": self.commitments,
            "memos": self.memos,
        }

    def to_agent_prompt(self):
        lines = [f"Your contract for this task:"]
        for i, c in enumerate(self.commitments):
            marker = {"pending": "[ ]", "done": "[x]", "failed": "[!]"}[c["status"]]
            lines.append(f"  {i}. {marker} {c['text']}")
        if self.memos:
            lines.append("Memos:")
            for m in self.memos:
                lines.append(f"  - {m['text']}")
        return "\n".join(lines)

    def summary_for_extractor(self):
        lines = [f"Contract for {self.executor_id} ({self.agent_name}):"]
        for i, c in enumerate(self.commitments):
            lines.append(f"  {i}. [{c['status']}] {c['text']}")
        if self.memos:
            lines.append("Memos from executor:")
            for m in self.memos:
                lines.append(f"  - {m['text']}")
        return "\n".join(lines)
