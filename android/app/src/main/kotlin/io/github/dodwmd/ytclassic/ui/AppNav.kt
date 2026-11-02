package io.github.dodwmd.ytclassic.ui

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ime
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.focus.onFocusChanged
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.produceState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
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
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import io.github.dodwmd.ytclassic.App
import kotlinx.coroutines.flow.first

@Composable
fun AppNav(app: App, openVideoId: String? = null, openTv: Boolean = false) {
    val nav = rememberNavController()
    var query by rememberSaveable { mutableStateOf("") }
    // The player is fullscreen: no masthead. Deliberately not saved: only a composed player enforces it, so after
    // process death a restored `true` would leave loading/error screens without bars or a way out.
    var fullscreen by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    // Searching (or navigating) should put the keyboard away, otherwise it covers the results.
    val settle = { focus.clearFocus(); keyboard?.hide() }
    // Whichever screen opens, the search box lets go of the keyboard and its panel.
    val here by nav.currentBackStackEntryAsState()
    LaunchedEffect(here?.id) { settle() }
    var searchFocused by remember { mutableStateOf(false) }
    val recent = remember(app) { RecentState(app.api) }
    val search = { text: String -> if (text.isNotBlank()) { recent.invalidate(); settle(); nav.navigate("search/${Uri.encode(text.trim())}") } }
    BackHandler(enabled = searchFocused) { settle() }

    // First launch: no server yet, so start on Settings (not Home, which would show an error under it).
    val start by produceState<String?>(null) { value = if (app.settings.serverUrl.first().isBlank()) "settings" else "home" }
    // Opened from the media notification while a video plays on: show that video (the back stack ends at the start page).
    LaunchedEffect(start) {
        if (start != null && openVideoId != null) {
            nav.currentBackStackEntryFlow.first() // the graph is set once the start page has its entry
            nav.navigate(if (openTv) "tv" else "watch/$openVideoId")
        }
    }
    val toHome: () -> Unit = { nav.navigate("home") { popUpTo(nav.graph.id) { inclusive = true } } }

    val openVideo = { id: String -> nav.navigate("watch/$id") { launchSingleTop = true } }
    val openChannel = { id: String -> nav.navigate("channel/$id") { launchSingleTop = true } }

    Scaffold(
        topBar = {
            if (!fullscreen) Masthead(
                query = query, onQuery = { query = it },
                onHome = { settle(); toHome() },
                onSearch = { search(query) },
                onSettings = { settle(); nav.navigate("settings") },
                onFocus = { searchFocused = it },
            )
        },
    ) { padding ->
        val startDestination = start ?: return@Scaffold
        CompositionLocalProvider(LocalOpenSettings provides { settle(); nav.navigate("settings") }) {
        BoxWithConstraints(Modifier.padding(padding)) {
        NavHost(nav, startDestination = startDestination) {
            composable("home") { HomeScreen(app.homeFeed, { app.settings.serverUrl.first() + "\n" + app.settings.accessToken.first() }, openVideo, openChannel, { nav.navigate("history") }, { nav.navigate("playlists") }, { app.host.clearTvMessage(); app.host.startTv(); nav.navigate("tv") }, app.host.tvMessage) }
            composable("tv") { TvScreen(app.host, fullscreen, { fullscreen = it }, onExit = { nav.popBackStack() }) }
            composable("playlists") { PlaylistsScreen(app.api) { nav.navigate("playlist/$it") } }
            composable("playlist/{id}", listOf(navArgument("id") { type = NavType.LongType })) { entry ->
                PlaylistScreen(app.api, entry.arguments?.getLong("id") ?: 0L, openVideo)
            }
            composable("history") { HistoryScreen(app.api, openVideo) }
            composable("search/{q}", listOf(navArgument("q") { type = NavType.StringType })) { entry ->
                SearchScreen(app.api, app.searchHolder, entry.arguments?.getString("q").orEmpty(), openVideo, openChannel)
            }
            composable(
                "watch/{id}?t={t}",
                listOf(navArgument("id") { type = NavType.StringType }, navArgument("t") { type = NavType.LongType; defaultValue = 0L }),
            ) { entry ->
                WatchScreen(app.api, entry.arguments?.getString("id").orEmpty(), entry.arguments?.getLong("t") ?: 0L, fullscreen, { fullscreen = it }, openVideo, openChannel)
            }
            composable("channel/{id}", listOf(navArgument("id") { type = NavType.StringType })) { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                ChannelScreen(app.api, id, openVideo, { nav.navigate("channel/$id/playlist/$it") { launchSingleTop = true } }) { cid, on -> app.searchHolder.setSubscribed(cid, on) }
            }
            composable("channel/{id}/playlist/{pid}", listOf(navArgument("id") { type = NavType.StringType }, navArgument("pid") { type = NavType.StringType })) { entry ->
                ChannelPlaylistScreen(app.api, entry.arguments?.getString("id").orEmpty(), entry.arguments?.getString("pid").orEmpty(), openVideo)
            }
            composable("status") { StatusScreen(app.api) }
            composable("settings") { SettingsScreen(app, onDone = toHome, onStatus = { nav.navigate("status") }) }
        }
        if (searchFocused) {
            val density = LocalDensity.current
            val keyboard = with(density) { WindowInsets.ime.getBottom(density).toDp() }
            SearchPanel(app.api, recent, query, (maxHeight - keyboard).coerceIn(96.dp, 288.dp), Modifier.align(Alignment.TopStart)) { query = it; search(it) }
        }
        }
        }
    }
}

@Composable
private fun Masthead(query: String, onQuery: (String) -> Unit, onHome: () -> Unit, onSearch: () -> Unit, onSettings: () -> Unit, onFocus: (Boolean) -> Unit) {
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
            modifier = Modifier.weight(1f).heightIn(min = 48.dp).onFocusChanged { onFocus(it.isFocused) }.background(Classic.fieldBackground, shape).border(1.dp, Classic.fieldBorder, shape)
                .padding(horizontal = 10.dp, vertical = 9.dp).semantics { contentDescription = "Search" },
            decorationBox = { inner ->
                Box(Modifier.heightIn(min = 30.dp), contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) Text("Search", fontSize = 15.sp, color = Classic.fieldHint)
                    inner()
                }
            },
        )
        TextButton(onClick = onSettings, modifier = Modifier.semantics { contentDescription = "Settings" }) {
            Text("⚙", fontSize = 20.sp, color = Classic.logoText)
        }
    }
}
