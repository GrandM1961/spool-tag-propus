import os
import re
import json
import logging
import threading
from datetime import datetime
from functools import wraps

import jwt
import bcrypt
from flask import Flask, jsonify, request, Response, make_response, g
from flask_cors import CORS
from apscheduler.schedulers.background import BackgroundScheduler
from database import init_db, get_db as _get_db_raw
from sync import run_full_sync
import requests

# Suppress SSL warnings for internal container-to-container communication
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, supports_credentials=True, origins=['*'], expose_headers=['Set-Cookie'])


def get_db():
    """Return a per-request SQLite connection (shared via Flask g, auto-closed on teardown)."""
    if 'db' not in g:
        g.db = _get_db_raw()
    return g.db


@app.teardown_appcontext
def close_db(exc=None):
    db = g.pop('db', None)
    if db is not None:
        try:
            db.close()
        except Exception:
            pass


# Ensure DB schema exists in all run modes (gunicorn/uwsgi/import).
# Previously this only ran under `python app.py` which could leave new tables
# (e.g. `groups`) missing in production and cause HTML 500 pages for JSON APIs.
try:
    init_db()
except Exception as e:
    log.exception("init_db failed during startup: %s", e)

JWT_SECRET = os.environ.get('JWT_SECRET', 'change-me-in-production-please-set-JWT_SECRET-env')
JWT_ALGORITHM = 'HS256'
JWT_EXPIRY_HOURS = 24 * 30  # 30 days
COOKIE_NAME = 'spooltag_auth'
COOKIE_MAX_AGE = 30 * 24 * 3600  # 30 days in seconds
MAX_BACKUPS_PER_USER = 10

SYNC_INTERVAL_HOURS = int(os.environ.get('SYNC_INTERVAL', 24))
_sync_lock = threading.Lock()


def _get_token():
    # Priority: Authorization header → auth cookie
    auth = request.headers.get('Authorization')
    if auth and auth.startswith('Bearer '):
        return auth[7:]
    return request.cookies.get(COOKIE_NAME)


def _set_auth_cookie(response, token: str):
    """Attach an HttpOnly 30-day auth cookie to a Flask response."""
    secure = request.headers.get('X-Forwarded-Proto', 'http') == 'https'
    response.set_cookie(
        COOKIE_NAME,
        value=token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite='Lax',
        secure=secure,
        path='/',
    )
    return response


def _clear_auth_cookie(response):
    response.delete_cookie(COOKIE_NAME, path='/')
    return response


def _user_from_token():
    token = _get_token()
    if not token:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload.get('user_id')
    except jwt.InvalidTokenError:
        return None


def require_auth(f):
    @wraps(f)
    def wrapped(*args, **kwargs):
        user_id = _user_from_token()
        if not user_id:
            return jsonify({'error': 'unauthorized', 'message': 'Login required'}), 401
        db = get_db()
        try:
            row = db.execute('SELECT is_locked, is_admin, group_id FROM users WHERE id = ?', (user_id,)).fetchone()
            perms = _get_permissions_for_user(db, user_id)
        finally:
            pass
        if not row:
            return jsonify({'error': 'unauthorized', 'message': 'User not found'}), 401
        if row['is_locked']:
            return jsonify({'error': 'locked', 'message': 'Account is locked'}), 403
        request.user_id = user_id
        request.is_admin = bool(row['is_admin'])
        request.permissions = perms
        return f(*args, **kwargs)
    return wrapped


def require_admin(f):
    @wraps(f)
    def wrapped(*args, **kwargs):
        user_id = _user_from_token()
        if not user_id:
            return jsonify({'error': 'unauthorized', 'message': 'Login required'}), 401
        db = get_db()
        try:
            row = db.execute('SELECT is_locked, is_admin, group_id FROM users WHERE id = ?', (user_id,)).fetchone()
        finally:
            pass
        if not row or row['is_locked']:
            return jsonify({'error': 'unauthorized'}), 401
        if not row['is_admin']:
            return jsonify({'error': 'forbidden', 'message': 'Admin required'}), 403
        request.user_id = user_id
        request.is_admin = True
        request.permissions = ['*']
        return f(*args, **kwargs)
    return wrapped


def _get_permissions_for_user(conn, user_id):
    """Return permission list for a user (empty for normal users)."""
    row = conn.execute('SELECT is_admin, group_id FROM users WHERE id = ?', (user_id,)).fetchone()
    if not row:
        return []
    if row['is_admin']:
        return ['*']
    gid = row['group_id']
    if not gid:
        return []
    g = conn.execute('SELECT permissions_json FROM groups WHERE id = ?', (gid,)).fetchone()
    if not g:
        return []
    try:
        perms = json.loads(g['permissions_json'] or '[]')
        if not isinstance(perms, list):
            return []
        # normalize to strings, unique
        out = []
        for p in perms:
            p = str(p or '').strip()
            if p and p not in out:
                out.append(p)
        return out
    except Exception:
        return []


def require_perm(permission):
    """Require a specific admin permission, or is_admin."""
    def deco(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            user_id = _user_from_token()
            if not user_id:
                return jsonify({'error': 'unauthorized', 'message': 'Login required'}), 401
            db = get_db()
            try:
                row = db.execute('SELECT is_locked, is_admin FROM users WHERE id = ?', (user_id,)).fetchone()
                if not row or row['is_locked']:
                    return jsonify({'error': 'unauthorized'}), 401
                perms = _get_permissions_for_user(db, user_id)
            finally:
                pass
            if row['is_admin'] or '*' in perms or permission in perms:
                request.user_id = user_id
                request.is_admin = bool(row['is_admin'])
                request.permissions = perms
                return f(*args, **kwargs)
            return jsonify({'error': 'forbidden', 'message': f'Missing permission: {permission}'}), 403
        return wrapped
    return deco


def require_any_perm(permissions):
    """Require at least one permission in list, or is_admin."""
    perms_needed = list(permissions or [])
    def deco(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            user_id = _user_from_token()
            if not user_id:
                return jsonify({'error': 'unauthorized', 'message': 'Login required'}), 401
            db = get_db()
            try:
                row = db.execute('SELECT is_locked, is_admin FROM users WHERE id = ?', (user_id,)).fetchone()
                if not row or row['is_locked']:
                    return jsonify({'error': 'unauthorized'}), 401
                perms = _get_permissions_for_user(db, user_id)
            finally:
                pass
            if row['is_admin'] or '*' in perms:
                request.user_id = user_id
                request.is_admin = bool(row['is_admin'])
                request.permissions = perms
                return f(*args, **kwargs)
            if any(p in perms for p in perms_needed):
                request.user_id = user_id
                request.is_admin = False
                request.permissions = perms
                return f(*args, **kwargs)
            return jsonify({'error': 'forbidden', 'message': 'Missing permission'}), 403
        return wrapped
    return deco


def _create_token(user_id):
    return jwt.encode(
        {'user_id': user_id, 'exp': datetime.utcnow().timestamp() + JWT_EXPIRY_HOURS * 3600},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM
    )


def _save_user_backup(user_id, backup_data):
    try:
        conn = get_db()
        try:
            conn.execute(
                'INSERT INTO user_backups (user_id, backup_json) VALUES (?, ?)',
                (user_id, json.dumps(backup_data))
            )
            conn.commit()
            count = conn.execute('SELECT COUNT(*) FROM user_backups WHERE user_id = ?', (user_id,)).fetchone()[0]
            if count > MAX_BACKUPS_PER_USER:
                excess = count - MAX_BACKUPS_PER_USER
                ids = conn.execute(
                    'SELECT id FROM user_backups WHERE user_id = ? ORDER BY created_at ASC LIMIT ?',
                    (user_id, excess)
                ).fetchall()
                for row in ids:
                    conn.execute('DELETE FROM user_backups WHERE id = ?', (row['id'],))
                conn.commit()
        finally:
            pass
    except Exception as e:
        log.warning(f"Could not save user backup (non-critical): {e}")


# --- Auth (public) ---

@app.route('/api/health')
def health():
    return jsonify({'status': 'ok', 'version': '1.6.106'})


@app.route('/api/auth/register', methods=['POST'])
def auth_register():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    username = (data.get('username') or '').strip().lower()
    password = data.get('password') or ''
    first_name = (data.get('firstName') or data.get('first_name') or '').strip()[:100]
    last_name = (data.get('lastName') or data.get('last_name') or '').strip()[:100]
    address = (data.get('address') or '').strip()[:500]
    birth_date = (data.get('birthDate') or data.get('birth_date') or '').strip()[:20]

    def _normalize_username(s):
        s = (s or '').strip().lower()
        # allow a-z 0-9 . _ -
        out = []
        for ch in s:
            if ('a' <= ch <= 'z') or ('0' <= ch <= '9') or ch in '._-':
                out.append(ch)
            elif ch == ' ':
                out.append('_')
        s = ''.join(out).strip('._-')
        return s

    if not email or not re.match(r'^[^@]+@[^@]+\.[^@]+$', email):
        return jsonify({'error': 'invalid_email', 'message': 'Invalid email'}), 400
    if len(password) < 8:
        return jsonify({'error': 'weak_password', 'message': 'Password must be at least 8 characters'}), 400

    # Username: optional in payload; if omitted, derive from email local-part.
    if not username:
        username = _normalize_username(email.split('@')[0])
    else:
        username = _normalize_username(username)
    if not username or not re.match(r'^[a-z0-9][a-z0-9._-]{2,29}$', username):
        return jsonify({'error': 'invalid_username', 'message': 'Invalid username (3-30 chars: a-z, 0-9, . _ -)'}), 400

    db = get_db()
    try:
        existing = db.execute('SELECT id FROM users WHERE email = ?', (email,)).fetchone()
        if existing:
            return jsonify({'error': 'email_exists', 'message': 'Email already registered'}), 409

        existing_u = db.execute('SELECT id FROM users WHERE lower(username) = lower(?)', (username,)).fetchone()
        if existing_u:
            return jsonify({'error': 'username_exists', 'message': 'Username already taken'}), 409

        pw_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('ascii')
        try:
            cur = db.execute(
                'INSERT INTO users (email, username, role, password_hash, first_name, last_name, address, birth_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (email, username, 'user', pw_hash, first_name, last_name, address, birth_date)
            )
        except Exception as e:
            msg = str(e) or ''
            # If the unique index triggers anyway, return a clean 409 instead of 500.
            if 'UNIQUE constraint failed: users.username' in msg:
                return jsonify({'error': 'username_exists', 'message': 'Username already taken'}), 409
            if 'UNIQUE constraint failed: users.email' in msg:
                return jsonify({'error': 'email_exists', 'message': 'Email already registered'}), 409
            raise
        user_id = cur.lastrowid
        db.execute(
            'INSERT INTO user_settings (user_id, spoolman_url, theme, language) VALUES (?, ?, ?, ?)',
            (user_id, '', 'dark', 'de')
        )
        db.commit()
        token = _create_token(user_id)
        resp = make_response(jsonify({
            'token': token,
            'user': {
                'id': user_id,
                'email': email,
                'username': username,
                'role': 'user',
                'isAdmin': False,
                'permissions': []
            }
        }))
        _set_auth_cookie(resp, token)
        return resp
    finally:
        pass


@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    data = request.get_json(force=True, silent=True) or {}
    identifier = (data.get('identifier') or data.get('email') or '').strip()
    password = data.get('password') or ''

    def _looks_like_email(s):
        return bool(s) and bool(re.match(r'^[^@]+@[^@]+\.[^@]+$', s))

    db = get_db()
    try:
        if _looks_like_email(identifier):
            ident_email = identifier.lower()
            row = db.execute(
                'SELECT id, email, username, role, password_hash, is_locked, is_admin FROM users WHERE lower(email) = ?',
                (ident_email,)
            ).fetchone()
        else:
            uname = identifier.strip().lower()
            row = db.execute(
                'SELECT id, email, username, role, password_hash, is_locked, is_admin FROM users WHERE lower(username) = lower(?)',
                (uname,)
            ).fetchone()
        if not row:
            return jsonify({'error': 'invalid_credentials', 'message': 'Invalid email or password'}), 401
        if not bcrypt.checkpw(password.encode('utf-8'), row['password_hash'].encode('ascii')):
            return jsonify({'error': 'invalid_credentials', 'message': 'Invalid email or password'}), 401
        if row['is_locked']:
            return jsonify({'error': 'locked', 'message': 'Account is locked. Contact an administrator.'}), 403

        # Track last successful login (best-effort; don't fail login on logging issues).
        try:
            ip = (request.headers.get('X-Forwarded-For') or request.remote_addr or '').split(',')[0].strip()
            ua = (request.headers.get('User-Agent') or '').strip()[:500]
            db.execute(
                "UPDATE users SET last_login_at = ?, last_login_ip = ?, last_login_ua = ? WHERE id = ?",
                (datetime.utcnow().isoformat(timespec='seconds'), ip, ua, row['id'])
            )
            db.commit()
        except Exception:
            pass

        perms = _get_permissions_for_user(db, row['id'])
        token = _create_token(row['id'])
        resp = make_response(jsonify({
            'token': token,
            'user': {
                'id': row['id'],
                'email': row['email'],
                'username': row['username'],
                'role': row['role'] or 'user',
                'isAdmin': bool(row['is_admin']),
                'permissions': perms
            }
        }))
        _set_auth_cookie(resp, token)
        return resp
    finally:
        pass


@app.route('/api/auth/me', methods=['GET'])
@require_auth
def auth_me():
    db = get_db()
    try:
        user = db.execute(
            'SELECT u.id, u.email, u.username, u.role, u.is_admin, u.first_name, u.last_name, u.address, u.birth_date, u.group_id, g.name AS group_name '
            'FROM users u LEFT JOIN groups g ON g.id = u.group_id WHERE u.id = ?',
            (request.user_id,)
        ).fetchone()
        if not user:
            return jsonify({'error': 'not_found'}), 404
        settings = db.execute(
            'SELECT spoolman_url, theme, language FROM user_settings WHERE user_id = ?',
            (request.user_id,)
        ).fetchone()
        perms = _get_permissions_for_user(db, request.user_id)
        result = {
            'id': user['id'],
            'email': user['email'],
            'username': user['username'],
            'role': user['role'] or 'user',
            'isAdmin': bool(user['is_admin']),
            'permissions': perms if perms != ['*'] else ['*'],
            'firstName': user['first_name'] or '',
            'lastName': user['last_name'] or '',
            'address': user['address'] or '',
            'birthDate': user['birth_date'] or '',
            'groupId': user['group_id'],
            'groupName': user['group_name'] or '',
        }
        if settings:
            result['settings'] = {
                'spoolmanUrl': settings['spoolman_url'] or '',
                'theme': settings['theme'] or 'dark',
                'language': settings['language'] or 'de'
            }
        return jsonify(result)
    finally:
        pass


@app.route('/api/auth/refresh', methods=['POST'])
@require_auth
def auth_refresh():
    """Issue a fresh 30-day token for an already authenticated user."""
    new_token = _create_token(request.user_id)
    resp = make_response(jsonify({'token': new_token}))
    _set_auth_cookie(resp, new_token)
    return resp


@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    """Clear the auth cookie."""
    resp = make_response(jsonify({'ok': True}))
    _clear_auth_cookie(resp)
    return resp


@app.route('/api/user/profile', methods=['PUT'])
@require_auth
def user_profile_update():
    data = request.get_json(force=True, silent=True) or {}
    new_email = (data.get('email') or '').strip().lower()
    new_username = (data.get('username') or '').strip().lower()
    new_password = data.get('password') or ''
    current_password = data.get('currentPassword') or ''
    first_name = (data.get('firstName') or '').strip()[:100]
    last_name = (data.get('lastName') or '').strip()[:100]
    address = (data.get('address') or '').strip()[:500]
    birth_date = (data.get('birthDate') or '').strip()[:20]

    db = get_db()
    try:
        user = db.execute('SELECT id, email, username, password_hash FROM users WHERE id = ?', (request.user_id,)).fetchone()
        if not user:
            return jsonify({'error': 'not_found'}), 404

        def _normalize_username(s):
            s = (s or '').strip().lower()
            out = []
            for ch in s:
                if ('a' <= ch <= 'z') or ('0' <= ch <= '9') or ch in '._-':
                    out.append(ch)
                elif ch == ' ':
                    out.append('_')
            s = ''.join(out).strip('._-')
            return s

        # Require current password only when changing email or password
        if (new_email or new_password):
            if not current_password:
                return jsonify({'error': 'password_required', 'message': 'Aktuelles Passwort erforderlich'}), 400
            if not bcrypt.checkpw(current_password.encode('utf-8'), user['password_hash'].encode('ascii')):
                return jsonify({'error': 'invalid_password', 'message': 'Aktuelles Passwort falsch'}), 400

        updates = []
        params = []

        # Profile info fields (no password required)
        updates.append('first_name = ?'); params.append(first_name)
        updates.append('last_name = ?'); params.append(last_name)
        updates.append('address = ?'); params.append(address)
        updates.append('birth_date = ?'); params.append(birth_date)

        if new_username:
            new_username = _normalize_username(new_username)
            if not new_username or not re.match(r'^[a-z0-9][a-z0-9._-]{2,29}$', new_username):
                return jsonify({'error': 'invalid_username', 'message': 'Ungültiger Benutzername (3-30 Zeichen: a-z, 0-9, . _ -)'}), 400
            if new_username != (user['username'] or '').lower():
                existing_u = db.execute(
                    'SELECT id FROM users WHERE lower(username) = lower(?) AND id != ?',
                    (new_username, request.user_id)
                ).fetchone()
                if existing_u:
                    return jsonify({'error': 'username_exists', 'message': 'Benutzername bereits vergeben'}), 409
                updates.append('username = ?')
                params.append(new_username)

        if new_email and new_email != user['email']:
            if not re.match(r'^[^@]+@[^@]+\.[^@]+$', new_email):
                return jsonify({'error': 'invalid_email', 'message': 'Ungültige E-Mail'}), 400
            existing = db.execute('SELECT id FROM users WHERE email = ? AND id != ?', (new_email, request.user_id)).fetchone()
            if existing:
                return jsonify({'error': 'email_exists', 'message': 'E-Mail bereits vergeben'}), 409
            updates.append('email = ?')
            params.append(new_email)
        if new_password:
            if len(new_password) < 8:
                return jsonify({'error': 'weak_password', 'message': 'Passwort min. 8 Zeichen'}), 400
            pw_hash = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt()).decode('ascii')
            updates.append('password_hash = ?')
            params.append(pw_hash)

        params.append(request.user_id)
        db.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", params)
        db.commit()

        user_updated = db.execute(
            'SELECT id, email, username, is_admin, first_name, last_name, address, birth_date FROM users WHERE id = ?',
            (request.user_id,)
        ).fetchone()
        return jsonify({
            'status': 'ok',
            'email': user_updated['email'],
            'username': user_updated['username'] or '',
            'firstName': user_updated['first_name'] or '',
            'lastName': user_updated['last_name'] or '',
            'address': user_updated['address'] or '',
            'birthDate': user_updated['birth_date'] or '',
        })
    finally:
        pass


# --- User settings & backup (protected) ---

@app.route('/api/user/settings', methods=['GET'])
@require_auth
def user_settings_get():
    db = get_db()
    try:
        row = db.execute(
            'SELECT spoolman_url, theme, language FROM user_settings WHERE user_id = ?',
            (request.user_id,)
        ).fetchone()
        if not row:
            return jsonify({'spoolmanUrl': '', 'theme': 'dark', 'language': 'de'})
        return jsonify({
            'spoolmanUrl': row['spoolman_url'] or '',
            'theme': row['theme'] or 'dark',
            'language': row['language'] or 'de'
        })
    finally:
        pass


@app.route('/api/user/settings', methods=['PUT'])
@require_auth
def user_settings_put():
    data = request.get_json(force=True, silent=True) or {}
    spoolman_url = (data.get('spoolmanUrl') or data.get('spoolman_url') or '')[:500]
    theme = (data.get('theme') or 'dark')[:20]
    language = (data.get('language') or 'de')[:10]
    if language not in ('de', 'en'):
        language = 'de'

    db = get_db()
    try:
        db.execute(
            '''INSERT INTO user_settings (user_id, spoolman_url, theme, language, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(user_id) DO UPDATE SET
                 spoolman_url=excluded.spoolman_url,
                 theme=excluded.theme,
                 language=excluded.language,
                 updated_at=datetime('now')''',
            (request.user_id, spoolman_url, theme, language)
        )
        backup_data = {'spoolmanUrl': spoolman_url, 'theme': theme, 'language': language}
        _save_user_backup(request.user_id, backup_data)
        db.commit()
        return jsonify({'status': 'ok'})
    finally:
        pass


@app.route('/api/user/export', methods=['GET'])
@require_auth
def user_export():
    db = get_db()
    try:
        row = db.execute(
            'SELECT spoolman_url, theme, language FROM user_settings WHERE user_id = ?',
            (request.user_id,)
        ).fetchone()
        data = {'spoolmanUrl': '', 'theme': 'dark', 'language': 'de', 'exportedAt': datetime.utcnow().isoformat()}
        if row:
            data.update({
                'spoolmanUrl': row['spoolman_url'] or '',
                'theme': row['theme'] or 'dark',
                'language': row['language'] or 'de'
            })
        return Response(
            json.dumps(data, indent=2),
            mimetype='application/json',
            headers={'Content-Disposition': 'attachment; filename="spooltagpropus-backup.json"'}
        )
    finally:
        pass


@app.route('/api/user/import', methods=['POST'])
@require_auth
def user_import():
    data = request.get_json(force=True, silent=True) or {}
    if not data:
        return jsonify({'error': 'invalid_data', 'message': 'No data provided'}), 400

    spoolman_url = (data.get('spoolmanUrl') or data.get('spoolman_url') or '')[:500]
    theme = (data.get('theme') or 'dark')[:20]
    language = (data.get('language') or 'de')[:10]
    if language not in ('de', 'en'):
        language = 'de'

    db = get_db()
    try:
        db.execute(
            '''INSERT INTO user_settings (user_id, spoolman_url, theme, language, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(user_id) DO UPDATE SET
                 spoolman_url=excluded.spoolman_url,
                 theme=excluded.theme,
                 language=excluded.language,
                 updated_at=datetime('now')''',
            (request.user_id, spoolman_url, theme, language)
        )
        _save_user_backup(request.user_id, {'spoolmanUrl': spoolman_url, 'theme': theme, 'language': language})
        db.commit()
        return jsonify({'status': 'ok'})
    finally:
        pass


@app.route('/api/user/backups', methods=['GET'])
@require_auth
def user_backups_list():
    db = get_db()
    try:
        rows = db.execute(
            'SELECT id, backup_json, created_at FROM user_backups WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
            (request.user_id, MAX_BACKUPS_PER_USER)
        ).fetchall()
        backups = []
        for r in rows:
            backups.append({'id': r['id'], 'createdAt': r['created_at']})
        return jsonify({'backups': backups})
    finally:
        pass


@app.route('/api/user/restore/<int:backup_id>', methods=['POST'])
@require_auth
def user_restore(backup_id):
    db = get_db()
    try:
        row = db.execute(
            'SELECT backup_json FROM user_backups WHERE id = ? AND user_id = ?',
            (backup_id, request.user_id)
        ).fetchone()
        if not row:
            return jsonify({'error': 'not_found', 'message': 'Backup not found'}), 404
        backup = json.loads(row['backup_json'])
        spoolman_url = (backup.get('spoolmanUrl') or '')[:500]
        theme = (backup.get('theme') or 'dark')[:20]
        language = (backup.get('language') or 'de')[:10]
        if language not in ('de', 'en'):
            language = 'de'

        db.execute(
            '''INSERT INTO user_settings (user_id, spoolman_url, theme, language, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(user_id) DO UPDATE SET
                 spoolman_url=excluded.spoolman_url,
                 theme=excluded.theme,
                 language=excluded.language,
                 updated_at=datetime('now')''',
            (request.user_id, spoolman_url, theme, language)
        )
        db.commit()
        return jsonify({'status': 'ok', 'settings': {'spoolmanUrl': spoolman_url, 'theme': theme, 'language': language}})
    finally:
        pass


# --- Protected routes (require auth) ---


# --- Slicer Profiles ---

@app.route('/api/profiles')
@require_auth
def list_profiles():
    db = get_db()
    vendor = request.args.get('vendor', '')
    material = request.args.get('material', '')
    slicer = request.args.get('slicer', '')
    search = request.args.get('q', '')
    page = max(1, int(request.args.get('page', 1)))
    per_page = min(100, int(request.args.get('per_page', 50)))

    conditions = ["source_path NOT LIKE '%@base%'"]
    params = []

    if vendor:
        conditions.append("vendor = ?")
        params.append(vendor)
    if material:
        conditions.append("material_type = ?")
        params.append(material.upper())
    if slicer:
        conditions.append("slicer = ?")
        params.append(slicer)
    if search:
        conditions.append("(filament_name LIKE ? OR vendor LIKE ?)")
        params.extend([f'%{search}%', f'%{search}%'])

    where = f"WHERE {' AND '.join(conditions)}"

    total = db.execute(f"SELECT COUNT(*) FROM slicer_profiles {where}", params).fetchone()[0]
    rows = db.execute(f"""
        SELECT id, vendor, printer, filament_name, material_type, slicer,
               nozzle_temp_min, nozzle_temp_max, bed_temp_min, bed_temp_max,
               filament_density, filament_cost, max_volumetric_speed, source_path
        FROM slicer_profiles {where}
        ORDER BY vendor, material_type, filament_name
        LIMIT ? OFFSET ?
    """, params + [per_page, (page - 1) * per_page]).fetchall()

    return jsonify({
        'total': total,
        'page': page,
        'per_page': per_page,
        'profiles': [dict(r) for r in rows]
    })


@app.route('/api/profiles/vendors')
@require_auth
def profile_vendors():
    db = get_db()
    rows = db.execute("""
        SELECT vendor, COUNT(*) as count
        FROM slicer_profiles
        GROUP BY vendor
        ORDER BY vendor
    """).fetchall()
    return jsonify([{'name': r['vendor'], 'count': r['count']} for r in rows])


@app.route('/api/profiles/materials')
@require_auth
def profile_materials():
    db = get_db()
    vendor = request.args.get('vendor', '')
    where = "WHERE vendor = ?" if vendor else ""
    params = [vendor] if vendor else []
    rows = db.execute(f"""
        SELECT material_type, COUNT(*) as count
        FROM slicer_profiles
        {where}
        GROUP BY material_type
        ORDER BY material_type
    """, params).fetchall()
    return jsonify([{'name': r['material_type'], 'count': r['count']} for r in rows])


@app.route('/api/profiles/<int:profile_id>')
@require_auth
def get_profile(profile_id):
    db = get_db()
    row = db.execute("SELECT * FROM slicer_profiles WHERE id = ?", (profile_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Profile not found'}), 404
    result = dict(row)
    result['profile_json'] = json.loads(result['profile_json'])
    return jsonify(result)


@app.route('/api/profiles/<int:profile_id>/download')
@require_auth
def download_profile(profile_id):
    db = get_db()
    row = db.execute("SELECT * FROM slicer_profiles WHERE id = ?", (profile_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Profile not found'}), 404

    profile_data = json.loads(row['profile_json'])
    filename = f"{row['filament_name']}.json"
    if row['printer']:
        filename = f"{row['filament_name']} @{row['printer']}.json"

    return Response(
        json.dumps(profile_data, indent=2),
        mimetype='application/json',
        headers={'Content-Disposition': f'attachment; filename="{filename}"'}
    )


# --- Filament Database ---

@app.route('/api/filaments')
@require_auth
def list_filaments():
    db = get_db()
    brand = request.args.get('brand', '')
    material = request.args.get('material', '')
    search = request.args.get('q', '')
    page = max(1, int(request.args.get('page', 1)))
    per_page = min(200, int(request.args.get('per_page', 50)))

    conditions = []
    params = []

    if brand:
        conditions.append("brand = ?")
        params.append(brand)
    if material:
        conditions.append("material = ?")
        params.append(material)
    if search:
        conditions.append("(name LIKE ? OR brand LIKE ? OR material LIKE ? OR color_name LIKE ?)")
        params.extend([f'%{search}%'] * 4)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ''

    total = db.execute(f"SELECT COUNT(*) FROM filaments {where}", params).fetchone()[0]
    rows = db.execute(f"""
        SELECT id, brand, material, name, color_name, color_hex,
               density, nozzle_temp_min, nozzle_temp_max,
               bed_temp_min, bed_temp_max, diameter
        FROM filaments {where}
        ORDER BY brand, material, name, color_name
        LIMIT ? OFFSET ?
    """, params + [per_page, (page - 1) * per_page]).fetchall()

    return jsonify({
        'total': total,
        'page': page,
        'per_page': per_page,
        'filaments': [dict(r) for r in rows]
    })


@app.route('/api/filaments/brands')
@require_auth
def filament_brands():
    db = get_db()
    rows = db.execute("""
        SELECT brand, COUNT(*) as count
        FROM filaments
        GROUP BY brand
        ORDER BY brand
    """).fetchall()
    return jsonify([{'name': r['brand'], 'count': r['count']} for r in rows])


@app.route('/api/filaments/materials')
@require_auth
def filament_materials():
    db = get_db()
    brand = request.args.get('brand', '')
    where = "WHERE brand = ?" if brand else ""
    params = [brand] if brand else []
    rows = db.execute(f"""
        SELECT material, COUNT(*) as count
        FROM filaments
        {where}
        GROUP BY material
        ORDER BY material
    """, params).fetchall()
    return jsonify([{'name': r['material'], 'count': r['count']} for r in rows])


@app.route('/api/filaments/colors')
@require_auth
def filament_colors():
    """
    Return distinct color_hex values for a given brand/material/(optional) variant.
    Used to limit the frontend swatch list to real available colors.
    """
    brand = (request.args.get('brand') or '').strip()
    material = (request.args.get('material') or '').strip()
    variant = (request.args.get('variant') or '').strip()

    # Require at least brand+material to avoid returning huge lists.
    if not brand or not material:
        return jsonify({'colors': []})

    conditions = ["brand = ?", "material = ?", "color_hex IS NOT NULL", "trim(color_hex) != ''"]
    params = [brand, material]

    if variant and variant.lower() not in ('basic',):
        # Variant is stored in `name` (e.g. "PLA Matte", "PLA Silk", ...).
        like = f"%{variant.replace(' ', '%')}%"
        conditions.append("name LIKE ?")
        params.append(like)

    where = " AND ".join(conditions)

    db = get_db()
    try:
        rows = db.execute(
            f"SELECT DISTINCT upper(replace(color_hex, '#', '')) AS hex FROM filaments WHERE {where} LIMIT 300",
            params
        ).fetchall()
    finally:
        pass

    colors = []
    for r in rows:
        hx = (r['hex'] or '').strip().upper()
        if re.match(r'^[0-9A-F]{6}$', hx) and hx not in colors:
            colors.append(hx)
    return jsonify({'colors': colors})


@app.route('/api/filaments/<int:filament_id>')
@require_auth
def get_filament(filament_id):
    db = get_db()
    row = db.execute("SELECT * FROM filaments WHERE id = ?", (filament_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Filament not found'}), 404
    result = dict(row)
    if result.get('extra_json'):
        result['extra'] = json.loads(result['extra_json'])
    del result['extra_json']
    return jsonify(result)


# --- Admin ---

@app.route('/api/admin/users', methods=['GET'])
@require_perm('admin.users')
def admin_users_list():
    db = get_db()
    try:
        rows = db.execute(
            '''SELECT u.id, u.email, u.username, u.role, u.is_admin, u.is_locked, u.created_at,
                      u.last_login_at, u.last_login_ip,
                      u.first_name, u.last_name,
                      u.group_id, g.name AS group_name,
                      COUNT(DISTINCT ub.id) as backup_count,
                      us.spoolman_url, us.theme, us.language
               FROM users u
               LEFT JOIN groups g ON g.id = u.group_id
               LEFT JOIN user_backups ub ON ub.user_id = u.id
               LEFT JOIN user_settings us ON us.user_id = u.id
               GROUP BY u.id
               ORDER BY u.created_at ASC'''
        ).fetchall()
        return jsonify({'users': [dict(r) for r in rows]})
    finally:
        pass


@app.route('/api/admin/users/<int:uid>/role', methods=['PUT'])
@require_perm('admin.users')
def admin_user_set_role(uid):
    data = request.get_json(force=True, silent=True) or {}
    role = (data.get('role') or '').strip().lower()
    allowed = ('user', 'viewer', 'manager', 'support')
    if role not in allowed:
        return jsonify({'error': 'invalid_role', 'message': f'Invalid role. Allowed: {allowed}'}), 400
    db = get_db()
    try:
        db.execute('UPDATE users SET role = ? WHERE id = ?', (role, uid))
        db.commit()
        return jsonify({'ok': True, 'role': role})
    finally:
        pass


def _normalize_permissions(perms):
    if not isinstance(perms, list):
        return []
    out = []
    for p in perms:
        p = str(p or '').strip()
        if not p:
            continue
        if len(p) > 80:
            continue
        # keep it simple + safe: only allow admin.* permissions for now
        if not p.startswith('admin.'):
            continue
        if p not in out:
            out.append(p)
    return out


@app.route('/api/admin/groups', methods=['GET'])
@require_any_perm(['admin.users', 'admin.groups'])
def admin_groups_list():
    db = get_db()
    try:
        rows = db.execute('SELECT id, name, permissions_json, created_at FROM groups ORDER BY name ASC').fetchall()
        groups = []
        for r in rows:
            try:
                perms = json.loads(r['permissions_json'] or '[]')
            except Exception:
                perms = []
            groups.append({
                'id': r['id'],
                'name': r['name'],
                'permissions': _normalize_permissions(perms),
                'created_at': r['created_at']
            })
        return jsonify({'groups': groups})
    finally:
        pass


@app.route('/api/admin/groups', methods=['POST'])
@require_perm('admin.groups')
def admin_groups_create():
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip()[:60]
    perms = _normalize_permissions(data.get('permissions') or [])
    if not name:
        return jsonify({'error': 'invalid_name', 'message': 'Name required'}), 400
    db = get_db()
    try:
        db.execute(
            'INSERT INTO groups (name, permissions_json) VALUES (?, ?)',
            (name, json.dumps(perms))
        )
        db.commit()
        gid = db.execute('SELECT id FROM groups WHERE name = ?', (name,)).fetchone()['id']
        return jsonify({'status': 'ok', 'group': {'id': gid, 'name': name, 'permissions': perms}})
    except Exception as e:
        return jsonify({'error': 'create_failed', 'message': str(e)}), 400
    finally:
        pass


@app.route('/api/admin/groups/<int:gid>', methods=['PUT'])
@require_perm('admin.groups')
def admin_groups_update(gid):
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get('name') or '').strip()[:60]
    perms = _normalize_permissions(data.get('permissions') or [])
    if not name:
        return jsonify({'error': 'invalid_name', 'message': 'Name required'}), 400
    db = get_db()
    try:
        db.execute('UPDATE groups SET name = ?, permissions_json = ? WHERE id = ?', (name, json.dumps(perms), gid))
        db.commit()
        return jsonify({'status': 'ok'})
    finally:
        pass


@app.route('/api/admin/groups/<int:gid>', methods=['DELETE'])
@require_perm('admin.groups')
def admin_groups_delete(gid):
    db = get_db()
    try:
        used = db.execute('SELECT COUNT(*) FROM users WHERE group_id = ?', (gid,)).fetchone()[0]
        if used:
            return jsonify({'error': 'group_in_use', 'message': 'Group is assigned to users'}), 409
        db.execute('DELETE FROM groups WHERE id = ?', (gid,))
        db.commit()
        return jsonify({'status': 'ok'})
    finally:
        pass


@app.route('/api/admin/users/<int:uid>/group', methods=['PUT'])
@require_perm('admin.users')
def admin_user_set_group(uid):
    data = request.get_json(force=True, silent=True) or {}
    gid = data.get('groupId')
    if gid in ('', None):
        gid = None
    else:
        try:
            gid = int(gid)
        except Exception:
            return jsonify({'error': 'invalid_group', 'message': 'Invalid groupId'}), 400
    db = get_db()
    try:
        if gid is not None:
            g = db.execute('SELECT id FROM groups WHERE id = ?', (gid,)).fetchone()
            if not g:
                return jsonify({'error': 'not_found', 'message': 'Group not found'}), 404
        db.execute('UPDATE users SET group_id = ? WHERE id = ?', (gid, uid))
        db.commit()
        return jsonify({'status': 'ok'})
    finally:
        pass


@app.route('/api/admin/users/<int:uid>/lock', methods=['PUT'])
@require_perm('admin.users')
def admin_user_lock(uid):
    if uid == request.user_id:
        return jsonify({'error': 'cannot_lock_self'}), 400
    data = request.get_json(force=True, silent=True) or {}
    locked = 1 if data.get('locked') else 0
    db = get_db()
    try:
        db.execute('UPDATE users SET is_locked = ? WHERE id = ?', (locked, uid))
        db.commit()
        return jsonify({'status': 'ok', 'locked': bool(locked)})
    finally:
        pass


@app.route('/api/admin/users/<int:uid>/admin', methods=['PUT'])
@require_perm('admin.users')
def admin_user_set_admin(uid):
    if uid == request.user_id:
        return jsonify({'error': 'cannot_change_own_admin'}), 400
    data = request.get_json(force=True, silent=True) or {}
    is_admin = 1 if data.get('isAdmin') else 0
    db = get_db()
    try:
        db.execute('UPDATE users SET is_admin = ? WHERE id = ?', (is_admin, uid))
        db.commit()
        return jsonify({'status': 'ok', 'isAdmin': bool(is_admin)})
    finally:
        pass


@app.route('/api/admin/users/<int:uid>', methods=['DELETE'])
@require_perm('admin.users')
def admin_user_delete(uid):
    if uid == request.user_id:
        return jsonify({'error': 'cannot_delete_self'}), 400
    db = get_db()
    try:
        db.execute('DELETE FROM users WHERE id = ?', (uid,))
        db.commit()
        return jsonify({'status': 'ok'})
    finally:
        pass


@app.route('/api/admin/status', methods=['GET'])
@require_perm('admin.status')
def admin_status():
    db = get_db()
    try:
        user_count = db.execute('SELECT COUNT(*) FROM users').fetchone()[0]
        admin_count = db.execute('SELECT COUNT(*) FROM users WHERE is_admin = 1').fetchone()[0]
        locked_count = db.execute('SELECT COUNT(*) FROM users WHERE is_locked = 1').fetchone()[0]
        backup_count = db.execute('SELECT COUNT(*) FROM user_backups').fetchone()[0]
        error_count = db.execute('SELECT COUNT(*) FROM error_reports').fetchone()[0]
        profile_count = db.execute('SELECT COUNT(*) FROM slicer_profiles').fetchone()[0]
        filament_count = db.execute('SELECT COUNT(*) FROM filaments').fetchone()[0]
        sync_rows = db.execute('SELECT source, last_sync, items_count, status FROM sync_status').fetchall()

        db_size = 0
        try:
            db_size = os.path.getsize(os.environ.get('DB_PATH', '/data/spool_propus.db'))
        except Exception:
            pass

        return jsonify({
            'version': '1.6.106',
            'dbSizeBytes': db_size,
            'users': {'total': user_count, 'admins': admin_count, 'locked': locked_count},
            'backups': backup_count,
            'errorReports': error_count,
            'slicerProfiles': profile_count,
            'filaments': filament_count,
            'sync': [dict(r) for r in sync_rows]
        })
    finally:
        pass


@app.route('/api/admin/backups', methods=['GET'])
@require_perm('admin.backups')
def admin_backups_list():
    db = get_db()
    try:
        rows = db.execute(
            '''SELECT ub.id, ub.user_id, u.email, ub.created_at
               FROM user_backups ub
               JOIN users u ON u.id = ub.user_id
               ORDER BY ub.created_at DESC
               LIMIT 200'''
        ).fetchall()
        return jsonify({'backups': [dict(r) for r in rows]})
    finally:
        pass


@app.route('/api/admin/error-reports', methods=['GET'])
@require_perm('admin.errors')
def admin_error_reports():
    db = get_db()
    try:
        rows = db.execute(
            '''SELECT id, error_message, user_message, user_agent, page_url, created_at,
                      COALESCE(status, 'neu') as status,
                      CASE WHEN screenshot IS NOT NULL AND screenshot != '' THEN 1 ELSE 0 END as has_screenshot
               FROM error_reports ORDER BY created_at DESC LIMIT 100'''
        ).fetchall()
        return jsonify({'reports': [dict(r) for r in rows]})
    finally:
        pass


@app.route('/api/admin/error-reports/<int:rid>', methods=['PATCH'])
@require_perm('admin.errors')
def admin_error_report_update(rid):
    data = request.get_json(silent=True) or {}
    status = data.get('status', '')
    allowed = ('neu', 'in_bearbeitung', 'erledigt', 'archiviert')
    if status not in allowed:
        return jsonify({'error': f'Ungültiger Status. Erlaubt: {allowed}'}), 400
    db = get_db()
    try:
        db.execute('UPDATE error_reports SET status = ? WHERE id = ?', (status, rid))
        db.commit()
        return jsonify({'ok': True, 'status': status})
    finally:
        pass


@app.route('/api/admin/error-reports/<int:rid>', methods=['DELETE'])
@require_perm('admin.errors')
def admin_error_report_delete(rid):
    db = get_db()
    try:
        db.execute('DELETE FROM error_reports WHERE id = ?', (rid,))
        db.commit()
        return jsonify({'ok': True})
    finally:
        pass


@app.route('/api/admin/error-reports/<int:rid>/screenshot', methods=['GET'])
@require_perm('admin.errors')
def admin_error_report_screenshot(rid):
    db = get_db()
    try:
        row = db.execute('SELECT screenshot FROM error_reports WHERE id = ?', (rid,)).fetchone()
        if not row or not row['screenshot']:
            return jsonify({'error': 'not_found'}), 404
        return jsonify({'screenshot': row['screenshot']})
    finally:
        pass


# --- Sync ---

@app.route('/api/sync/status')
@require_auth
def sync_status():
    db = get_db()
    rows = db.execute("SELECT * FROM sync_status ORDER BY id").fetchall()
    profile_count = db.execute("SELECT COUNT(*) FROM slicer_profiles").fetchone()[0]
    filament_count = db.execute("SELECT COUNT(*) FROM filaments").fetchone()[0]
    return jsonify({
        'sources': [dict(r) for r in rows],
        'totals': {
            'profiles': profile_count,
            'filaments': filament_count
        }
    })


# --- Error Reports ---

def _redact_url(url):
    """Redact IPs in URL for privacy (e.g. 192.168.1.4 -> 192.168.1.xxx)."""
    if not url or not isinstance(url, str):
        return url
    import re
    return re.sub(r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}', lambda m: m.group()[:-1] + 'xxx', url)


def _create_github_issue(row_id, error_message, error_stack, user_message, user_agent, url, page_url):
    """Create a GitHub issue from error report. Runs in background thread."""
    token = os.environ.get('GITHUB_TOKEN', '').strip()
    repo = os.environ.get('GITHUB_REPO', '').strip()
    if not token or not repo or '/' not in repo:
        return

    title = (error_message[:80] + '...') if len(error_message) > 80 else (error_message or 'Error Report')
    title = title.replace('\r', '').replace('\n', ' ')[:200]

    body_parts = [
        '## Error Report',
        '',
        f'**Report ID:** {row_id}',
        '',
        '### Error Message',
        f'```\n{(error_message or "(none)")}\n```',
        ''
    ]
    if error_stack:
        body_parts.extend(['### Stack Trace', '```', error_stack[:4000], '```', ''])
    if user_message:
        body_parts.extend(['### User Description', user_message, ''])
    body_parts.extend([
        '### Context',
        f'- **User-Agent:** {user_agent or "—"}',
        f'- **Page URL:** {page_url or "—"}',
        f'- **URL (redacted):** {url or "—"}',
        ''
    ])
    body = '\n'.join(body_parts)

    try:
        r = requests.post(
            f'https://api.github.com/repos/{repo}/issues',
            headers={
                'Authorization': f'Bearer {token}',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            json={'title': f'[Error Report] {title}', 'body': body},
            timeout=10
        )
        if r.status_code == 201:
            issue_url = r.json().get('html_url', '')
            log.info("GitHub issue created: %s", issue_url)
        else:
            log.warning("GitHub API error %s: %s", r.status_code, r.text[:200])
    except Exception as e:
        log.warning("Failed to create GitHub issue: %s", e)


@app.route('/api/error-report', methods=['POST'])
@require_auth
def error_report():
    try:
        data = request.get_json(force=True, silent=True) or {}
        error_message = (data.get('errorMessage') or data.get('error_message') or '')[:2000]
        error_stack = (data.get('errorStack') or data.get('error_stack') or '')[:8000]
        user_message = (data.get('userMessage') or data.get('user_message') or '')[:2000]
        user_agent = (request.headers.get('User-Agent') or '')[:500]
        url = _redact_url(data.get('url', ''))[:500]
        page_url = (data.get('pageUrl') or data.get('page_url') or request.referrer or '')[:500]
        if page_url:
            page_url = _redact_url(page_url)

        # Screenshot: accept base64 data URL, max ~4 MB base64 string (~3 MB image)
        screenshot = data.get('screenshot') or ''
        if screenshot and not screenshot.startswith('data:image/'):
            screenshot = ''
        if len(screenshot) > 4 * 1024 * 1024:
            screenshot = screenshot[:4 * 1024 * 1024]

        db = get_db()
        cur = db.execute(
            """INSERT INTO error_reports
               (error_message, error_stack, user_message, user_agent, url, page_url, screenshot)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (error_message, error_stack, user_message, user_agent, url, page_url, screenshot or None)
        )
        row_id = cur.lastrowid
        db.commit()

        has_screenshot = bool(screenshot)
        log.info("Error report received: %s (screenshot: %s)", error_message[:100] if error_message else '(no message)', has_screenshot)

        # Create GitHub issue in background if GITHUB_TOKEN and GITHUB_REPO are set
        if os.environ.get('GITHUB_TOKEN') and os.environ.get('GITHUB_REPO'):
            thread = threading.Thread(
                target=_create_github_issue,
                args=(row_id, error_message, error_stack, user_message, user_agent, url, page_url),
                daemon=True
            )
            thread.start()

        return jsonify({'status': 'ok', 'id': row_id, 'screenshot': has_screenshot})
    except Exception as e:
        log.warning("Failed to save error report: %s", e)
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/sync/trigger', methods=['POST'])
@require_auth
def trigger_sync():
    if _sync_lock.locked():
        return jsonify({'status': 'already_running'}), 409

    def do_sync():
        with _sync_lock:
            run_full_sync()

    thread = threading.Thread(target=do_sync, daemon=True)
    thread.start()
    return jsonify({'status': 'started'})


def scheduled_sync():
    if _sync_lock.locked():
        log.info("Sync already running, skipping scheduled run")
        return
    with _sync_lock:
        run_full_sync()


@app.route('/api/spoolman/proxy', methods=['GET'])
@require_auth
def spoolman_proxy():
    """Server-side proxy for Spoolman API – avoids Mixed Content / CORS issues."""
    spoolman_url = request.args.get('url', '').rstrip('/')
    path = request.args.get('path', '/api/v1/info')
    if not spoolman_url:
        return jsonify({'error': 'missing_url'}), 400
    if not spoolman_url.startswith(('http://', 'https://')):
        spoolman_url = 'http://' + spoolman_url
    try:
        # Use the exact URL provided (supports both internal containers and external HTTPS)
        target = f"{spoolman_url}{path}"
        resp = requests.get(target, timeout=6, verify=False)
        return Response(resp.content, status=resp.status_code,
                        content_type=resp.headers.get('Content-Type', 'application/json'))
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'connection_refused', 'message': 'Cannot reach Spoolman server'}), 502
    except requests.exceptions.Timeout:
        return jsonify({'error': 'timeout', 'message': 'Spoolman server timed out'}), 504
    except Exception as e:
        return jsonify({'error': 'proxy_error', 'message': str(e)}), 500


@app.route('/api/spoolman/spools', methods=['GET'])
@require_auth
def spoolman_spools_proxy():
    """Proxy: fetch all spools from user's Spoolman instance."""
    db = get_db()
    try:
        row = db.execute('SELECT spoolman_url FROM user_settings WHERE user_id = ?',
                         (request.user_id,)).fetchone()
        spoolman_url = (row['spoolman_url'] if row else '').rstrip('/')
    finally:
        pass

    if not spoolman_url:
        return jsonify({'error': 'no_spoolman_url'}), 400
    if not spoolman_url.startswith(('http://', 'https://')):
        spoolman_url = 'http://' + spoolman_url
    try:
        # Use the exact URL provided by the user (supports both internal and external)
        resp = requests.get(f"{spoolman_url}/api/v1/spool", timeout=8, verify=False)
        return Response(resp.content, status=resp.status_code,
                        content_type=resp.headers.get('Content-Type', 'application/json'))
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'connection_refused'}), 502
    except requests.exceptions.Timeout:
        return jsonify({'error': 'timeout'}), 504
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/spoolman/filaments', methods=['GET'])
@require_auth
def spoolman_filaments_proxy():
    """Proxy: fetch all filaments from user's Spoolman instance."""
    db = get_db()
    try:
        row = db.execute('SELECT spoolman_url FROM user_settings WHERE user_id = ?',
                         (request.user_id,)).fetchone()
        spoolman_url = (row['spoolman_url'] if row else '').rstrip('/')
    finally:
        pass

    if not spoolman_url:
        return jsonify({'error': 'no_spoolman_url'}), 400
    if not spoolman_url.startswith(('http://', 'https://')):
        spoolman_url = 'http://' + spoolman_url
    try:
        # Use the exact URL provided by the user (supports both internal and external)
        resp = requests.get(f"{spoolman_url}/api/v1/filament", timeout=10, verify=False)
        return Response(resp.content, status=resp.status_code,
                        content_type=resp.headers.get('Content-Type', 'application/json'))
    except requests.exceptions.ConnectionError:
        return jsonify({'error': 'connection_refused'}), 502
    except requests.exceptions.Timeout:
        return jsonify({'error': 'timeout'}), 504
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# =====================
#  Admin: KI-Chat
# =====================

def _chat_openai(messages, api_key, model='gpt-4o-mini'):
    """Call OpenAI Chat Completions API. Returns (reply_text, error_str)."""
    try:
        import urllib.request as _urlreq
        payload = json.dumps({
            'model': model,
            'messages': messages,
            'max_tokens': 2048,
            'temperature': 0.7,
        }).encode('utf-8')
        req = _urlreq.Request(
            'https://api.openai.com/v1/chat/completions',
            data=payload,
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json',
            },
            method='POST'
        )
        with _urlreq.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        return result['choices'][0]['message']['content'], None
    except Exception as e:
        return None, str(e)


def _get_chat_api_key(db):
    row = db.execute("SELECT value FROM app_config WHERE key='openai_api_key'").fetchone()
    return row['value'] if row else None


_CHAT_PROMPT_CACHE = {'path': None, 'mtime': None, 'text': None}


def _load_chat_system_prompt():
    """
    Load system prompt from file so it can be kept project-specific.
    Override path via CHAT_SYSTEM_PROMPT_PATH.
    """
    default_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'chat_system_prompt.txt')
    path = os.environ.get('CHAT_SYSTEM_PROMPT_PATH', default_path)
    try:
        st = os.stat(path)
        if (_CHAT_PROMPT_CACHE['path'] == path and
                _CHAT_PROMPT_CACHE['mtime'] == st.st_mtime and
                _CHAT_PROMPT_CACHE['text']):
            return _CHAT_PROMPT_CACHE['text']
        with open(path, 'r', encoding='utf-8') as fh:
            txt = (fh.read() or '').strip()
        if not txt:
            raise RuntimeError('empty prompt')
        _CHAT_PROMPT_CACHE.update({'path': path, 'mtime': st.st_mtime, 'text': txt})
        return txt
    except Exception as e:
        # Safe fallback (should be rare); keep it minimal.
        log.warning("Chat system prompt load failed (%s): %s", path, e)
        return "Du bist der KI-Assistent der App Spool Tag Propus. Antworte kurz, korrekt und auf Deutsch."


@app.route('/api/admin/chat/key', methods=['GET', 'POST'])
@require_admin
def admin_chat_key():
    db = get_db()
    try:
        if request.method == 'GET':
            row = db.execute("SELECT value FROM app_config WHERE key='openai_api_key'").fetchone()
            has_key = bool(row and row['value'])
            masked = ('sk-...' + row['value'][-4:]) if has_key else None
            return jsonify({'has_key': has_key, 'masked': masked})
        data = request.get_json(silent=True) or {}
        key = (data.get('api_key') or '').strip()
        if not key:
            return jsonify({'error': 'api_key darf nicht leer sein'}), 400
        if not key.startswith('sk-'):
            return jsonify({'error': 'Ungültiger API-Key (muss mit sk- beginnen)'}), 400
        db.execute(
            "INSERT INTO app_config(key,value,updated_at) VALUES('openai_api_key',?,datetime('now')) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key,)
        )
        db.commit()
        return jsonify({'ok': True, 'masked': 'sk-...' + key[-4:]})
    finally:
        pass


@app.route('/api/admin/chat/conversations', methods=['GET'])
@require_admin
def admin_chat_conversations():
    db = get_db()
    try:
        rows = db.execute(
            "SELECT c.id, c.title, c.created_at, c.updated_at, "
            "  (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id=c.id) as msg_count "
            "FROM chat_conversations c ORDER BY c.updated_at DESC LIMIT 100"
        ).fetchall()
        return jsonify({'conversations': [dict(r) for r in rows]})
    finally:
        pass


@app.route('/api/admin/chat/conversations/<int:cid>', methods=['GET', 'DELETE'])
@require_admin
def admin_chat_conversation(cid):
    db = get_db()
    try:
        if request.method == 'DELETE':
            db.execute("DELETE FROM chat_conversations WHERE id=?", (cid,))
            db.commit()
            return jsonify({'ok': True})
        rows = db.execute(
            "SELECT id, role, content, created_at FROM chat_messages "
            "WHERE conversation_id=? ORDER BY id ASC", (cid,)
        ).fetchall()
        conv = db.execute("SELECT id, title, created_at FROM chat_conversations WHERE id=?", (cid,)).fetchone()
        if not conv:
            return jsonify({'error': 'not_found'}), 404
        return jsonify({'conversation': dict(conv), 'messages': [dict(r) for r in rows]})
    finally:
        pass


@app.route('/api/admin/chat/conversations/<int:cid>/title', methods=['PATCH'])
@require_admin
def admin_chat_rename(cid):
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or '').strip()[:120]
    if not title:
        return jsonify({'error': 'Titel darf nicht leer sein'}), 400
    db = get_db()
    try:
        db.execute("UPDATE chat_conversations SET title=?, updated_at=datetime('now') WHERE id=?", (title, cid))
        db.commit()
        return jsonify({'ok': True})
    finally:
        pass


@app.route('/api/admin/chat/send', methods=['POST'])
@require_admin
def admin_chat_send():
    data = request.get_json(silent=True) or {}
    message = (data.get('message') or '').strip()
    conversation_id = data.get('conversation_id')
    if not message:
        return jsonify({'error': 'Nachricht darf nicht leer sein'}), 400
    if len(message) > 8000:
        return jsonify({'error': 'Nachricht zu lang (max 8000 Zeichen)'}), 400

    db = get_db()
    try:
        api_key = _get_chat_api_key(db)
        if not api_key:
            return jsonify({'error': 'Kein OpenAI API-Key konfiguriert. Bitte unter "KI-Einstellungen" eintragen.'}), 400

        # Create or load conversation
        if conversation_id:
            conv = db.execute("SELECT id FROM chat_conversations WHERE id=?", (conversation_id,)).fetchone()
            if not conv:
                conversation_id = None
        if not conversation_id:
            cur = db.execute(
                "INSERT INTO chat_conversations(title, created_by) VALUES(?, ?)",
                (message[:60] + ('…' if len(message) > 60 else ''), request.user_id)
            )
            db.commit()
            conversation_id = cur.lastrowid

        # Load history (last 20 messages for context)
        history = db.execute(
            "SELECT role, content FROM chat_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 20",
            (conversation_id,)
        ).fetchall()
        history = list(reversed(history))

        # Build messages for OpenAI
        openai_messages = [{'role': 'system', 'content': _load_chat_system_prompt()}]
        for h in history:
            openai_messages.append({'role': h['role'], 'content': h['content']})
        openai_messages.append({'role': 'user', 'content': message})

        # Save user message
        db.execute(
            "INSERT INTO chat_messages(conversation_id, role, content) VALUES(?,?,?)",
            (conversation_id, 'user', message)
        )
        db.commit()

        # Call OpenAI
        reply, err = _chat_openai(openai_messages, api_key)
        if err:
            return jsonify({'error': f'OpenAI Fehler: {err}'}), 502

        # Save assistant reply
        db.execute(
            "INSERT INTO chat_messages(conversation_id, role, content) VALUES(?,?,?)",
            (conversation_id, 'assistant', reply)
        )
        db.execute(
            "UPDATE chat_conversations SET updated_at=datetime('now') WHERE id=?",
            (conversation_id,)
        )
        db.commit()

        return jsonify({'ok': True, 'conversation_id': conversation_id, 'reply': reply})
    finally:
        pass


@app.route('/api/admin/chat/conversations/<int:cid>/export', methods=['GET'])
@require_admin
def admin_chat_export(cid):
    """Export conversation as Markdown and optionally save to .chat/ folder."""
    db = get_db()
    try:
        conv = db.execute("SELECT id, title, created_at FROM chat_conversations WHERE id=?", (cid,)).fetchone()
        if not conv:
            return jsonify({'error': 'not_found'}), 404
        msgs = db.execute(
            "SELECT role, content, created_at FROM chat_messages WHERE conversation_id=? ORDER BY id ASC", (cid,)
        ).fetchall()

        lines = [f"# {conv['title']}", f"_Erstellt: {conv['created_at']}_", ""]
        for m in msgs:
            prefix = "**Du:**" if m['role'] == 'user' else "**KI:**"
            lines.append(f"{prefix}  \n{m['content']}")
            lines.append("")
        md = "\n".join(lines)

        # Save to configured export directory. This can be a bind-mounted workspace folder.
        export_dir = os.environ.get('CHAT_EXPORT_DIR', '').strip() or '/data/chat_exports'
        saved_path = None
        saved_file = None
        try:
            os.makedirs(export_dir, exist_ok=True)
            safe_title = re.sub(r'[^\w\-_. ]', '_', conv['title'])[:60]
            filename = f"{cid:04d}_{safe_title}.md"
            filepath = os.path.join(export_dir, filename)
            with open(filepath, 'w', encoding='utf-8') as fh:
                fh.write(md)
            saved_file = filename
            saved_path = filepath
        except Exception as save_err:
            log.warning("Could not save chat export to %s: %s", export_dir, save_err)

        return jsonify({'ok': True, 'markdown': md, 'saved_path': saved_path, 'saved_file': saved_file, 'export_dir': export_dir})
    finally:
        pass


if __name__ == '__main__':
    init_db()

    with app.app_context():
        db = get_db()
        count = db.execute("SELECT COUNT(*) FROM slicer_profiles").fetchone()[0]

    if count == 0:
        log.info("Empty database, running initial sync...")
        threading.Thread(target=scheduled_sync, daemon=True).start()

    scheduler = BackgroundScheduler()
    scheduler.add_job(scheduled_sync, 'interval', hours=SYNC_INTERVAL_HOURS, id='sync')
    scheduler.start()

    app.run(host='0.0.0.0', port=5000, debug=False)
