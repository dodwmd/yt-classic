package io.github.dodwmd.ytclassic.ui

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.produceState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import io.github.dodwmd.ytclassic.App
import kotlinx.coroutines.flow.first

@Composable
fun AppNav(app: App) {
    val nav = rememberNavController()
    var query by rememberSaveable { mutableStateOf("") }
    var fullscreen by rememberSaveable { mutableStateOf(false) } // the player is fullscreen: no masthead
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    // Searching (or navigating) should put the keyboard away, otherwise it covers the results.
    val settle = { focus.clearFocus(); keyboard?.hide() }

    // First launch: no server yet, so start on Settings (not Home, which would show an error under it).
    val start by produceState<String?>(null) { value = if (app.settings.serverUrl.first().isBlank()) "settings" else "home" }
    val toHome: () -> Unit = { nav.navigate("home") { popUpTo(nav.graph.id) { inclusive = true } } }

    val openVideo = { id: String -> nav.navigate("watch/$id") }
    val openChannel = { id: String -> nav.navigate("channel/$id") }

    Scaffold(
        topBar = {
            if (!fullscreen) Masthead(
                query = query, onQuery = { query = it },
                onHome = { settle(); toHome() },
                onSearch = { if (query.isNotBlank()) { settle(); nav.navigate("search/${Uri.encode(query.trim())}") } },
                onSettings = { settle(); nav.navigate("settings") },
            )
        },
    ) { padding ->
        val startDestination = start ?: return@Scaffold
        NavHost(nav, startDestination = startDestination, modifier = Modifier.padding(padding)) {
            composable("home") { HomeScreen(app.api, openVideo, openChannel) }
            composable("search/{q}", listOf(navArgument("q") { type = NavType.StringType })) { entry ->
                SearchScreen(app.api, entry.arguments?.getString("q").orEmpty(), openVideo)
            }
            composable(
                "watch/{id}?t={t}",
                listOf(navArgument("id") { type = NavType.StringType }, navArgument("t") { type = NavType.LongType; defaultValue = 0L }),
            ) { entry ->
                WatchScreen(app.api, entry.arguments?.getString("id").orEmpty(), entry.arguments?.getLong("t") ?: 0L, fullscreen, { fullscreen = it }, openVideo, openChannel)
            }
            composable("channel/{id}", listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                ChannelScreen(app.api, entry.arguments?.getString("id").orEmpty(), openVideo)
            }
            composable("settings") { SettingsScreen(app, onDone = toHome) }
        }
    }
}

@Composable
private fun Masthead(query: String, onQuery: (String) -> Unit, onHome: () -> Unit, onSearch: () -> Unit, onSettings: () -> Unit) {
    val shape = RoundedCornerShape(4.dp)
    Row(
        Modifier.fillMaxWidth().background(Masthead).windowInsetsPadding(WindowInsets.statusBars.union(WindowInsets.displayCutout)).padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            Modifier.clickable(onClick = onHome, role = Role.Button, onClickLabel = "Home").semantics { contentDescription = "YouTube home" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("You", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = Classic.logoText)
            Text("Tube", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = Color.White, modifier = Modifier.background(LogoRed, shape).padding(horizontal = 4.dp))
        }
        BasicTextField(
            value = query, onValueChange = onQuery, singleLine = true,
            textStyle = TextStyle(fontSize = 15.sp, color = Classic.fieldText),
            cursorBrush = SolidColor(Classic.fieldText),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { onSearch() }),
            modifier = Modifier.weight(1f).heightIn(min = 38.dp).background(Classic.fieldBackground, shape).border(1.dp, Classic.fieldBorder, shape)
                .padding(horizontal = 10.dp, vertical = 9.dp).semantics { contentDescription = "Search" },
            decorationBox = { inner ->
                if (query.isEmpty()) Text("Search", fontSize = 15.sp, color = Classic.fieldHint)
                inner()
            },
        )
        TextButton(onClick = onSettings, modifier = Modifier.semantics { contentDescription = "Settings" }) {
            Text("⚙", fontSize = 20.sp, color = Classic.logoText)
        }
    }
}
