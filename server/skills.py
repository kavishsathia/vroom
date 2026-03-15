import json
import os
import time


SKILLS_FILE = os.path.join(os.path.dirname(__file__), "skills.json")


class SkillStore:
    def __init__(self):
        self.skills = {}  # name -> {"description": str, "text": str, "created_at": float}
        self._load()

    def _load(self):
        if os.path.exists(SKILLS_FILE):
            try:
                with open(SKILLS_FILE, "r") as f:
                    self.skills = json.load(f)
                print(f"[skills] Loaded {len(self.skills)} skills")
            except Exception as e:
                print(f"[skills] Failed to load: {e}")

    def _save(self):
        try:
            with open(SKILLS_FILE, "w") as f:
                json.dump(self.skills, f, indent=2)
        except Exception as e:
            print(f"[skills] Failed to save: {e}")

    def list_skills(self):
        """Return list of {name, description} for all skills."""
        return [
            {"name": name, "description": s["description"]}
            for name, s in self.skills.items()
        ]

    def get_skill(self, name):
        """Return full skill text, or None if not found."""
        skill = self.skills.get(name)
        return skill["text"] if skill else None

    def add_skill(self, name, description, text):
        """Add a new skill."""
        self.skills[name] = {
            "description": description,
            "text": text,
            "created_at": time.time(),
        }
        self._save()
        print(f"[skills] Added: {name}")

    def replace_text(self, name, old_text, new_text):
        """Replace text in an existing skill. Returns True if successful."""
        skill = self.skills.get(name)
        if not skill:
            return False
        if old_text not in skill["text"]:
            return False
        skill["text"] = skill["text"].replace(old_text, new_text, 1)
        self._save()
        print(f"[skills] Updated: {name}")
        return True
