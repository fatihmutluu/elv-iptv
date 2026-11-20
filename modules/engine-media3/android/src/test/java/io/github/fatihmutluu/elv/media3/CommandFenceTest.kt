package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandFenceTest {
  private fun sampleRequest(url: String) = LoadRequest(
    url = url,
    headers = emptyMap(),
    live = true,
    startMs = null,
    softwareAudio = false,
  )

  @Test
  fun `supersedes an earlier queued load when a newer load arrives before execution`() {
    val fence = CommandFence()
    val req1 = sampleRequest("http://sim/live/a/a/1.ts")
    val req2 = sampleRequest("http://sim/live/a/a/2.ts")
    val epoch1 = fence.recordLoad(1, req1)!!
    val epoch2 = fence.recordLoad(2, req2)!!

    assertEquals(CommandFence.MediaAction.Superseded, fence.beginMedia(epoch1))
    assertEquals(
      CommandFence.MediaAction.Run(epoch = epoch2, rebuildFirst = false, request = req2),
      fence.beginMedia(epoch2),
    )
    assertNull(fence.filterOutboundToken("state", driverEpoch = epoch1, driverToken = 1))
    assertEquals(2, fence.filterOutboundToken("state", driverEpoch = epoch2, driverToken = 2))
  }

  @Test
  fun `coalesces recreate into a following load or retry while preserving rebuildFirst and request`() {
    val fence = CommandFence()
    val req1 = sampleRequest("http://sim/live/a/a/1.ts")
    val loadEpoch = fence.recordLoad(1, req1)!!
    val recreateEpoch = fence.recordRecreate(2)!!
    val retryEpoch = fence.recordRetry(3)!!

    assertEquals(CommandFence.MediaAction.Superseded, fence.beginMedia(loadEpoch))
    assertEquals(CommandFence.RecreateAction.Superseded, fence.beginRecreate(recreateEpoch))
    assertEquals(
      CommandFence.MediaAction.Run(epoch = retryEpoch, rebuildFirst = true, request = req1),
      fence.beginMedia(retryEpoch),
    )
  }

  @Test
  fun `executes standalone recreate once and clears pendingRebuild`() {
    val fence = CommandFence()
    val epoch = fence.recordRecreate(2)!!

    assertEquals(CommandFence.RecreateAction.Run(epoch), fence.beginRecreate(epoch))
    assertEquals(CommandFence.RecreateAction.Superseded, fence.beginRecreate(epoch))
  }

  @Test
  fun `in-epoch pause and play adopt newer token and filter stale events while keeping tracks and surface`() {
    val fence = CommandFence()
    val req = sampleRequest("http://sim/live/a/a/1.ts")
    val epoch1 = fence.recordLoad(1, req)!!
    assertEquals(epoch1, fence.recordInEpochCommand(2))
    assertTrue(fence.beginInEpoch(epoch1))

    assertNull(fence.filterOutboundToken("clock", driverEpoch = epoch1, driverToken = 1))
    assertEquals(2, fence.filterOutboundToken("clock", driverEpoch = epoch1, driverToken = 2))
    assertEquals(2, fence.filterOutboundToken("tracks", driverEpoch = epoch1, driverToken = 1))
    assertEquals(2, fence.filterOutboundToken("surface", driverEpoch = 0, driverToken = 0))
  }

  @Test
  fun `stop advances epoch, clears pending request, and silences prior media events`() {
    val fence = CommandFence()
    val epoch1 = fence.recordLoad(1, sampleRequest("http://sim/live/a/a/1.ts"))!!
    val stopEpoch = fence.recordStop(2)!!

    assertEquals(CommandFence.MediaAction.Superseded, fence.beginMedia(epoch1))
    assertFalse(fence.beginInEpoch(epoch1))
    assertTrue(fence.canRunStop())
    assertNull(fence.filterOutboundToken("state", driverEpoch = epoch1, driverToken = 1))
    assertNull(fence.filterOutboundToken("tracks", driverEpoch = epoch1, driverToken = 1))
    assertEquals(2, fence.filterOutboundToken("surface", driverEpoch = epoch1, driverToken = 1))

    val retryEpoch = fence.recordRetry(3)!!
    assertEquals(
      CommandFence.MediaAction.Run(epoch = retryEpoch, rebuildFirst = false, request = null),
      fence.beginMedia(retryEpoch),
    )
    assertTrue(stopEpoch < retryEpoch)
  }

  @Test
  fun `markDisposed is idempotent and blocks all future commands and outbound events`() {
    val fence = CommandFence()
    val epoch1 = fence.recordLoad(1, sampleRequest("http://sim/live/a/a/1.ts"))!!

    assertTrue(fence.markDisposed())
    assertFalse(fence.markDisposed())
    assertTrue(fence.isDisposedNow)
    assertNull(fence.recordLoad(2, sampleRequest("http://sim/live/a/a/2.ts")))
    assertNull(fence.recordRetry(3))
    assertNull(fence.recordInEpochCommand(4))
    assertNull(fence.recordStop(5))
    assertNull(fence.recordRecreate(6))
    assertEquals(CommandFence.MediaAction.Superseded, fence.beginMedia(epoch1))
    assertFalse(fence.beginInEpoch(epoch1))
    assertFalse(fence.canRunStop())
    assertNull(fence.filterOutboundToken("surface", driverEpoch = epoch1, driverToken = 1))
    assertNull(fence.filterOutboundToken("state", driverEpoch = epoch1, driverToken = 1))
  }
}
