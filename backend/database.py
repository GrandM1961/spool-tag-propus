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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
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

        CREATE INDEX IF NOT EXISTS idx_profiles_vendor ON slicer_profiles(vendor);
        CREATE INDEX IF NOT EXISTS idx_profiles_material ON slicer_profiles(material_type);
        CREATE INDEX IF NOT EXISTS idx_profiles_slicer ON slicer_profiles(slicer);
        CREATE INDEX IF NOT EXISTS idx_filaments_brand ON filaments(brand);
        CREATE INDEX IF NOT EXISTS idx_filaments_material ON filaments(material);
        CREATE INDEX IF NOT EXISTS idx_error_reports_created ON error_reports(created_at);
        CREATE INDEX IF NOT EXISTS idx_user_backups_user ON user_backups(user_id);
        CREATE INDEX IF NOT EXISTS idx_users_group ON users(group_id);
    """)
    conn.commit()

    # Migrations for existing databases
    _run_migrations(conn)
    conn.close()

def _run_migrations(conn):
    """Add missing columns to existing databases."""
    migrations = [
        ("error_reports", "screenshot", "TEXT"),
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
