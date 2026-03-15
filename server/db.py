import asyncpg


async def create_pool(dsn=None):
    return await asyncpg.create_pool(
        dsn or "postgresql://localhost/vroom",
        min_size=2,
        max_size=10,
    )


async def ensure_schema(pool):
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                token TEXT UNIQUE NOT NULL,
                created_at TIMESTAMPTZ DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS skills (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT now(),
                updated_at TIMESTAMPTZ DEFAULT now(),
                UNIQUE(user_id, name)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                created_at TIMESTAMPTZ DEFAULT now(),
                updated_at TIMESTAMPTZ DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS executors (
                id SERIAL PRIMARY KEY,
                task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
                executor_id TEXT NOT NULL,
                agent_name TEXT NOT NULL DEFAULT '',
                subtask TEXT NOT NULL DEFAULT '',
                tab_id INTEGER,
                status TEXT NOT NULL DEFAULT 'running',
                summary TEXT,
                created_at TIMESTAMPTZ DEFAULT now(),
                updated_at TIMESTAMPTZ DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS commitments (
                id SERIAL PRIMARY KEY,
                executor_db_id INTEGER REFERENCES executors(id) ON DELETE CASCADE,
                idx INTEGER NOT NULL,
                text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
            );
        """)


# --- Users ---

async def get_or_create_user(pool, token):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM users WHERE token = $1", token
        )
        if row:
            return row["id"]
        row = await conn.fetchrow(
            "INSERT INTO users (token) VALUES ($1) RETURNING id", token
        )
        return row["id"]


# --- Skills ---

async def list_skills(pool, user_id):
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT name, description FROM skills WHERE user_id = $1 ORDER BY name",
            user_id,
        )
        return [{"name": r["name"], "description": r["description"]} for r in rows]


async def get_skill(pool, user_id, name):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT text FROM skills WHERE user_id = $1 AND name = $2",
            user_id, name,
        )
        return row["text"] if row else None


async def add_skill(pool, user_id, name, description, text):
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO skills (user_id, name, description, text)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id, name)
               DO UPDATE SET description = $3, text = $4, updated_at = now()""",
            user_id, name, description, text,
        )


async def replace_skill_text(pool, user_id, name, old_text, new_text):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, text FROM skills WHERE user_id = $1 AND name = $2",
            user_id, name,
        )
        if not row or old_text not in row["text"]:
            return False
        updated = row["text"].replace(old_text, new_text, 1)
        await conn.execute(
            "UPDATE skills SET text = $1, updated_at = now() WHERE id = $2",
            updated, row["id"],
        )
        return True


async def resolve_skills(pool, user_id, names):
    if not names:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT name, description FROM skills WHERE user_id = $1 AND name = ANY($2)",
            user_id, names,
        )
        return [{"name": r["name"], "description": r["description"]} for r in rows]


# --- Tasks ---

async def create_task(pool, user_id, text):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO tasks (user_id, text) VALUES ($1, $2) RETURNING id",
            user_id, text,
        )
        return row["id"]


async def update_task_status(pool, task_id, status):
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE tasks SET status = $1, updated_at = now() WHERE id = $2",
            status, task_id,
        )


async def get_recent_tasks(pool, user_id, limit=50):
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, text, status, created_at
               FROM tasks WHERE user_id = $1
               ORDER BY created_at DESC LIMIT $2""",
            user_id, limit,
        )
        return [dict(r) for r in rows]


# --- Executors ---

async def create_executor(pool, task_id, executor_id, agent_name, subtask, tab_id=None):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO executors (task_id, executor_id, agent_name, subtask, tab_id)
               VALUES ($1, $2, $3, $4, $5) RETURNING id""",
            task_id, executor_id, agent_name, subtask, tab_id,
        )
        return row["id"]


async def update_executor(pool, executor_db_id, status=None, summary=None, tab_id=None):
    sets = ["updated_at = now()"]
    args = []
    i = 1
    if status is not None:
        sets.append(f"status = ${i}")
        args.append(status)
        i += 1
    if summary is not None:
        sets.append(f"summary = ${i}")
        args.append(summary)
        i += 1
    if tab_id is not None:
        sets.append(f"tab_id = ${i}")
        args.append(tab_id)
        i += 1
    if len(args) == 0:
        return
    args.append(executor_db_id)
    async with pool.acquire() as conn:
        await conn.execute(
            f"UPDATE executors SET {', '.join(sets)} WHERE id = ${i}",
            *args,
        )


# --- Commitments ---

async def create_commitments(pool, executor_db_id, commitments):
    if not commitments:
        return
    async with pool.acquire() as conn:
        await conn.executemany(
            """INSERT INTO commitments (executor_db_id, idx, text, status)
               VALUES ($1, $2, $3, $4)""",
            [(executor_db_id, i, c["text"], c.get("status", "pending"))
             for i, c in enumerate(commitments)],
        )


async def update_commitment(pool, executor_db_id, idx, status):
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE commitments SET status = $1 WHERE executor_db_id = $2 AND idx = $3",
            status, executor_db_id, idx,
        )
