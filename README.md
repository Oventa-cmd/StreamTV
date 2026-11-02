# StreamTV

IPTV-Player für Fire TV / Android TV im Netflix-Stil (WebView-App, Player liegt lokal in `app/src/main/assets`).

- Startseite mit Hero-Banner und Kategorie-Reihen
- HLS-Player (hls.js gebündelt), Kanalwechsel per ▲▼
- M3U-Import per URL oder Datei, Kanäle hinzufügen, bearbeiten, löschen
- Kategorien, Suche, Favoriten (Taste „f“ / Menü-Taste oder Stern)
- Komplett per Fernbedienung bedienbar

Jeder Push auf `main` baut per GitHub Actions eine APK und veröffentlicht sie als Release.

## Installation auf dem Fire TV

Downloader-App öffnen und diese URL eingeben:

```
https://github.com/Oventa-cmd/StreamTV/releases/latest/download/StreamTV.apk
```

Oder per ADB vom PC:

```
adb install -r StreamTV.apk
```
