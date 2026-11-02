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

class MainActivity : Activity() {

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this)
        web.setBackgroundColor(0xFF000000.toInt())
        setContentView(web)

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

        web.webViewClient = WebViewClient()
        web.webChromeClient = object : WebChromeClient() {
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

        @JavascriptInterface
        fun appVersion(): String = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: ""
        } catch (e: Exception) { "" }
    }

    private fun launchIntent(pkg: String): Intent? =
        packageManager.getLeanbackLaunchIntentForPackage(pkg) ?: packageManager.getLaunchIntentForPackage(pkg)

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
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
        web.evaluateJavascript("try{ if (playerOpen) closePlayer(); }catch(e){}", null)
        super.onStop()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val REQ_FILE = 42
        private const val PROTON = "ch.protonvpn.android"
    }
}
