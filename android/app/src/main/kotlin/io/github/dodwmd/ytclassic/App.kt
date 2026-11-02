package io.github.dodwmd.ytclassic

import android.app.Application
import io.github.dodwmd.ytclassic.data.HomeFeed
import io.github.dodwmd.ytclassic.data.SearchHolder
import io.github.dodwmd.ytclassic.data.SettingsStore
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.player.PlaybackHost
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** Holds the few app-wide singletons; no DI framework needed for an app this size. */
class App : Application() {
    lateinit var settings: SettingsStore
        private set
    lateinit var api: YtApi
        private set

    /** The Home screen's state (feed pages, scroll, filters), kept for the life of the process so Back restores it. */
    lateinit var homeFeed: HomeFeed
        private set

    /** Search results kept while the user visits a channel and comes back. */
    val searchHolder = SearchHolder()

    /** Owns the player, so playback can outlive the activity (background audio). */
    lateinit var host: PlaybackHost
        private set

    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(this)
        // Always read the persisted address (DataStore caches it), so there is no window where a request can run
        // before a mirrored copy has been loaded, and a stale copy can never overwrite a fresh one.
        api = YtApi(server = { settings.serverUrl.first() }, token = { settings.accessToken.first() })
        host = PlaybackHost(this, api)
        homeFeed = HomeFeed(api, MainScope())
        MainScope().launch { settings.backgroundAudio.collect { host.keepInBackground = it } }
    }
}
