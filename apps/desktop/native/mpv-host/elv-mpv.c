/*
 * elv-mpv: a small host that loads the official LGPL libmpv-2.dll from its own folder (dynamically, so the
 * DLL stays replaceable), hands it the --name=value, --name and --no-name options, and runs until mpv shuts
 * down or the process named by --elv-parent-pid exits. Exit codes: 0 normal, 2 bad argument or rejected
 * option, 3 libmpv or a symbol missing, 4 mpv_initialize failed, 5 parent pid not openable. It never prints
 * its arguments. A watchdog ends the process 3 s after quit or shutdown begins, whatever mpv is doing.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <mpv/client.h>

typedef mpv_handle *(*create_fn)(void);
typedef int (*set_option_string_fn)(mpv_handle *, const char *, const char *);
typedef int (*initialize_fn)(mpv_handle *);
typedef mpv_event *(*wait_event_fn)(mpv_handle *, double);
typedef int (*command_string_fn)(mpv_handle *, const char *);
typedef void (*terminate_destroy_fn)(mpv_handle *);

static void *symbol(HMODULE lib, const char *name)
{
    return (void *)GetProcAddress(lib, name);
}

static char *to_utf8(const wchar_t *w)
{
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    char *s = n > 0 ? (char *)malloc((size_t)n) : NULL;
    if (s && WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL) <= 0) {
        free(s);
        s = NULL;
    }
    return s;
}

static HMODULE load_libmpv(void)
{
    wchar_t path[MAX_PATH + 32];
    DWORD n = GetModuleFileNameW(NULL, path, MAX_PATH);
    wchar_t *slash;
    if (n == 0 || n >= MAX_PATH)
        return NULL;
    slash = wcsrchr(path, L'\\');
    if (!slash)
        return NULL;
    wcscpy_s(slash + 1, 32, L"libmpv-2.dll");
    return LoadLibraryExW(path, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
}

/*
 * Per-Monitor V2 like the official mpv.exe: mpv's windows then work in physical pixels, so --geometry lands where
 * the app put it and a --wid child fills its parent on scaled displays. Without it Windows scales mpv's windows.
 */
static void become_dpi_aware(void)
{
    typedef BOOL (WINAPI *set_context_fn)(DPI_AWARENESS_CONTEXT);
    HMODULE user32 = LoadLibraryExW(L"user32.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    set_context_fn set_context = user32 ? (set_context_fn)GetProcAddress(user32, "SetProcessDpiAwarenessContext") : NULL;
    if (set_context)
        set_context(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}

/* Hard stop: a stalled provider connection must never keep this process (and its pipe) alive. */
static DWORD WINAPI watchdog(LPVOID ms)
{
    Sleep((DWORD)(ULONG_PTR)ms);
    TerminateProcess(GetCurrentProcess(), 1);
    return 0;
}

static void arm_watchdog(DWORD ms)
{
    HANDLE t = CreateThread(NULL, 0, watchdog, (LPVOID)(ULONG_PTR)ms, 0, NULL);
    if (t)
        CloseHandle(t);
}

/* Returns 0, or 2 when an argument is malformed or mpv rejects it. */
static int apply_args(int argc, wchar_t **argv, set_option_string_fn set_option, mpv_handle *h, DWORD *parent_pid)
{
    int i;
    for (i = 1; i < argc; i++) {
        const wchar_t *arg = argv[i];
        const wchar_t *eq;
        char *name, *value;
        int rc;
        if (wcsncmp(arg, L"--", 2) != 0 || arg[2] == L'\0')
            return 2;
        arg += 2;
        if (wcsncmp(arg, L"elv-parent-pid=", 15) == 0) {
            wchar_t *end = (wchar_t *)arg;
            unsigned long pid = iswdigit(arg[15]) ? wcstoul(arg + 15, &end, 10) : 0;
            if (pid == 0 || *end != L'\0')
                return 2;
            *parent_pid = (DWORD)pid;
            continue;
        }
        eq = wcschr(arg, L'=');
        if (eq) {
            wchar_t *wname = _wcsdup(arg);
            if (!wname)
                return 2;
            wname[eq - arg] = L'\0';
            name = to_utf8(wname);
            free(wname);
            value = to_utf8(eq + 1);
        } else if (wcsncmp(arg, L"no-", 3) == 0 && arg[3] != 0) {
            name = to_utf8(arg + 3);
            value = _strdup("no");
        } else {
            name = to_utf8(arg);
            value = _strdup("yes");
        }
        rc = (name && value) ? set_option(h, name, value) : -1;
        free(name);
        free(value);
        if (rc < 0)
            return 2;
    }
    return 0;
}

int wmain(int argc, wchar_t **argv)
{
    HMODULE lib;
    create_fn create;
    set_option_string_fn set_option;
    initialize_fn initialize;
    wait_event_fn wait_event;
    command_string_fn command;
    terminate_destroy_fn destroy;
    mpv_handle *h;
    HANDLE parent = NULL;
    DWORD parent_pid = 0;
    int code;

    become_dpi_aware();
    lib = load_libmpv();
    if (!lib)
        return 3;
    create = (create_fn)symbol(lib, "mpv_create");
    set_option = (set_option_string_fn)symbol(lib, "mpv_set_option_string");
    initialize = (initialize_fn)symbol(lib, "mpv_initialize");
    wait_event = (wait_event_fn)symbol(lib, "mpv_wait_event");
    command = (command_string_fn)symbol(lib, "mpv_command_string");
    destroy = (terminate_destroy_fn)symbol(lib, "mpv_terminate_destroy");
    if (!create || !set_option || !initialize || !wait_event || !command || !destroy)
        return 3;
    h = create();
    if (!h)
        return 3;

    /* Hardened defaults first; the caller's arguments may still override them. */
    set_option(h, "config", "no");
    set_option(h, "load-scripts", "no");
    set_option(h, "ytdl", "no");
    set_option(h, "load-unsafe-playlists", "no");
    set_option(h, "input-default-bindings", "yes");
    set_option(h, "input-vo-keyboard", "yes");
    set_option(h, "osc", "yes");
    code = apply_args(argc, argv, set_option, h, &parent_pid);
    if (code == 0 && parent_pid != 0 && !(parent = OpenProcess(SYNCHRONIZE, FALSE, parent_pid)))
        code = 5;
    if (code == 0 && initialize(h) < 0)
        code = 4;
    if (code != 0) {
        arm_watchdog(3000);
        destroy(h);
        return code;
    }

    for (;;) {
        mpv_event *ev = wait_event(h, 0.25);
        if (ev->event_id == MPV_EVENT_SHUTDOWN)
            break;
        if (parent && WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) {
            CloseHandle(parent);
            parent = NULL;
            arm_watchdog(3000);
            command(h, "quit");
        }
    }
    if (parent)
        CloseHandle(parent);
    arm_watchdog(3000);
    destroy(h);
    return 0;
}
