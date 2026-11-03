# StreamTV + TV-Launcher: Watchlist-Konto vom PC auf den Fire TV übertragen
# Das Passwort wird nur zur Anmeldung übergeben und auf dem Fire TV nicht gespeichert.
$ErrorActionPreference = 'Continue'
Write-Host ''
Write-Host '  Watchlist-Konto an StreamTV und TV-Launcher übertragen' -ForegroundColor Cyan
Write-Host ''
$adb = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $adb -and (Test-Path "$PSScriptRoot\adb.exe")) { $adb = "$PSScriptRoot\adb.exe" }
if (-not $adb) {
  Write-Host 'ADB wurde nicht gefunden. Bitte die Android Platform-Tools installieren oder adb.exe in diesen Ordner legen.' -ForegroundColor Red
  Read-Host 'Enter zum Schließen' | Out-Null; exit 1
}
$ip = Read-Host 'IP-Adresse des Fire TV (leer lassen, wenn schon verbunden)'
$mail = Read-Host 'E-Mail (Serien-Watchlist)'
$sec = Read-Host 'Passwort' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
$pass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if (-not $mail -or -not $pass) { Write-Host 'E-Mail und Passwort werden benötigt.' -ForegroundColor Red; Read-Host 'Enter zum Schließen' | Out-Null; exit 1 }
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("WATCHLIST_EMAIL=$mail`nWATCHLIST_PASSWORT=$pass"))
$pass = $null
if ($ip) { & $adb connect "$($ip):5555" | Out-Host; Start-Sleep -Seconds 1 }
Write-Host 'StreamTV …'
& $adb shell am start -n de.oventa.streamtv/.MainActivity --es config $b64 | Out-Host
Start-Sleep -Seconds 5
Write-Host 'TV-Launcher …'
& $adb shell am start -n de.oventa.tvlauncher/.MainActivity --es config $b64 | Out-Host
$b64 = $null
Write-Host ''
Write-Host 'Fertig. Auf dem Fernseher erscheint jeweils eine Bestätigung („Watchlist angemeldet“).' -ForegroundColor Green
Read-Host 'Enter zum Schließen' | Out-Null
