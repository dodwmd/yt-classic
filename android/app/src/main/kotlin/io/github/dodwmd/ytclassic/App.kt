package io.github.dodwmd.ytclassic

import android.app.Application
import io.github.dodwmd.ytclassic.data.SettingsStore
import io.github.dodwmd.ytclassic.data.YtApi
import kotlinx.coroutines.flow.first

/** Holds the few app-wide singletons; no DI framework needed for an app this size. */
class App : Application() {
    lateinit var settings: SettingsStore
        private set
    lateinit var api: YtApi
        private set

    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(this)
        // Always read the persisted address (DataStore caches it), so there is no window where a request can run
        // before a mirrored copy has been loaded, and a stale copy can never overwrite a fresh one.
        api = YtApi(server = { settings.serverUrl.first() })
    }
}
