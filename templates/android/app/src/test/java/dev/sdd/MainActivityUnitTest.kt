package dev.sdd

import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MainActivityUnitTest {
    @Test
    fun activityCreatesSuccessfully() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).create().get()
        assertTrue(activity.window.decorView.isShown)
    }
}
