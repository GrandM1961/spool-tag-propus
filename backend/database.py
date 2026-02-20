import sqlite3
import os
import json
from datetime import datetime

DB_PATH = os.environ.get('DB_PATH', '/data/spool_propus.db')

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_db()
    conn.executescript("""
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

        CREATE INDEX IF NOT EXISTS idx_profiles_vendor ON slicer_profiles(vendor);
        CREATE INDEX IF NOT EXISTS idx_profiles_material ON slicer_profiles(material_type);
        CREATE INDEX IF NOT EXISTS idx_profiles_slicer ON slicer_profiles(slicer);
        CREATE INDEX IF NOT EXISTS idx_filaments_brand ON filaments(brand);
        CREATE INDEX IF NOT EXISTS idx_filaments_material ON filaments(material);
    """)
    conn.commit()
    conn.close()
