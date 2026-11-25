package dev.hridoy.agentnotify.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColors = darkColorScheme(
    primary = Color(0xFF7CE38B),
    onPrimary = Color(0xFF06210F),
    primaryContainer = Color(0xFF173B25),
    onPrimaryContainer = Color(0xFFB8F5C2),
    secondary = Color(0xFF8AB4F8),
    onSecondary = Color(0xFF0B1B33),
    background = Color(0xFF0B0F14),
    onBackground = Color(0xFFE6EDF3),
    surface = Color(0xFF10161D),
    onSurface = Color(0xFFE6EDF3),
    surfaceVariant = Color(0xFF18212B),
    onSurfaceVariant = Color(0xFF9FB0C0),
    outline = Color(0xFF2B3A4A),
    error = Color(0xFFFF7B72),
    onError = Color(0xFF2B0705),
)

@Composable
fun AgentNotifyTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColors,
        content = content,
    )
}
