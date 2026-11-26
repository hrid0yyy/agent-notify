package dev.hridoy.agentnotify.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.hridoy.agentnotify.AgentEvent
import dev.hridoy.agentnotify.BridgeStatus
import dev.hridoy.agentnotify.Notifications

private val AccentTeal = Color(0xFF64D8C8)
private val AccentAmber = Color(0xFFE9B65B)
private val AccentRed = Color(0xFFF07A70)

@Composable
fun HomeScreen(
    status: BridgeStatus?,
    events: List<AgentEvent>,
    serviceStatus: String,
    serviceEnabled: Boolean,
    snackbarHostState: SnackbarHostState,
    onSettings: () -> Unit,
    onPresence: (String) -> Unit,
    onAlarm: (String, Int) -> Unit,
) {
    val atDesk = status?.atDesk == true
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp)
                .padding(top = 12.dp),
        ) {
            Header(
                status = status,
                serviceStatus = serviceStatus,
                serviceEnabled = serviceEnabled,
                onSettings = onSettings,
            )

            Spacer(Modifier.height(28.dp))

            PresenceSwitch(
                atDesk = atDesk,
                enabled = status != null,
                onChange = onPresence,
            )

            Spacer(Modifier.height(36.dp))

            AlarmSection(
                status = status,
                onAlarm = onAlarm,
            )

            Spacer(Modifier.height(36.dp))

            RecentSection(events)
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
private fun Header(
    status: BridgeStatus?,
    serviceStatus: String,
    serviceEnabled: Boolean,
    onSettings: () -> Unit,
) {
    val live = serviceStatus.startsWith("Connected")
    val label = when {
        !serviceEnabled -> "Background off"
        status == null -> "Offline"
        !live -> serviceStatus
        status.activeAlarm -> "Alarm ringing"
        status.atDesk -> "Muted"
        status.clients == 0 -> "Connecting"
        status.pending > 0 -> "${status.pending} waiting"
        else -> {
            val devices = if (status.clients == 1) "device" else "devices"
            "Live · ${status.clients} $devices"
        }
    }
    val dot = when {
        !serviceEnabled -> MaterialTheme.colorScheme.onSurfaceVariant
        status == null -> AccentRed
        status.activeAlarm -> AccentRed
        !live -> AccentAmber
        status.atDesk -> MaterialTheme.colorScheme.onSurfaceVariant
        status.clients == 0 -> AccentAmber
        else -> AccentTeal
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text("Agent Notify", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                val animatedDot by animateColorAsState(
                    targetValue = dot,
                    animationSpec = tween(220),
                    label = "status-dot",
                )
                Box(
                    modifier = Modifier
                        .size(7.dp)
                        .background(animatedDot, CircleShape),
                )
                Spacer(Modifier.width(8.dp))
                AnimatedContent(
                    targetState = label,
                    transitionSpec = {
                        fadeIn(tween(180)) togetherWith fadeOut(tween(120))
                    },
                    label = "status-label",
                ) { value ->
                    Text(
                        value,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        IconButton(onClick = onSettings) {
            Icon(
                Icons.Outlined.Settings,
                contentDescription = "Settings",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

@Composable
private fun PresenceSwitch(
    atDesk: Boolean,
    enabled: Boolean,
    onChange: (String) -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val select: (String) -> Unit = { mode ->
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        onChange(mode)
    }

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .clip(MaterialTheme.shapes.large)
            .background(MaterialTheme.colorScheme.surface)
            .selectableGroup(),
    ) {
        val thumbWidth = (maxWidth - 8.dp) / 2
        val offset by animateDpAsState(
            targetValue = if (atDesk) 0.dp else thumbWidth,
            animationSpec = spring(
                dampingRatio = Spring.DampingRatioNoBouncy,
                stiffness = 520f,
            ),
            label = "presence-thumb",
        )
        val thumbColor by animateColorAsState(
            targetValue = if (atDesk) {
                MaterialTheme.colorScheme.surfaceVariant
            } else {
                MaterialTheme.colorScheme.primaryContainer
            },
            animationSpec = tween(200),
            label = "presence-thumb-color",
        )

        Box(
            modifier = Modifier
                .offset(x = 4.dp + offset, y = 4.dp)
                .width(thumbWidth)
                .height(48.dp)
                .clip(MaterialTheme.shapes.medium)
                .background(thumbColor),
        )

        Row(modifier = Modifier.fillMaxSize()) {
            PresenceHalf(
                label = "At desk",
                selected = atDesk,
                selectedColor = MaterialTheme.colorScheme.onSurface,
                unselectedColor = MaterialTheme.colorScheme.onSurfaceVariant,
                enabled = enabled,
                modifier = Modifier.weight(1f),
                onClick = { select("desk") },
            )
            PresenceHalf(
                label = "Away",
                selected = !atDesk,
                selectedColor = MaterialTheme.colorScheme.primary,
                unselectedColor = MaterialTheme.colorScheme.onSurfaceVariant,
                enabled = enabled,
                modifier = Modifier.weight(1f),
                onClick = { select("away") },
            )
        }
    }
}

@Composable
private fun PresenceHalf(
    label: String,
    selected: Boolean,
    selectedColor: Color,
    unselectedColor: Color,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val color by animateColorAsState(
        targetValue = if (selected) selectedColor else unselectedColor,
        animationSpec = tween(180),
        label = "presence-label",
    )
    Box(
        modifier = modifier
            .fillMaxHeight()
            .selectable(
                selected = selected,
                enabled = enabled,
                role = Role.RadioButton,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.titleSmall,
            color = color,
        )
    }
}

@Composable
private fun AlarmSection(
    status: BridgeStatus?,
    onAlarm: (String, Int) -> Unit,
) {
    val mode = status?.alarmMode ?: "off"
    val minutes = status?.alarmMinutes() ?: 0
    val enabled = status != null && !status.atDesk
    val armed = enabled && mode != "off"
    val state = when {
        status == null -> "Offline"
        status.atDesk -> "At desk"
        mode == "on" -> "On"
        mode == "timed" -> "${minutes}m left"
        else -> "Off"
    }

    Column {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SectionLabel("Alarms")
            Spacer(Modifier.weight(1f))
            Text(
                state,
                style = MaterialTheme.typography.labelSmall,
                color = if (armed) AccentAmber else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(10.dp))
        AlarmSegment(
            mode = mode,
            enabled = enabled,
            onSelect = onAlarm,
        )
    }
}

@Composable
private fun AlarmSegment(
    mode: String,
    enabled: Boolean,
    onSelect: (String, Int) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surface)
            .alpha(if (enabled) 1f else 0.4f)
            .padding(4.dp)
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        AlarmOption(
            label = "Off",
            selected = mode == "off",
            enabled = enabled,
            selectedColor = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
            onClick = { onSelect("off", 0) },
        )
        AlarmOption(
            label = "On",
            selected = mode == "on",
            enabled = enabled,
            selectedColor = AccentAmber,
            modifier = Modifier.weight(1f),
            onClick = { onSelect("on", 0) },
        )
        AlarmOption(
            label = "30 min",
            selected = mode == "timed",
            enabled = enabled,
            selectedColor = AccentAmber,
            modifier = Modifier.weight(1f),
            onClick = { onSelect("timed", 30) },
        )
    }
}

@Composable
private fun AlarmOption(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    selectedColor: Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val background by animateColorAsState(
        targetValue = if (selected) {
            MaterialTheme.colorScheme.surfaceVariant
        } else {
            Color.Transparent
        },
        animationSpec = tween(180),
        label = "alarm-option-bg",
    )
    val color by animateColorAsState(
        targetValue = if (selected) {
            selectedColor
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
        animationSpec = tween(180),
        label = "alarm-option-text",
    )
    Box(
        modifier = modifier
            .fillMaxHeight()
            .clip(MaterialTheme.shapes.small)
            .background(background)
            .selectable(
                selected = selected,
                enabled = enabled,
                role = Role.RadioButton,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = color,
        )
    }
}

@Composable
private fun RecentSection(events: List<AgentEvent>) {
    SectionLabel("Recent")
    Spacer(Modifier.height(4.dp))
    if (events.isEmpty()) {
        Text(
            "Nothing yet.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(vertical = 14.dp),
        )
    } else {
        events.take(6).forEach { event ->
            RecentRow(event)
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.semantics { heading() },
    )
}

@Composable
private fun RecentRow(event: AgentEvent) {
    val agentColor = Color(Notifications.agentColor(event.agent))
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(7.dp)
                .background(agentColor, CircleShape),
        )
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                event.title,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${event.project} · ${Notifications.agentLabel(event.agent)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(12.dp))
        Text(
            relativeTime(event.createdAt),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

private fun relativeTime(timestamp: Long): String {
    if (timestamp <= 0) return ""
    val elapsed = (System.currentTimeMillis() - timestamp).coerceAtLeast(0)
    val minutes = elapsed / 60_000
    return when {
        minutes < 1 -> "now"
        minutes < 60 -> "${minutes}m"
        minutes < 1440 -> "${minutes / 60}h"
        else -> "${minutes / 1440}d"
    }
}
