package io.github.dodwmd.ytclassic.ui

import android.util.Log
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.AuthException
import kotlinx.coroutines.CancellationException

sealed interface LoadState<out T> {
    data object Loading : LoadState<Nothing>
    data class Error(val message: String, val needsToken: Boolean = false) : LoadState<Nothing>
    data class Ready<T>(val data: T) : LoadState<T>
}

/** Lets deep screens (load errors, the player) send the user to Settings; provided by AppNav. */
val LocalOpenSettings = staticCompositionLocalOf<() -> Unit> { {} }

class Loaded<T>(val state: LoadState<T>, val retry: () -> Unit)

/** Runs [block] when [keys] change (and on retry), exposing loading / error / data. */
@Composable
fun <T> rememberLoad(vararg keys: Any?, block: suspend () -> T): Loaded<T> {
    var attempt by remember { mutableIntStateOf(0) }
    val state by produceState<LoadState<T>>(LoadState.Loading, *keys, attempt) {
        value = LoadState.Loading
        value = try {
            LoadState.Ready(block())
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            LoadState.Error(e.message ?: "Something went wrong.", needsToken = e is AuthException)
        } catch (e: Exception) {
            Log.e("YtClassic", "load failed", e) // the user only sees a generic message
            LoadState.Error("Something went wrong.")
        }
    }
    return Loaded(state) { attempt++ }
}

/** Shows a spinner or an error with Retry; calls [content] once the data is ready. */
@Composable
fun <T> LoadedContent(loaded: Loaded<T>, modifier: Modifier = Modifier, content: @Composable (T) -> Unit) {
    when (val s = loaded.state) {
        LoadState.Loading -> CenteredBox(modifier) { CircularProgressIndicator() }
        is LoadState.Error -> CenteredBox(modifier) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(24.dp)) {
                Text(s.message, color = MaterialTheme.colorScheme.error)
                if (s.needsToken) {
                    val openSettings = LocalOpenSettings.current
                    Button(onClick = openSettings) { Text("Open Settings") }
                }
                Button(onClick = loaded.retry) { Text("Retry") }
            }
        }
        is LoadState.Ready -> content(s.data)
    }
}

@Composable
private fun CenteredBox(modifier: Modifier, content: @Composable () -> Unit) {
    Row(modifier.fillMaxSize(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) { content() }
}
