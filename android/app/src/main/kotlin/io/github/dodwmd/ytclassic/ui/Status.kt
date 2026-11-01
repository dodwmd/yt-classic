package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.statusRows

/** The backend's health, from GET /api/status (the same fields as the web /status page). */
@Composable
fun StatusScreen(api: YtApi) {
    val loaded = rememberLoad { api.status() }
    LoadedContent(loaded) { s ->
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Status: ${s.health}", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
            for ((label, value) in statusRows(s)) {
                // One TalkBack stop per row ("yt-dlp, 2026.10.26"), not two.
                Column(Modifier.semantics(mergeDescendants = true) {}) {
                    Text(label, color = Muted)
                    Text(value)
                }
            }
        }
    }
}
