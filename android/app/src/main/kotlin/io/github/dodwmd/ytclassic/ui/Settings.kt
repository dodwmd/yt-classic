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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.App
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.normalizeServerUrl
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(app: App, onDone: () -> Unit) {
    var address by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }
    var ok by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { address = app.settings.serverUrl.first() }

    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Server", style = MaterialTheme.typography.titleLarge)
        Text(
            "The address of your YouTube Classic backend, for example 192.168.1.153:8080 on home Wi-Fi, " +
                "or its VPN host name when you're away. The app has no login, so only use a network you trust.",
            color = Muted,
        )
        OutlinedTextField(
            value = address, onValueChange = { address = it; status = null }, singleLine = true,
            label = { Text("Server address") }, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        status?.let { Text(it, color = if (ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                scope.launch {
                    val url = normalizeServerUrl(address)
                    if (url == null) {
                        ok = false
                        status = "That doesn't look like an address."
                    } else {
                        status = "Testing…"
                        ok = YtApi(server = { address }).ping()
                        status = if (ok) "Connected to $url" else "Can't reach $url"
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
