package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.ApiJson
import io.github.dodwmd.ytclassic.data.ImportResult
import io.github.dodwmd.ytclassic.data.ImportSkipped
import io.github.dodwmd.ytclassic.data.importSummary
import io.github.dodwmd.ytclassic.data.readBytesLimited
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SubscriptionsIoTest {
    private fun fixture(name: String) = javaClass.getResource("/$name.json")!!.readText()

    @Test
    fun parsesRealImportResponse() {
        val r = ApiJson.decodeFromString<ImportResult>(fixture("import"))
        assertEquals(ImportResult(added = 7, existing = 2, skipped = ImportSkipped(invalid = 1, handles = 3, full = 4), total = 500), r)
    }

    @Test
    fun missingFieldsDefaultToZero() {
        assertEquals(ImportResult(), ApiJson.decodeFromString<ImportResult>("{}"))
    }

    @Test
    fun summaryListsOnlyWhatWasSkipped() {
        assertEquals("Added 3, 2 already subscribed. You now have 5 subscriptions.", importSummary(ImportResult(3, 2, ImportSkipped(), 5)))
        assertEquals("Added 0, 0 already subscribed. You now have 1 subscription.", importSummary(ImportResult(0, 0, ImportSkipped(), 1)))
        assertEquals(
            "Added 1, 0 already subscribed. Skipped 2 invalid, 3 @handle (can't be resolved), 4 over the limit of 500. You now have 500 subscriptions.",
            importSummary(ImportResult(1, 0, ImportSkipped(2, 3, 4), 500)),
        )
    }

    @Test
    fun readBytesLimitedAcceptsUpToTheLimitOnly() {
        assertContentEquals("héllo".toByteArray(), readBytesLimited("héllo".byteInputStream(), max = 10))
        assertContentEquals("abc".toByteArray(), readBytesLimited("abc".byteInputStream(), max = 3))
        assertNull(readBytesLimited("abcd".byteInputStream(), max = 3))
    }

    @Test
    fun readBytesLimitedKeepsTheBytesUntouched() {
        // Latin-1 and UTF-16 files must reach the server byte for byte (decoding and re-encoding would change them).
        val latin1 = byteArrayOf(0x43, 0x61, 0x66, 0xe9.toByte())
        assertContentEquals(latin1, readBytesLimited(latin1.inputStream()))
        val utf16 = byteArrayOf(0xff.toByte(), 0xfe.toByte(), 0x41, 0x00)
        assertContentEquals(utf16, readBytesLimited(utf16.inputStream()))
        assertContentEquals(ByteArray(0), readBytesLimited(ByteArray(0).inputStream()))
    }
}
