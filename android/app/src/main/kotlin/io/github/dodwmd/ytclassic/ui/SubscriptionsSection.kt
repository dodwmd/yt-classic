package io.github.dodwmd.ytclassic.ui

import android.net.Uri
import android.provider.DocumentsContract
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.importSummary
import io.github.dodwmd.ytclassic.data.readBytesLimited
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Import and export of subscriptions through the system file picker (no storage permission needed): the user picks
 * a Takeout CSV or OPML file to import, or a place to save the CSV or OPML export.
 */
@Composable
fun SubscriptionsSection(api: YtApi) {
    val resolver = LocalContext.current.applicationContext.contentResolver
    val scope = rememberCoroutineScope()
    // Only finished results are saved across recreation; "Working…" is derived from [busy], which is not.
    var message by rememberSaveable { mutableStateOf<String?>(null) }
    var failed by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var pickerOpen by remember { mutableStateOf(false) } // a quick double tap must not stack two pickers

    fun run(block: suspend () -> String) {
        if (busy) return
        busy = true
        failed = false
        scope.launch {
            try {
                message = block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                message = e.message
                failed = true
            } catch (e: Exception) {
                message = "Couldn't read or write that file."
                failed = true
            } finally {
                busy = false
            }
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        pickerOpen = false
        if (uri != null) run {
            val bytes = withContext(Dispatchers.IO) { resolver.openInputStream(uri)?.use { readBytesLimited(it) } }
                ?: throw ApiException("That file is empty, unreadable or larger than 1 MB.")
            importSummary(api.importSubscriptions(bytes))
        }
    }

    fun saver(format: String) = { uri: Uri? ->
        pickerOpen = false
        if (uri != null) run {
            // The picker has already created the (empty) document: remove it again unless the export fully arrived.
            var saved = false
            try {
                val text = api.exportSubscriptions(format)
                withContext(NonCancellable + Dispatchers.IO) { // once writing starts it finishes, so no half file is left
                    // "wt" truncates: the picker may hand back an existing, longer file.
                    resolver.openOutputStream(uri, "wt")?.use { it.write(text.toByteArray()) } ?: throw ApiException("Couldn't write that file.")
                }
                saved = true
            } finally {
                if (!saved) withContext(NonCancellable + Dispatchers.IO) { runCatching { DocumentsContract.deleteDocument(resolver, uri) } }
            }
            "Saved the ${format.uppercase()} export to the file you chose."
        }
    }
    val saveCsv = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv"), saver("csv"))
    val saveOpml = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/x-opml"), saver("opml"))
    val enabled = !busy && !pickerOpen

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Subscriptions", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(top = 8.dp))
        Text(
            "Import a Google Takeout subscriptions.csv, an OPML file or a list of channel links from your device, " +
                "or export your subscriptions. Uses the saved server address.",
            color = Muted,
        )
        val shown = if (busy) "Working…" else message
        shown?.let {
            Text(
                it, color = if (failed && !busy) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        OutlinedButton(enabled = enabled, onClick = { pickerOpen = true; picker.launch(arrayOf("*/*")) }) { Text("Import subscriptions") }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(enabled = enabled, onClick = { pickerOpen = true; saveCsv.launch("subscriptions.csv") }) { Text("Export CSV") }
            OutlinedButton(enabled = enabled, onClick = { pickerOpen = true; saveOpml.launch("subscriptions.opml") }) { Text("Export OPML") }
        }
    }
}
