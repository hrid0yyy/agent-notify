package dev.hridoy.agentnotify.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hridoy.agentnotify.R

val SignalInk = Color(0xFF0A0E10)
val SignalPanel = Color(0xFF11171A)
val SignalRaised = Color(0xFF182125)
val SignalAmber = Color(0xFFE9B65B)
val SignalTeal = Color(0xFF64D8C8)
val SignalMuted = Color(0xFF8C9BA1)
val SignalOutline = Color(0xFF2A363B)
val SignalText = Color(0xFFE8EFF1)
val SignalDanger = Color(0xFFF07A70)

private val SignalColors = darkColorScheme(
    primary = SignalTeal,
    onPrimary = Color(0xFF00201C),
    primaryContainer = Color(0xFF12312D),
    onPrimaryContainer = Color(0xFFB9F5EC),
    secondary = SignalAmber,
    onSecondary = Color(0xFF2A1C00),
    secondaryContainer = Color(0xFF33260B),
    onSecondaryContainer = Color(0xFFFFDFA3),
    tertiary = Color(0xFF9BB4C4),
    onTertiary = Color(0xFF0B1B24),
    background = SignalInk,
    onBackground = SignalText,
    surface = SignalPanel,
    onSurface = SignalText,
    surfaceVariant = SignalRaised,
    onSurfaceVariant = SignalMuted,
    outline = SignalOutline,
    outlineVariant = Color(0xFF1D272B),
    error = SignalDanger,
    onError = Color(0xFF330A08),
    errorContainer = Color(0xFF5A1815),
    onErrorContainer = Color(0xFFFFDAD6),
    inverseSurface = SignalText,
    inverseOnSurface = SignalInk,
    inversePrimary = Color(0xFF005148),
)

private val SignalShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

private val Geist = FontFamily(
    Font(R.font.geist_regular, FontWeight.Normal),
    Font(R.font.geist_medium, FontWeight.Medium),
    Font(R.font.geist_semibold, FontWeight.SemiBold),
)

private val SignalTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.SemiBold,
        fontSize = 34.sp,
        lineHeight = 40.sp,
        letterSpacing = (-0.6).sp,
    ),
    headlineLarge = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.SemiBold,
        fontSize = 28.sp,
        lineHeight = 34.sp,
        letterSpacing = (-0.4).sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.SemiBold,
        fontSize = 23.sp,
        lineHeight = 29.sp,
        letterSpacing = (-0.3).sp,
    ),
    titleLarge = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.SemiBold,
        fontSize = 21.sp,
        lineHeight = 27.sp,
        letterSpacing = (-0.2).sp,
    ),
    titleMedium = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 21.sp,
    ),
    titleSmall = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.Normal,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 21.sp,
    ),
    bodySmall = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 17.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.2.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.9.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = Geist,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.2.sp,
    ),
)

@Composable
fun AgentNotifyTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = SignalColors,
        typography = SignalTypography,
        shapes = SignalShapes,
        content = content,
    )
}
