package io.github.dodwmd.ytclassic

import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import io.github.dodwmd.ytclassic.ui.AppNav
import io.github.dodwmd.ytclassic.ui.ClassicTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    // The result isn't needed: if it's denied, connections fail and Settings explains how to allow it.
    private val requestLocalNetwork = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

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
        lifecycleScope.launch {
            preset?.let { app.settings.setServerUrl(it) } // persisted before any screen loads
            setContent { ClassicTheme { AppNav(app) } }
        }
    }
}

private const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
