package io.github.dodwmd.ytclassic.player

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import io.github.dodwmd.ytclassic.data.retryStreamStatus

/** Default retries for network trouble, none for an HTTP answer that retrying can't change (see [retryStreamStatus]). */
@OptIn(UnstableApi::class)
internal class StreamErrorPolicy : DefaultLoadErrorHandlingPolicy() {
    override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
        val http = loadErrorInfo.exception as? HttpDataSource.InvalidResponseCodeException
        if (http != null && !retryStreamStatus(http.responseCode, http.responseBody.decodeToString())) return C.TIME_UNSET
        return super.getRetryDelayMsFor(loadErrorInfo)
    }
}
