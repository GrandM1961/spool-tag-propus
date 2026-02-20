import requests
import json
import re
import time
import logging
from datetime import datetime
from database import get_db

log = logging.getLogger(__name__)

GITHUB_API = 'https://api.github.com'
ORCA_REPO = 'SoftFever/OrcaSlicer'
ORCA_RAW = f'https://raw.githubusercontent.com/{ORCA_REPO}/main'
BAMBU_REPO = 'bambulab/BambuStudio'
BAMBU_RAW = f'https://raw.githubusercontent.com/{BAMBU_REPO}/master'
FILAMENT_DB_API = 'https://api.openfilamentdatabase.org/api/v1'

RATE_DELAY = 0.3

VENDOR_DIRS = {
    'orca': [
        'BBL', 'Creality', 'Elegoo', 'Prusa', 'Anycubic', 'Qidi',
        'Snapmaker', 'Voron', 'Raise3D', 'FLSun', 'Sovol', 'Flashforge',
        'Kingroon', 'Artillery', 'BIQU', 'Ratrig', 'TwoTrees', 'Geeetech',
        'Eryone', 'Comgrow', 'LONGER', 'Lulzbot', 'UltiMaker',
        'Anker', 'Phrozen', 'Tronxy', 'Voxelab', 'Vzbot',
        'OrcaFilamentLibrary'
    ]
}

VENDOR_NAME_MAP = {
    'BBL': 'Bambu Lab',
    'OrcaFilamentLibrary': 'Generic (Orca)',
}


def _gh_get(url, retries=3):
    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=30,
                                headers={'Accept': 'application/vnd.github.v3+json'})
            if resp.status_code == 403 and 'rate limit' in resp.text.lower():
                log.warning("GitHub rate limit, waiting 60s...")
                time.sleep(60)
                continue
            resp.raise_for_status()
            return resp
        except requests.RequestException as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise
    return None


def _parse_temp_range(profile_data, key_min, key_max):
    """Extract temperature from profile JSON, handling various formats."""
    def _val(k):
        v = profile_data.get(k)
        if isinstance(v, list):
            v = v[0] if v else None
        if v is None:
            return None
        try:
            return int(float(str(v)))
        except (ValueError, TypeError):
            return None
    return _val(key_min), _val(key_max)


def _extract_material_type(name, profile_data):
    """Guess material type from filament name or profile data."""
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


def _float_val(profile_data, key):
    v = profile_data.get(key)
    if isinstance(v, list):
        v = v[0] if v else None
    if v is None:
        return None
    try:
        return float(str(v))
    except (ValueError, TypeError):
        return None


def sync_orca_profiles():
    """Fetch all filament profiles from OrcaSlicer GitHub repo."""
    log.info("Starting Orca Slicer profile sync...")
    db = get_db()
    count = 0

    for vendor_dir in VENDOR_DIRS['orca']:
        vendor_display = VENDOR_NAME_MAP.get(vendor_dir, vendor_dir)
        log.info(f"  Syncing vendor: {vendor_display} ({vendor_dir})")

        try:
            url = f'{GITHUB_API}/repos/{ORCA_REPO}/contents/resources/profiles/{vendor_dir}/filament'
            resp = _gh_get(url)
            if not resp:
                continue

            entries = resp.json()
            if not isinstance(entries, list):
                url2 = f'{GITHUB_API}/repos/{ORCA_REPO}/contents/resources/profiles/{vendor_dir}'
                resp2 = _gh_get(url2)
                if resp2:
                    dirs = [e for e in resp2.json() if e.get('type') == 'dir']
                    filament_dirs = [d for d in dirs if d['name'] == 'filament']
                    if not filament_dirs:
                        continue
                    entries = _gh_get(filament_dirs[0]['url']).json()
                else:
                    continue

            json_files = []
            for entry in entries:
                if entry.get('type') == 'file' and entry['name'].endswith('.json'):
                    json_files.append(entry)
                elif entry.get('type') == 'dir':
                    sub_resp = _gh_get(entry['url'])
                    if sub_resp:
                        for sub_entry in sub_resp.json():
                            if sub_entry.get('type') == 'file' and sub_entry['name'].endswith('.json'):
                                json_files.append(sub_entry)
                    time.sleep(RATE_DELAY)

            for file_entry in json_files:
                fname = file_entry['name']
                if fname.startswith('fdm_filament_') or fname == 'fdm_filament_common.json':
                    continue
                if '@base' in fname:
                    continue

                try:
                    raw_url = file_entry.get('download_url')
                    if not raw_url:
                        continue
                    prof_resp = requests.get(raw_url, timeout=15)
                    prof_resp.raise_for_status()
                    profile = prof_resp.json()

                    filament_name = profile.get('name', fname.replace('.json', ''))

                    nozzle_match = re.search(r'\s+(\d+\.?\d*)\s+nozzle$', filament_name)
                    nozzle_size = nozzle_match.group(1) if nozzle_match else None

                    printer_match = re.search(r'@(.+?)(?:\s+\d+\.?\d*\s+nozzle)?$', filament_name)
                    printer = printer_match.group(1).strip() if printer_match else None
                    if printer in ('base', 'System'):
                        printer = None
                    if printer and re.match(r'^\d+\.?\d*\s+nozzle$', printer):
                        printer = None

                    base_name = re.sub(r'\s*@.*$', '', filament_name).strip()
                    material_type = _extract_material_type(base_name, profile)

                    nozzle_min, nozzle_max = _parse_temp_range(
                        profile, 'nozzle_temperature', 'nozzle_temperature')
                    if nozzle_min and not nozzle_max:
                        nozzle_max = nozzle_min
                    nozzle_range_min, _ = _parse_temp_range(
                        profile, 'nozzle_temperature_range_low', 'nozzle_temperature_range_low')
                    nozzle_range_max, _ = _parse_temp_range(
                        profile, 'nozzle_temperature_range_high', 'nozzle_temperature_range_high')
                    if nozzle_range_min:
                        nozzle_min = nozzle_range_min
                    if nozzle_range_max:
                        nozzle_max = nozzle_range_max

                    bed_min, _ = _parse_temp_range(
                        profile, 'hot_plate_temp', 'hot_plate_temp')
                    bed_max, _ = _parse_temp_range(
                        profile, 'hot_plate_temp', 'hot_plate_temp')

                    density = _float_val(profile, 'filament_density')
                    cost = _float_val(profile, 'filament_cost')
                    flow_ratio = _float_val(profile, 'filament_flow_ratio')
                    mvs = _float_val(profile, 'filament_max_volumetric_speed')

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
                          density, cost, flow_ratio, mvs,
                          json.dumps(profile), raw_url,
                          file_entry.get('path', ''),
                          datetime.utcnow().isoformat()))
                    count += 1

                except Exception as e:
                    log.warning(f"    Error parsing {fname}: {e}")

                time.sleep(RATE_DELAY)

            db.commit()

        except Exception as e:
            log.warning(f"  Error syncing {vendor_dir}: {e}")

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
            log.info(f"  Syncing brand: {brand_name}")

            try:
                mat_resp = requests.get(
                    f'{FILAMENT_DB_API}/brands/{brand_slug}/index.json', timeout=15)
                mat_resp.raise_for_status()
                brand_data = mat_resp.json()
                materials = brand_data.get('materials', [])

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
                        slicer_settings = mat_data.get('default_slicer_settings', {})

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

                                nozzle_min = slicer_settings.get('nozzle_temperature_min')
                                nozzle_max = slicer_settings.get('nozzle_temperature_max')
                                bed_min = slicer_settings.get('bed_temperature_min')
                                bed_max = slicer_settings.get('bed_temperature_max')

                                if variants:
                                    for variant in variants:
                                        color_name = variant.get('color_name', '')
                                        color_hex = variant.get('color_hex', '')
                                        if color_hex and not color_hex.startswith('#'):
                                            color_hex = '#' + color_hex

                                        db.execute("""
                                            INSERT INTO filaments
                                            (brand, material, name, color_name, color_hex,
                                             density, nozzle_temp_min, nozzle_temp_max,
                                             bed_temp_min, bed_temp_max, diameter,
                                             source, source_id, extra_json, updated_at)
                                            VALUES (?, ?, ?, ?, ?,
                                                    ?, ?, ?, ?, ?, 1.75,
                                                    'openfilamentdb', ?, ?, ?)
                                        """, (brand_name, mat_name, fil_name,
                                              color_name, color_hex,
                                              density, nozzle_min, nozzle_max,
                                              bed_min, bed_max,
                                              f'{brand_slug}/{mat_slug}/{fil_slug}/{variant.get("slug", "")}',
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
                                        VALUES (?, ?, ?, '', '',
                                                ?, ?, ?, ?, ?, 1.75,
                                                'openfilamentdb', ?, ?, ?)
                                    """, (brand_name, mat_name, fil_name,
                                          density, nozzle_min, nozzle_max,
                                          bed_min, bed_max,
                                          f'{brand_slug}/{mat_slug}/{fil_slug}',
                                          json.dumps(fil_data),
                                          datetime.utcnow().isoformat()))
                                    count += 1

                            except Exception as e:
                                log.warning(f"    Error fetching filament {fil_slug}: {e}")
                            time.sleep(RATE_DELAY)

                    except Exception as e:
                        log.warning(f"    Error fetching material {mat_slug}: {e}")
                    time.sleep(RATE_DELAY)

            except Exception as e:
                log.warning(f"  Error fetching brand {brand_slug}: {e}")
            db.commit()
            time.sleep(RATE_DELAY)

    except Exception as e:
        log.error(f"Filament DB sync failed: {e}")

    db.commit()
    db.close()
    log.info(f"Filament database sync done: {count} entries")
    return count


def run_full_sync():
    """Run complete sync of all sources."""
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

    log.info(f"Full sync complete: {profile_count} profiles, {filament_count} filaments")
    return profile_count, filament_count
