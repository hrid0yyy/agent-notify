package dev.hridoy.agentnotify

import org.json.JSONObject

data class EventOption(
    val id: String,
    val label: String,
    val destructive: Boolean,
)

data class AgentEvent(
    val id: String,
    val kind: String,
    val title: String,
    val body: String,
    val agent: String,
    val project: String,
    val askId: String?,
    val options: List<EventOption>,
    val allowText: Boolean,
) {
    val attention: Boolean
        get() = kind == "needs_input" || kind == "error"
}

object EventParser {
    fun parse(obj: JSONObject): AgentEvent? {
        val id = obj.optString("id").ifBlank { return null }
        val options = mutableListOf<EventOption>()
        val array = obj.optJSONArray("options")
        if (array != null) {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val optionId = item.optString("id").ifBlank { continue }
                options += EventOption(
                    id = optionId,
                    label = item.optString("label", optionId),
                    destructive = item.optString("style") == "destructive",
                )
            }
        }
        return AgentEvent(
            id = id,
            kind = obj.optString("kind", "info"),
            title = obj.optString("title", "Agent update"),
            body = obj.optString("body", ""),
            agent = obj.optString("agent", "agent"),
            project = obj.optString("project", ""),
            askId = obj.optString("askId").takeIf { it.isNotBlank() },
            options = options,
            allowText = obj.optBoolean("allowText", false),
        )
    }
}
