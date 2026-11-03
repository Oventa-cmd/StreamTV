package de.oventa.streamtv

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Binder
import org.json.JSONArray

/**
 * Stellt die "Weiterschauen"-Liste fuer den TV-Launcher bereit (nur lesen).
 * content://de.oventa.streamtv.continue/items
 * Die Daten schreibt die Web-Oberflaeche ueber StreamTVApp.setContinue() in die SharedPreferences.
 */
class ContinueProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
        val ctx = context ?: return null
        // Nur der eigene TV-Launcher (und StreamTV selbst) duerfen lesen
        val caller = ctx.packageManager.getPackagesForUid(Binder.getCallingUid())?.toSet() ?: emptySet()
        if (caller.none { it in ALLOWED }) throw SecurityException("Kein Zugriff")
        val c = MatrixCursor(COLUMNS)
        val arr = try { JSONArray(ctx.getSharedPreferences(PREFS, 0).getString(KEY, "[]")) } catch (e: Exception) { JSONArray() }
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            c.addRow(arrayOf<Any?>(
                o.optString("id"), o.optString("show"), o.optInt("season"), o.optInt("episode"), o.optString("title"),
                o.optString("image"), o.optLong("pos"), o.optLong("dur"), o.optLong("updated"), o.optString("tmdb"),
                if (o.optBoolean("movie")) 1 else 0, o.optString("uri")
            ))
        }
        return c
    }

    override fun getType(uri: Uri): String = "vnd.android.cursor.dir/vnd.de.oventa.streamtv.continue"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    companion object {
        const val PREFS = "continue"
        const val KEY = "items"
        private val ALLOWED = setOf("de.oventa.tvlauncher", "de.oventa.streamtv")
        val COLUMNS = arrayOf("id", "show", "season", "episode", "title", "image", "pos", "dur", "updated", "tmdb", "movie", "uri")
    }
}
