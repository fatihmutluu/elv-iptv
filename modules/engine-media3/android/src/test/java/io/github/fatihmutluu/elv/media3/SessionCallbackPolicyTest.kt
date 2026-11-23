package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommands
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class SessionCallbackPolicyTest {
  @Test
  fun `untrusted controllers receive empty session commands and strictly bounded transport player commands (#132)`() {
    val result = SessionCallbackPolicy.resolveConnectionResult(isNotificationOrSystemController = false)
    assertTrue(result.isAccepted)
    assertEquals(SessionCommands.EMPTY, result.availableSessionCommands)

    val cmds = result.availablePlayerCommands
    assertTrue(cmds.contains(Player.COMMAND_PLAY_PAUSE))
    assertTrue(cmds.contains(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM))
    assertTrue(cmds.contains(Player.COMMAND_SEEK_BACK))
    assertTrue(cmds.contains(Player.COMMAND_SEEK_FORWARD))
    assertTrue(cmds.contains(Player.COMMAND_SEEK_TO_PREVIOUS))
    assertTrue(cmds.contains(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM))
    assertTrue(cmds.contains(Player.COMMAND_SEEK_TO_NEXT))
    assertTrue(cmds.contains(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM))
    assertTrue(cmds.contains(Player.COMMAND_STOP))
    assertTrue(cmds.contains(Player.COMMAND_GET_CURRENT_MEDIA_ITEM))
    assertTrue(cmds.contains(Player.COMMAND_GET_METADATA))

    // Explicitly blocked mutation commands
    assertFalse(cmds.contains(Player.COMMAND_SET_MEDIA_ITEM))
    assertFalse(cmds.contains(Player.COMMAND_CHANGE_MEDIA_ITEMS))
    assertFalse(cmds.contains(Player.COMMAND_SET_TRACK_SELECTION_PARAMETERS))
    assertFalse(cmds.contains(Player.COMMAND_SET_PLAYLIST_METADATA))
    assertFalse(cmds.contains(Player.COMMAND_SET_SPEED_AND_PITCH))
    assertFalse(cmds.contains(Player.COMMAND_SET_REPEAT_MODE))
    assertFalse(cmds.contains(Player.COMMAND_SET_SHUFFLE_MODE))
    assertFalse(cmds.contains(Player.COMMAND_SET_VOLUME))
  }

  @Test
  fun `notification and system controllers receive default session commands and read-only notification commands without media mutations (#132)`() {
    val result = SessionCallbackPolicy.resolveConnectionResult(isNotificationOrSystemController = true)
    assertTrue(result.isAccepted)
    assertEquals(MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS, result.availableSessionCommands)

    val cmds = result.availablePlayerCommands
    assertTrue(cmds.contains(Player.COMMAND_PLAY_PAUSE))
    assertTrue(cmds.contains(Player.COMMAND_PREPARE))
    assertTrue(cmds.contains(Player.COMMAND_GET_TIMELINE))
    assertTrue(cmds.contains(Player.COMMAND_GET_TRACKS))
    assertTrue(cmds.contains(Player.COMMAND_GET_AUDIO_ATTRIBUTES))
    assertTrue(cmds.contains(Player.COMMAND_GET_METADATA))

    assertFalse(cmds.contains(Player.COMMAND_SET_MEDIA_ITEM))
    assertFalse(cmds.contains(Player.COMMAND_CHANGE_MEDIA_ITEMS))
    assertFalse(cmds.contains(Player.COMMAND_SET_TRACK_SELECTION_PARAMETERS))
    assertFalse(cmds.contains(Player.COMMAND_SET_PLAYLIST_METADATA))
  }

  @Test
  fun `sanitizeArtworkUri rejects disallowed schemes and strips userinfo and credential query params (#412)`() {
    assertNull(SessionCallbackPolicy.sanitizeArtworkUri(null))
    assertNull(SessionCallbackPolicy.sanitizeArtworkUri(""))
    assertNull(SessionCallbackPolicy.sanitizeArtworkUri("   "))
    assertNull(SessionCallbackPolicy.sanitizeArtworkUri("file:///etc/passwd"))
    assertNull(SessionCallbackPolicy.sanitizeArtworkUri("content://media/external/images/1"))
    assertNull(SessionCallbackPolicy.sanitizeArtworkUri("javascript:alert(1)"))
    assertNull(SessionCallbackPolicy.sanitizeArtworkUri("data:image/png;base64,AAAA"))
    assertNull(SessionCallbackPolicy.sanitizeArtworkUri("rtmp://example.com/logo.png"))
    assertNull(SessionCallbackPolicy.sanitizeArtworkUri("https://example.com/logo.png\r\nX-Inject: 1"))

    assertEquals(
      "https://cdn.example.com/logos/ch1.png",
      SessionCallbackPolicy.sanitizeArtworkUri("https://alice:s3cr3t@cdn.example.com/logos/ch1.png")?.toString(),
    )
    assertEquals(
      "https://cdn.example.com/logos/ch1.png?size=256&fmt=webp",
      SessionCallbackPolicy.sanitizeArtworkUri(
        "https://user:pw@cdn.example.com/logos/ch1.png?size=256&password=123&pass=456&token=abc&auth=xyz&key=k&username=u&USER=u2&fmt=webp",
      )?.toString(),
    )
    assertEquals(
      "http://cdn.example.com/logo.jpg",
      SessionCallbackPolicy.sanitizeArtworkUri("  http://cdn.example.com/logo.jpg?token=secret&Auth=bearer  ")?.toString(),
    )
  }
}
