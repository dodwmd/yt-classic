package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.isPrivateHost
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ServerAddressTest {
    @Test
    fun privateAndLocalHostsAreRecognised() {
        for (h in listOf("192.168.1.153", "10.0.0.5", "172.16.0.1", "172.31.255.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "100.127.1.1",
            "localhost", "nas", "yt.local", "box.lan", "pi.home.arpa", "host.internal", "mybox.tail1234.ts.net", "[::1]", "fd12::1", "fe80::1")) {
            assertTrue(isPrivateHost(h), h)
        }
    }

    @Test
    fun publicHostsAreNot() {
        for (h in listOf("8.8.8.8", "172.32.0.1", "172.15.0.1", "100.128.0.1", "100.63.0.1", "192.169.1.1", "yt.example.com", "example.org", "2001:db8::1", "")) {
            assertFalse(isPrivateHost(h), h)
        }
    }
}
