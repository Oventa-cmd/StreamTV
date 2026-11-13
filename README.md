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
- **App-Update:** prüft höchstens alle 12 h die neueste GitHub-Version; unter „Einstellungen → App-Update“ lässt sie sich direkt in der App laden und installieren (einmalig „Unbekannte Apps installieren“ erlauben), alternativ per ADB

## Web-Version (iPad, Laptop)

Dieselbe Oberfläche läuft als Web-App unter **https://oventa-cmd.github.io/StreamTV/** (jeder Push auf `main` aktualisiert sie, Workflow `pages.yml`).

1. Seite öffnen (iPad: Safari → Teilen → **„Zum Home-Bildschirm“**, dann startet sie wie eine App im Vollbild)
2. Einstellungen → Serien-Empfehlungen: mit dem **Watchlist-Konto** anmelden
3. Einstellungen → Quelle hinzufügen: Xtream-Zugang eintragen (bleibt nur auf diesem Gerät)

Danach kommen Weiterschauen-Fortschritt (Folge + Sekunde), Favoriten, Zuletzt gesehen und Einstellungen automatisch per Cloud-Sync vom Fernseher – und umgekehrt.

**Technik:** Xtream-API, EPG und M3U-Listen laufen über die Supabase-Funktion `xtream-proxy` (Quelltext in `supabase/functions/xtream-proxy`), weil Browser sie sonst blockieren (CORS, IPTV-Kennung). Nur angemeldete Watchlist-Konten dürfen sie nutzen; Videos laufen **nicht** darüber, sondern direkt vom Anbieter. Safari spielt HLS mit dem eingebauten Player; Live-Sender werden im Browser automatisch als `.m3u8` abgerufen.

**Grenzen im Browser:** MKV/AVI-Folgen spielt Safari nicht ab (MP4/HLS schon). Kein Systemplayer, keine VPN-Steuerung, kein App-Update. Sperrt der Anbieter Browser-Wiedergabe, hilft nur die TV-App.

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

## Umzug auf einen neuen Fernseher (z. B. Google TV / TCL)

`tools/Umzug-auf-neuen-TV.bat` doppelklicken. Das Skript
1. sichert die StreamTV-Daten vom Fire TV (Quellen, Kanäle, Favoriten, Einstellungen, **Weiterschauen-Fortschritt**, Intro-Marken, Watchlist-Konto) nach `streamtv-backup-<Datum>.json`,
2. lädt die neuesten APKs von StreamTV und TV-Launcher,
3. installiert beide auf dem neuen TV und richtet Home-Dienst und Rechte des Launchers ein,
4. spielt die Sicherung ein (Fortschritt wird zusammengeführt, neuerer Stand gewinnt).

Manuell:
```
adb shell am start -n de.oventa.streamtv/.MainActivity --es backup export
adb pull /sdcard/Android/data/de.oventa.streamtv/files/streamtv-backup.json
adb push streamtv-backup.json /sdcard/Android/data/de.oventa.streamtv/files/
adb shell am start -n de.oventa.streamtv/.MainActivity --es backup import
```

## Cloud-Sync über das Watchlist-Konto

Mit angemeldetem Watchlist-Konto gleicht StreamTV automatisch ab (Tabelle `streamtv_sync`, nur für das eigene Konto lesbar): Weiterschauen-Fortschritt, Favoriten, Zuletzt gesehen, Einstellungen (außer „Effekte reduzieren“, VPN- und Player-Einstellungen), gelernte Intro-Marken, Tonspur-Wahl und Sport-Erinnerungen.
**Nicht** synchronisiert werden IPTV-Zugänge und Kanallisten. Server, Benutzer und Passwort in Stream-Adressen werden vor dem Hochladen durch Platzhalter ersetzt und auf dem anderen Gerät mit dessen eigenem Zugang wieder eingesetzt.
Abgleich beim Start, beim Zurückkehren in die App, nach Änderungen (20 s verzögert) und beim Verlassen der App.

## Claude-Suche & Spracheingabe

In der Suche: **🎤 Sprechen** (Google-Spracherkennung des TVs) oder **✨ Claude** (getippter Text). Claude versteht freie Anfragen („was Düsteres wie Dark“, „Bundesliga live“) und liefert Titel, die StreamTV im Katalog deines Anbieters sucht.
Läuft über die Supabase-Funktion `smart-search` (Quelltext in `supabase/functions/smart-search`). Der Anthropic-Schlüssel liegt nur als Secret `ANTHROPIC_API_KEY` im Supabase-Projekt. Optional `CLAUDE_MODEL` (Standard `claude-haiku-5-5`).
Deep Link: `streamtv://search?q=<Text>&ai=1` bzw. `streamtv://search?voice=1`.
