# StreamTV

IPTV-Player für Fire TV / Android TV im Apple-Stil (WebView-App, Oberfläche liegt lokal in `app/src/main/assets`). Komplett per Fernbedienung bedienbar.

## Funktionen

**Live-TV**
- M3U-Playlists und Xtream-Codes-Zugänge, Kategorien, Suche, Favoriten
- HLS (hls.js) und MPEG-TS (mpegts.js) gebündelt, automatischer Wechsel bei Problemen
- **EPG:** laufende Sendung auf jeder Senderkachel; im Player „Jetzt / Danach“ mit Uhrzeit und Fortschritt (Xtream `get_short_epg`, gecacht)
- **Senderliste im Player:** ◀ öffnet die Sender der aktuellen Kategorie samt EPG; ▲▼ wählen, OK umschalten

**Serien & Filme vom Anbieter**
- **Reiter „Serien“:** kompletter Xtream-Serienkatalog mit Covern, Kategorie-Chips, Filter; auch große Kataloge (20.000+) laufen flüssig
- **Filme (VOD):** „Beim Anbieter suchen“ auch für Filme; Film-Reihen unter „Entdecken“
- **Weiterschauen:** angefangene Folgen und Filme ganz oben auf der Startseite, OK setzt direkt fort (≡ entfernt einen Eintrag)
- **Intro, Rückblick, Abspann überspringen:** exakte Zeiten aus [TheIntroDB](https://theintrodb.org); fehlt ein Eintrag, lernt die App pro Serie aus dem eigenen Spulverhalten; sonst Faustregel. Im Abspann „Nächste Folge ▶“
- **Tonspur & Untertitel:** ≡ im Player (HLS); für MKV/MP4 „In anderem Player öffnen“ (z. B. VLC) mit aktueller Position

**Empfehlungen & Watchlist**
- Serien- und Film-Empfehlungen (TMDB), persönlich mit dem Serien-Watchlist-Konto
- **Watchlist-Sync:** ab 90 % gesehen wird die Folge im Watchlist-Konto eingetragen (Status „watching“, nach der letzten Folge „done“); offline wird nachgetragen

**Sonstiges**
- ProtonVPN-Anbindung (Autostart, „nur mit VPN abspielen“)
- **Update-Hinweis:** prüft höchstens alle 12 h die neueste GitHub-Version und zeigt den ADB-Befehl unter „Einstellungen → App-Update“

## Bedienung im Player

| Taste | Live-TV | Serie / Film |
|---|---|---|
| ▲▼ | Sender wechseln | Folge wechseln |
| ◀ | Senderliste | 10 s zurück |
| ▶ | – | 10 s vor |
| OK | Pause / Skip-Button | Pause / Skip-Button |
| ≡ | Optionen (Ton, Untertitel, Favorit) | Optionen (Ton, Untertitel, anderer Player) |
| Zurück | Liste/Menü schließen, dann Player | wie Live-TV |

## Build

Jeder Push auf `main` baut per GitHub Actions eine APK und veröffentlicht sie als Release (`v1.0.<Run-Nummer>`).

## Installation auf dem Fire TV

Downloader-App öffnen und diese URL eingeben:

```
https://github.com/Oventa-cmd/StreamTV/releases/latest/download/StreamTV.apk
```

Oder per ADB vom PC:

```
curl -L -o StreamTV.apk https://github.com/Oventa-cmd/StreamTV/releases/latest/download/StreamTV.apk
adb connect <IP-des-Fire-TV>:5555
adb install -r StreamTV.apk
```
