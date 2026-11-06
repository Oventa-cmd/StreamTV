package de.oventa.streamtv

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.SurfaceView
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

/**
 * Nativer Player (Media3/ExoPlayer) fuer Serien und Filme.
 * Das Video laeuft in einer SurfaceView HINTER der (transparenten) WebView – die Oberflaeche
 * (OSD, Menues, Intro ueberspringen …) bleibt komplett in HTML. Kann Dolby-Ton (AC3/E-AC3),
 * MKV, mehrere Tonspuren und eingebettete Untertitel; fehlt ein Geraete-Decoder, springt FFmpeg ein.
 * Alle Ereignisse gehen als NV.ev(...) an die Web-Oberflaeche.
 */
@OptIn(UnstableApi::class)
class NativePlayer(private val act: Activity, private val root: FrameLayout, private val js: (String) -> Unit) {
    private val ui = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null
    private var surface: SurfaceView? = null
    private var lastTracks: Tracks? = null
    private var metaSent = false
    private var vw = 0
    private var vh = 0
    @Volatile var tracksJson: String = "[]"
    // Live-TV: gespielte Zeit (monoton), damit die Oberflaeche Haenger erkennt
    private var live = false
    private var liveBase = 0L
    private var playingSince = -1L
    private var liveRetries = 0

    private val tick = object : Runnable {
        override fun run() { emit("timeupdate"); ui.postDelayed(this, 500) }
    }

    init {
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> layoutSurface() }
    }

    fun play(url: String, startMs: Long, ua: String) { ui.post { start(url, startMs, ua, false, 0) } }
    /** Live-TV mit grossem Puffer. buf: 1 normal · 2 gross · 3 sehr gross */
    fun playLive(url: String, ua: String, buf: Int) { ui.post { start(url, 0, ua, true, buf) } }
    fun pause() { ui.post { player?.playWhenReady = false; emit("pause") } }
    fun resume() { ui.post { player?.playWhenReady = true } }
    fun seek(ms: Long) { ui.post { player?.seekTo(ms.coerceAtLeast(0)) } }
    fun stop() { ui.post { release() } }

    /** Spur waehlen: type "audio"/"text", g = Gruppe, i = Spur; i < 0 schaltet Untertitel aus. */
    fun select(type: String, g: Int, i: Int) {
        ui.post {
            val p = player ?: return@post
            val tt = if (type == "audio") C.TRACK_TYPE_AUDIO else C.TRACK_TYPE_TEXT
            val b = p.trackSelectionParameters.buildUpon()
            if (i < 0) b.setTrackTypeDisabled(tt, true)
            else {
                val grp = lastTracks?.groups?.getOrNull(g) ?: return@post
                b.setTrackTypeDisabled(tt, false).setOverrideForType(TrackSelectionOverride(grp.mediaTrackGroup, i))
            }
            p.trackSelectionParameters = b.build()
        }
    }

    private fun start(url: String, startMs: Long, ua: String, isLive: Boolean, buf: Int) {
        release()
        live = isLive; liveBase = 0L; playingSince = -1L; liveRetries = 0
        val sv = SurfaceView(act)
        root.addView(sv, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER))
        surface = sv
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(ua)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(if (isLive) 20000 else 30000)
        // MPEG-TS von IPTV-Servern: Zugriffseinheiten erkennen, auch ohne saubere IDR-Frames starten
        val extractors = DefaultExtractorsFactory().setTsExtractorFlags(
            DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS or DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES)
        // Geraete-Decoder zuerst, FFmpeg (AC3, E-AC3, DTS, TrueHD …) als Rueckfall
        val rf = DefaultRenderersFactory(act)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
            .setEnableDecoderFallback(true)
        val b = ExoPlayer.Builder(act, rf).setMediaSourceFactory(DefaultMediaSourceFactory(http, extractors))
        if (isLive) {
            // Puffer: min / max / bis Start / nach Haenger (ms)
            val (mn, mx, st, re) = when (buf) {
                1 -> listOf(15000, 30000, 2500, 5000)
                3 -> listOf(50000, 120000, 5000, 12000)
                else -> listOf(30000, 60000, 3000, 8000)
            }
            b.setLoadControl(DefaultLoadControl.Builder()
                .setBufferDurationsMs(mn, mx, st, re)
                .setPrioritizeTimeOverSizeThresholds(true)
                .build())
        }
        val p = b.build()
        p.setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
        p.setVideoSurfaceView(sv)
        // Springen zum naechsten Schluesselbild: viel schneller ueber das Netz (wie bei Netflix)
        p.setSeekParameters(SeekParameters.CLOSEST_SYNC)
        p.addListener(listener)
        p.setMediaItem(mediaItem(url, isLive, buf), if (isLive) C.TIME_UNSET else startMs.coerceAtLeast(0))
        p.prepare()
        p.playWhenReady = true
        player = p
        metaSent = false
        vw = 0; vh = 0
        ui.removeCallbacks(tick)
        ui.postDelayed(tick, 500)
    }

    private fun mediaItem(url: String, isLive: Boolean, buf: Int): MediaItem {
        val m = MediaItem.Builder().setUri(url)
        if (isLive) {
            // Weiter hinter der Live-Kante bleiben = mehr Vorrat; keine Tempo-Anpassung (kein „Leiern“)
            m.setLiveConfiguration(MediaItem.LiveConfiguration.Builder()
                .setTargetOffsetMs(when (buf) { 1 -> 12000L; 3 -> 40000L; else -> 24000L })
                .setMinPlaybackSpeed(1f).setMaxPlaybackSpeed(1f)
                .build())
        }
        return m.build()
    }

    private fun livePos(): Long =
        liveBase + if (playingSince >= 0) SystemClock.elapsedRealtime() - playingSince else 0L

    fun release() {
        ui.removeCallbacks(tick)
        player?.let { it.removeListener(listener); it.release() }
        player = null
        lastTracks = null
        tracksJson = "[]"
        surface?.let { root.removeView(it) }
        surface = null
    }

    private fun emit(type: String, msg: String = "") {
        val p = player ?: return
        val dur = if (live || p.duration == C.TIME_UNSET) -1 else p.duration
        val pos = if (live) livePos() else p.currentPosition
        js("window.NV&&NV.ev(${JSONObject.quote(type)},$pos,$dur,${!p.playWhenReady},${JSONObject.quote(msg)})")
    }

    private fun layoutSurface() {
        val s = surface ?: return
        val w0 = root.width; val h0 = root.height
        if (vw <= 0 || vh <= 0 || w0 <= 0 || h0 <= 0) return
        val r = vw.toFloat() / vh
        var w = w0; var h = (w0 / r).toInt()
        if (h > h0) { h = h0; w = (h0 * r).toInt() }
        val lp = s.layoutParams as FrameLayout.LayoutParams
        if (lp.width == w && lp.height == h) return
        s.layoutParams = FrameLayout.LayoutParams(w, h, Gravity.CENTER)
    }

    private fun tracksToJson(t: Tracks): String {
        val arr = JSONArray()
        t.groups.forEachIndexed { g, grp ->
            val type = when (grp.type) { C.TRACK_TYPE_AUDIO -> "audio"; C.TRACK_TYPE_TEXT -> "text"; else -> null } ?: return@forEachIndexed
            for (i in 0 until grp.length) {
                val f = grp.getTrackFormat(i)
                arr.put(JSONObject()
                    .put("type", type).put("g", g).put("i", i)
                    .put("label", f.label ?: "").put("lang", f.language ?: "")
                    .put("sel", grp.isTrackSelected(i)).put("ok", grp.isTrackSupported(i))
                    .put("ch", f.channelCount).put("mime", f.sampleMimeType ?: ""))
            }
        }
        return arr.toString()
    }

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            when (state) {
                Player.STATE_BUFFERING -> emit("waiting")
                Player.STATE_READY -> { liveRetries = 0; if (!metaSent) { metaSent = true; emit("loadedmetadata") } }
                Player.STATE_ENDED -> emit("ended")
                else -> {}
            }
        }
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) { if (playingSince < 0) playingSince = SystemClock.elapsedRealtime() }
            else if (playingSince >= 0) { liveBase += SystemClock.elapsedRealtime() - playingSince; playingSince = -1L }
            // „pause“ nur bei echter Pause – Puffern meldet STATE_BUFFERING
            if (isPlaying) emit("playing") else if (player?.playWhenReady == false) emit("pause")
        }
        override fun onPlayerError(error: PlaybackException) {
            val p = player
            // Live: hinter das Zeitfenster gefallen bzw. kurzer Netzaussetzer → still an der Live-Kante weitermachen
            if (live && p != null && liveRetries < 3 && (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW ||
                        error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
                        error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT)) {
                liveRetries++
                if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) p.seekToDefaultPosition()
                p.prepare()
                return
            }
            emit("error", error.errorCodeName + " " + (error.message ?: ""))
        }
        override fun onTracksChanged(tracks: Tracks) { lastTracks = tracks; tracksJson = tracksToJson(tracks); emit("tracks") }
        override fun onVideoSizeChanged(videoSize: VideoSize) {
            vw = (videoSize.width * videoSize.pixelWidthHeightRatio).toInt(); vh = videoSize.height
            layoutSurface()
        }
        override fun onCues(cueGroup: CueGroup) {
            val t = cueGroup.cues.mapNotNull { it.text?.toString() }.joinToString("\n")
            js("window.NV&&NV.cue(${JSONObject.quote(t)})")
        }
    }
}
