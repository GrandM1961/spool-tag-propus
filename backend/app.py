import os
import json
import logging
import threading
from flask import Flask, jsonify, request, Response
from flask_cors import CORS
from apscheduler.schedulers.background import BackgroundScheduler
from database import init_db, get_db
from sync import run_full_sync

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
log = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

SYNC_INTERVAL_HOURS = int(os.environ.get('SYNC_INTERVAL', 24))
_sync_lock = threading.Lock()


@app.route('/api/health')
def health():
    return jsonify({'status': 'ok', 'version': '1.6.4-beta'})


# --- Slicer Profiles ---

@app.route('/api/profiles')
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


# --- Sync ---

@app.route('/api/sync/status')
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


@app.route('/api/sync/trigger', methods=['POST'])
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
