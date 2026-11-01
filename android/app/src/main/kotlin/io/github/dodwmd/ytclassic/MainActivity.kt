package io.github.dodwmd.ytclassic

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.lifecycleScope
import io.github.dodwmd.ytclassic.ui.AppNav
import io.github.dodwmd.ytclassic.ui.ClassicTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as App
        // Debug builds only: `adb shell am start -n <pkg>/.MainActivity --es server 10.0.2.2:8080` presets the server.
        val preset = if (BuildConfig.DEBUG) intent.getStringExtra("server") else null
        lifecycleScope.launch {
            preset?.let { app.settings.setServerUrl(it) } // persisted before any screen loads
            setContent { ClassicTheme { AppNav(app) } }
        }
    }
}
