/*
 * elv-mpv (macOS): a small host that dynamically loads sibling ../Frameworks/libmpv.2.dylib via
 * _NSGetExecutablePath (keeping LGPL libmpv replaceable), forwards --name=value, --name and --no-name
 * options, optionally drives an in-canvas OpenGL/IOSurface Unix-socket stream (--elv-canvas-pipe),
 * and runs until mpv shuts down or its parent exits (kqueue EVFILT_PROC/NOTE_EXIT).
 * Exit codes: 0 normal, 2 bad argument or rejected option, 3 libmpv or a symbol missing,
 * 4 init failed, 5 explicit parent pid not watchable. Never prints arguments.
 */
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include <mpv/client.h>

typedef mpv_handle *(*create_fn)(void);
typedef int (*set_option_string_fn)(mpv_handle *, const char *, const char *);
typedef int (*initialize_fn)(mpv_handle *);
typedef mpv_event *(*wait_event_fn)(mpv_handle *, double);
typedef int (*command_string_fn)(mpv_handle *, const char *);
typedef void (*terminate_destroy_fn)(mpv_handle *);

static void *symbol(void *lib, const char *name) { return dlsym(lib, name); }

static int64_t monotonic_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + (int64_t)(ts.tv_nsec / 1000000L);
}

static void set_fd_flags(int fd, int nonblock)
{
    int fl = fcntl(fd, F_GETFD, 0);
    if (fl >= 0) fcntl(fd, F_SETFD, fl | FD_CLOEXEC);
    if (nonblock) {
        fl = fcntl(fd, F_GETFL, 0);
        if (fl >= 0) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    }
}

static void close_fd(int *fd)
{
    if (*fd >= 0) {
        close(*fd);
        *fd = -1;
    }
}

static int parse_u32(const char *s, unsigned int *out, const char **next)
{
    unsigned long val;
    char *end = NULL;
    if (!s || *s < '0' || *s > '9') return 0;
    errno = 0;
    val = strtoul(s, &end, 10);
    if (errno != 0 || end == s || val > (unsigned long)UINT32_MAX) return 0;
    *out = (unsigned int)val;
    *next = end;
    return 1;
}

static int parse_u32_pair(const char *s, unsigned int *a, unsigned int *b)
{
    const char *p = NULL;
    return parse_u32(s, a, &p) && *p == ' ' && parse_u32(p + 1, b, &p) && *p == '\0';
}

static int connect_unix_socket(const char *path, int timeout_ms)
{
    struct sockaddr_un addr;
    size_t len = path ? strlen(path) : 0;
    int64_t deadline = monotonic_ms() + timeout_ms;

    if (!path || path[0] != '/' || len <= 1 || len >= sizeof(addr.sun_path)) return -1;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    memcpy(addr.sun_path, path, len + 1);
    for (;;) {
        int fd = socket(AF_UNIX, SOCK_STREAM, 0), one = 1, err;
        struct timespec pause = { 0, 25000000L };
        if (fd < 0) return -1;
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
        set_fd_flags(fd, 0);
        if (connect(fd, (struct sockaddr *)&addr, (socklen_t)sizeof(addr)) == 0) {
            set_fd_flags(fd, 1);
            return fd;
        }
        err = errno;
        close(fd);
        if ((err != EAGAIN && err != EINTR && err != ENOENT && err != ECONNREFUSED) ||
            monotonic_ms() >= deadline)
            return -1;
        nanosleep(&pause, NULL);
    }
}

#include "elv-mpv-macos-canvas.h"

static void *load_libmpv(void)
{
    char raw_stack[PATH_MAX], resolved[PATH_MAX], lib_path[PATH_MAX];
    char *raw_heap = NULL;
    const char *exe_raw = raw_stack, *exe, *slash;
    uint32_t sz = (uint32_t)sizeof(raw_stack);
    void *lib = NULL;

    if (_NSGetExecutablePath(raw_stack, &sz) != 0) {
        raw_heap = (char *)malloc((size_t)sz);
        if (!raw_heap || _NSGetExecutablePath(raw_heap, &sz) != 0) {
            free(raw_heap);
            return NULL;
        }
        exe_raw = raw_heap;
    }
    exe = realpath(exe_raw, resolved) ? resolved : exe_raw;
    slash = strrchr(exe, '/');
    if (slash) {
        int n = snprintf(lib_path, sizeof(lib_path), "%.*s/../Frameworks/libmpv.2.dylib",
                         (int)(slash - exe), exe);
        if (n > 0 && (size_t)n < sizeof(lib_path))
            lib = dlopen(lib_path, RTLD_NOW | RTLD_LOCAL);
    }
    free(raw_heap);
    return lib;
}

static void *watchdog_thread(void *arg)
{
    unsigned int ms = (unsigned int)(uintptr_t)arg;
    struct timespec ts;
    ts.tv_sec = (time_t)(ms / 1000u);
    ts.tv_nsec = (long)((ms % 1000u) * 1000000u);
    while (nanosleep(&ts, &ts) == -1 && errno == EINTR) {
    }
    _exit(1);
    return NULL;
}

static void arm_watchdog(unsigned int ms)
{
    pthread_t t;
    pthread_attr_t attr;
    if (pthread_attr_init(&attr) != 0) return;
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    (void)pthread_create(&t, &attr, watchdog_thread, (void *)(uintptr_t)ms);
    pthread_attr_destroy(&attr);
}

static int parent_watch_open(pid_t pid, int explicit_parent, int *kq_out, int *already_exited)
{
    struct kevent kev;
    int kq;

    *kq_out = -1;
    *already_exited = 0;
    if (pid <= 1) return explicit_parent ? 0 : 1;
    kq = kqueue();
    if (kq < 0) return explicit_parent ? 0 : 1;
    set_fd_flags(kq, 0);
    EV_SET(&kev, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
    if (kevent(kq, &kev, 1, NULL, 0, NULL) < 0) {
        int err = errno;
        close(kq);
        if (explicit_parent) return 0;
        if (err == ESRCH || (kill(pid, 0) == -1 && errno == ESRCH)) *already_exited = 1;
        return 1;
    }
    *kq_out = kq;
    return 1;
}

static int parent_watch_exited(int kq, pid_t pid)
{
    if (kq >= 0) {
        struct kevent ev;
        struct timespec zero = { 0, 0 };
        int n = kevent(kq, NULL, 0, &ev, 1, &zero);
        if (n > 0 && ev.filter == EVFILT_PROC && (ev.fflags & NOTE_EXIT)) return 1;
    }
    return pid > 1 && kill(pid, 0) == -1 && errno == ESRCH;
}

/* Returns 0, or 2 when an argument is malformed or mpv rejects it. */
static int apply_args(
    int argc, char **argv, set_option_string_fn set_option, mpv_handle *h,
    pid_t *parent_pid, int *explicit_parent, const char **canvas_pipe)
{
    int i;
    for (i = 1; i < argc; i++) {
        const char *arg = argv[i], *eq;
        int rc;
        if (strncmp(arg, "--", 2) != 0 || arg[2] == '\0') return 2;
        arg += 2;
        if (strncmp(arg, "elv-parent-pid=", 15) == 0) {
            const char *val = arg + 15;
            char *end = NULL;
            unsigned long pid;
            if (!isdigit((unsigned char)val[0])) return 2;
            errno = 0;
            pid = strtoul(val, &end, 10);
            if (errno != 0 || *end != '\0' || pid == 0 || pid > (unsigned long)INT_MAX) return 2;
            *parent_pid = (pid_t)pid;
            *explicit_parent = 1;
            continue;
        }
        if (strncmp(arg, "elv-canvas-pipe=", 16) == 0) {
            const char *val = arg + 16;
            size_t len = strlen(val);
            if (val[0] != '/' || len <= 1 || len >= sizeof(((struct sockaddr_un *)0)->sun_path))
                return 2;
            *canvas_pipe = val;
            continue;
        }
        eq = strchr(arg, '=');
        if (eq) {
            char *name;
            if (eq == arg) return 2;
            name = strndup(arg, (size_t)(eq - arg));
            rc = name ? set_option(h, name, eq + 1) : -1;
            free(name);
        } else if (strncmp(arg, "no-", 3) == 0 && arg[3] != '\0') {
            rc = set_option(h, arg + 3, "no");
        } else {
            rc = set_option(h, arg, "yes");
        }
        if (rc < 0) return 2;
    }
    return 0;
}

int main(int argc, char **argv)
{
    void *lib;
    create_fn create;
    set_option_string_fn set_option;
    initialize_fn initialize;
    wait_event_fn wait_event;
    command_string_fn command;
    terminate_destroy_fn destroy;
    mpv_handle *h;
    pid_t parent_pid = 0;
    int explicit_parent = 0, parent_kq = -1, parent_dead = 0;
    const char *canvas_pipe = NULL;
    CanvasState canvas;
    int canvas_active = 0, quit_sent = 0, code;

    signal(SIGPIPE, SIG_IGN);
    canvas_init(&canvas);
    lib = load_libmpv();
    if (!lib) return 3;
    create = (create_fn)symbol(lib, "mpv_create");
    set_option = (set_option_string_fn)symbol(lib, "mpv_set_option_string");
    initialize = (initialize_fn)symbol(lib, "mpv_initialize");
    wait_event = (wait_event_fn)symbol(lib, "mpv_wait_event");
    command = (command_string_fn)symbol(lib, "mpv_command_string");
    destroy = (terminate_destroy_fn)symbol(lib, "mpv_terminate_destroy");
    if (!create || !set_option || !initialize || !wait_event || !command || !destroy) return 3;
    h = create();
    if (!h) return 3;

    /* Hardened defaults first; the caller's arguments may still override them. */
    set_option(h, "config", "no");
    set_option(h, "load-scripts", "no");
    set_option(h, "ytdl", "no");
    set_option(h, "load-unsafe-playlists", "no");
    set_option(h, "input-default-bindings", "no");
    set_option(h, "input-vo-keyboard", "no");
    set_option(h, "osc", "no");
    set_option(h, "osd-level", "0");
    code = apply_args(argc, argv, set_option, h, &parent_pid, &explicit_parent, &canvas_pipe);
    if (code == 0) {
        if (!explicit_parent) parent_pid = getppid();
        if (!parent_watch_open(parent_pid, explicit_parent, &parent_kq, &parent_dead)) code = 5;
    }
    if (code == 0 && canvas_pipe != NULL) {
        if (!canvas_load_symbols(&canvas, lib)) code = 3;
        else if (set_option(h, "vo", "libmpv") < 0 || set_option(h, "force-window", "no") < 0 ||
                 set_option(h, "video-timing-offset", "0") < 0) code = 4;
        else if (!canvas_prepare(&canvas, canvas_pipe)) code = 4;
        else canvas_active = 1;
    }
    if (code == 0 && initialize(h) < 0) code = 4;
    if (code == 0 && canvas_active && !canvas_start(&canvas, h, command)) code = 4;
    if (code != 0) {
        arm_watchdog(3000);
        if (canvas_pipe != NULL) canvas_stop(&canvas);
        if (parent_kq >= 0) close(parent_kq);
        destroy(h);
        return code;
    }
    if (parent_dead) {
        quit_sent = 1;
        if (canvas_active) canvas_signal_shutdown(&canvas);
        arm_watchdog(3000);
        command(h, "quit");
    }
    for (;;) {
        mpv_event *ev = wait_event(h, 0.25);
        if (ev->event_id == MPV_EVENT_SHUTDOWN) break;
        if (!quit_sent && canvas_active && canvas_is_shutdown(&canvas)) {
            quit_sent = 1; arm_watchdog(3000); command(h, "quit");
        }
        if (!quit_sent && parent_watch_exited(parent_kq, parent_pid)) {
            quit_sent = 1;
            if (canvas_active) canvas_signal_shutdown(&canvas);
            arm_watchdog(3000); command(h, "quit");
        }
    }
    if (!quit_sent) arm_watchdog(3000);
    if (canvas_active) canvas_stop(&canvas);
    if (parent_kq >= 0) close(parent_kq);
    destroy(h);
    return 0;
}
