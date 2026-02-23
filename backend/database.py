import sqlite3
import os
import json
from datetime import datetime

DB_PATH = os.environ.get('DB_PATH', '/data/spool_propus.db')

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            permissions_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS slicer_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vendor TEXT NOT NULL,
            printer TEXT,
            filament_name TEXT NOT NULL,
            material_type TEXT,
            slicer TEXT NOT NULL,
            nozzle_temp_min INTEGER,
            nozzle_temp_max INTEGER,
            bed_temp_min INTEGER,
            bed_temp_max INTEGER,
            filament_density REAL,
            filament_cost REAL,
            filament_flow_ratio REAL,
            max_volumetric_speed REAL,
            profile_json TEXT NOT NULL,
            source_url TEXT,
            source_path TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS filaments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            brand TEXT NOT NULL,
            material TEXT NOT NULL,
            name TEXT NOT NULL,
            color_name TEXT,
            color_hex TEXT,
            density REAL,
            nozzle_temp_min INTEGER,
            nozzle_temp_max INTEGER,
            bed_temp_min INTEGER,
            bed_temp_max INTEGER,
            diameter REAL DEFAULT 1.75,
            source TEXT NOT NULL,
            source_id TEXT,
            extra_json TEXT,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_status (
            id INTEGER PRIMARY KEY,
            source TEXT NOT NULL,
            last_sync TEXT,
            items_count INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            error TEXT
        );

        CREATE TABLE IF NOT EXISTS error_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            error_message TEXT,
            error_stack TEXT,
            user_message TEXT,
            user_agent TEXT,
            url TEXT,
            page_url TEXT,
            screenshot TEXT,
            status TEXT NOT NULL DEFAULT 'neu',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            username TEXT,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            last_login_at TEXT DEFAULT '',
            last_login_ip TEXT DEFAULT '',
            last_login_ua TEXT DEFAULT '',
            first_name TEXT DEFAULT '',
            last_name TEXT DEFAULT '',
            address TEXT DEFAULT '',
            birth_date TEXT DEFAULT '',
            group_id INTEGER REFERENCES groups(id),
            is_admin INTEGER NOT NULL DEFAULT 0,
            is_locked INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS user_settings (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            spoolman_url TEXT DEFAULT '',
            theme TEXT DEFAULT 'dark',
            language TEXT DEFAULT 'de',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS user_backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            backup_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS chat_conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT 'Neues Gespräch',
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
            content TEXT NOT NULL,
            meta_json TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS app_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_profiles_vendor ON slicer_profiles(vendor);
        CREATE INDEX IF NOT EXISTS idx_profiles_material ON slicer_profiles(material_type);
        CREATE INDEX IF NOT EXISTS idx_profiles_slicer ON slicer_profiles(slicer);
        CREATE INDEX IF NOT EXISTS idx_filaments_brand ON filaments(brand);
        CREATE INDEX IF NOT EXISTS idx_filaments_material ON filaments(material);
        CREATE INDEX IF NOT EXISTS idx_error_reports_created ON error_reports(created_at);
        CREATE INDEX IF NOT EXISTS idx_user_backups_user ON user_backups(user_id);
        CREATE INDEX IF NOT EXISTS idx_users_group ON users(group_id);
        CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id);
    """)
    conn.commit()

    # Migrations for existing databases
    _run_migrations(conn)
    conn.close()

def _run_migrations(conn):
    """Add missing columns to existing databases."""
    migrations = [
        ("error_reports", "screenshot", "TEXT"),
        ("error_reports", "status", "TEXT NOT NULL DEFAULT 'neu'"),
        ("users", "username", "TEXT"),
        ("users", "role", "TEXT NOT NULL DEFAULT 'user'"),
        ("users", "last_login_at", "TEXT DEFAULT ''"),
        ("users", "last_login_ip", "TEXT DEFAULT ''"),
        ("users", "last_login_ua", "TEXT DEFAULT ''"),
        ("users", "is_admin", "INTEGER NOT NULL DEFAULT 0"),
        ("users", "is_locked", "INTEGER NOT NULL DEFAULT 0"),
        ("users", "first_name", "TEXT DEFAULT ''"),
        ("users", "last_name", "TEXT DEFAULT ''"),
        ("users", "address", "TEXT DEFAULT ''"),
        ("users", "birth_date", "TEXT DEFAULT ''"),
        ("users", "group_id", "INTEGER REFERENCES groups(id)"),
    ]
    for table, column, col_type in migrations:
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
            conn.commit()
        except Exception:
            pass  # Column already exists

    # Special-case migrations where SQLite ALTER TABLE limitations apply.
    # Some older DBs may have `groups` without `created_at`.
    try:
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(groups)").fetchall()]
        if "created_at" not in cols:
            # SQLite doesn't allow non-constant defaults on ALTER TABLE.
            conn.execute("ALTER TABLE groups ADD COLUMN created_at TEXT")
            conn.execute("UPDATE groups SET created_at = datetime('now') WHERE created_at IS NULL OR created_at = ''")
            conn.commit()
    except Exception:
        # Ignore if `groups` table doesn't exist yet; init_db will create it.
        pass

    # Ensure username is backfilled and unique; create a UNIQUE index for future inserts.
    try:
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
        if "username" in cols:
            # Create unique index (works even for existing DBs if no duplicates).
            try:
                conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)")
                conn.commit()
            except Exception:
                # If duplicates exist, we'll try to fix via backfill first.
                pass

            def _slug(s):
                s = (s or "").strip().lower()
                out = []
                for ch in s:
                    if ("a" <= ch <= "z") or ("0" <= ch <= "9") or ch in "._-":
                        out.append(ch)
                    elif ch in " ":
                        out.append("_")
                slug = "".join(out).strip("._-")
                return slug

            rows = conn.execute(
                "SELECT id, email, username FROM users WHERE username IS NULL OR username = ''"
            ).fetchall()
            for r in rows:
                base = _slug((r["email"] or "").split("@")[0])
                if not base:
                    base = f"user{r['id']}"
                candidate = base
                n = 2
                while True:
                    exists = conn.execute(
                        "SELECT 1 FROM users WHERE lower(username) = lower(?) AND id != ? LIMIT 1",
                        (candidate, r["id"]),
                    ).fetchone()
                    if not exists:
                        break
                    candidate = f"{base}-{n}"
                    n += 1
                    if n > 999:
                        candidate = f"user{r['id']}"
                        break
                conn.execute("UPDATE users SET username = ? WHERE id = ?", (candidate, r["id"]))
            conn.commit()

            # Re-attempt unique index creation after backfill.
            try:
                conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)")
                conn.commit()
            except Exception:
                # Leave as-is; app layer will still enforce uniqueness on register.
                pass
    except Exception:
        pass
