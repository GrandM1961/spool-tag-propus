# 🧵 Spool Tag Propus

**Filament Tag Manager for 3D Printing** — Read, write, and manage NFC tags on filament spools using the [OpenSpool](https://github.com/spuder/OpenSpool) (JSON) and [OpenPrintTag](https://github.com/OpenPrintTag) (CBOR) standards.

> ⚠️ **Beta** — Actively developed. Feedback and contributions welcome!

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Support-yellow?logo=buymeacoffee)](https://buymeacoffee.com/propuscode)

---

## ✨ Features

| Feature | Description |
|---|---|
| **NFC Tag Read/Write** | Read and write filament data to NFC tags via Web NFC (Android Chrome) |
| **OpenSpool & OpenPrintTag** | Full support for both open standards |
| **Slicer Profile Database** | Browse and download Orca Slicer & Bambu Studio profiles from all manufacturers |
| **Filament Database** | Searchable database of filaments, synced from the Open Filament Database |
| **Spoolman Integration** | Import filament data directly from your [Spoolman](https://github.com/Donkie/Spoolman) instance |
| **QR Code Generator** | Generate QR codes with filament data to label spools |
| **QR Code Scanner** | Scan QR codes with your camera to read filament info |
| **Drying Profiles** | Recommended drying temperatures and times for 20+ materials |
| **Brand-Filtered Palettes** | Material and color options filtered by manufacturer |
| **Light/Dark Mode** | Toggle between light and dark themes |
| **PWA** | Installable as a Progressive Web App on mobile and desktop |
| **Self-Hosted** | Run entirely on your own hardware via Docker |

---

## 🖼️ Screenshots

*Coming soon*

---

## 🚀 Quick Start (Docker)

### Prerequisites

- Docker & Docker Compose
- (Optional) A Spoolman instance for filament imports

### 1. Clone the repository

```bash
git clone https://github.com/Janez76/spool-propus.git
cd spool-propus
```

### 2. Start with Docker Compose

```bash
docker compose up -d
```

This starts two containers:

| Container | Port | Description |
|---|---|---|
| `spool-propus` | `8090` | Nginx frontend |
| `spool-propus-api` | `5000` | Flask backend (API + data sync) |

### 3. Open in browser

```
http://localhost:8090
```

For NFC support on mobile, HTTPS is required. See the [HTTPS Setup](#https-setup) section.

---

## 🏗️ Architecture

```
┌──────────────┐     ┌───────────────────┐
│   Browser    │────▶│  Nginx (Frontend)  │
│  (PWA)       │     │  :8090 / :8443     │
└──────────────┘     └────────┬──────────┘
                              │ /api/*
                     ┌────────▼──────────┐
                     │  Flask (Backend)   │
                     │  :5000             │
                     │  ┌──────────────┐  │
                     │  │  SQLite DB   │  │
                     │  └──────────────┘  │
                     └────────┬──────────┘
                              │ Sync (every 24h)
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
        GitHub Repos   Open Filament   Spoolman
        (Orca/Bambu)   Database API    (optional)
```

---

## 🔧 Configuration

### Environment Variables (Backend)

| Variable | Default | Description |
|---|---|---|
| `DB_PATH` | `/data/spool_propus.db` | Path to the SQLite database |
| `SYNC_INTERVAL` | `24` | Hours between automatic data syncs |
| `GITHUB_TOKEN` | — | Optional: GitHub Personal Access Token for creating issues from error reports |
| `GITHUB_REPO` | — | Optional: Repository in `owner/repo` format (e.g. `Janez76/spool-propus`) |

If both `GITHUB_TOKEN` and `GITHUB_REPO` are set, error reports submitted via "Fehler melden" will automatically create a GitHub issue. Create a token at [GitHub Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens) with `repo` scope (or fine-grained: Issues write access).

### HTTPS Setup

Web NFC requires a secure context. Options:

1. **Cloudflare Tunnel** (recommended): Expose your local instance via a tunnel — automatic HTTPS
2. **Self-signed certificate**: Mount your certificate into the Nginx container and use port `8443`
3. **Reverse proxy**: Use Traefik, Caddy, or another reverse proxy with Let's Encrypt

### Spoolman Integration

Enter your Spoolman server URL in the app (e.g., `http://192.168.1.x:7912`) to import spools directly.

---

## 📁 Project Structure

> **Mehrere Propus/Spool-Projekte auf deiner NAS?** Siehe [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) für die Übersicht und Verknüpfungen.

```
├── public/                 # Frontend (static files)
│   ├── index.html          # Main application (HTML + CSS)
│   ├── app.js              # Core application logic
│   ├── openspool.js        # OpenSpool format encoder/decoder
│   ├── openprinttag.js     # OpenPrintTag (CBOR) encoder/decoder
│   ├── cbor.js             # CBOR library
│   ├── ndef.js             # NDEF record handling
│   ├── formats.js          # Format detection and routing
│   ├── color.js            # Filament color palette
│   ├── filamentdb.js       # Filament database integration
│   ├── profiledb.js        # Slicer profile browser
│   ├── drying.js           # Drying profile data
│   ├── qr.js               # QR code generation/scanning
│   ├── sw.js               # Service Worker (PWA caching)
│   └── manifest.json       # PWA manifest
├── backend/                # Backend API
│   ├── app.py              # Flask application
│   ├── database.py         # SQLite database setup
│   ├── sync.py             # Data synchronization (GitHub, Open Filament DB)
│   ├── requirements.txt    # Python dependencies
│   └── Dockerfile          # Backend container
├── nginx.conf              # Nginx configuration
├── docker-compose.yml      # Docker Compose stack
└── README.md
```

---

## 🛠️ Development

### Frontend

The frontend is pure HTML/CSS/JavaScript — no build step required. Simply serve the `public/` folder with any web server:

```bash
cd public
python -m http.server 8080
```

### Backend

```bash
cd backend
pip install -r requirements.txt
python app.py
```

The backend starts on port `5000` and automatically begins syncing slicer profiles and filament data.

---

## 📋 Supported NFC Tag Formats

| Format | Encoding | Standard |
|---|---|---|
| OpenSpool | JSON (NDEF Text Record) | [spuder/OpenSpool](https://github.com/spuder/OpenSpool) |
| OpenPrintTag | CBOR (NDEF MIME Record) | [OpenPrintTag](https://github.com/OpenPrintTag) |

Both formats store filament metadata (brand, material, color, temperatures, etc.) on standard NTAG213/215/216 NFC tags.

---

## 🌐 Platform Support

| Platform | NFC Read | NFC Write | QR Code | PWA |
|---|---|---|---|---|
| Android Chrome | ✅ | ✅ | ✅ | ✅ |
| iOS Safari | ❌ | ❌ | ✅ | ✅ |
| Desktop Chrome | ❌ | ❌ | ✅ | ✅ |
| Desktop Firefox | ❌ | ❌ | ✅ | ✅ |

> Web NFC is only available on Android Chrome. For other platforms, use the QR code feature as an alternative.

---

## 📄 License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.

---

## 🤝 Contributing

Contributions are welcome! Feel free to open issues or pull requests.

---

## ☕ Support

If you find this project useful, consider [buying me a coffee](https://buymeacoffee.com/propuscode)!
