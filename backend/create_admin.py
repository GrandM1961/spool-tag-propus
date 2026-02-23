#!/usr/bin/env python3
"""Create or update admin user. Run inside container: python /app/create_admin.py"""
import os
import sqlite3
import bcrypt

DB_PATH = os.environ.get('DB_PATH', '/data/spool_propus.db')
ADMIN_EMAIL = 'janez@janez.ch'  # Login: Janez
ADMIN_PASSWORD = 'Biel2503!'


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Add is_admin column if missing
    try:
        conn.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0')
        conn.commit()
        print('Added is_admin column')
    except sqlite3.OperationalError as e:
        if 'duplicate column' not in str(e).lower():
            raise

    cur = conn.execute('SELECT id, password_hash FROM users WHERE email = ?', (ADMIN_EMAIL,))
    row = cur.fetchone()
    pw_hash = bcrypt.hashpw(ADMIN_PASSWORD.encode('utf-8'), bcrypt.gensalt()).decode('ascii')

    if row:
        conn.execute('UPDATE users SET password_hash = ?, is_admin = 1 WHERE id = ?', (pw_hash, row['id']))
        conn.commit()
        print(f'Updated admin: {ADMIN_EMAIL}')
    else:
        conn.execute('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, 1)',
                     (ADMIN_EMAIL, pw_hash))
        user_id = conn.execute('SELECT last_insert_rowid()').fetchone()[0]
        conn.execute(
            'INSERT INTO user_settings (user_id, spoolman_url, theme, language) VALUES (?, ?, ?, ?)',
            (user_id, '', 'dark', 'de')
        )
        conn.commit()
        print(f'Created admin: {ADMIN_EMAIL}')

    conn.close()


if __name__ == '__main__':
    main()
