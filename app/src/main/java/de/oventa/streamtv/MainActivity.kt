package de.oventa.streamtv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.util.Base64
import android.util.Log
import android.webkit.ConsoleMessage
import org.json.JSONObject

class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var native: NativePlayer
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingConfig: String? = null
    private var pendingDeep: String? = null
    private var pendingBackup: String? = null
    private var pageReady = false

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Video (nativ) liegt hinter der transparenten WebView
        val root = FrameLayout(this)
        root.setBackgroundColor(0xFF000000.toInt())
        web = WebView(this)
        web.setBackgroundColor(0x00000000)
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        native = NativePlayer(this, root) { s -> web.evaluateJavascript(s, null) }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            // Erlaubt Streams, Playlists und APIs ohne CORS-Header (Seite läuft lokal aus den Assets)
            allowUniversalAccessFromFileURLs = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            textZoom = 100
            // Viele IPTV-Server lassen nur bekannte Player zu (Browser-Kennung wird oft blockiert)
            userAgentString = "IPTVSmartersPlayer"
        }
        web.addJavascriptInterface(Bridge(), "StreamTVApp")

        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                deliverConfig()
                deliverDeep()
                deliverBackup()
            }
        }
        takeConfig(intent)
        takeDeep(intent)
        takeBackup(intent)
        // Ordner fuer die Sicherung anlegen (adb push braucht ihn beim Umzug)
        try { getExternalFilesDir(null) } catch (_: Exception) { }
        web.webChromeClient = object : WebChromeClient() {
            // JS-Meldungen und -Fehler im Logcat (Tag StreamTV-JS) – für Fehlersuche per adb logcat
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.i("StreamTV-JS", "${m.messageLevel()} ${m.message()} (${m.sourceId()?.substringAfterLast('/')}:${m.lineNumber()})")
                return true
            }
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                    startActivityForResult(intent, REQ_FILE)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        web.isFocusable = true
        web.requestFocus()

        if (savedInstanceState == null) {
            web.loadUrl("file:///android_asset/index.html")
        } else {
            web.restoreState(savedInstanceState)
        }
    }

    /** Schnittstelle für die Web-Oberfläche (window.StreamTVApp). */
    inner class Bridge {
        @JavascriptInterface
        fun vpnActive(): Boolean = try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }
        } catch (e: Exception) { false }

        @JavascriptInterface
        fun vpnInstalled(): Boolean = launchIntent(PROTON) != null

        @JavascriptInterface
        fun openVpn(): Boolean {
            val i = launchIntent(PROTON) ?: return false
            runOnUiThread { try { startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) { } }
            return true
        }

        /** Gibt es eine andere App, die Videos abspielen kann (z. B. VLC)? */
        @JavascriptInterface
        fun hasExternalPlayer(): Boolean = try {
            packageManager.queryIntentActivities(videoIntent("http://localhost/x.mp4", "", 0.0), 0)
                .any { it.activityInfo.packageName != packageName }
        } catch (e: Exception) { false }

        /** Stream in einer anderen App öffnen (Auswahldialog), Startposition in Millisekunden. */
        @JavascriptInterface
        fun openExternal(url: String, title: String, posMs: Double): Boolean = try {
            val chooser = Intent.createChooser(videoIntent(url, title, posMs), "Abspielen mit")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runOnUiThread { try { startActivity(chooser) } catch (_: Exception) { } }
            true
        } catch (e: Exception) { false }

        // ---------- Nativer Player (Serien & Filme) ----------
        @JavascriptInterface fun nvPlay(url: String, startMs: Double, ua: String) = native.play(url, startMs.toLong(), ua)
        @JavascriptInterface fun nvPause() = native.pause()
        @JavascriptInterface fun nvResume() = native.resume()
        @JavascriptInterface fun nvSeek(ms: Double) = native.seek(ms.toLong())
        @JavascriptInterface fun nvStop() = native.stop()
        @JavascriptInterface fun nvTracks(): String = native.tracksJson
        @JavascriptInterface fun nvSelect(type: String, g: Int, i: Int) = native.select(type, g, i)

        /** Weiterschauen-Liste (JSON-Array) fuer den TV-Launcher speichern. */
        @JavascriptInterface
        fun setContinue(json: String) {
            getSharedPreferences(ContinueProvider.PREFS, Context.MODE_PRIVATE).edit().putString(ContinueProvider.KEY, json).apply()
        }

        /** Sicherung fuer den Umzug auf ein anderes Geraet (per adb pull abholbar). */
        @JavascriptInterface
        fun writeBackup(json: String): Boolean = try {
            val dir = getExternalFilesDir(null) ?: throw IllegalStateException("kein Speicher")
            val tmp = java.io.File(dir, BACKUP_FILE + ".tmp")
            tmp.writeText(json, Charsets.UTF_8)
            tmp.renameTo(java.io.File(dir, BACKUP_FILE))
        } catch (e: Exception) { Log.w("StreamTV", "Sicherung fehlgeschlagen", e); false }

        /** Spracheingabe starten (Google-Spracherkennung des Fernsehers). Ergebnis -> onVoice(text). */
        @JavascriptInterface
        fun listen(): Boolean {
            val i = Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "de-DE")
                putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Was möchtest du schauen?")
                putExtra(android.speech.RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            if (packageManager.resolveActivity(i, 0) == null) return false
            runOnUiThread { try { startActivityForResult(i, REQ_VOICE) } catch (_: Exception) { } }
            return true
        }

        @JavascriptInterface
        fun deviceName(): String = android.os.Build.MODEL ?: "TV"

        @JavascriptInterface
        fun appVersion(): String = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: ""
        } catch (e: Exception) { "" }
    }

    // Zugangsdaten vom Laptop: adb shell am start -n de.oventa.streamtv/.MainActivity --es config <Base64>
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeConfig(intent)
        deliverConfig()
        takeDeep(intent)
        deliverDeep()
        takeBackup(intent)
        deliverBackup()
    }

    // Umzug: adb shell am start -n de.oventa.streamtv/.MainActivity --es backup export|import
    private fun takeBackup(i: Intent?) {
        val b = i?.getStringExtra("backup") ?: return
        i!!.removeExtra("backup")
        if (b == "export" || b == "import") pendingBackup = b
    }

    private fun deliverBackup() {
        val b = pendingBackup ?: return
        if (!pageReady) return
        pendingBackup = null
        if (b == "export") {
            web.evaluateJavascript("window.exportBackup && exportBackup()", null)
            return
        }
        val text = try {
            java.io.File(getExternalFilesDir(null), BACKUP_FILE).readText(Charsets.UTF_8)
        } catch (e: Exception) { null }
        val arg = if (text == null) "''" else JSONObject.quote(text)
        web.evaluateJavascript("window.importBackup && importBackup($arg)", null)
    }

    private fun takeDeep(i: Intent?) {
        val d = i?.data ?: return
        if (d.scheme != "streamtv") return
        pendingDeep = d.toString()
        i.data = null
    }

    private fun deliverDeep() {
        val d = pendingDeep ?: return
        if (!pageReady) return
        pendingDeep = null
        web.evaluateJavascript("window.openDeep && openDeep(" + JSONObject.quote(d) + ")", null)
    }

    private fun takeConfig(i: Intent?) {
        val b64 = i?.getStringExtra("config") ?: return
        i!!.removeExtra("config")
        pendingConfig = try { String(Base64.decode(b64, Base64.DEFAULT), Charsets.UTF_8) } catch (e: Exception) { null }
    }

    private fun deliverConfig() {
        val cfg = pendingConfig ?: return
        if (!pageReady) return
        pendingConfig = null
        web.evaluateJavascript("window.importConfig && importConfig(" + JSONObject.quote(cfg) + ")", null)
    }

    private fun videoIntent(url: String, title: String, posMs: Double): Intent =
        Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(Uri.parse(url), "video/*")
            if (title.isNotEmpty()) putExtra("title", title)
            if (posMs > 0) putExtra("position", posMs.toLong())   // VLC / MX Player: Startposition
            putExtra("headers", arrayOf("User-Agent", "IPTVSmartersPlayer"))
        }

    private fun launchIntent(pkg: String): Intent? =
        packageManager.getLeanbackLaunchIntentForPackage(pkg) ?: packageManager.getLaunchIntentForPackage(pkg)

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_VOICE) {
            val text = data?.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if (resultCode == RESULT_OK && !text.isNullOrBlank())
                web.evaluateJavascript("window.onVoice && onVoice(" + JSONObject.quote(text) + ")", null)
            return
        }
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        } else {
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    // Zurück: offenes Overlay (Player/Details) schließen, sonst zur Startseite, dann App beenden
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) {
            web.goBack()
            return
        }
        web.evaluateJavascript("(function(){try{return handleBack();}catch(e){return false;}})()") { result ->
            if (result != "true") finish()
        }
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        web.evaluateJavascript("window.onAppResume && onAppResume()", null)
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    // Home-Taste o. Ä.: laufenden Stream beenden, damit kein Ton im Hintergrund weiterläuft
    override fun onStop() {
        web.evaluateJavascript("try{ if (playerOpen) closePlayer(); }catch(e){} try{ SYNC.run(false); }catch(e){}", null)
        super.onStop()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        native.release()
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val REQ_FILE = 42
        private const val REQ_VOICE = 43
        private const val PROTON = "ch.protonvpn.android"
        const val BACKUP_FILE = "streamtv-backup.json"
    }
}
