package io.github.dodwmd.ytclassic.player

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * While [active]: lock to landscape and hide the system bars (a swipe from the edge shows them briefly).
 * Leaving fullscreen, or leaving the screen, puts both back. The activity handles its own configuration changes,
 * so rotating does not recreate it and playback carries on.
 */
@Composable
fun FullscreenEffect(active: Boolean) {
    val activity = LocalContext.current.findActivity() ?: return
    DisposableEffect(active) {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        if (active) {
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        }
        onDispose {
            if (active) {
                controller.show(WindowInsetsCompat.Type.systemBars())
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
        }
    }
}

private fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
