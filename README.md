# StreamTV

IPTV-Player für Fire TV / Android TV im Apple-Stil (WebView-App, Oberfläche liegt lokal in `app/src/main/assets`). Komplett per Fernbedienung bedienbar.

## Funktionen

**Live-TV**
- M3U-Playlists und Xtream-Codes-Zugänge, Kategorien, Suche, Favoriten
- HLS (hls.js) und MPEG-TS (mpegts.js) gebündelt, automatischer Wechsel bei Problemen
- **EPG:** laufende Sendung auf jeder Senderkachel; im Player „Jetzt / Danach“ mit Uhrzeit und Fortschritt (Xtream `get_short_epg`, gecacht)
- **Senderliste im Player:** ◀ öffnet die Sender der aktuellen Kategorie samt EPG; ▲▼ wählen, OK umschalten
- **Auto-Reconnect:** bricht ein Stream ab oder hängt, verbindet die App still neu (1–30 s Pause, max. 6 Versuche); Serien/Filme laufen an derselben Stelle weiter
- **Kategorien ausblenden:** Einstellungen → Inhalte; Schnellauswahl nach Sprache/Land (z. B. alle „AR |“-Kategorien), wirkt auf Live-TV, Serien, Filme und Suche

**Serien & Filme vom Anbieter**
- **Reiter:** Start · Live-TV · Serien · Filme · Sport · Suche · Einstellungen; jeder Inhalt hat genau einen Platz, ◀ ▶ in der Leiste wechselt den Reiter sofort
- **Reiter „Serien“ / „Filme“:** oben TMDB-Empfehlungen (nur Titel, die dein Anbieter hat), darunter der komplette Xtream-Katalog (Serien bzw. VOD) mit Covern und Kategorie-Chips; auch große Kataloge (20.000+) laufen flüssig
- **Suche:** eine Suche für Sender, Serien und Filme des Anbieters
- **Weiterschauen:** angefangene Folgen und Filme ganz oben auf der Startseite, OK setzt direkt fort (≡ entfernt einen Eintrag)
- **Intro, Rückblick, Abspann überspringen:** exakte Zeiten aus [TheIntroDB](https://theintrodb.org); fehlt ein Eintrag, lernt die App pro Serie aus dem eigenen Spulverhalten; sonst Faustregel. Im Abspann „Nächste Folge ▶“
- **Tonspur & Untertitel:** ≡ im Player (HLS); für MKV/MP4 „In anderem Player öffnen“ (z. B. VLC) mit aktueller Position

**Sport**
- **Reiter „Sport“:** kommende Live-Events – Bundesliga, 2. und 3. Liga, DFB-Pokal, Champions League, WM/EM (OpenLigaDB, TheSportsDB) sowie Formel 1 (Jolpica), MotoGP und DTM; Reihen „Jetzt live“, „Heute“, „Morgen“ …, Chips zum Filtern
- Detailansicht mit passenden Sendern aus der eigenen Liste (Sendername + EPG), OK startet die Wiedergabe
- **Vormerken** (≡ oder Button): 5 Min. vor Beginn erscheint ein Hinweis, OK schaltet direkt um

**Bildschirmschoner**
- Nach 2/5/10 Min. ohne Eingabe (nicht während der Wiedergabe) wechselnde Serien-Plakate in groß mit Uhr; jede Taste beendet ihn

**Empfehlungen & Watchlist**
- Serien- und Film-Empfehlungen (TMDB), persönlich mit dem Serien-Watchlist-Konto
- **Watchlist-Sync:** ab 90 % gesehen wird die Folge im Watchlist-Konto eingetragen (Status „watching“, nach der letzten Folge „done“); offline wird nachgetragen

**Sonstiges**
- ProtonVPN-Anbindung (Autostart, „nur mit VPN abspielen“)
- **Update-Hinweis:** prüft höchstens alle 12 h die neueste GitHub-Version und zeigt den ADB-Befehl unter „Einstellungen → App-Update“

## Watchlist-Konto vom PC übertragen

`tools/Watchlist-Anmelden.bat` doppelklicken (ADB nötig): fragt IP, E-Mail und Passwort ab und meldet StreamTV **und** den TV-Launcher an. Das Passwort wird auf dem Fire TV nicht gespeichert, nur die Sitzung.

## Verbindung zum TV-Launcher

- Deep Links: `streamtv://resume/<Folge>`, `streamtv://title/tv/<TMDB-ID>?play=1[&s=2&e=5]`, `streamtv://title/movie/<ID>?play=1`, `streamtv://sport`
- „Weiterschauen“ für den Launcher: ContentProvider `content://de.oventa.streamtv.continue/items` (nur lesen, nur für `de.oventa.tvlauncher`)

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
