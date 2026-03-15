import db


class SkillStore:
    """Async, per-user skill store backed by Postgres."""

    def __init__(self, pool, user_id):
        self.pool = pool
        self.user_id = user_id

    async def list_skills(self):
        return await db.list_skills(self.pool, self.user_id)

    async def get_skill(self, name):
        return await db.get_skill(self.pool, self.user_id, name)

    async def add_skill(self, name, description, text):
        await db.add_skill(self.pool, self.user_id, name, description, text)

    async def replace_text(self, name, old_text, new_text):
        return await db.replace_skill_text(self.pool, self.user_id, name, old_text, new_text)

    async def resolve_skills(self, names):
        return await db.resolve_skills(self.pool, self.user_id, names)
