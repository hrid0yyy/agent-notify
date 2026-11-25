package dev.hridoy.agentnotify

import org.json.JSONObject

data class BridgeStatus(
    val presence: String = "away",
    val alarmMode: String = "off",
    val alarmsUntil: Long = 0L,
    val clients: Int = 0,
    val pending: Int = 0,
    val activeAlarm: Boolean = false,
) {
    val atDesk: Boolean get() = presence == "desk"

    fun alarmsAllowed(now: Long = System.currentTimeMillis()): Boolean =
        !atDesk &&
            (alarmMode == "on" || (alarmMode == "timed" && alarmsUntil > now))

    fun alarmMinutes(now: Long = System.currentTimeMillis()): Long =
        if (alarmMode == "timed") {
            ((alarmsUntil - now + 59_999L) / 60_000L).coerceAtLeast(0L)
        } else {
            0L
        }
}

object BridgeStatusParser {
    fun parse(value: JSONObject?): BridgeStatus? {
        if (value == null) return null
        return BridgeStatus(
            presence = value.optString("presence", "away"),
            alarmMode = value.optString("alarmMode", "off"),
            alarmsUntil = value.optLong("alarmsUntil", 0L),
            clients = value.optInt("clients", 0),
            pending = value.optInt("pending", 0),
            activeAlarm = !value.isNull("activeAlarm"),
        )
    }

    fun events(value: JSONObject?): List<AgentEvent> {
        val array = value?.optJSONArray("events") ?: return emptyList()
        val result = mutableListOf<AgentEvent>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            EventParser.parse(item)?.let(result::add)
        }
        return result.asReversed()
    }
}
