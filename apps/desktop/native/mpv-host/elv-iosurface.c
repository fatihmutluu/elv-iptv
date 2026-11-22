/*
 * Minimal ABI-stable Node-API (N-API v8) helper for macOS cross-process IOSurface lookup.
 * Exports lookup(surfaceId: number): Buffer | null and release(surfaceBuf: Buffer): void.
 */
#define NAPI_VERSION 8
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <node_api.h>

static napi_value js_lookup(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value arg = NULL;
    napi_valuetype type = napi_undefined;
    double raw = 0.0;
    uint32_t sid;
    IOSurfaceRef surf;
    napi_value out = NULL;

    if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok)
        return NULL;
    if (argc < 1 || napi_typeof(env, arg, &type) != napi_ok || type != napi_number) {
        napi_throw_type_error(env, NULL, "surfaceId must be a uint32 number");
        return NULL;
    }
    if (napi_get_value_double(env, arg, &raw) != napi_ok)
        return NULL;
    if (!(raw >= 0.0 && raw <= (double)UINT32_MAX)) {
        napi_throw_type_error(env, NULL, "surfaceId must be an integer in [0, 4294967295]");
        return NULL;
    }
    sid = (uint32_t)raw;
    if ((double)sid != raw) {
        napi_throw_type_error(env, NULL, "surfaceId must be an integer in [0, 4294967295]");
        return NULL;
    }
    if (sid == 0)
        return napi_get_null(env, &out) == napi_ok ? out : NULL;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    surf = IOSurfaceLookup((IOSurfaceID)sid);
#pragma clang diagnostic pop
    if (surf == NULL)
        return napi_get_null(env, &out) == napi_ok ? out : NULL;
    if (napi_create_buffer_copy(env, sizeof(IOSurfaceRef), &surf, NULL, &out) != napi_ok) {
        CFRelease(surf);
        return NULL;
    }
    return out;
}

static napi_value js_release(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value arg = NULL;
    bool is_buf = false;
    void *data = NULL;
    size_t len = 0;
    IOSurfaceRef surf = NULL;
    napi_value undef = NULL;

    if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok)
        return NULL;
    if (argc < 1 || napi_is_buffer(env, arg, &is_buf) != napi_ok || !is_buf) {
        napi_throw_type_error(env, NULL, "surface must be a Buffer");
        return NULL;
    }
    if (napi_get_buffer_info(env, arg, &data, &len) != napi_ok)
        return NULL;
    if (data == NULL || len != sizeof(IOSurfaceRef)) {
        napi_throw_type_error(env, NULL, "surface buffer must have IOSurfaceRef pointer length");
        return NULL;
    }
    memcpy(&surf, data, sizeof(IOSurfaceRef));
    memset(data, 0, sizeof(IOSurfaceRef));
    if (surf != NULL)
        CFRelease(surf);
    return napi_get_undefined(env, &undef) == napi_ok ? undef : NULL;
}

NAPI_MODULE_INIT()
{
    napi_value fn = NULL;

    if (napi_create_function(env, "lookup", NAPI_AUTO_LENGTH, js_lookup, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "lookup", fn) != napi_ok)
        return NULL;
    if (napi_create_function(env, "release", NAPI_AUTO_LENGTH, js_release, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "release", fn) != napi_ok)
        return NULL;
    return exports;
}
