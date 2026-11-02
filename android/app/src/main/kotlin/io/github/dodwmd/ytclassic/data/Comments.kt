package io.github.dodwmd.ytclassic.data

import java.util.Locale

// Wording for the Watch screen's comments, kept free of UI so it can be tested (mirrors frontend/public/js/comments.js).

/** Shown for the backend's "comments-disabled" code, whatever message an older or newer server sends with it. */
const val COMMENTS_OFF = "Comments are turned off for this video."

const val COMMENTS_DISABLED_CODE = "comments-disabled"

/** The label of the row that opens or closes the comments: "Show comments (1,234)" / "Hide comments (1,234)"; no count when unknown. */
fun commentsToggleLabel(count: Long?, open: Boolean): String =
    (if (open) "Hide comments" else "Show comments") + (count?.let { " (%,d)".format(Locale.US, it) } ?: "")

/** "Show 3 replies" / "Hide 1 reply". */
fun repliesLabel(count: Int, open: Boolean): String =
    "${if (open) "Hide" else "Show"} %,d ${if (count == 1) "reply" else "replies"}".format(Locale.US, count)

/** "1,234 likes"; empty for none. */
fun likesLabel(likes: Long): String = if (likes <= 0) "" else "%,d ${if (likes == 1L) "like" else "likes"}".format(Locale.US, likes)

/** The muted line under the author: "3 days ago", plus "(edited)" when the comment was changed after posting. */
fun commentAge(c: Comment, nowMillis: Long = System.currentTimeMillis()): String =
    joinParts(timeAgo(c.publishedAt, nowMillis).ifEmpty { null }, if (c.updatedAt != null) "(edited)" else null)

/** The spoken name of a replies button: it says whose comment it belongs to. */
fun repliesDescription(count: Int, open: Boolean, author: String): String = "${repliesLabel(count, open)} to ${author.ifBlank { "this comment" }}"

/** What the footer under a list of comments (or replies) shows, decided from its page state alone. */
data class CommentFooter(
    val spinner: Boolean,
    /** The text to show: the error (or the turned-off note), else null. */
    val message: String?,
    val muted: Boolean,
    val openSettings: Boolean,
    val hint: String?,
    val retry: Boolean,
    val loadMore: Boolean,
    /** The "nothing here" note is shown. */
    val empty: Boolean,
)

fun commentFooter(s: PageState<*>): CommentFooter {
    val off = s.code == COMMENTS_DISABLED_CODE
    val actions = errorActions(s.code, s.retryable)
    return CommentFooter(
        spinner = s.loading,
        message = s.error?.let { if (off) COMMENTS_OFF else shortMessage(it) },
        muted = off,
        openSettings = s.error != null && s.needsToken,
        hint = if (s.error != null && !off) actions.hint else null,
        retry = s.error != null && actions.showRetry && !off,
        loadMore = s.canLoadMore && s.error == null,
        empty = s.started && s.items.isEmpty() && s.error == null && s.token == null && !s.loading,
    )
}
