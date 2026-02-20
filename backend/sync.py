import requests
import json
import re
import time
import logging
from datetime import datetime
from database import get_db

log = logging.getLogger(__name__)

ORCA_RAW = 'https://raw.githubusercontent.com/SoftFever/OrcaSlicer/main'
FILAMENT_DB_API = 'https://api.openfilamentdatabase.org/api/v1'

VENDOR_NAME_MAP = {
    'BBL': 'Bambu Lab',
    'OrcaFilamentLibrary': 'Generic (Orca)',
}


def _extract_material_type(name, profile_data):
    ft = profile_data.get('filament_type')
    if isinstance(ft, list):
        ft = ft[0] if ft else None
    if ft:
        return ft.upper()
    name_upper = name.upper()
    for mat in ['PLA-CF', 'PETG-CF', 'PA-CF', 'ABS-GF', 'PET-CF',
                'PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC',
                'PVA', 'HIPS', 'PCTG', 'PEEK', 'PA12', 'BVOH']:
        if mat in name_upper:
            return mat
    return 'OTHER'


def _float_val(d, key):
    v = d.get(key)
    if isinstance(v, list): v = v[0] if v else None
    if v is None: return None
    try: return float(str(v))
    except: return None


def _int_val(d, key):
    v = d.get(key)
    if isinstance(v, list): v = v[0] if v else None
    if v is None: return None
    try: return int(float(str(v)))
    except: return None


VENDORS = [
    'BBL', 'Creality', 'Elegoo', 'Prusa', 'Anycubic', 'Qidi',
    'Snapmaker', 'Sovol', 'Flashforge', 'FLSun', 'Artillery',
    'Eryone', 'Comgrow', 'UltiMaker', 'Anker', 'Tronxy',
    'TwoTrees', 'BIQU', 'Geeetech', 'Lulzbot', 'OrcaFilamentLibrary',
]


def sync_orca_profiles():
    """Fetch filament profiles directly from raw.githubusercontent.com (no API rate limits)."""
    log.info("Starting Orca Slicer profile sync...")
    db = get_db()
    count = 0

    for vendor_dir in VENDORS:
        vendor_display = VENDOR_NAME_MAP.get(vendor_dir, vendor_dir)
        log.info(f"  Syncing: {vendor_display}")

        try:
            index_url = f'{ORCA_RAW}/resources/profiles/{vendor_dir}.json'
            resp = requests.get(index_url, timeout=30)
            if resp.status_code != 200:
                log.warning(f"    No index file for {vendor_dir}")
                continue
            vendor_meta = resp.json()

            filament_list = vendor_meta.get('filament_list', [])
            if not filament_list:
                log.info(f"    No filaments listed for {vendor_dir}")
                continue

            log.info(f"    {len(filament_list)} filament entries")

            for entry in filament_list:
                sub_path = entry.get('sub_path', '')
                if not sub_path or not sub_path.endswith('.json'):
                    continue
                fname = sub_path.split('/')[-1]
                if fname.startswith('fdm_filament_'):
                    continue

                try:
                    raw_url = f'{ORCA_RAW}/resources/profiles/{vendor_dir}/{sub_path}'
                    prof_resp = requests.get(raw_url, timeout=15)
                    if prof_resp.status_code != 200:
                        continue
                    profile = prof_resp.json()

                    filament_name = profile.get('name', fname.replace('.json', ''))
                    if profile.get('instantiation') == 'false' and '@base' not in filament_name.lower():
                        pass

                    printer_match = re.search(r'@(.+?)(?:\s+\d+\.\d+ nozzle)?$', filament_name)
                    printer = printer_match.group(1).strip() if printer_match else None
                    if printer in ('base', 'System'):
                        printer = None

                    base_name = re.sub(r'\s*@.*$', '', filament_name).strip()
                    material_type = _extract_material_type(base_name, profile)

                    nozzle_min = _int_val(profile, 'nozzle_temperature') or _int_val(profile, 'nozzle_temperature_range_low')
                    nozzle_max = _int_val(profile, 'nozzle_temperature') or _int_val(profile, 'nozzle_temperature_range_high')
                    bed_min = _int_val(profile, 'hot_plate_temp')
                    bed_max = _int_val(profile, 'hot_plate_temp')

                    db.execute("""
                        INSERT INTO slicer_profiles
                        (vendor, printer, filament_name, material_type, slicer,
                         nozzle_temp_min, nozzle_temp_max, bed_temp_min, bed_temp_max,
                         filament_density, filament_cost, filament_flow_ratio,
                         max_volumetric_speed, profile_json, source_url, source_path, updated_at)
                        VALUES (?, ?, ?, ?, 'orca',
                                ?, ?, ?, ?,
                                ?, ?, ?, ?,
                                ?, ?, ?, ?)
                    """, (vendor_display, printer, base_name, material_type,
                          nozzle_min, nozzle_max, bed_min, bed_max,
                          _float_val(profile, 'filament_density'),
                          _float_val(profile, 'filament_cost'),
                          _float_val(profile, 'filament_flow_ratio'),
                          _float_val(profile, 'filament_max_volumetric_speed'),
                          json.dumps(profile), raw_url,
                          f'resources/profiles/{vendor_dir}/{sub_path}',
                          datetime.utcnow().isoformat()))
                    count += 1

                except Exception as e:
                    pass

                time.sleep(0.05)

            db.commit()
            log.info(f"    {vendor_display} done ({count} total profiles)")

        except Exception as e:
            log.warning(f"    Error syncing {vendor_dir}: {e}")

    db.commit()
    db.close()
    log.info(f"Orca profile sync done: {count} profiles")
    return count


def sync_filament_database():
    """Fetch filament data from the Open Filament Database."""
    log.info("Starting filament database sync...")
    db = get_db()
    count = 0

    try:
        resp = requests.get(f'{FILAMENT_DB_API}/brands/index.json', timeout=15)
        resp.raise_for_status()
        brands = resp.json().get('brands', [])

        for brand in brands:
            if brand.get('material_count', 0) == 0:
                continue

            brand_slug = brand['slug']
            brand_name = brand['name']

            try:
                mat_resp = requests.get(
                    f'{FILAMENT_DB_API}/brands/{brand_slug}/index.json', timeout=15)
                mat_resp.raise_for_status()
                materials = mat_resp.json().get('materials', [])

                for material in materials:
                    mat_slug = material['slug']
                    mat_name = material.get('material', mat_slug)

                    try:
                        fil_resp = requests.get(
                            f'{FILAMENT_DB_API}/brands/{brand_slug}/materials/{mat_slug}/index.json',
                            timeout=15)
                        fil_resp.raise_for_status()
                        mat_data = fil_resp.json()
                        filaments = mat_data.get('filaments', [])
                        base_density = mat_data.get('density')
                        ss = mat_data.get('default_slicer_settings', {})

                        for filament in filaments:
                            fil_slug = filament['slug']
                            fil_name = filament.get('name', fil_slug)

                            try:
                                var_resp = requests.get(
                                    f'{FILAMENT_DB_API}/brands/{brand_slug}/materials/{mat_slug}/filaments/{fil_slug}/index.json',
                                    timeout=15)
                                var_resp.raise_for_status()
                                fil_data = var_resp.json()
                                variants = fil_data.get('variants', [])
                                density = fil_data.get('density') or base_density

                                if variants:
                                    for variant in variants:
                                        color_hex = variant.get('color_hex', '')
                                        if color_hex and not color_hex.startswith('#'):
                                            color_hex = '#' + color_hex
                                        db.execute("""
                                            INSERT INTO filaments
                                            (brand, material, name, color_name, color_hex,
                                             density, nozzle_temp_min, nozzle_temp_max,
                                             bed_temp_min, bed_temp_max, diameter,
                                             source, source_id, extra_json, updated_at)
                                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.75,
                                                    'openfilamentdb', ?, ?, ?)
                                        """, (brand_name, mat_name, fil_name,
                                              variant.get('color_name', ''), color_hex,
                                              density, ss.get('nozzle_temperature_min'),
                                              ss.get('nozzle_temperature_max'),
                                              ss.get('bed_temperature_min'),
                                              ss.get('bed_temperature_max'),
                                              f'{brand_slug}/{mat_slug}/{fil_slug}/{variant.get("slug","")}',
                                              json.dumps(variant),
                                              datetime.utcnow().isoformat()))
                                        count += 1
                                else:
                                    db.execute("""
                                        INSERT INTO filaments
                                        (brand, material, name, color_name, color_hex,
                                         density, nozzle_temp_min, nozzle_temp_max,
                                         bed_temp_min, bed_temp_max, diameter,
                                         source, source_id, extra_json, updated_at)
                                        VALUES (?, ?, ?, '', '', ?, ?, ?, ?, ?, 1.75,
                                                'openfilamentdb', ?, ?, ?)
                                    """, (brand_name, mat_name, fil_name,
                                          density, ss.get('nozzle_temperature_min'),
                                          ss.get('nozzle_temperature_max'),
                                          ss.get('bed_temperature_min'),
                                          ss.get('bed_temperature_max'),
                                          f'{brand_slug}/{mat_slug}/{fil_slug}',
                                          json.dumps(fil_data),
                                          datetime.utcnow().isoformat()))
                                    count += 1

                            except Exception as e:
                                pass
                            time.sleep(0.1)

                    except Exception as e:
                        pass
                    time.sleep(0.1)

                db.commit()
                log.info(f"  {brand_name}: {count} total filaments so far")

            except Exception as e:
                log.warning(f"  Error fetching brand {brand_slug}: {e}")
            time.sleep(0.1)

    except Exception as e:
        log.error(f"Filament DB sync failed: {e}")

    db.commit()
    db.close()
    log.info(f"Filament database sync done: {count} entries")
    return count


def run_full_sync():
    log.info("=== Starting full sync ===")
    db = get_db()
    now = datetime.utcnow().isoformat()
    db.execute("DELETE FROM slicer_profiles")
    db.execute("DELETE FROM filaments")
    db.commit()
    db.close()

    profile_count = 0
    filament_count = 0

    db = get_db()
    try:
        profile_count = sync_orca_profiles()
        db.execute("""
            INSERT OR REPLACE INTO sync_status (id, source, last_sync, items_count, status)
            VALUES (1, 'orca_profiles', ?, ?, 'ok')
        """, (now, profile_count))
    except Exception as e:
        log.error(f"Orca sync error: {e}")
        db.execute("""
            INSERT OR REPLACE INTO sync_status (id, source, last_sync, items_count, status, error)
            VALUES (1, 'orca_profiles', ?, 0, 'error', ?)
        """, (now, str(e)))

    try:
        filament_count = sync_filament_database()
        db.execute("""
            INSERT OR REPLACE INTO sync_status (id, source, last_sync, items_count, status)
            VALUES (2, 'filament_database', ?, ?, 'ok')
        """, (now, filament_count))
    except Exception as e:
        log.error(f"Filament DB sync error: {e}")
        db.execute("""
            INSERT OR REPLACE INTO sync_status (id, source, last_sync, items_count, status, error)
            VALUES (2, 'filament_database', ?, 0, 'error', ?)
        """, (now, str(e)))

    db.commit()
    db.close()
    log.info(f"=== Full sync complete: {profile_count} profiles, {filament_count} filaments ===")
    return profile_count, filament_count
