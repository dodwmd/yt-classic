package io.github.dodwmd.ytclassic.data

/**
 * Which videos are in Watch later, as far as this screen knows. Plain Kotlin so it can be tested on the JVM.
 *
 * Ids are asked about once, in chunks of 100 (the server's limit). A chunk that fails stays unasked (a later call
 * retries it) and earlier chunks are kept. A reply that arrives after the user toggled one of its videos is not
 * allowed to overwrite what the user did since the request started.
 */
class MembershipTracker(private val fetch: suspend (List<String>) -> Set<String>) {
    var members: Set<String> = emptySet()
        private set

    private val asked = mutableSetOf<String>()
    private var tick = 0
    private val toggledAt = mutableMapOf<String, Int>()

    /** Whether the server has told us about [id] (or the user has changed it): an unknown id has no definite state. */
    fun known(id: String) = id in asked || id in toggledAt

    /** Asks about the ids not asked yet; [onChange] runs after each chunk. Throws on the first failing chunk. */
    suspend fun load(ids: List<String>, onChange: () -> Unit = {}) {
        for (chunk in ids.filter { it !in asked }.distinct().chunked(MAX_IDS)) {
            val started = tick
            val reply = fetch(chunk)
            for (id in chunk) {
                if ((toggledAt[id] ?: -1) > started) continue // toggled while we waited: the user's action wins
                members = if (id in reply) members + id else members - id
            }
            asked += chunk
            onChange()
        }
    }

    /** The user added or removed [id]. */
    fun set(id: String, inList: Boolean) {
        toggledAt[id] = ++tick
        members = if (inList) members + id else members - id
    }

    companion object {
        const val MAX_IDS = 100
    }
}
