package io.github.dodwmd.ytclassic.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "settings")
private val SERVER_URL = stringPreferencesKey("server_url")
private val ACCESS_TOKEN = stringPreferencesKey("access_token")
private val BACKGROUND_AUDIO = booleanPreferencesKey("background_audio")

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
}
