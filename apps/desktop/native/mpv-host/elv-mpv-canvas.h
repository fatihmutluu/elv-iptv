/*
 * In-canvas D3D11 render context and triple-buffered shared-texture named-pipe host for elv-mpv.
 * Active only when --elv-canvas-pipe=\\.\pipe\<name> is passed; legacy mode never calls this header.
 */
#ifndef ELV_MPV_CANVAS_H_
#define ELV_MPV_CANVAS_H_

#define COBJMACROS
#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable: 4201)
#endif
#include <d3d11.h>
#include <d3d10.h>
#include <dxgi1_2.h>
#ifdef _MSC_VER
#pragma warning(pop)
#endif
#include <stdint.h>
#include <stdio.h>
#include <mpv/render.h>
#include <mpv/render_d3d11.h>
#include "elv-mpv-canvas-io.h"

enum {
    CANVAS_SLOTS = 3, CANVAS_DEFAULT_W = 1280, CANVAS_DEFAULT_H = 720,
    CANVAS_MIN_DIM = 16, CANVAS_MAX_DIM = 4096,
    CANVAS_TIMEOUT_MS = 2000, CANVAS_DRAIN_TIMEOUT_MS = 250,
    EV_RENDER_STOP = 0, EV_RESIZE = 1, EV_FRAME = 2,
    EV_SHUTDOWN = 3, EV_READ = 4, EV_WRITE = 5,
    EV_DUP_FREE = 6, EV_DUP_EMPTY = 7, EV_PIPE_EOF = 8, EV_COUNT = 9
};

static const GUID ELV_IID_IDXGIResource1 = { 0x30961379, 0x4609, 0x4a41, { 0x99, 0x8e, 0x54, 0xfe, 0x56, 0x7e, 0xe0, 0xc1 } };
static const GUID ELV_IID_ID3D10Multithread = { 0x9b7e4e00, 0x342c, 0x4106, { 0xa1, 0x9f, 0x4f, 0x27, 0x04, 0xf6, 0x89, 0xf0 } };

typedef HRESULT (WINAPI *d3d11_create_device_fn)(
    IDXGIAdapter *, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL *, UINT, UINT,
    ID3D11Device **, D3D_FEATURE_LEVEL *, ID3D11DeviceContext **);
typedef int (*render_create_fn)(mpv_render_context **, mpv_handle *, mpv_render_param *);
typedef uint64_t (*render_update_fn)(mpv_render_context *);
typedef int (*render_render_fn)(mpv_render_context *, mpv_render_param *);
typedef void (*render_report_swap_fn)(mpv_render_context *);
typedef void (*render_set_cb_fn)(mpv_render_context *, mpv_render_update_fn, void *);
typedef void (*render_free_fn)(mpv_render_context *);

typedef struct CanvasState {
    mpv_handle *mpv;
    command_string_fn command;
    render_create_fn render_create; render_update_fn render_update;
    render_render_fn render_render; render_report_swap_fn render_report_swap;
    render_set_cb_fn render_set_cb; render_free_fn render_free;
    HMODULE d3d11_dll;
    ID3D11Device *device;
    ID3D11DeviceContext *ctx;
    mpv_render_context *rc;
    HANDLE parent, pipe, ev[EV_COUNT], render_thread, reader_thread;
    CRITICAL_SECTION state_cs, write_cs;
    ID3D11Texture2D *tex[CANVAS_SLOTS];
    HANDLE shared[CANVAS_SLOTS];
    PendingDupTable pending_dups;
    int in_flight[CANVAS_SLOTS];
    int cs_init, pipe_eof, pending_w, pending_h, cur_w, cur_h, next_slot, has_rendered;
    unsigned int gen;
} CanvasState;

static void canvas_init(CanvasState *c) {
    ZeroMemory(c, sizeof(*c));
    c->pipe = INVALID_HANDLE_VALUE; c->pending_w = CANVAS_DEFAULT_W; c->pending_h = CANVAS_DEFAULT_H;
}

static void canvas_on_update(void *cb_ctx) { SetEvent(((CanvasState *)cb_ctx)->ev[EV_FRAME]); }
static void canvas_unload(CanvasState *c) { if (c->d3d11_dll) { FreeLibrary(c->d3d11_dll); c->d3d11_dll = NULL; } }
static int canvas_is_shutdown(CanvasState *c) { return WaitForSingleObject(c->ev[EV_SHUTDOWN], 0) == WAIT_OBJECT_0; }

static void canvas_signal_shutdown(CanvasState *c) {
    if (c->ev[EV_RENDER_STOP]) SetEvent(c->ev[EV_RENDER_STOP]);
    if (c->ev[EV_SHUTDOWN]) SetEvent(c->ev[EV_SHUTDOWN]);
}

static void canvas_mark_pipe_eof(CanvasState *c) {
    EnterCriticalSection(&c->state_cs);
    c->pipe_eof = 1;
    LeaveCriticalSection(&c->state_cs);
    SetEvent(c->ev[EV_PIPE_EOF]);
}

static int canvas_load_symbols(CanvasState *c, HMODULE lib) {
    c->render_create = (render_create_fn)symbol(lib, "mpv_render_context_create");
    c->render_update = (render_update_fn)symbol(lib, "mpv_render_context_update");
    c->render_render = (render_render_fn)symbol(lib, "mpv_render_context_render");
    c->render_report_swap = (render_report_swap_fn)symbol(lib, "mpv_render_context_report_swap");
    c->render_set_cb = (render_set_cb_fn)symbol(lib, "mpv_render_context_set_update_callback");
    c->render_free = (render_free_fn)symbol(lib, "mpv_render_context_free");
    return c->render_create && c->render_update && c->render_render &&
           c->render_report_swap && c->render_set_cb && c->render_free;
}

static int canvas_write_all(CanvasState *c, const char *buf, size_t len) {
    int res = canvas_write_buf(
        c->pipe, &c->write_cs, c->ev[EV_RENDER_STOP], c->ev[EV_WRITE], buf, len, CANVAS_TIMEOUT_MS);
    if (res < 0) canvas_mark_pipe_eof(c);
    return res > 0;
}

static void canvas_release_slots(CanvasState *c) {
    int i;
    for (i = 0; i < CANVAS_SLOTS; i++) {
        canvas_close(&c->shared[i]);
        if (c->tex[i]) { ID3D11Texture2D_Release(c->tex[i]); c->tex[i] = NULL; }
    }
}

static int canvas_wait_dup_space(CanvasState *c) {
    ULONGLONG deadline = GetTickCount64() + CANVAS_TIMEOUT_MS;
    for (;;) {
        int have_space;
        HANDLE waits[2] = { c->ev[EV_RENDER_STOP], c->ev[EV_DUP_FREE] };
        ULONGLONG now;
        EnterCriticalSection(&c->state_cs);
        have_space = (c->pending_dups.count + CANVAS_SLOTS <= CANVAS_MAX_PENDING);
        LeaveCriticalSection(&c->state_cs);
        if (have_space) return 1;
        now = GetTickCount64();
        if (now >= deadline) return 0;
        if (WaitForMultipleObjects(2, waits, FALSE, (DWORD)(deadline - now)) != WAIT_OBJECT_0 + 1)
            return 0;
    }
}

static int canvas_recreate_ring(CanvasState *c, int w, int h)
{
    ID3D11Texture2D *new_tex[CANVAS_SLOTS] = { NULL, NULL, NULL };
    HANDLE new_shared[CANVAS_SLOTS] = { NULL, NULL, NULL };
    HANDLE dups[CANVAS_SLOTS] = { NULL, NULL, NULL };
    D3D11_TEXTURE2D_DESC desc = { 0 };
    unsigned int new_gen;
    int i;

    if (!canvas_wait_dup_space(c)) return 0;
    canvas_release_slots(c);
    desc.Width = (UINT)w; desc.Height = (UINT)h; desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;

    for (i = 0; i < CANVAS_SLOTS; i++) {
        IDXGIResource1 *res1 = NULL;
        HRESULT hr = ID3D11Device_CreateTexture2D(c->device, &desc, NULL, &new_tex[i]);
        if (FAILED(hr) || !new_tex[i]) goto fail;
        hr = ID3D11Texture2D_QueryInterface(new_tex[i], &ELV_IID_IDXGIResource1, (void **)&res1);
        if (FAILED(hr) || !res1) goto fail;
        hr = IDXGIResource1_CreateSharedHandle(res1, NULL, DXGI_SHARED_RESOURCE_READ, NULL, &new_shared[i]);
        IDXGIResource1_Release(res1);
        if (FAILED(hr) || !new_shared[i]) goto fail;
        if (!DuplicateHandle(GetCurrentProcess(), new_shared[i], c->parent, &dups[i],
                             0, FALSE, DUPLICATE_SAME_ACCESS) || !dups[i])
            goto fail;
    }

    EnterCriticalSection(&c->state_cs);
    new_gen = ++c->gen;
    for (i = 0; i < CANVAS_SLOTS; i++) c->in_flight[i] = 0;
    LeaveCriticalSection(&c->state_cs);
    for (i = 0; i < CANVAS_SLOTS; i++) { c->tex[i] = new_tex[i]; c->shared[i] = new_shared[i]; }
    c->cur_w = w; c->cur_h = h; c->next_slot = 0;

    for (i = 0; i < CANVAS_SLOTS; i++) {
        char msg[128];
        int n = snprintf(msg, sizeof(msg), "S %u %d %llu %d %d\n",
                         new_gen, i, (unsigned long long)(uintptr_t)dups[i], w, h);
        int added, j;
        if (n <= 0 || (size_t)n >= sizeof(msg)) {
            for (j = i; j < CANVAS_SLOTS; j++) canvas_close_parent_handle(c->parent, dups[j]);
            return 0;
        }
        EnterCriticalSection(&c->state_cs);
        added = pending_dup_add(&c->pending_dups, new_gen, (unsigned int)i, dups[i]);
        if (added) ResetEvent(c->ev[EV_DUP_EMPTY]);
        LeaveCriticalSection(&c->state_cs);
        if (!added || !canvas_write_all(c, msg, (size_t)n)) {
            HANDLE unsent = dups[i];
            if (added) {
                EnterCriticalSection(&c->state_cs);
                unsent = pending_dup_take(&c->pending_dups, new_gen, (unsigned int)i);
                if (c->pending_dups.count == 0) SetEvent(c->ev[EV_DUP_EMPTY]);
                LeaveCriticalSection(&c->state_cs);
            }
            canvas_close_parent_handle(c->parent, unsent);
            for (j = i + 1; j < CANVAS_SLOTS; j++) canvas_close_parent_handle(c->parent, dups[j]);
            return 0;
        }
    }
    return 1;
fail:
    for (i = 0; i < CANVAS_SLOTS; i++) {
        canvas_close_parent_handle(c->parent, dups[i]);
        canvas_close(&new_shared[i]);
        if (new_tex[i]) ID3D11Texture2D_Release(new_tex[i]);
    }
    return 0;
}

static void canvas_render_frame(CanvasState *c, int force_redraw)
{
    uint64_t flags = c->render_update(c->rc);
    int slot = -1, k, n;
    unsigned int cur_gen;
    char msg[96];

    if (!(flags & MPV_RENDER_UPDATE_FRAME) && !(force_redraw && c->has_rendered)) return;
    EnterCriticalSection(&c->state_cs);
    cur_gen = c->gen;
    for (k = 0; k < CANVAS_SLOTS; k++) {
        int idx = (c->next_slot + k) % CANVAS_SLOTS;
        if (!c->in_flight[idx]) {
            c->in_flight[idx] = 1; c->next_slot = (idx + 1) % CANVAS_SLOTS; slot = idx;
            break;
        }
    }
    LeaveCriticalSection(&c->state_cs);
    if (slot < 0) {
        int skip = 1;
        mpv_render_param p[] = { { MPV_RENDER_PARAM_SKIP_RENDERING, &skip }, { MPV_RENDER_PARAM_INVALID, NULL } };
        c->render_render(c->rc, p);
        c->render_report_swap(c->rc);
        return;
    }
    if (!c->tex[slot]) return;
    {
        mpv_d3d11_fbo fbo = { c->tex[slot] };
        mpv_render_param p[] = { { MPV_RENDER_PARAM_D3D11_FBO, &fbo }, { MPV_RENDER_PARAM_INVALID, NULL } };
        if (c->render_render(c->rc, p) < 0) {
            EnterCriticalSection(&c->state_cs);
            if (c->gen == cur_gen) c->in_flight[slot] = 0;
            LeaveCriticalSection(&c->state_cs);
            return;
        }
    }
    ID3D11DeviceContext_Flush(c->ctx);
    c->render_report_swap(c->rc);
    c->has_rendered = 1;
    n = snprintf(msg, sizeof(msg), "F %u %d %d %d\n", cur_gen, slot, c->cur_w, c->cur_h);
    if (n <= 0 || (size_t)n >= sizeof(msg) || !canvas_write_all(c, msg, (size_t)n))
        canvas_signal_shutdown(c);
}

static DWORD WINAPI canvas_render_thread(LPVOID param)
{
    CanvasState *c = (CanvasState *)param;
    int w, h;

    EnterCriticalSection(&c->state_cs);
    w = c->pending_w; h = c->pending_h;
    LeaveCriticalSection(&c->state_cs);
    if (!canvas_recreate_ring(c, w, h)) { canvas_signal_shutdown(c); return 0; }
    for (;;) {
        DWORD wr = WaitForMultipleObjects(3, c->ev, FALSE, INFINITE);
        if (wr == WAIT_OBJECT_0 + EV_RESIZE) {
            int same;
            EnterCriticalSection(&c->state_cs);
            w = c->pending_w; h = c->pending_h;
            same = (c->gen > 0 && w == c->cur_w && h == c->cur_h);
            LeaveCriticalSection(&c->state_cs);
            if (!same) {
                if (!canvas_recreate_ring(c, w, h)) { canvas_signal_shutdown(c); break; }
                canvas_render_frame(c, 1);
            }
        } else if (wr == WAIT_OBJECT_0 + EV_FRAME) {
            canvas_render_frame(c, 0);
        } else {
            break;
        }
    }
    return 0;
}

static void canvas_handle_line(void *ctx, const char *line)
{
    CanvasState *c = (CanvasState *)ctx;
    unsigned int a = 0, b = 0;
    if ((line[0] != 'R' && line[0] != 'A' && line[0] != 'I') || line[1] != ' ')
        return;
    if (!canvas_parse_u32_pair(line + 2, &a, &b))
        return;
    if (line[0] == 'R') {
        EnterCriticalSection(&c->state_cs);
        c->pending_w = canvas_clamp_u32(a, CANVAS_MIN_DIM, CANVAS_MAX_DIM);
        c->pending_h = canvas_clamp_u32(b, CANVAS_MIN_DIM, CANVAS_MAX_DIM);
        LeaveCriticalSection(&c->state_cs);
        SetEvent(c->ev[EV_RESIZE]);
    } else if (line[0] == 'A' && a > 0 && b < CANVAS_SLOTS) {
        EnterCriticalSection(&c->state_cs);
        if (a == c->gen) c->in_flight[b] = 0;
        LeaveCriticalSection(&c->state_cs);
    } else if (line[0] == 'I' && a > 0 && b < CANVAS_SLOTS) {
        HANDLE dup = NULL;
        EnterCriticalSection(&c->state_cs);
        dup = pending_dup_take(&c->pending_dups, a, b);
        if (dup) {
            SetEvent(c->ev[EV_DUP_FREE]);
            if (c->pending_dups.count == 0) SetEvent(c->ev[EV_DUP_EMPTY]);
        }
        LeaveCriticalSection(&c->state_cs);
        canvas_close_parent_handle(c->parent, dup);
    }
}

static DWORD WINAPI canvas_reader_thread(LPVOID param) {
    CanvasState *c = (CanvasState *)param;
    if (canvas_read_lines(c->pipe, c->ev[EV_SHUTDOWN], c->ev[EV_READ], canvas_handle_line, c) < 0)
        canvas_mark_pipe_eof(c);
    if (!canvas_is_shutdown(c)) {
        canvas_signal_shutdown(c);
        c->command(c->mpv, "quit");
    }
    return 0;
}

static int canvas_prepare(CanvasState *c, const wchar_t *pipe_path, HANDLE parent) {
    static const D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0
    };
    static const D3D_DRIVER_TYPE drivers[2] = { D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP };
    static const BOOL manual[EV_COUNT] = { TRUE, FALSE, FALSE, TRUE, TRUE, TRUE, FALSE, TRUE, TRUE };
    static const BOOL initial[EV_COUNT] = { FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE, FALSE };
    d3d11_create_device_fn create_dev;
    ID3D10Multithread *mt = NULL;
    HRESULT hr = E_FAIL;
    int i;

    c->parent = parent;
    c->d3d11_dll = LoadLibraryExW(L"d3d11.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    create_dev = c->d3d11_dll ? (d3d11_create_device_fn)symbol(c->d3d11_dll, "D3D11CreateDevice") : NULL;
    if (!create_dev) return 0;
    for (i = 0; i < 2 && FAILED(hr); i++)
        hr = create_dev(NULL, drivers[i], NULL, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                        levels, 4, D3D11_SDK_VERSION, &c->device, NULL, &c->ctx);
    if (FAILED(hr) || !c->device || !c->ctx) return 0;
    if (SUCCEEDED(ID3D11Device_QueryInterface(c->device, &ELV_IID_ID3D10Multithread, (void **)&mt)) && mt) {
        ID3D10Multithread_SetMultithreadProtected(mt, TRUE);
        ID3D10Multithread_Release(mt);
    }
    InitializeCriticalSection(&c->state_cs); InitializeCriticalSection(&c->write_cs);
    c->cs_init = 1;
    for (i = 0; i < EV_COUNT; i++) {
        c->ev[i] = CreateEventW(NULL, manual[i], initial[i], NULL);
        if (!c->ev[i]) return 0;
    }
    c->pipe = canvas_connect_pipe(pipe_path, CANVAS_TIMEOUT_MS);
    return c->pipe != INVALID_HANDLE_VALUE;
}

static int canvas_start(CanvasState *c, mpv_handle *mpv, command_string_fn command) {
    mpv_d3d11_init_params d3d11_init = { c->device };
    mpv_render_param params[] = {
        { MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_D3D11 },
        { MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &d3d11_init },
        { MPV_RENDER_PARAM_INVALID, NULL }
    };
    c->mpv = mpv; c->command = command;
    if (c->render_create(&c->rc, mpv, params) < 0 || !c->rc) return 0;
    c->render_set_cb(c->rc, canvas_on_update, c);
    c->render_thread = CreateThread(NULL, 0, canvas_render_thread, c, 0, NULL);
    c->reader_thread = CreateThread(NULL, 0, canvas_reader_thread, c, 0, NULL);
    return c->render_thread != NULL && c->reader_thread != NULL;
}

/* Stops threads and frees mpv_render_context; must be called before mpv_terminate_destroy. */
static void canvas_stop(CanvasState *c) {
    int joined = 1, need_drain = 0, i;
    if (c->ev[EV_RENDER_STOP]) SetEvent(c->ev[EV_RENDER_STOP]);
    canvas_join(&c->render_thread, CANVAS_TIMEOUT_MS, &joined);
    if (joined && c->cs_init && c->reader_thread) {
        EnterCriticalSection(&c->state_cs);
        need_drain = (c->pending_dups.count > 0 && !c->pipe_eof);
        LeaveCriticalSection(&c->state_cs);
        if (need_drain) {
            HANDLE waits[2] = { c->ev[EV_PIPE_EOF], c->ev[EV_DUP_EMPTY] };
            WaitForMultipleObjects(2, waits, FALSE, CANVAS_DRAIN_TIMEOUT_MS);
        }
    }
    canvas_signal_shutdown(c);
    canvas_join(&c->reader_thread, CANVAS_TIMEOUT_MS, &joined);
    if (!joined) { TerminateProcess(GetCurrentProcess(), 1); return; }
    if (c->pipe_eof && c->parent)
        pending_dup_close_all(&c->pending_dups, c->parent);
    if (c->rc) { c->render_set_cb(c->rc, NULL, NULL); c->render_free(c->rc); c->rc = NULL; }
    canvas_release_slots(c);
    if (c->ctx) { ID3D11DeviceContext_Release(c->ctx); c->ctx = NULL; }
    if (c->device) { ID3D11Device_Release(c->device); c->device = NULL; }
    if (c->pipe != INVALID_HANDLE_VALUE) { CloseHandle(c->pipe); c->pipe = INVALID_HANDLE_VALUE; }
    for (i = 0; i < EV_COUNT; i++) canvas_close(&c->ev[i]);
    if (c->cs_init) { DeleteCriticalSection(&c->write_cs); DeleteCriticalSection(&c->state_cs); c->cs_init = 0; }
}

#endif
