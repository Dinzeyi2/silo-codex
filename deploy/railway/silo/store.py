import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


class JobStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = threading.Lock()
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, subject TEXT NOT NULL, role TEXT NOT NULL,
                task TEXT NOT NULL, status TEXT NOT NULL, branch TEXT NOT NULL,
                architecture_digest TEXT NOT NULL, changed_paths TEXT NOT NULL DEFAULT '[]',
                error_code TEXT, error_message TEXT, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, commit_sha TEXT
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL,
                action TEXT NOT NULL, job_id TEXT, details TEXT NOT NULL,
                created_at TEXT NOT NULL
            )""")

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def create(self, job: dict) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self.lock, self._connect() as db:
            db.execute(
                "INSERT INTO jobs(id,subject,role,task,status,branch,architecture_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    job["id"],
                    job["subject"],
                    job["role"],
                    job["task"],
                    "queued",
                    job["branch"],
                    job["architectureDigest"],
                    now,
                    now,
                ),
            )

    def update(self, job_id: str, **values) -> None:
        values["updated_at"] = datetime.now(timezone.utc).isoformat()
        columns = ",".join(f"{key}=?" for key in values)
        with self.lock, self._connect() as db:
            db.execute(
                f"UPDATE jobs SET {columns} WHERE id=?", (*values.values(), job_id)
            )

    def get(self, job_id: str) -> dict | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["changed_paths"] = json.loads(result["changed_paths"])
        result.pop("task")
        return result

    def fail_interrupted(self) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self.lock, self._connect() as db:
            db.execute(
                """UPDATE jobs SET status='failed', error_code='PROCESS_RESTARTED',
                    error_message='job execution was interrupted by a service restart',
                    updated_at=? WHERE status IN ('queued','running','integrating')""",
                (now,),
            )

    def audit(
        self,
        actor: str,
        action: str,
        job_id: str | None = None,
        details: dict | None = None,
    ) -> None:
        with self.lock, self._connect() as db:
            db.execute(
                "INSERT INTO audit_events(actor,action,job_id,details,created_at) VALUES(?,?,?,?,?)",
                (
                    actor,
                    action,
                    job_id,
                    json.dumps(details or {}, separators=(",", ":")),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
