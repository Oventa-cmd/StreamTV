# Umzug vom Fire TV auf einen neuen Fernseher (Google TV / Android TV, z. B. TCL)
#  1. StreamTV-Daten vom Fire TV sichern (Quellen, Kanäle, Favoriten, Einstellungen, Weiterschauen-Fortschritt)
#  2. Neueste StreamTV- und TV-Launcher-APK von GitHub laden
#  3. Beide Apps auf dem neuen TV installieren, Home-Dienst und Rechte einrichten
#  4. Sicherung auf dem neuen TV einspielen
$ErrorActionPreference = 'Continue'
$PKG = 'de.oventa.streamtv'
$LPKG = 'de.oventa.tvlauncher'
$REMOTE = "/sdcard/Android/data/$PKG/files/streamtv-backup.json"
$dir = $PSScriptRoot

function Pause-Exit($code) { Read-Host 'Enter zum Schließen' | Out-Null; exit $code }
function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }

Write-Host ''
Write-Host '  Umzug: Fire TV  ->  neuer Fernseher (Google TV)' -ForegroundColor Cyan
Write-Host ''

$adb = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $adb -and (Test-Path "$dir\adb.exe")) { $adb = "$dir\adb.exe" }
if (-not $adb -and (Test-Path "$dir\platform-tools\adb.exe")) { $adb = "$dir\platform-tools\adb.exe" }
if (-not $adb) { Write-Host 'ADB nicht gefunden (Platform-Tools installieren oder adb.exe hier ablegen).' -ForegroundColor Red; Pause-Exit 1 }

function Connect($ip) {
  $s = "$($ip):5555"
  & $adb connect $s | Out-Host
  for ($i = 0; $i -lt 30; $i++) {
    $st = (& $adb -s $s get-state 2>$null)
    if ($st -match 'device') { return $s }
    if ($i -eq 0) { Write-Host '  Falls am Fernseher „USB-Debugging zulassen?“ erscheint: „Immer zulassen“ + OK.' -ForegroundColor Yellow }
    Start-Sleep -Seconds 2
    & $adb connect $s | Out-Null
  }
  Write-Host "  Keine Verbindung zu $s." -ForegroundColor Red
  return $null
}

# ---------------- 1. Sicherung vom Fire TV ----------------
$backup = $null
$old = Read-Host 'IP des Fire TV (leer = Sicherung überspringen / vorhandene Datei nutzen)'
if ($old) {
  Step 'Sicherung vom Fire TV'
  $f = Connect $old
  if ($f) {
    & $adb -s $f shell rm -f $REMOTE 2>$null | Out-Null
    & $adb -s $f shell am start -n "$PKG/.MainActivity" --es backup export | Out-Null
    $ok = $false
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 1
      $ls = (& $adb -s $f shell ls $REMOTE 2>$null)
      if ($ls -match 'streamtv-backup') { $ok = $true; break }
    }
    if ($ok) {
      $backup = Join-Path $dir ("streamtv-backup-" + (Get-Date -Format 'yyyy-MM-dd_HHmm') + ".json")
      & $adb -s $f pull $REMOTE $backup | Out-Host
      Write-Host "  Gesichert: $backup" -ForegroundColor Green
      & $adb disconnect $f | Out-Null   # danach ist nur noch der neue TV verbunden
    } else {
      Write-Host '  Keine Sicherung erhalten. Ist StreamTV auf dem Fire TV aktuell (Version mit Umzug-Funktion)?' -ForegroundColor Red
      Write-Host '  -> Erst StreamTV auf dem Fire TV updaten (StreamTV-installieren.bat), dann dieses Skript erneut starten.'
    }
  }
}
if (-not $backup) {
  $last = Get-ChildItem $dir -Filter 'streamtv-backup-*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($last) { $backup = $last.FullName; Write-Host "  Nutze vorhandene Sicherung: $($last.Name)" }
}

# ---------------- 2. APKs laden ----------------
Step 'Neueste Versionen von GitHub laden'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Get-Apk($repo, $out) {
  try {
    $rel = Invoke-RestMethod "https://api.github.com/repos/Oventa-cmd/$repo/releases/latest" -Headers @{ 'User-Agent' = 'StreamTV-Umzug' }
    $asset = $rel.assets | Where-Object { $_.name -like '*.apk' } | Select-Object -First 1
    Invoke-WebRequest $asset.browser_download_url -OutFile $out -UseBasicParsing
    Write-Host "  $repo $($rel.tag_name) geladen" -ForegroundColor Green
    return $true
  } catch { Write-Host "  $repo konnte nicht geladen werden: $($_.Exception.Message)" -ForegroundColor Red; return (Test-Path $out) }
}
$st = Join-Path $dir 'StreamTV.apk'
$la = Join-Path $dir 'TV-Launcher.apk'
$okS = Get-Apk 'StreamTV' $st
$okL = Get-Apk 'TV-Launcher' $la

# ---------------- 3. Neuer TV ----------------
Write-Host ''
Write-Host 'Am neuen TV vorher: Einstellungen > System > Info > 7x auf „Android TV-Betriebssystem-Build“ drücken,' -ForegroundColor Yellow
Write-Host 'dann Einstellungen > System > Entwickleroptionen > „USB-Debugging“ einschalten.' -ForegroundColor Yellow
Write-Host 'Die IP steht unter Einstellungen > Netzwerk & Internet > (dein WLAN/LAN).' -ForegroundColor Yellow
$new = Read-Host 'IP des neuen Fernsehers'
if (-not $new) { Pause-Exit 1 }
Step 'Verbinden mit dem neuen Fernseher'
$t = Connect $new
if (-not $t) { Pause-Exit 1 }

Step 'Apps installieren'
if ($okS) { & $adb -s $t install -r $st | Out-Host }
if ($okL) { & $adb -s $t install -r $la | Out-Host }

Step 'TV-Launcher einrichten (Home-Taste, Bildschirmschoner-Zeiten)'
& $adb -s $t shell settings put secure enabled_accessibility_services "$LPKG/$LPKG.HomeRedirectService" | Out-Host
& $adb -s $t shell settings put secure accessibility_enabled 1 | Out-Host
& $adb -s $t shell pm grant $LPKG android.permission.READ_LOGS 2>&1 | Out-Host
& $adb -s $t shell pm grant $LPKG android.permission.WRITE_SECURE_SETTINGS 2>&1 | Out-Host
& $adb -s $t shell appops set $LPKG WRITE_SETTINGS allow 2>&1 | Out-Host

# ---------------- 4. Sicherung einspielen ----------------
if ($backup -and (Test-Path $backup)) {
  Step 'StreamTV-Daten einspielen'
  & $adb -s $t shell am start -n "$PKG/.MainActivity" | Out-Null
  Start-Sleep -Seconds 6     # erster Start legt den Datenordner an
  & $adb -s $t shell mkdir -p "/sdcard/Android/data/$PKG/files" 2>$null | Out-Null
  & $adb -s $t push $backup $REMOTE | Out-Host
  & $adb -s $t shell am start -n "$PKG/.MainActivity" --es backup import | Out-Null
  Write-Host '  Am TV erscheint „Daten übernommen – StreamTV startet neu …“.' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host 'Keine Sicherung vorhanden – StreamTV startet leer. Zugangsdaten dann mit Zugang-uebertragen.bat.' -ForegroundColor Yellow
}

# ---------------- Google-TV-Startseite abschalten (in den Launcher-Einstellungen wieder einschaltbar) ----------------
Step 'Google-TV-Startseite abschalten – Home öffnet immer den TV-Launcher'
& $adb -s $t shell pm disable-user --user 0 com.google.android.apps.tv.launcherx 2>&1 | Out-Host
& $adb -s $t shell pm disable-user --user 0 com.google.android.tungsten.setupwraith 2>&1 | Out-Host
& $adb -s $t shell am start -n "$LPKG/.MainActivity" | Out-Null
Write-Host '  Wieder einschalten: Launcher > Einstellungen > System > „Google-TV-Startseite erreichbar“.' -ForegroundColor Yellow
Write-Host "  Notfall vom PC: adb -s $t shell pm enable com.google.android.apps.tv.launcherx"

Write-Host ''
Write-Host 'Fertig. Danach noch Watchlist-Anmelden.bat (Konto für den Launcher) ausführen.' -ForegroundColor Green
Pause-Exit 0
