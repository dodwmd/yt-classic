package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// The classic look: light grey masthead, red logo, blue links. Dark mode follows the system setting (no in-app toggle).
val LogoRed = Color(0xFFCC0000)

/** The few colours that aren't in the Material scheme, one set per theme. */
@Immutable
class ClassicColors(
    val masthead: Color,
    val link: Color,
    val muted: Color,
    val logoText: Color,
    val fieldBackground: Color,
    val fieldBorder: Color,
    val fieldText: Color,
    val fieldHint: Color,
)

private val LightClassic = ClassicColors(
    masthead = Color(0xFFE8E8E8), link = Color(0xFF0033CC), muted = Color(0xFF666666), logoText = Color(0xFF333333),
    fieldBackground = Color.White, fieldBorder = Color(0xFFBBBBBB), fieldText = Color(0xFF222222), fieldHint = Color(0xFF888888),
)
private val DarkClassic = ClassicColors(
    masthead = Color(0xFF242424), link = Color(0xFF78AAFF), muted = Color(0xFFA8A8A8), logoText = Color(0xFFE4E4E4),
    fieldBackground = Color(0xFF121212), fieldBorder = Color(0xFF555555), fieldText = Color(0xFFE4E4E4), fieldHint = Color(0xFF999999),
)

private val LocalClassic = staticCompositionLocalOf { LightClassic }

// Read these inside composables; they resolve to the current theme.
val Masthead: Color @Composable get() = LocalClassic.current.masthead
val LinkBlue: Color @Composable get() = LocalClassic.current.link
val Muted: Color @Composable get() = LocalClassic.current.muted
val Classic: ClassicColors @Composable get() = LocalClassic.current

private val LightScheme = lightColorScheme(
    primary = LogoRed,
    onPrimary = Color.White,
    secondary = Color(0xFF0033CC),
    background = Color.White,
    surface = Color.White,
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFFFF6B6B),
    onPrimary = Color(0xFF1A1A1A),
    secondary = Color(0xFF78AAFF),
    background = Color(0xFF181818),
    onBackground = Color(0xFFE4E4E4),
    surface = Color(0xFF181818),
    onSurface = Color(0xFFE4E4E4),
    onSurfaceVariant = Color(0xFFA8A8A8),
    outline = Color(0xFF666666),
    surfaceVariant = Color(0xFF2C2C2C),
    secondaryContainer = Color(0xFF3A2A2A),
    onSecondaryContainer = Color(0xFFE4E4E4),
)

@Composable
fun ClassicTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalClassic provides if (dark) DarkClassic else LightClassic) {
        MaterialTheme(colorScheme = if (dark) DarkScheme else LightScheme, content = content)
    }
}
