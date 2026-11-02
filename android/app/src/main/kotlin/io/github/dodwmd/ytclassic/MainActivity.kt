package io.github.dodwmd.ytclassic

import android.app.AppOpsManager
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.Process
import android.util.Log
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshotFlow
import androidx.core.content.ContextCompat
import androidx.core.util.Consumer
import androidx.core.app.PictureInPictureModeChangedInfo
import io.github.dodwmd.ytclassic.player.LocalPip
import io.github.dodwmd.ytclassic.player.PipAction
import io.github.dodwmd.ytclassic.player.PipState
import io.github.dodwmd.ytclassic.player.pipActions
import io.github.dodwmd.ytclassic.player.pipAspect
import io.github.dodwmd.ytclassic.player.dismissedFromPip
import io.github.dodwmd.ytclassic.player.shouldEnterPip
import androidx.lifecycle.lifecycleScope
import io.github.dodwmd.ytclassic.ui.AppNav
import io.github.dodwmd.ytclassic.ui.ClassicTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    // The result isn't needed: if it's denied, connections fail and Settings explains how to allow it.
    private val requestLocalNetwork = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    // Background audio works without it (only the notification is hidden), so the answer isn't needed either.
    private val requestNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    private val pip = PipState()
    private val pipFeature by lazy { packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE) }

    /** The device has it and the user hasn't turned it off for this app in system settings (checked again on each start). */
    private fun pipAllowed(): Boolean = pipFeature && try {
        val ops = getSystemService(AppOpsManager::class.java)
        ops.checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, Process.myUid(), packageName) == AppOpsManager.MODE_ALLOWED
    } catch (e: RuntimeException) {
        Log.w("MainActivity", "Couldn't check the picture-in-picture permission: ${e.javaClass.simpleName}")
        true
    }

    // The window's Play/Pause and Skip buttons arrive here (explicit, not exported); only registered while started.
    private val pipControls = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val host = (application as App).host
            when (intent.getIntExtra(EXTRA_CONTROL, 0)) {
                CONTROL_PLAY_PAUSE -> if (host.wantsToPlay) host.pause() else host.play()
                CONTROL_SKIP -> host.skipTv()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Android 17+ blocks apps targeting SDK 37 from the local network (where the backend lives) until granted.
        if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission(LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED) {
            requestLocalNetwork.launch(LOCAL_NETWORK)
        }
        val app = application as App
        initPip(app)
        // Debug builds only: `adb shell am start -n <pkg>/.MainActivity --es server 10.0.2.2:8080` presets the server.
        val preset = if (BuildConfig.DEBUG) intent.getStringExtra("server") else null
        // Ask for notifications the first time something plays (Android 13+), not at launch, when it is clear why.
        if (Build.VERSION.SDK_INT >= 33) lifecycleScope.launch {
            snapshotFlow { app.host.isPlaying }.first { it }
            if (app.host.keepInBackground && checkSelfPermission(NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestNotifications.launch(NOTIFICATIONS)
            }
        }
        // Reopened from the media notification after the activity was gone: go back to the video that is playing.
        val playing = if (savedInstanceState == null && intent.getBooleanExtra(EXTRA_OPEN_PLAYING, false)) app.host.video?.id else null
        val tvOn = playing != null && app.host.tv != null
        lifecycleScope.launch {
            preset?.let { app.settings.setServerUrl(it) } // persisted before any screen loads
            setContent { CompositionLocalProvider(LocalPip provides pip) { ClassicTheme { AppNav(app, playing, tvOn) } } }
        }
    }

    override fun onStart() {
        super.onStart()
        (application as App).host.appVisible = true
        pip.supported = pipAllowed()
        ContextCompat.registerReceiver(this, pipControls, IntentFilter(ACTION_PIP_CONTROL), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    // In the small window the activity stays started, so the app still counts as on screen. It is stopped when the
    // window is dismissed (X) or the screen turns off: then the background rules apply (pause, or audio plays on).
    override fun onStop() {
        unregisterReceiver(pipControls)
        val host = (application as App).host
        host.appVisible = false
        val dismissed = dismissedFromPip(isInPictureInPictureMode, getSystemService(PowerManager::class.java).isInteractive, isFinishing)
        super.onStop() // the player screen saves its position and applies the background rules first
        // X on the window: the user closed the video, so pause it and remove its notification (and end TV) whatever the
        // background setting says. The video stays loaded, so reopening the app offers Play where it left off.
        if (dismissed) host.endSession()
    }

    // Android 12+ enters by itself (auto-enter in the parameters); before that, enter when the user leaves.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && pipWanted()) enterPip()
    }

    private fun pipWanted() = shouldEnterPip((application as App).host.wantsToPlay, pip.enabled, pip.supported)

    private fun enterPip() {
        if (!pip.available) return
        try {
            enterPictureInPictureMode(pipParams(autoEnter = false))
        } catch (e: RuntimeException) { // IllegalStateException, or IllegalArgumentException for parameters the platform rejects
            Log.w("MainActivity", "Couldn't enter picture in picture: ${e.javaClass.simpleName}")
        }
    }

    private fun initPip(app: App) {
        pip.inPip = isInPictureInPictureMode
        pip.enter = ::enterPip
        pip.onBoundsChanged = ::updatePip
        val listener = Consumer<PictureInPictureModeChangedInfo> { pip.inPip = it.isInPictureInPictureMode }
        addOnPictureInPictureModeChangedListener(listener)
        pip.supported = pipAllowed()
        if (!pipFeature) return
        lifecycleScope.launch { app.settings.pictureInPicture.collect { pip.enabled = it } }
        // Keep the window's shape, buttons and auto-enter flag in step with what is playing.
        lifecycleScope.launch {
            val host = app.host
            snapshotFlow {
                listOf(host.isPlaying, host.buffering, host.video?.id, host.error, host.finished, host.tv != null, host.videoSize, host.wantsToPlay, pip.enabled, pip.supported)
            }.collect { updatePip() }
        }
    }

    private fun updatePip() {
        if (!pipFeature) return
        try {
            setPictureInPictureParams(pipParams(autoEnter = pipWanted()))
        } catch (e: RuntimeException) { // must never escape: this runs inside a coroutine collector
            Log.w("MainActivity", "Couldn't update picture in picture: ${e.javaClass.simpleName}")
        }
    }

    private fun pipParams(autoEnter: Boolean): PictureInPictureParams {
        val host = (application as App).host
        val size = host.videoSize
        val ratio = pipAspect(size.width, size.height, size.pixelWidthHeightRatio)
        val builder = PictureInPictureParams.Builder()
            .setAspectRatio(Rational(ratio.width, ratio.height))
            .setActions(pipActions(host.video != null, host.wantsToPlay, host.tv != null).map(::remoteAction))
        pip.videoBounds?.let { builder.setSourceRectHint(it) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setAutoEnterEnabled(autoEnter).setSeamlessResizeEnabled(false)
        return builder.build()
    }

    private fun remoteAction(action: PipAction): RemoteAction {
        val (icon, title, control) = when (action) {
            PipAction.Play -> Triple(R.drawable.ic_pip_play, getString(R.string.pip_play), CONTROL_PLAY_PAUSE)
            PipAction.Pause -> Triple(R.drawable.ic_pip_pause, getString(R.string.pip_pause), CONTROL_PLAY_PAUSE)
            PipAction.Skip -> Triple(R.drawable.ic_pip_skip, getString(R.string.pip_skip), CONTROL_SKIP)
        }
        val intent = Intent(ACTION_PIP_CONTROL).setPackage(packageName).putExtra(EXTRA_CONTROL, control)
        // One request code per action, so Play/Pause and Skip never share (and overwrite) a PendingIntent.
        val pending = PendingIntent.getBroadcast(this, control, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return RemoteAction(Icon.createWithResource(this, icon), title, title, pending)
    }

    companion object {
        const val EXTRA_OPEN_PLAYING = "open_playing"
        private const val ACTION_PIP_CONTROL = "io.github.dodwmd.ytclassic.PIP_CONTROL"
        private const val EXTRA_CONTROL = "control"
        private const val CONTROL_PLAY_PAUSE = 1
        private const val CONTROL_SKIP = 2
    }
}

private const val NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"
private const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
