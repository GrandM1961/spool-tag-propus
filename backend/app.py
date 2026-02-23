import os
import re
import json
import logging
import threading
from datetime import datetime
from functools import wraps

import jwt
import bcrypt
from flask import Flask, jsonify, request, Response
from flask_cors import CORS
from apscheduler.schedulers.background import BackgroundScheduler
from database import init_db, get_db
from sync import run_full_sync
import requests

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, supports_credentials=True, origins=['*'])

# Ensure DB schema exists in all run modes (gunicorn/uwsgi/import).
# Previously this only ran under `python app.py` which could leave new tables
# (e.g. `groups`) missing in production and cause HTML 500 pages for JSON APIs.
try:
    init_db()
except Exception as e:
    log.exception("init_db failed during startup: %s", e)

JWT_SECRET = os.environ.get('JWT_SECRET', 'change-me-in-production-' + os.urandom(16).hex())
JWT_ALGORITHM = 'HS256'
JWT_EXPIRY_HOURS = 24 * 30  # 30 days
MAX_BACKUPS_PER_USER = 10

SYNC_INTERVAL_HOURS = int(os.environ.get('SYNC_INTERVAL', 24))
_sync_lock = threading.Lock()


def _get_token():
    auth = request.headers.get('Authorization')
    if auth and auth.startswith('Bearer '):
        return auth[7:]
    return request.cookies.get('token')


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
            db.close()
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
            db.close()
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
                db.close()
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
                db.close()
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
            conn.close()
    except Exception as e:
        log.warning(f"Could not save user backup (non-critical): {e}")


# --- Auth (public) ---

@app.route('/api/health')
def health():
    return jsonify({'status': 'ok', 'version': '1.6.63'})


@app.route('/api/auth/register', methods=['POST'])
def auth_register():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''
    first_name = (data.get('firstName') or data.get('first_name') or '').strip()[:100]
    last_name = (data.get('lastName') or data.get('last_name') or '').strip()[:100]
    address = (data.get('address') or '').strip()[:500]
    birth_date = (data.get('birthDate') or data.get('birth_date') or '').strip()[:20]

    if not email or not re.match(r'^[^@]+@[^@]+\.[^@]+$', email):
        return jsonify({'error': 'invalid_email', 'message': 'Invalid email'}), 400
    if len(password) < 8:
        return jsonify({'error': 'weak_password', 'message': 'Password must be at least 8 characters'}), 400

    db = get_db()
    try:
        existing = db.execute('SELECT id FROM users WHERE email = ?', (email,)).fetchone()
        if existing:
            db.close()
            return jsonify({'error': 'email_exists', 'message': 'Email already registered'}), 409

        pw_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('ascii')
        cur = db.execute(
            'INSERT INTO users (email, password_hash, first_name, last_name, address, birth_date) VALUES (?, ?, ?, ?, ?, ?)',
            (email, pw_hash, first_name, last_name, address, birth_date)
        )
        user_id = cur.lastrowid
        db.execute(
            'INSERT INTO user_settings (user_id, spoolman_url, theme, language) VALUES (?, ?, ?, ?)',
            (user_id, '', 'dark', 'de')
        )
        db.commit()
        token = _create_token(user_id)
        return jsonify({
            'token': token,
            'user': {
                'id': user_id,
                'email': email,
                'isAdmin': False,
                'permissions': []
            }
        })
    finally:
        db.close()


@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    data = request.get_json(force=True, silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    db = get_db()
    try:
        row = db.execute('SELECT id, password_hash, is_locked, is_admin FROM users WHERE email = ?', (email,)).fetchone()
        if not row:
            return jsonify({'error': 'invalid_credentials', 'message': 'Invalid email or password'}), 401
        if not bcrypt.checkpw(password.encode('utf-8'), row['password_hash'].encode('ascii')):
            return jsonify({'error': 'invalid_credentials', 'message': 'Invalid email or password'}), 401
        if row['is_locked']:
            return jsonify({'error': 'locked', 'message': 'Account is locked. Contact an administrator.'}), 403
        perms = _get_permissions_for_user(db, row['id'])
        token = _create_token(row['id'])
        return jsonify({
            'token': token,
            'user': {
                'id': row['id'],
                'email': email,
                'isAdmin': bool(row['is_admin']),
                'permissions': perms
            }
        })
    finally:
        db.close()


@app.route('/api/auth/me', methods=['GET'])
@require_auth
def auth_me():
    db = get_db()
    try:
        user = db.execute(
            'SELECT u.id, u.email, u.is_admin, u.first_name, u.last_name, u.address, u.birth_date, u.group_id, g.name AS group_name '
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
        db.close()


@app.route('/api/auth/refresh', methods=['POST'])
@require_auth
def auth_refresh():
    """Issue a fresh 30-day token for an already authenticated user."""
    new_token = _create_token(request.user_id)
    return jsonify({'token': new_token})


@app.route('/api/user/profile', methods=['PUT'])
@require_auth
def user_profile_update():
    data = request.get_json(force=True, silent=True) or {}
    new_email = (data.get('email') or '').strip().lower()
    new_password = data.get('password') or ''
    current_password = data.get('currentPassword') or ''
    first_name = (data.get('firstName') or '').strip()[:100]
    last_name = (data.get('lastName') or '').strip()[:100]
    address = (data.get('address') or '').strip()[:500]
    birth_date = (data.get('birthDate') or '').strip()[:20]

    db = get_db()
    try:
        user = db.execute('SELECT id, email, password_hash FROM users WHERE id = ?', (request.user_id,)).fetchone()
        if not user:
            return jsonify({'error': 'not_found'}), 404

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
            'SELECT id, email, is_admin, first_name, last_name, address, birth_date FROM users WHERE id = ?',
            (request.user_id,)
        ).fetchone()
        return jsonify({
            'status': 'ok',
            'email': user_updated['email'],
            'firstName': user_updated['first_name'] or '',
            'lastName': user_updated['last_name'] or '',
            'address': user_updated['address'] or '',
            'birthDate': user_updated['birth_date'] or '',
        })
    finally:
        db.close()


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
        db.close()


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
        db.close()


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
        db.close()


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
        db.close()


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
        db.close()


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
        db.close()


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

    db.close()
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
    db.close()
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
    db.close()
    return jsonify([{'name': r['material_type'], 'count': r['count']} for r in rows])


@app.route('/api/profiles/<int:profile_id>')
@require_auth
def get_profile(profile_id):
    db = get_db()
    row = db.execute("SELECT * FROM slicer_profiles WHERE id = ?", (profile_id,)).fetchone()
    db.close()
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
    db.close()
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

    db.close()
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
    db.close()
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
    db.close()
    return jsonify([{'name': r['material'], 'count': r['count']} for r in rows])


@app.route('/api/filaments/<int:filament_id>')
@require_auth
def get_filament(filament_id):
    db = get_db()
    row = db.execute("SELECT * FROM filaments WHERE id = ?", (filament_id,)).fetchone()
    db.close()
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
            '''SELECT u.id, u.email, u.is_admin, u.is_locked, u.created_at,
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
        db.close()


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
        db.close()


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
        db.close()


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
        db.close()


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
        db.close()


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
        db.close()


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
        db.close()


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
        db.close()


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
        db.close()


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
            'version': '1.6.63',
            'dbSizeBytes': db_size,
            'users': {'total': user_count, 'admins': admin_count, 'locked': locked_count},
            'backups': backup_count,
            'errorReports': error_count,
            'slicerProfiles': profile_count,
            'filaments': filament_count,
            'sync': [dict(r) for r in sync_rows]
        })
    finally:
        db.close()


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
        db.close()


@app.route('/api/admin/error-reports', methods=['GET'])
@require_perm('admin.errors')
def admin_error_reports():
    db = get_db()
    try:
        rows = db.execute(
            '''SELECT id, error_message, user_message, user_agent, page_url, created_at,
                      CASE WHEN screenshot IS NOT NULL AND screenshot != '' THEN 1 ELSE 0 END as has_screenshot
               FROM error_reports ORDER BY created_at DESC LIMIT 100'''
        ).fetchall()
        return jsonify({'reports': [dict(r) for r in rows]})
    finally:
        db.close()


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
        db.close()


# --- Sync ---

@app.route('/api/sync/status')
@require_auth
def sync_status():
    db = get_db()
    rows = db.execute("SELECT * FROM sync_status ORDER BY id").fetchall()
    profile_count = db.execute("SELECT COUNT(*) FROM slicer_profiles").fetchone()[0]
    filament_count = db.execute("SELECT COUNT(*) FROM filaments").fetchone()[0]
    db.close()
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
        db.close()

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


if __name__ == '__main__':
    init_db()

    db = get_db()
    count = db.execute("SELECT COUNT(*) FROM slicer_profiles").fetchone()[0]
    db.close()

    if count == 0:
        log.info("Empty database, running initial sync...")
        threading.Thread(target=scheduled_sync, daemon=True).start()

    scheduler = BackgroundScheduler()
    scheduler.add_job(scheduled_sync, 'interval', hours=SYNC_INTERVAL_HOURS, id='sync')
    scheduler.start()

    app.run(host='0.0.0.0', port=5000, debug=False)
