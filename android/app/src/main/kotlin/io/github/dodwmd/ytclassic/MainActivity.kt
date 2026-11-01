package io.github.dodwmd.ytclassic

import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.snapshotFlow
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Android 17+ blocks apps targeting SDK 37 from the local network (where the backend lives) until granted.
        if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission(LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED) {
            requestLocalNetwork.launch(LOCAL_NETWORK)
        }
        val app = application as App
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
        lifecycleScope.launch {
            preset?.let { app.settings.setServerUrl(it) } // persisted before any screen loads
            setContent { ClassicTheme { AppNav(app, playing) } }
        }
    }

    override fun onStart() {
        super.onStart()
        (application as App).host.appVisible = true
    }

    override fun onStop() {
        (application as App).host.appVisible = false
        super.onStop()
    }

    companion object {
        const val EXTRA_OPEN_PLAYING = "open_playing"
    }
}

private const val NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"
private const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
