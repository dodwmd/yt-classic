package io.github.dodwmd.ytclassic.ui

/** Tablets and phones in landscape (but not a narrow split-screen window: below 480dp the right pane would be tiny) show the watch screen as two panes (player left, details and related right). */
fun useTwoPane(widthDp: Int, heightDp: Int): Boolean = widthDp >= 600 || (widthDp > heightDp && widthDp >= 480)

/** Home and search lists become a two-column grid on wide tablets. */
fun listColumns(widthDp: Int): Int = if (widthDp >= 840) 2 else 1
