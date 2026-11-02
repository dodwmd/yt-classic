package io.github.dodwmd.ytclassic.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.github.dodwmd.ytclassic.player.clampSpeed
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "settings")
private val SERVER_URL = stringPreferencesKey("server_url")
private val ACCESS_TOKEN = stringPreferencesKey("access_token")
private val PLAYBACK_SPEED = floatPreferencesKey("playback_speed")
private val BACKGROUND_AUDIO = booleanPreferencesKey("background_audio")
private val PICTURE_IN_PICTURE = booleanPreferencesKey("picture_in_picture")
private val QUALITY_PREF = intPreferencesKey("quality_pref")
private val CAPTIONS_ON = booleanPreferencesKey("captions_on")
private val CAPTIONS_LANG = stringPreferencesKey("captions_lang")
private val AUTO_UPDATE_CHECK = booleanPreferencesKey("auto_update_check")
private val LAST_UPDATE_CHECK = longPreferencesKey("last_update_check")

/** Persists the backend address, e.g. "192.168.1.153:8080" (home Wi-Fi) or a VPN host name, and playback options. */
class SettingsStore(private val context: Context) {
    val serverUrl: Flow<String> = context.dataStore.data.map { it[SERVER_URL] ?: "" }

    suspend fun setServerUrl(url: String) {
        context.dataStore.edit { it[SERVER_URL] = url.trim() }
    }

    /**
     * Optional shared access token for the backend. Stored in the app's private DataStore like the rest (not
     * encrypted: Android's per-app storage isolation is the protection, and the token only guards a self-hosted
     * server). Never logged and never shown after it is saved.
     */
    val accessToken: Flow<String> = context.dataStore.data.map { it[ACCESS_TOKEN] ?: "" }

    /** Saves the address and the token in one edit, so a reader never sees the new address with the old token. */
    suspend fun saveConnection(url: String, token: String) {
        context.dataStore.edit {
            it[SERVER_URL] = url.trim()
            if (token.isBlank()) it.remove(ACCESS_TOKEN) else it[ACCESS_TOKEN] = token.trim()
        }
    }

    /** Keep playing (with a notification) when the app is in the background or the screen is off. On by default. */
    val backgroundAudio: Flow<Boolean> = context.dataStore.data.map { it[BACKGROUND_AUDIO] ?: true }

    suspend fun setBackgroundAudio(on: Boolean) {
        context.dataStore.edit { it[BACKGROUND_AUDIO] = on }
    }

    /** Shrink a playing video into a small window when leaving the app, and offer the button. On by default. */
    val pictureInPicture: Flow<Boolean> = context.dataStore.data.map { it[PICTURE_IN_PICTURE] ?: true }

    suspend fun setPictureInPicture(on: Boolean) {
        context.dataStore.edit { it[PICTURE_IN_PICTURE] = on }
    }

    /** The playback speed chosen in the player: one global default (no per-video memory), kept across videos and TV. */
    val playbackSpeed: Flow<Float> = context.dataStore.data.map { clampSpeed(it[PLAYBACK_SPEED]) }

    suspend fun setPlaybackSpeed(speed: Float) {
        context.dataStore.edit { it[PLAYBACK_SPEED] = clampSpeed(speed) }
    }

    /** The quality last chosen in the player (0 = Auto), the default for new videos; null until the user picks one. */
    val qualityPref: Flow<Int?> = context.dataStore.data.map { it[QUALITY_PREF] }

    suspend fun setQualityPref(q: Int) {
        context.dataStore.edit { it[QUALITY_PREF] = q }
    }

    /** Subtitles on or off (off by default) and the last language chosen: one global choice, like the speed. */
    val captionsOn: Flow<Boolean> = context.dataStore.data.map { it[CAPTIONS_ON] ?: false }
    val captionsLang: Flow<String> = context.dataStore.data.map { it[CAPTIONS_LANG] ?: "" }

    suspend fun setCaptions(on: Boolean, lang: String) {
        context.dataStore.edit {
            it[CAPTIONS_ON] = on
            if (lang.isNotEmpty()) it[CAPTIONS_LANG] = lang
        }
    }

    /** Check GitHub for a new release once a week when the app starts. Off by default: the check contacts GitHub. */
    val autoUpdateCheck: Flow<Boolean> = context.dataStore.data.map { it[AUTO_UPDATE_CHECK] ?: false }

    suspend fun setAutoUpdateCheck(on: Boolean) {
        context.dataStore.edit { it[AUTO_UPDATE_CHECK] = on }
    }

    /** When the last update check ran (epoch ms), 0 if never. */
    val lastUpdateCheck: Flow<Long> = context.dataStore.data.map { it[LAST_UPDATE_CHECK] ?: 0L }

    suspend fun setLastUpdateCheck(ms: Long) {
        context.dataStore.edit { it[LAST_UPDATE_CHECK] = ms }
    }
}
