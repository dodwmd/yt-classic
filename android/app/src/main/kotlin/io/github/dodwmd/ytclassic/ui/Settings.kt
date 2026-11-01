package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.App
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.isPrivateHost
import io.github.dodwmd.ytclassic.data.normalizeServerUrl
import kotlinx.coroutines.Job
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(app: App, onDone: () -> Unit) {
    // Saveable, so what you've typed survives the system recreating the activity (dark mode, language, process death).
    var address by rememberSaveable { mutableStateOf("") }
    var loadedStored by rememberSaveable { mutableStateOf(false) }
    var status by rememberSaveable { mutableStateOf<String?>(null) }
    var ok by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var testing by remember { mutableStateOf<Job?>(null) }
    // One short-timeout client for the connection test, instead of a new connection pool per tap.
    val testClient = remember { OkHttpClient.Builder().callTimeout(8, TimeUnit.SECONDS).build() }
    LaunchedEffect(Unit) {
        if (!loadedStored) { // don't overwrite text the user already typed
            address = app.settings.serverUrl.first()
            loadedStored = true
        }
    }
    val host = normalizeServerUrl(address)
    val cleartextWarning = host != null && host.scheme == "http" && !isPrivateHost(host.host)

    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Server", style = MaterialTheme.typography.titleLarge)
        Text(
            "The address of your YouTube Classic backend, for example 192.168.1.153:8080 on home Wi-Fi, " +
                "or its VPN host name when you're away. The app has no login, so only use a network you trust.",
            color = Muted,
        )
        OutlinedTextField(
            value = address, onValueChange = { address = it; status = null; testing?.cancel() }, singleLine = true,
            label = { Text("Server address") }, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        if (cleartextWarning) {
            Text(
                "This isn't a private network address, and http isn't encrypted: anyone on the path can see your traffic. " +
                    "Use a VPN, or an https address.",
                color = MaterialTheme.colorScheme.error,
            )
        }
        status?.let { Text(it, color = if (ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                testing?.cancel()
                testing = scope.launch {
                    val url = normalizeServerUrl(address)
                    if (url == null) {
                        ok = false
                        status = "That doesn't look like an address."
                    } else {
                        status = "Testing…"
                        ok = YtApi(server = { address }, client = testClient).ping()
                        status = if (ok) "Connected to $url" else "Can't reach $url. Check the address and Wi-Fi. " +
                            "On Android 17+, also allow Local network / Nearby devices for this app in system settings."
                    }
                }
            }) { Text("Test connection") }
            Button(enabled = normalizeServerUrl(address) != null, onClick = {
                // Wait for the write, so the screen we go back to reads the new address.
                scope.launch { app.settings.setServerUrl(address); onDone() }
            }) { Text("Save") }
        }
    }
}
