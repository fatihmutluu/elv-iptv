/*
 * In-canvas OpenGL/CGL + IOSurface render context and 5-slot ring-buffered Unix-socket host for macOS elv-mpv.
 * Active only when --elv-canvas-pipe=/abs/path is passed; standalone mode never calls this header.
 */
#ifndef ELV_MPV_MACOS_CANVAS_H_
#define ELV_MPV_MACOS_CANVAS_H_

#define GL_SILENCE_DEPRECATION
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <OpenGL/CGLIOSurface.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <poll.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>

enum {
    CANVAS_SLOTS = 5, CANVAS_MAX_PENDING = 40, CANVAS_DEFAULT_W = 1280, CANVAS_DEFAULT_H = 720,
    CANVAS_MIN_DIM = 16, CANVAS_MAX_DIM = 4096, CANVAS_TIMEOUT_MS = 2000, CANVAS_DRAIN_TIMEOUT_MS = 250
};

typedef int (*render_create_fn)(mpv_render_context **, mpv_handle *, mpv_render_param *);
typedef uint64_t (*render_update_fn)(mpv_render_context *);
typedef int (*render_render_fn)(mpv_render_context *, mpv_render_param *);
typedef void (*render_report_swap_fn)(mpv_render_context *);
typedef void (*render_set_cb_fn)(mpv_render_context *, mpv_render_update_fn, void *);
typedef void (*render_free_fn)(mpv_render_context *);

typedef struct PendingSurface { unsigned int gen, slot; IOSurfaceRef surf; } PendingSurface;
typedef struct PendingSurfaceTable { PendingSurface items[CANVAS_MAX_PENDING]; int count; } PendingSurfaceTable;

typedef struct CanvasState {
    mpv_handle *mpv; command_string_fn command;
    render_create_fn render_create; render_update_fn render_update;
    render_render_fn render_render; render_report_swap_fn render_report_swap;
    render_set_cb_fn render_set_cb; render_free_fn render_free;
    CGLContextObj cgl; mpv_render_context *rc;
    int sock_fd, shutdown_pipe[2], render_started, reader_started, sync_init;
    pthread_t render_thread, reader_thread;
    pthread_mutex_t state_mu, write_mu; pthread_cond_t state_cv;
    IOSurfaceRef surf[CANVAS_SLOTS]; GLuint tex[CANVAS_SLOTS], fbo[CANVAS_SLOTS];
    PendingSurfaceTable pending;
    int in_flight[CANVAS_SLOTS], ready, render_stop, shutdown, stopping, pipe_eof, reader_done;
    int resize_pending, frame_pending, pending_w, pending_h, cur_w, cur_h, next_slot, has_rendered;
    unsigned int gen;
} CanvasState;

static int pending_surf_add(PendingSurfaceTable *t, unsigned int gen, unsigned int slot, IOSurfaceRef s) {
    if (!s || t->count >= CANVAS_MAX_PENDING) return 0;
    t->items[t->count].gen = gen; t->items[t->count].slot = slot; t->items[t->count].surf = s;
    t->count++; return 1;
}
static IOSurfaceRef pending_surf_take(PendingSurfaceTable *t, unsigned int gen, unsigned int slot) {
    int i;
    for (i = 0; i < t->count; i++)
        if (t->items[i].gen == gen && t->items[i].slot == slot) {
            IOSurfaceRef s = t->items[i].surf;
            if (i < --t->count) t->items[i] = t->items[t->count];
            return s;
        }
    return NULL;
}
static void pending_surf_release_all(PendingSurfaceTable *t) {
    int i;
    for (i = 0; i < t->count; i++) if (t->items[i].surf) CFRelease(t->items[i].surf);
    t->count = 0;
}
static void canvas_release_pending(CanvasState *c, unsigned int gen, unsigned int slot) {
    IOSurfaceRef s;
    pthread_mutex_lock(&c->state_mu);
    s = pending_surf_take(&c->pending, gen, slot);
    if (s) pthread_cond_broadcast(&c->state_cv);
    pthread_mutex_unlock(&c->state_mu);
    if (s) CFRelease(s);
}

static void canvas_init(CanvasState *c) {
    memset(c, 0, sizeof(*c));
    c->sock_fd = -1; c->shutdown_pipe[0] = -1; c->shutdown_pipe[1] = -1;
    c->pending_w = CANVAS_DEFAULT_W; c->pending_h = CANVAS_DEFAULT_H;
}
static int canvas_load_symbols(CanvasState *c, void *lib) {
    c->render_create = (render_create_fn)symbol(lib, "mpv_render_context_create");
    c->render_update = (render_update_fn)symbol(lib, "mpv_render_context_update");
    c->render_render = (render_render_fn)symbol(lib, "mpv_render_context_render");
    c->render_report_swap = (render_report_swap_fn)symbol(lib, "mpv_render_context_report_swap");
    c->render_set_cb = (render_set_cb_fn)symbol(lib, "mpv_render_context_set_update_callback");
    c->render_free = (render_free_fn)symbol(lib, "mpv_render_context_free");
    return c->render_create && c->render_update && c->render_render &&
           c->render_report_swap && c->render_set_cb && c->render_free;
}
static int canvas_is_shutdown(CanvasState *c) {
    int v; if (!c->sync_init) return 0;
    pthread_mutex_lock(&c->state_mu); v = c->shutdown; pthread_mutex_unlock(&c->state_mu); return v;
}
static void canvas_signal_shutdown(CanvasState *c) {
    if (!c->sync_init) return;
    pthread_mutex_lock(&c->state_mu); c->render_stop = 1; c->shutdown = 1;
    pthread_cond_broadcast(&c->state_cv); pthread_mutex_unlock(&c->state_mu);
    if (c->shutdown_pipe[1] >= 0) { char b = 1; ssize_t ig = write(c->shutdown_pipe[1], &b, 1); (void)ig; }
}
static void canvas_mark_pipe_eof(CanvasState *c) {
    pthread_mutex_lock(&c->state_mu); c->pipe_eof = 1; pthread_cond_broadcast(&c->state_cv); pthread_mutex_unlock(&c->state_mu);
}
static void canvas_on_update(void *cb_ctx) {
    CanvasState *c = (CanvasState *)cb_ctx;
    pthread_mutex_lock(&c->state_mu); c->frame_pending = 1; pthread_cond_signal(&c->state_cv); pthread_mutex_unlock(&c->state_mu);
}
static void *canvas_get_proc_address(void *ctx, const char *name) { (void)ctx; return name ? dlsym(RTLD_DEFAULT, name) : NULL; }

/* Caller holds c->state_mu. Returns 0 once deadline has elapsed. */
static int canvas_wait_until(CanvasState *c, int64_t deadline) {
    int64_t rem = deadline - monotonic_ms(); struct timespec rel;
    if (rem <= 0) return 0;
    rel.tv_sec = (time_t)(rem / 1000); rel.tv_nsec = (long)((rem % 1000) * 1000000L);
    pthread_cond_timedwait_relative_np(&c->state_cv, &c->state_mu, &rel); return 1;
}

static int canvas_write_all(CanvasState *c, const char *buf, size_t len) {
    size_t off = 0; int ok = 1, eof = 0; int64_t deadline = monotonic_ms() + CANVAS_TIMEOUT_MS;
    pthread_mutex_lock(&c->write_mu);
    while (off < len) {
        struct pollfd pfd = { c->sock_fd, POLLOUT, 0 };
        int64_t rem; int stop, pr; ssize_t w;
        pthread_mutex_lock(&c->state_mu); stop = c->render_stop; pthread_mutex_unlock(&c->state_mu);
        rem = deadline - monotonic_ms();
        if (stop || rem <= 0) { ok = 0; break; }
        pr = poll(&pfd, 1, rem > 100 ? 100 : (int)rem);
        if (pr < 0) { if (errno == EINTR) continue; eof = 1; ok = 0; break; }
        if (pr == 0) continue;
        if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) { eof = 1; ok = 0; break; }
        w = write(c->sock_fd, buf + off, len - off);
        if (w > 0) off += (size_t)w;
        else if (w < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        else { eof = 1; ok = 0; break; }
    }
    pthread_mutex_unlock(&c->write_mu);
    if (eof) canvas_mark_pipe_eof(c);
    return ok;
}

static CGLContextObj canvas_create_cgl_context(void) {
    static const CGLPixelFormatAttribute profiles[3][6] = {
        { kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
          kCGLPFAAccelerated, kCGLPFAAllowOfflineRenderers, (CGLPixelFormatAttribute)0 },
        { kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
          kCGLPFARendererID, (CGLPixelFormatAttribute)kCGLRendererGenericFloatID, (CGLPixelFormatAttribute)0 },
        { kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core, (CGLPixelFormatAttribute)0 }
    };
    int i;
    for (i = 0; i < 3; i++) {
        CGLPixelFormatObj pix = NULL; GLint npix = 0; CGLContextObj ctx = NULL;
        if (CGLChoosePixelFormat(profiles[i], &pix, &npix) == kCGLNoError && pix && npix > 0) {
            CGLError err = CGLCreateContext(pix, NULL, &ctx);
            CGLDestroyPixelFormat(pix);
            if (err == kCGLNoError && ctx) return ctx;
            if (ctx) CGLDestroyContext(ctx);
        } else if (pix) CGLDestroyPixelFormat(pix);
    }
    return NULL;
}

static IOSurfaceRef canvas_create_iosurface(int w, int h) {
    int32_t bpr = (int32_t)((((size_t)w * 4u) + 63u) & ~(size_t)63u);
    int32_t raw[6] = { (int32_t)w, (int32_t)h, 4, bpr, bpr * (int32_t)h, (int32_t)0x42475241u };
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    const void *keys[7] = {
        kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement,
        kIOSurfaceBytesPerRow, kIOSurfaceAllocSize, kIOSurfacePixelFormat, kIOSurfaceIsGlobal
    };
#pragma clang diagnostic pop
    const void *vals[7] = { NULL, NULL, NULL, NULL, NULL, NULL, kCFBooleanTrue };
    IOSurfaceRef surf = NULL; int i, ok = 1;
    for (i = 0; i < 6; i++) {
        vals[i] = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &raw[i]);
        if (!vals[i]) ok = 0;
    }
    if (ok) {
        CFDictionaryRef dict = CFDictionaryCreate(kCFAllocatorDefault, keys, vals, 7,
            &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        if (dict) { surf = IOSurfaceCreate(dict); CFRelease(dict); }
    }
    for (i = 0; i < 6; i++) if (vals[i]) CFRelease(vals[i]);
    if (surf && IOSurfaceGetID(surf) == 0) { CFRelease(surf); surf = NULL; }
    return surf;
}
static void canvas_release_arrays(GLuint fbo[CANVAS_SLOTS], GLuint tex[CANVAS_SLOTS], IOSurfaceRef surf[CANVAS_SLOTS]) {
    int i;
    for (i = 0; i < CANVAS_SLOTS; i++) {
        if (fbo[i]) { glDeleteFramebuffers(1, &fbo[i]); fbo[i] = 0; }
        if (tex[i]) { glDeleteTextures(1, &tex[i]); tex[i] = 0; }
        if (surf[i]) { CFRelease(surf[i]); surf[i] = NULL; }
    }
}
static int canvas_recreate_ring(CanvasState *c, int w, int h) {
    IOSurfaceRef ns[CANVAS_SLOTS] = { NULL };
    GLuint nt[CANVAS_SLOTS] = { 0 }, nf[CANVAS_SLOTS] = { 0 };
    int64_t deadline = monotonic_ms() + CANVAS_TIMEOUT_MS; unsigned int new_gen; int i, ok;
    pthread_mutex_lock(&c->state_mu);
    while (!c->render_stop && c->pending.count + CANVAS_SLOTS > CANVAS_MAX_PENDING)
        if (!canvas_wait_until(c, deadline)) break;
    ok = !c->render_stop && (c->pending.count + CANVAS_SLOTS <= CANVAS_MAX_PENDING);
    pthread_mutex_unlock(&c->state_mu);
    if (!ok) return 0;
    canvas_release_arrays(c->fbo, c->tex, c->surf);
    for (i = 0; i < CANVAS_SLOTS; i++) {
        ns[i] = canvas_create_iosurface(w, h); if (!ns[i]) goto fail;
        glGenTextures(1, &nt[i]); glBindTexture(GL_TEXTURE_RECTANGLE, nt[i]);
        glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_RECTANGLE, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        if (CGLTexImageIOSurface2D(c->cgl, GL_TEXTURE_RECTANGLE, GL_RGBA, (GLsizei)w, (GLsizei)h,
                                   GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, ns[i], 0) != kCGLNoError) goto fail;
        glGenFramebuffers(1, &nf[i]); glBindFramebuffer(GL_FRAMEBUFFER, nf[i]);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_RECTANGLE, nt[i], 0);
        if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) goto fail;
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0); glBindTexture(GL_TEXTURE_RECTANGLE, 0);
    pthread_mutex_lock(&c->state_mu); new_gen = ++c->gen;
    for (i = 0; i < CANVAS_SLOTS; i++) c->in_flight[i] = 0;
    pthread_mutex_unlock(&c->state_mu);
    for (i = 0; i < CANVAS_SLOTS; i++) { c->surf[i] = ns[i]; c->tex[i] = nt[i]; c->fbo[i] = nf[i]; }
    c->cur_w = w; c->cur_h = h; c->next_slot = 0;
    for (i = 0; i < CANVAS_SLOTS; i++) {
        char msg[128]; int added, n = snprintf(msg, sizeof(msg), "S %u %d %u %d %d\n",
                                               new_gen, i, (unsigned int)IOSurfaceGetID(c->surf[i]), w, h);
        if (n <= 0 || (size_t)n >= sizeof(msg)) return 0;
        CFRetain(c->surf[i]);
        pthread_mutex_lock(&c->state_mu); added = pending_surf_add(&c->pending, new_gen, (unsigned int)i, c->surf[i]);
        pthread_mutex_unlock(&c->state_mu);
        if (!added) { CFRelease(c->surf[i]); return 0; }
        if (!canvas_write_all(c, msg, (size_t)n)) { canvas_release_pending(c, new_gen, (unsigned int)i); return 0; }
    }
    return 1;
fail:
    glBindFramebuffer(GL_FRAMEBUFFER, 0); glBindTexture(GL_TEXTURE_RECTANGLE, 0);
    canvas_release_arrays(nf, nt, ns); return 0;
}
static void canvas_render_frame(CanvasState *c, int force_redraw) {
    uint64_t flags = c->render_update(c->rc);
    int slot = -1, k, n; unsigned int cur_gen; char msg[96];
    if (!(flags & MPV_RENDER_UPDATE_FRAME) && !(force_redraw && c->has_rendered)) return;
    pthread_mutex_lock(&c->state_mu); cur_gen = c->gen;
    for (k = 0; k < CANVAS_SLOTS; k++) {
        int idx = (c->next_slot + k) % CANVAS_SLOTS;
        if (!c->in_flight[idx]) { c->in_flight[idx] = 1; c->next_slot = (idx + 1) % CANVAS_SLOTS; slot = idx; break; }
    }
    pthread_mutex_unlock(&c->state_mu);
    if (slot < 0) {
        int skip = 1;
        mpv_render_param p[] = { { MPV_RENDER_PARAM_SKIP_RENDERING, &skip }, { MPV_RENDER_PARAM_INVALID, NULL } };
        c->render_render(c->rc, p); c->render_report_swap(c->rc); return;
    }
    {
        mpv_opengl_fbo fbo = { (int)c->fbo[slot], c->cur_w, c->cur_h, GL_RGBA8 }; int flip_y = 0;
        mpv_render_param p[] = { { MPV_RENDER_PARAM_OPENGL_FBO, &fbo }, { MPV_RENDER_PARAM_FLIP_Y, &flip_y },
                                 { MPV_RENDER_PARAM_INVALID, NULL } };
        if (!c->fbo[slot] || c->render_render(c->rc, p) < 0) {
            pthread_mutex_lock(&c->state_mu); if (c->gen == cur_gen) c->in_flight[slot] = 0;
            pthread_mutex_unlock(&c->state_mu); return;
        }
    }
    glFlush(); glFinish(); c->render_report_swap(c->rc); c->has_rendered = 1;
    n = snprintf(msg, sizeof(msg), "F %u %d %d %d\n", cur_gen, slot, c->cur_w, c->cur_h);
    if (n <= 0 || (size_t)n >= sizeof(msg) || !canvas_write_all(c, msg, (size_t)n)) canvas_signal_shutdown(c);
}
static void *canvas_render_thread(void *param) {
    CanvasState *c = (CanvasState *)param;
    mpv_opengl_init_params gl_init = { canvas_get_proc_address, NULL };
    mpv_render_param params[] = { { MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_OPENGL },
                                  { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init }, { MPV_RENDER_PARAM_INVALID, NULL } };
    int w, h;
    c->cgl = canvas_create_cgl_context();
    if (!c->cgl || CGLSetCurrentContext(c->cgl) != kCGLNoError) goto init_fail;
    if (c->render_create(&c->rc, c->mpv, params) < 0 || !c->rc) goto init_fail;
    c->render_set_cb(c->rc, canvas_on_update, c);
    pthread_mutex_lock(&c->state_mu); c->ready = 1; w = c->pending_w; h = c->pending_h;
    pthread_cond_broadcast(&c->state_cv); pthread_mutex_unlock(&c->state_mu);
    if (!canvas_recreate_ring(c, w, h)) { canvas_signal_shutdown(c); goto cleanup; }
    for (;;) {
        int do_resize = 0, do_frame = 0;
        pthread_mutex_lock(&c->state_mu);
        while (!c->render_stop && !c->resize_pending && !c->frame_pending)
            pthread_cond_wait(&c->state_cv, &c->state_mu);
        if (c->render_stop) { pthread_mutex_unlock(&c->state_mu); break; }
        if (c->resize_pending) { c->resize_pending = 0; w = c->pending_w; h = c->pending_h; do_resize = 1; }
        else if (c->frame_pending) { c->frame_pending = 0; do_frame = 1; }
        pthread_mutex_unlock(&c->state_mu);
        if (do_resize && (c->gen == 0 || w != c->cur_w || h != c->cur_h)) {
            if (!canvas_recreate_ring(c, w, h)) { canvas_signal_shutdown(c); break; }
            canvas_render_frame(c, 1);
        } else if (do_frame) canvas_render_frame(c, 0);
    }
    goto cleanup;
init_fail:
    pthread_mutex_lock(&c->state_mu); c->ready = -1; pthread_cond_broadcast(&c->state_cv); pthread_mutex_unlock(&c->state_mu);
cleanup:
    if (c->rc) { c->render_set_cb(c->rc, NULL, NULL); c->render_free(c->rc); c->rc = NULL; }
    canvas_release_arrays(c->fbo, c->tex, c->surf);
    if (c->cgl) { CGLSetCurrentContext(NULL); CGLDestroyContext(c->cgl); c->cgl = NULL; }
    return NULL;
}

static void canvas_handle_line(CanvasState *c, const char *line) {
    unsigned int a = 0, b = 0;
    if ((line[0] != 'R' && line[0] != 'A' && line[0] != 'I') || line[1] != ' ' || !parse_u32_pair(line + 2, &a, &b)) return;
    if (line[0] == 'R') {
        int cw = (int)(a < CANVAS_MIN_DIM ? CANVAS_MIN_DIM : (a > CANVAS_MAX_DIM ? CANVAS_MAX_DIM : a));
        int ch = (int)(b < CANVAS_MIN_DIM ? CANVAS_MIN_DIM : (b > CANVAS_MAX_DIM ? CANVAS_MAX_DIM : b));
        pthread_mutex_lock(&c->state_mu); c->pending_w = cw; c->pending_h = ch; c->resize_pending = 1;
        pthread_cond_broadcast(&c->state_cv); pthread_mutex_unlock(&c->state_mu);
    } else if (line[0] == 'A' && a > 0 && b < CANVAS_SLOTS) {
        pthread_mutex_lock(&c->state_mu); if (a == c->gen) c->in_flight[b] = 0; pthread_mutex_unlock(&c->state_mu);
    } else if (line[0] == 'I' && a > 0 && b < CANVAS_SLOTS) canvas_release_pending(c, a, b);
}
static void *canvas_reader_thread(void *param) {
    CanvasState *c = (CanvasState *)param;
    char chunk[512], line[256]; size_t line_len = 0; int overflow = 0, eof = 0, need_quit;
    for (;;) {
        struct pollfd pfds[2] = { { c->sock_fd, POLLIN, 0 }, { c->shutdown_pipe[0], POLLIN, 0 } };
        int pr = poll(pfds, 2, -1);
        if (pr < 0) { if (errno == EINTR) continue; eof = 1; break; }
        if (pfds[1].revents & (POLLIN | POLLHUP | POLLERR)) break;
        if (pfds[0].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) {
            ssize_t got = read(c->sock_fd, chunk, sizeof(chunk)), i;
            if (got < 0) { if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue; eof = 1; break; }
            if (got == 0) { eof = 1; break; }
            for (i = 0; i < got; i++) {
                if (chunk[i] == '\n') {
                    if (!overflow) {
                        if (line_len > 0 && line[line_len - 1] == '\r') line_len--;
                        line[line_len] = '\0'; canvas_handle_line(c, line);
                    }
                    line_len = 0; overflow = 0;
                } else if (!overflow) {
                    if (line_len + 1 < sizeof(line)) line[line_len++] = chunk[i]; else overflow = 1;
                }
            }
        }
    }
    if (eof) canvas_mark_pipe_eof(c);
    pthread_mutex_lock(&c->state_mu);
    need_quit = !c->shutdown && !c->stopping; c->reader_done = 1; pthread_cond_broadcast(&c->state_cv);
    pthread_mutex_unlock(&c->state_mu);
    if (need_quit) { canvas_signal_shutdown(c); c->command(c->mpv, "quit"); }
    return NULL;
}
static int canvas_prepare(CanvasState *c, const char *socket_path) {
    if (pthread_mutex_init(&c->state_mu, NULL) != 0) return 0;
    if (pthread_mutex_init(&c->write_mu, NULL) != 0) { pthread_mutex_destroy(&c->state_mu); return 0; }
    if (pthread_cond_init(&c->state_cv, NULL) != 0) {
        pthread_mutex_destroy(&c->write_mu); pthread_mutex_destroy(&c->state_mu); return 0;
    }
    c->sync_init = 1;
    if (pipe(c->shutdown_pipe) != 0) return 0;
    set_fd_flags(c->shutdown_pipe[0], 1); set_fd_flags(c->shutdown_pipe[1], 1);
    c->sock_fd = connect_unix_socket(socket_path, CANVAS_TIMEOUT_MS); return c->sock_fd >= 0;
}
static int canvas_start(CanvasState *c, mpv_handle *mpv, command_string_fn command) {
    int ready; c->mpv = mpv; c->command = command;
    if (pthread_create(&c->render_thread, NULL, canvas_render_thread, c) != 0) return 0;
    c->render_started = 1;
    pthread_mutex_lock(&c->state_mu);
    while (c->ready == 0) pthread_cond_wait(&c->state_cv, &c->state_mu);
    ready = c->ready; pthread_mutex_unlock(&c->state_mu);
    if (ready <= 0 || pthread_create(&c->reader_thread, NULL, canvas_reader_thread, c) != 0) return 0;
    c->reader_started = 1; return 1;
}
/* Stops threads and releases GL/render/IOSurface state; must be called before mpv_terminate_destroy. */
static void canvas_stop(CanvasState *c) {
    if (c->sync_init) {
        pthread_mutex_lock(&c->state_mu); c->stopping = 1; c->render_stop = 1;
        pthread_cond_broadcast(&c->state_cv); pthread_mutex_unlock(&c->state_mu);
    }
    if (c->render_started) { pthread_join(c->render_thread, NULL); c->render_started = 0; }
    if (c->sync_init && c->reader_started) {
        int64_t deadline = monotonic_ms() + CANVAS_DRAIN_TIMEOUT_MS;
        pthread_mutex_lock(&c->state_mu);
        while (c->pending.count > 0 && !c->pipe_eof && !c->reader_done) if (!canvas_wait_until(c, deadline)) break;
        pthread_mutex_unlock(&c->state_mu);
    }
    canvas_signal_shutdown(c);
    if (c->reader_started) { pthread_join(c->reader_thread, NULL); c->reader_started = 0; }
    pending_surf_release_all(&c->pending);
    close_fd(&c->sock_fd); close_fd(&c->shutdown_pipe[0]); close_fd(&c->shutdown_pipe[1]);
    if (c->sync_init) {
        pthread_cond_destroy(&c->state_cv); pthread_mutex_destroy(&c->write_mu);
        pthread_mutex_destroy(&c->state_mu); c->sync_init = 0;
    }
}

#endif
