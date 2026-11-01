package io.github.dodwmd.ytclassic.player

/** TV is available from this many subscriptions (the server enforces it too). */
const val TV_MIN_SUBS = 5

/** Consecutive failures (no video found, or one that would not play) after which TV stops. */
const val TV_MAX_FAILURES = 3

/** How many recently played ids are sent with each request so they are not picked again. */
const val TV_SEEN = 50

/** Null when TV can be turned on with [have] subscriptions, else the reason, e.g. "Subscribe to 2 more channels to turn on TV". */
fun tvNeedMessage(have: Int, need: Int = TV_MIN_SUBS): String? {
    val more = need - have
    return if (more <= 0) null else "Subscribe to $more more channel${if (more == 1) "" else "s"} to turn on TV"
}

fun tvFailureMessage(cause: String?): String = "TV stopped after $TV_MAX_FAILURES failures in a row${cause?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}"

/** TV stopped because the server says there are too few subscriptions now. */
fun tvNeedStopMessage(serverMessage: String): String = "TV stopped. ${serverMessage.trimEnd('.')}."

/**
 * The state of one TV session, with no Android in it: which channel played last, the ring of recently played ids and
 * the count of consecutive failures. [PlaybackHost] feeds it events and asks what to send; the server does the picking.
 */
class TvSession(private val maxFailures: Int = TV_MAX_FAILURES, private val keep: Int = TV_SEEN) {
    private val recent = ArrayDeque<String>()

    /** Channel of the video last started: the next one must come from another channel. Empty before the first. */
    var after: String = ""
        private set

    var failures: Int = 0
        private set

    /** Oldest first, at most [keep]. */
    val seen: List<String> get() = recent.toList()

    /** A video was handed to the player. */
    fun started(videoId: String, channelId: String) {
        recent.remove(videoId)
        recent.addLast(videoId)
        while (recent.size > keep) recent.removeFirst()
        after = channelId
    }

    /** Something really played: the failure streak is over. */
    fun playing() {
        failures = 0
    }

    /** One more failure; true when TV must stop now. */
    fun failed(): Boolean = ++failures >= maxFailures
}
