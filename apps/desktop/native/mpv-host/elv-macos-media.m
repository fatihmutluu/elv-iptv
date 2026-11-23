/*
 * Minimal ABI-stable Node-API (N-API v8) helper for macOS MediaPlayer remote commands,
 * Now Playing metadata, and NSScreen.screensHaveSeparateSpaces (zero Accessibility prompts).
 *
 * Exports:
 *   screensHaveSeparateSpaces(): boolean
 *   installRemoteCommands(callback: (event) => void): void
 *   uninstallRemoteCommands(): void
 *   setNowPlaying(info | null): void
 */
#define NAPI_VERSION 8
#include <math.h>
#include <os/lock.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <node_api.h>

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <MediaPlayer/MediaPlayer.h>

#define MAX_REMOTE_COMMANDS 10
#define MAX_TEXT_BYTES 2048

typedef struct {
    char type[32];
    bool has_offset;
    double offset_sec;
    bool has_position;
    double position_sec;
} RemoteEventPayload;

static os_unfair_lock g_tsfn_lock = OS_UNFAIR_LOCK_INIT;
static napi_threadsafe_function g_tsfn = NULL;
static bool g_cleanup_registered = false;
static MPRemoteCommand *g_commands[MAX_REMOTE_COMMANDS];
static id g_tokens[MAX_REMOTE_COMMANDS];
static size_t g_command_count = 0;

static void dispatch_remote_event(const char *type, bool has_offset, double offset_sec,
                                  bool has_position, double position_sec)
{
    RemoteEventPayload *payload = (RemoteEventPayload *)calloc(1, sizeof(RemoteEventPayload));
    if (payload == NULL)
        return;
    strlcpy(payload->type, type, sizeof(payload->type));
    payload->has_offset = has_offset;
    payload->offset_sec = offset_sec;
    payload->has_position = has_position;
    payload->position_sec = position_sec;

    os_unfair_lock_lock(&g_tsfn_lock);
    napi_threadsafe_function tsfn = g_tsfn;
    napi_status st = napi_closing;
    if (tsfn != NULL)
        st = napi_call_threadsafe_function(tsfn, payload, napi_tsfn_nonblocking);
    os_unfair_lock_unlock(&g_tsfn_lock);

    if (st != napi_ok)
        free(payload);
}

static void call_js_remote_command(napi_env env, napi_value js_callback, void *context, void *data)
{
    (void)context;
    RemoteEventPayload *payload = (RemoteEventPayload *)data;
    if (payload == NULL)
        return;
    if (env == NULL || js_callback == NULL) {
        free(payload);
        return;
    }

    napi_value obj = NULL;
    napi_value val = NULL;
    napi_value global = NULL;
    if (napi_create_object(env, &obj) == napi_ok &&
        napi_create_string_utf8(env, payload->type, NAPI_AUTO_LENGTH, &val) == napi_ok &&
        napi_set_named_property(env, obj, "type", val) == napi_ok) {
        if (payload->has_offset && isfinite(payload->offset_sec)) {
            if (napi_create_double(env, payload->offset_sec, &val) == napi_ok)
                napi_set_named_property(env, obj, "offsetSec", val);
        }
        if (payload->has_position && isfinite(payload->position_sec)) {
            if (napi_create_double(env, payload->position_sec, &val) == napi_ok)
                napi_set_named_property(env, obj, "positionSec", val);
        }
        if (napi_get_global(env, &global) == napi_ok) {
            napi_call_function(env, global, js_callback, 1, &obj, NULL);
        }
    }
    free(payload);
}

static void register_command(MPRemoteCommand *cmd,
                             MPRemoteCommandHandlerStatus (^handler)(MPRemoteCommandEvent *event))
{
    if (cmd == nil || g_command_count >= MAX_REMOTE_COMMANDS)
        return;
    cmd.enabled = NO;
    id token = [cmd addTargetWithHandler:handler];
    if (token != nil) {
        g_commands[g_command_count] = cmd;
        g_tokens[g_command_count] = token;
        g_command_count += 1;
    }
}

static void uninstall_all_commands(void)
{
    @autoreleasepool {
        for (size_t i = 0; i < g_command_count; i++) {
            if (g_commands[i] != nil && g_tokens[i] != nil) {
                [g_commands[i] removeTarget:g_tokens[i]];
                g_commands[i].enabled = NO;
            }
            g_commands[i] = nil;
            g_tokens[i] = nil;
        }
        g_command_count = 0;
    }

    os_unfair_lock_lock(&g_tsfn_lock);
    napi_threadsafe_function old_tsfn = g_tsfn;
    g_tsfn = NULL;
    os_unfair_lock_unlock(&g_tsfn_lock);

    if (old_tsfn != NULL)
        napi_release_threadsafe_function(old_tsfn, napi_tsfn_abort);
}

static void cleanup_hook(void *arg)
{
    (void)arg;
    g_cleanup_registered = false;
    uninstall_all_commands();
    @autoreleasepool {
        MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
        center.nowPlayingInfo = nil;
        center.playbackState = MPNowPlayingPlaybackStateStopped;
    }
}

static napi_value js_screens_have_separate_spaces(napi_env env, napi_callback_info info)
{
    (void)info;
    napi_value out = NULL;
    bool separate = true;
    @autoreleasepool {
        separate = [NSScreen screensHaveSeparateSpaces] ? true : false;
    }
    return napi_get_boolean(env, separate, &out) == napi_ok ? out : NULL;
}

static napi_value js_install_remote_commands(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value cb = NULL;
    napi_valuetype type = napi_undefined;
    napi_value resource_name = NULL;
    napi_threadsafe_function tsfn = NULL;
    napi_value undef = NULL;

    if (napi_get_cb_info(env, info, &argc, &cb, NULL, NULL) != napi_ok)
        return NULL;
    if (argc < 1 || napi_typeof(env, cb, &type) != napi_ok || type != napi_function) {
        napi_throw_type_error(env, NULL, "callback must be a function");
        return NULL;
    }

    uninstall_all_commands();

    if (napi_create_string_utf8(env, "elv-macos-media", NAPI_AUTO_LENGTH, &resource_name) != napi_ok)
        return NULL;
    if (napi_create_threadsafe_function(env, cb, NULL, resource_name, 0, 1, NULL, NULL, NULL,
                                        call_js_remote_command, &tsfn) != napi_ok) {
        return NULL;
    }
    napi_unref_threadsafe_function(env, tsfn);

    os_unfair_lock_lock(&g_tsfn_lock);
    g_tsfn = tsfn;
    os_unfair_lock_unlock(&g_tsfn_lock);

    if (!g_cleanup_registered) {
        if (napi_add_env_cleanup_hook(env, cleanup_hook, NULL) == napi_ok)
            g_cleanup_registered = true;
    }

    @autoreleasepool {
        MPRemoteCommandCenter *center = [MPRemoteCommandCenter sharedCommandCenter];

        register_command(center.playCommand, ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            dispatch_remote_event("play", false, 0.0, false, 0.0);
            return MPRemoteCommandHandlerStatusSuccess;
        });
        register_command(center.pauseCommand, ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            dispatch_remote_event("pause", false, 0.0, false, 0.0);
            return MPRemoteCommandHandlerStatusSuccess;
        });
        register_command(center.togglePlayPauseCommand, ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            dispatch_remote_event("togglePlayPause", false, 0.0, false, 0.0);
            return MPRemoteCommandHandlerStatusSuccess;
        });
        register_command(center.stopCommand, ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            dispatch_remote_event("stop", false, 0.0, false, 0.0);
            return MPRemoteCommandHandlerStatusSuccess;
        });
        register_command(center.nextTrackCommand, ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            dispatch_remote_event("next", false, 0.0, false, 0.0);
            return MPRemoteCommandHandlerStatusSuccess;
        });
        register_command(center.previousTrackCommand, ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            (void)event;
            dispatch_remote_event("previous", false, 0.0, false, 0.0);
            return MPRemoteCommandHandlerStatusSuccess;
        });

        center.skipForwardCommand.preferredIntervals = @[ @10 ];
        register_command(center.skipForwardCommand, ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            double interval = 10.0;
            if ([event isKindOfClass:[MPSkipIntervalCommandEvent class]])
                interval = ((MPSkipIntervalCommandEvent *)event).interval;
            dispatch_remote_event("seekBy", true, interval, false, 0.0);
            return MPRemoteCommandHandlerStatusSuccess;
        });

        center.skipBackwardCommand.preferredIntervals = @[ @10 ];
        register_command(center.skipBackwardCommand, ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            double interval = 10.0;
            if ([event isKindOfClass:[MPSkipIntervalCommandEvent class]])
                interval = ((MPSkipIntervalCommandEvent *)event).interval;
            dispatch_remote_event("seekBy", true, -interval, false, 0.0);
            return MPRemoteCommandHandlerStatusSuccess;
        });

        register_command(center.changePlaybackPositionCommand, ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
            if ([event isKindOfClass:[MPChangePlaybackPositionCommandEvent class]]) {
                double pos = ((MPChangePlaybackPositionCommandEvent *)event).positionTime;
                dispatch_remote_event("seekTo", false, 0.0, true, pos);
                return MPRemoteCommandHandlerStatusSuccess;
            }
            return MPRemoteCommandHandlerStatusCommandFailed;
        });
    }

    return napi_get_undefined(env, &undef) == napi_ok ? undef : NULL;
}

static napi_value js_uninstall_remote_commands(napi_env env, napi_callback_info info)
{
    (void)info;
    napi_value undef = NULL;
    uninstall_all_commands();
    return napi_get_undefined(env, &undef) == napi_ok ? undef : NULL;
}

static NSString *read_optional_string(napi_env env, napi_value obj, const char *key)
{
    napi_value prop = NULL;
    napi_valuetype type = napi_undefined;
    if (napi_get_named_property(env, obj, key, &prop) != napi_ok)
        return nil;
    if (napi_typeof(env, prop, &type) != napi_ok || type != napi_string)
        return nil;
    char buf[MAX_TEXT_BYTES];
    size_t len = 0;
    if (napi_get_value_string_utf8(env, prop, buf, sizeof(buf), &len) != napi_ok)
        return nil;
    return [NSString stringWithUTF8String:buf];
}

static bool read_optional_double(napi_env env, napi_value obj, const char *key, double *out)
{
    napi_value prop = NULL;
    napi_valuetype type = napi_undefined;
    double val = 0.0;
    if (napi_get_named_property(env, obj, key, &prop) != napi_ok)
        return false;
    if (napi_typeof(env, prop, &type) != napi_ok || type != napi_number)
        return false;
    if (napi_get_value_double(env, prop, &val) != napi_ok || !isfinite(val))
        return false;
    *out = val;
    return true;
}

static bool read_optional_bool(napi_env env, napi_value obj, const char *key, bool fallback)
{
    napi_value prop = NULL;
    napi_valuetype type = napi_undefined;
    bool val = fallback;
    if (napi_get_named_property(env, obj, key, &prop) != napi_ok)
        return fallback;
    if (napi_typeof(env, prop, &type) != napi_ok || type != napi_boolean)
        return fallback;
    if (napi_get_value_bool(env, prop, &val) != napi_ok)
        return fallback;
    return val;
}

static napi_value js_set_now_playing(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value arg = NULL;
    napi_valuetype type = napi_undefined;
    napi_value undef = NULL;

    if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok)
        return NULL;

    if (argc < 1 || napi_typeof(env, arg, &type) != napi_ok ||
        type == napi_null || type == napi_undefined) {
        @autoreleasepool {
            MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
            center.nowPlayingInfo = nil;
            center.playbackState = MPNowPlayingPlaybackStateStopped;
            for (size_t i = 0; i < g_command_count; i++) {
                if (g_commands[i] != nil)
                    g_commands[i].enabled = NO;
            }
        }
        return napi_get_undefined(env, &undef) == napi_ok ? undef : NULL;
    }

    if (type != napi_object) {
        napi_throw_type_error(env, NULL, "nowPlaying info must be an object or null");
        return NULL;
    }

    @autoreleasepool {
        NSMutableDictionary *dict = [NSMutableDictionary dictionary];
        NSString *title = read_optional_string(env, arg, "title");
        if (title != nil && title.length > 0)
            dict[MPMediaItemPropertyTitle] = title;
        NSString *artist = read_optional_string(env, arg, "artist");
        if (artist != nil && artist.length > 0)
            dict[MPMediaItemPropertyArtist] = artist;

        NSString *stateStr = read_optional_string(env, arg, "playbackState");
        MPNowPlayingPlaybackState pbState = MPNowPlayingPlaybackStateStopped;
        if ([stateStr isEqualToString:@"playing"])
            pbState = MPNowPlayingPlaybackStatePlaying;
        else if ([stateStr isEqualToString:@"paused"])
            pbState = MPNowPlayingPlaybackStatePaused;

        double rate = 1.0;
        read_optional_double(env, arg, "playbackRate", &rate);
        if (!(rate > 0.0))
            rate = 1.0;
        dict[MPNowPlayingInfoPropertyDefaultPlaybackRate] = @1.0;
        dict[MPNowPlayingInfoPropertyPlaybackRate] =
            pbState == MPNowPlayingPlaybackStatePlaying ? @(rate) : @0.0;

        double durationSec = 0.0;
        double elapsedSec = 0.0;
        if (read_optional_double(env, arg, "durationSec", &durationSec) && durationSec > 0.0) {
            dict[MPMediaItemPropertyPlaybackDuration] = @(durationSec);
            if (read_optional_double(env, arg, "elapsedSec", &elapsedSec) && elapsedSec >= 0.0)
                dict[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @(elapsedSec);
            dict[MPNowPlayingInfoPropertyIsLiveStream] = @NO;
        } else {
            dict[MPNowPlayingInfoPropertyIsLiveStream] = @YES;
        }

        MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
        center.nowPlayingInfo = dict;
        center.playbackState = pbState;

        if (g_command_count > 0) {
            MPRemoteCommandCenter *rc = [MPRemoteCommandCenter sharedCommandCenter];
            bool canNext = read_optional_bool(env, arg, "canGoNext", false);
            bool canPrev = read_optional_bool(env, arg, "canGoPrevious", false);
            bool canSeek = read_optional_bool(env, arg, "canSeek", false);
            rc.playCommand.enabled = YES;
            rc.pauseCommand.enabled = YES;
            rc.togglePlayPauseCommand.enabled = YES;
            rc.stopCommand.enabled = YES;
            rc.nextTrackCommand.enabled = canNext ? YES : NO;
            rc.previousTrackCommand.enabled = canPrev ? YES : NO;
            rc.changePlaybackPositionCommand.enabled = canSeek ? YES : NO;
            rc.skipForwardCommand.enabled = canSeek ? YES : NO;
            rc.skipBackwardCommand.enabled = canSeek ? YES : NO;
        }
    }

    return napi_get_undefined(env, &undef) == napi_ok ? undef : NULL;
}

NAPI_MODULE_INIT()
{
    napi_value fn = NULL;

    if (napi_create_function(env, "screensHaveSeparateSpaces", NAPI_AUTO_LENGTH,
                             js_screens_have_separate_spaces, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "screensHaveSeparateSpaces", fn) != napi_ok)
        return NULL;
    if (napi_create_function(env, "installRemoteCommands", NAPI_AUTO_LENGTH,
                             js_install_remote_commands, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "installRemoteCommands", fn) != napi_ok)
        return NULL;
    if (napi_create_function(env, "uninstallRemoteCommands", NAPI_AUTO_LENGTH,
                             js_uninstall_remote_commands, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "uninstallRemoteCommands", fn) != napi_ok)
        return NULL;
    if (napi_create_function(env, "setNowPlaying", NAPI_AUTO_LENGTH,
                             js_set_now_playing, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "setNowPlaying", fn) != napi_ok)
        return NULL;
    return exports;
}
