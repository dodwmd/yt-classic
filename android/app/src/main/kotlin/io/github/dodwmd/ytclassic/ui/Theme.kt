package io.github.dodwmd.ytclassic.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The classic look: light grey masthead, red logo, blue links.
val Masthead = Color(0xFFE8E8E8)
val LogoRed = Color(0xFFCC0000)
val LinkBlue = Color(0xFF0033CC)
val Muted = Color(0xFF666666)

private val Colors = lightColorScheme(
    primary = LogoRed,
    onPrimary = Color.White,
    secondary = LinkBlue,
    background = Color.White,
    surface = Color.White,
)

@Composable
fun ClassicTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = Colors, content = content)
