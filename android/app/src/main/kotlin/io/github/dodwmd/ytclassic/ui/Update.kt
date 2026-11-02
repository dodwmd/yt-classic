package io.github.dodwmd.ytclassic.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.core.net.toUri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.App
import io.github.dodwmd.ytclassic.data.UpdateResult
import io.github.dodwmd.ytclassic.data.updateSummary
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Opens the release page in the browser. The URL comes from [UpdateResult.Available.pageUrl]: fixed repo + validated tag. */
@Composable
private fun rememberOpenRelease(): (UpdateResult.Available) -> Unit {
    val context = LocalContext.current
    return { release ->
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, release.pageUrl.toUri()).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            // no browser installed: nothing more to do
        }
    }
}

/** Settings: a manual check, plus the opt-in weekly check. The only feature of the app that contacts GitHub. */
@Composable
fun UpdateSection(app: App) {
    val scope = rememberCoroutineScope()
    var checking by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<UpdateResult?>(null) }
    val open = rememberOpenRelease()
    val auto by app.settings.autoUpdateCheck.collectAsState(initial = false)
    Text("Updates", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 8.dp))
    Text(
        "Checking asks GitHub (api.github.com) for the latest release of this app. That is the only time the app contacts " +
            "anything but your server, and your access token is never sent there. Nothing is checked unless you ask or turn the weekly check on.",
        color = Muted,
    )
    OutlinedButton(enabled = !checking, onClick = {
        checking = true
        result = null
        scope.launch {
            try {
                result = app.updateChecker.check()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                result = UpdateResult.Failed("The check failed. Try again later.")
            } finally {
                checking = false
            }
        }
    }) { Text(if (checking) "Checking…" else "Check for updates") }
    result?.let { r ->
        Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(updateSummary(r), color = if (r is UpdateResult.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            if (r is UpdateResult.Available) {
                if (r.notes.isNotBlank()) Text(r.notes, color = Muted)
                Button(onClick = { open(r) }) { Text("Open release page") }
            }
        }
    }
    Row(
        Modifier.fillMaxWidth().toggleable(value = auto, role = Role.Switch) { scope.launch { app.settings.setAutoUpdateCheck(it) } },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text("Check weekly when the app starts")
            Text("Off by default. When on, the app asks GitHub at most once every 7 days and shows a note on Home if there is a newer version.", color = Muted)
        }
        Switch(checked = auto, onCheckedChange = null)
    }
}

/** A small banner on Home when the weekly check found a newer version. */
@Composable
fun UpdateBanner(app: App) {
    val found by app.updateBanner.collectAsState()
    val release = found ?: return
    val open = rememberOpenRelease()
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(updateSummary(release), modifier = Modifier.weight(1f))
        TextButton(onClick = { open(release) }) { Text("View") }
        TextButton(onClick = { app.updateBanner.value = null }) { Text("Dismiss") }
    }
}
