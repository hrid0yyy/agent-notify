package dev.hridoy.agentnotify

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.hridoy.agentnotify.ui.HomeScreen
import dev.hridoy.agentnotify.ui.SettingsScreen
import dev.hridoy.agentnotify.ui.theme.AgentNotifyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Only on a fresh launch: a rotation/recreate must not re-apply an old link.
        if (savedInstanceState == null) confirmSetupIntent(intent)
        val prefs = Prefs(this)
        if (prefs.enabled && !NotifyService.running) {
            ContextCompat.startForegroundService(
                this,
                Intent(this, NotifyService::class.java),
            )
        }
        setContent {
            AgentNotifyTheme {
                AgentNotifyApp(prefs)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        confirmSetupIntent(intent)
    }

    /**
     * A pairing link can come from any web page or app, so never apply it
     * silently: show where it points and save only after the user confirms.
     */
    private fun confirmSetupIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "agentnotify" || data.host != "setup") return
        val url = data.getQueryParameter("url")?.trim().orEmpty()
        val token = data.getQueryParameter("token")?.trim().orEmpty()
        if (url.isBlank() || token.isBlank()) return
        // Consume the link so it is not handled again.
        setIntent(Intent(this, MainActivity::class.java))

        val parsedHost: String? = try {
            Uri.parse(if (url.contains("://")) url else "https://$url").host
        } catch (_: Exception) {
            null
        }
        val target = parsedHost?.takeIf { it.isNotBlank() } ?: url
        val current = Prefs(this).httpBase()
        val message = buildString {
            append("Connect Agent Notify to this bridge?\n\n")
            append(target)
            if (current.isNotBlank()) {
                append("\n\nThis replaces your current bridge:\n")
                append(Uri.parse(current).host ?: current)
            }
            append("\n\nOnly continue if you started pairing from your own computer.")
        }

        AlertDialog.Builder(this)
            .setTitle("Pair with bridge")
            .setMessage(message)
            .setCancelable(false)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Connect") { _, _ ->
                val prefs = Prefs(this)
                prefs.baseUrl = url
                prefs.token = token
                prefs.enabled = true
                // Starting the service again makes a running one reconnect
                // with the new URL and token.
                ContextCompat.startForegroundService(
                    this,
                    Intent(this, NotifyService::class.java),
                )
                recreate()
            }
            .show()
            .also { dialog ->
                // Ignore taps that pass through an overlay drawn on top.
                dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.filterTouchesWhenObscured = true
            }
    }
}

@Composable
private fun AgentNotifyApp(prefs: Prefs) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var screen by rememberSaveable { mutableStateOf("home") }
    var status by remember { mutableStateOf<BridgeStatus?>(null) }
    var events by remember { mutableStateOf<List<AgentEvent>>(emptyList()) }
    var serviceEnabled by remember { mutableStateOf(prefs.enabled) }
    var refreshKey by remember { mutableStateOf(0) }
    val serviceStatus by NotifyService.status.collectAsStateWithLifecycle()

    val notificationPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (!granted) {
            scope.launch {
                snackbar.showSnackbar("Notifications are blocked in Android settings.")
            }
        }
    }

    fun tell(message: String) {
        scope.launch { snackbar.showSnackbar(message) }
    }

    fun requireNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    fun startService() {
        ContextCompat.startForegroundService(
            context,
            Intent(context, NotifyService::class.java),
        )
    }

    fun saveConnection(url: String, token: String, enabled: Boolean) {
        prefs.baseUrl = url
        prefs.token = token
        prefs.enabled = enabled
        serviceEnabled = enabled
        if (enabled) {
            requireNotificationPermission()
            startService()
            tell("Connecting to ${prefs.httpBase().ifBlank { "the bridge" }}…")
        } else {
            context.stopService(Intent(context, NotifyService::class.java))
            tell("Background service stopped.")
        }
        refreshKey += 1
    }

    fun setBackgroundService(enabled: Boolean) {
        prefs.enabled = enabled
        serviceEnabled = enabled
        if (enabled) {
            requireNotificationPermission()
            startService()
            tell("Background service on.")
        } else {
            context.stopService(Intent(context, NotifyService::class.java))
            tell("Background service off.")
        }
        refreshKey += 1
    }

    fun clearHistory() {
        BridgeApi.deleteJson(context, "/events") { value ->
            if (value?.optBoolean("ok") == true) {
                events = emptyList()
                Notifications.cancelStatus(context)
            } else {
                tell("Could not clear history.")
            }
            refreshKey += 1
        }
    }

    fun setPresence(mode: String) {
        BridgeApi.postJson(
            context,
            "/presence",
            JSONObject().put("mode", mode),
        ) { value ->
            val parsed = BridgeStatusParser.parse(value)
            if (parsed != null) {
                status = parsed
            } else {
                tell("Could not reach the bridge.")
            }
            refreshKey += 1
        }
    }

    fun setAlarm(mode: String, minutes: Int = 0) {
        BridgeApi.postJson(
            context,
            "/alarm",
            JSONObject().put("mode", mode).put("minutes", minutes),
        ) { value ->
            if (value == null) {
                tell("Could not reach the bridge.")
            }
            refreshKey += 1
        }
    }

    fun testNotification() {
        requireNotificationPermission()
        Notifications.showTest(context)
        tell("Test notification sent.")
    }

    fun batterySettings() {
        val power = context.getSystemService(PowerManager::class.java)
        if (power?.isIgnoringBatteryOptimizations(context.packageName) == true) {
            tell("Battery optimization is already disabled for this app.")
            return
        }
        try {
            context.startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${context.packageName}"),
                ),
            )
        } catch (_: Exception) {
            context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    fun fullScreenSettings() {
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                        Uri.parse("package:${context.packageName}"),
                    ),
                )
            } catch (_: Exception) {
                tell("Open Settings → Special app access → Full-screen notifications.")
            }
        } else {
            tell("Full-screen alarms are allowed on this Android version.")
        }
    }

    LaunchedEffect(refreshKey) {
        while (isActive) {
            BridgeApi.getJson(context, "/status") { value ->
                status = BridgeStatusParser.parse(value)
            }
            BridgeApi.getJson(context, "/events?limit=8") { value ->
                events = BridgeStatusParser.events(value)
            }
            delay(2500)
        }
    }

    BackHandler(enabled = screen == "settings") {
        screen = "home"
    }

    AnimatedContent(
        targetState = screen,
        transitionSpec = {
            fadeIn(tween(200)) togetherWith fadeOut(tween(120))
        },
        label = "screen",
    ) { current ->
        when (current) {
            "settings" -> SettingsScreen(
                prefs = prefs,
                status = status,
                serviceStatus = serviceStatus,
                snackbarHostState = snackbar,
                onBack = { screen = "home" },
                onSave = { url, token, enabled -> saveConnection(url, token, enabled) },
                onEnabledChange = { setBackgroundService(it) },
                onTest = { testNotification() },
                onBattery = { batterySettings() },
                onFullScreen = { fullScreenSettings() },
            )

            else -> HomeScreen(
                status = status,
                events = events,
                serviceStatus = serviceStatus,
                serviceEnabled = serviceEnabled,
                snackbarHostState = snackbar,
                onSettings = { screen = "settings" },
                onPresence = { mode -> setPresence(mode) },
                onAlarm = { mode, minutes -> setAlarm(mode, minutes) },
                onClearHistory = { clearHistory() },
            )
        }
    }
}
