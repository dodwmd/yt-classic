package io.github.dodwmd.ytclassic.player

import android.app.PendingIntent
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import android.content.Intent
import androidx.media3.common.MediaItem
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import io.github.dodwmd.ytclassic.App
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import io.github.dodwmd.ytclassic.MainActivity

/**
 * Hosts the MediaSession around [PlaybackHost.player]. Media3 turns it into the media notification and runs this
 * service in the foreground (type mediaPlayback) while audio plays. The player itself belongs to the host, not
 * the service, so the UI and the notification control the same playback.
 */
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                .putExtra(MainActivity.EXTRA_OPEN_PLAYING, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        session = MediaSession.Builder(this, (application as App).host.player).setSessionActivity(open).setCallback(Guard()).build()
        addSession(session!!) // so Media3 builds the notification and runs the service in the foreground
    }

    /** Only the system's media controls and this app may connect, with [allowedControllerCommands]; items can't be replaced. */
    @OptIn(UnstableApi::class)
    private inner class Guard : MediaSession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult =
            if (controller.packageName == packageName || controller.isTrusted || session.isMediaNotificationController(controller)) {
                MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailablePlayerCommands(allowedControllerCommands()).build()
            } else {
                MediaSession.ConnectionResult.reject()
            }

        override fun onAddMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>): ListenableFuture<List<MediaItem>> =
            Futures.immediateFailedFuture(UnsupportedOperationException("The stream is chosen by the app"))
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo) = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiped out of recents: keep playing if it is, otherwise nothing is left to keep alive.
        val host = (application as App).host
        if (!host.wantsToPlay) host.stop()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        session?.release()
        session = null
        super.onDestroy()
    }
}
