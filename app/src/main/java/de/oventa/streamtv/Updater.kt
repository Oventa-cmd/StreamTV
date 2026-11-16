package de.oventa.streamtv

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * App-Update direkt in der App: APK von GitHub laden und per PackageInstaller installieren.
 * Kann StreamTV selbst und den TV-Launcher (de.oventa.tvlauncher) aktualisieren.
 * Rückmeldungen an die Oberfläche über report(state, info, which):
 *   progress <Prozent> · confirm · done · error <Text>   – which = "app" oder "launcher"
 */
object Updater {
    const val LAUNCHER = "de.oventa.tvlauncher"
    @Volatile private var busy = false
    /** Welche App gerade aktualisiert wird: "app" (StreamTV) oder "launcher". */
    @Volatile var which = "app"
    var report: ((String, String, String) -> Unit)? = null

    /** Installierte Version einer App ("" = nicht installiert). */
    fun versionOf(ctx: Context, pkg: String): String = try {
        ctx.packageManager.getPackageInfo(pkg, 0).versionName ?: ""
    } catch (e: Exception) { "" }

    /** Darf StreamTV Apps installieren? (ab Android 8 einmalig in den Einstellungen erlauben) */
    fun allowed(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 26 || ctx.packageManager.canRequestPackageInstalls()

    /** Einstellungsseite „Unbekannte Apps installieren“ für StreamTV öffnen. */
    fun openPermission(act: Activity): Boolean {
        val tries = mutableListOf<Intent>()
        if (Build.VERSION.SDK_INT >= 26) tries += Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + act.packageName))
        tries += Intent(Settings.ACTION_SECURITY_SETTINGS)
        tries += Intent(Settings.ACTION_SETTINGS)
        for (i in tries) {
            try { act.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return true } catch (_: Exception) { }
        }
        return false
    }

    /** pkg = null → StreamTV selbst, sonst z. B. LAUNCHER. */
    fun start(ctx: Context, url: String, pkg: String? = null): Boolean {
        if (busy) return false
        busy = true
        val app = ctx.applicationContext
        val target = pkg ?: app.packageName
        which = if (target == app.packageName) "app" else "launcher"
        Thread {
            try {
                install(app, url, target)
            } catch (e: Exception) {
                Log.w("StreamTV", "Update fehlgeschlagen", e)
                report?.invoke("error", e.message ?: e.javaClass.simpleName, which)
                busy = false
            }
        }.start()
        return true
    }

    private fun open(url: String): HttpURLConnection {
        var u = URL(url)
        repeat(6) {
            val c = u.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = 15000
            c.readTimeout = 30000
            c.setRequestProperty("User-Agent", "StreamTV-Updater")
            val code = c.responseCode
            if (code in 300..399) {
                val loc = c.getHeaderField("Location") ?: throw IOException("Weiterleitung ohne Ziel")
                c.disconnect()
                u = URL(u, loc)
            } else if (code == 200) {
                return c
            } else {
                c.disconnect()
                throw IOException("Download fehlgeschlagen (HTTP $code)")
            }
        }
        throw IOException("Zu viele Weiterleitungen")
    }

    private fun install(ctx: Context, url: String, target: String) {
        val conn = open(url)
        val total = conn.contentLength.toLong()
        val pi = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(target)
        // Ab Android 12: Updates ohne Bestätigungsdialog, sobald StreamTV als Installer der App eingetragen ist
        // (nach dem ersten Update aus StreamTV heraus). Sonst fragt das System wie gewohnt nach.
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        if (Build.VERSION.SDK_INT >= 26) params.setInstallReason(android.content.pm.PackageManager.INSTALL_REASON_USER)
        val id = pi.createSession(params)
        val session = pi.openSession(id)
        try {
            session.openWrite(if (which == "app") "StreamTV.apk" else "TV-Launcher.apk", 0, if (total > 0) total else -1).use { out ->
                conn.inputStream.use { inp ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var last = -1
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val pct = if (total > 0) (done * 100 / total).toInt() else -1
                        if (pct != last) { last = pct; report?.invoke("progress", pct.toString(), which) }
                    }
                }
                session.fsync(out)
            }
            conn.disconnect()
            val intent = Intent(ctx, InstallReceiver::class.java)
            var flags = PendingIntent.FLAG_UPDATE_CURRENT
            if (Build.VERSION.SDK_INT >= 31) flags = flags or PendingIntent.FLAG_MUTABLE
            val pending = PendingIntent.getBroadcast(ctx, id, intent, flags)
            session.commit(pending.intentSender)
        } catch (e: Exception) {
            session.abandon()
            throw e
        } finally {
            session.close()
        }
    }

    fun finished(state: String, info: String) {
        if (state != "confirm") busy = false
        report?.invoke(state, info, which)
    }
}

/** Ergebnis des Systeminstallers (Bestätigungsdialog, Erfolg, Fehler). */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, i: Intent) {
        when (i.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = i.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) {
                    try { ctx.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { }
                }
                Updater.finished("confirm", "")
            }
            PackageInstaller.STATUS_SUCCESS -> Updater.finished("done", "")
            PackageInstaller.STATUS_FAILURE_ABORTED -> Updater.finished("error", "Installation abgebrochen")
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                Updater.finished("error", "Signatur passt nicht zur installierten App – einmalig per ADB neu installieren (" + (i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "") + ")")
            PackageInstaller.STATUS_FAILURE_STORAGE -> Updater.finished("error", "Zu wenig Speicher auf dem Fernseher")
            PackageInstaller.STATUS_FAILURE_BLOCKED -> Updater.finished("error", "Installation vom System blockiert (unbekannte Apps erlauben?)")
            else -> Updater.finished("error", i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Installation fehlgeschlagen")
        }
    }
}
