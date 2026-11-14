/*
 * elv-mpv: a small host that loads the official LGPL libmpv-2.dll from its own folder (dynamically, so the
 * DLL stays replaceable), hands it the --name=value, --name and --no-name options, and runs until mpv shuts
 * down or the process named by --elv-parent-pid exits. Exit codes: 0 normal, 2 bad argument or rejected
 * option, 3 libmpv or a symbol missing, 4 mpv_initialize failed. It never prints its arguments.
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
            wchar_t *end;
            unsigned long pid = wcstoul(arg + 15, &end, 10);
            if (end == arg + 15 || *end != L'\0' || pid == 0)
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
    HMODULE lib = load_libmpv();
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

    set_option(h, "input-default-bindings", "yes");
    set_option(h, "input-vo-keyboard", "yes");
    set_option(h, "osc", "yes");
    code = apply_args(argc, argv, set_option, h, &parent_pid);
    if (code == 0 && initialize(h) < 0)
        code = 4;
    if (code != 0) {
        destroy(h);
        return code;
    }

    if (parent_pid != 0) {
        parent = OpenProcess(SYNCHRONIZE, FALSE, parent_pid);
        if (!parent)
            command(h, "quit");
    }
    for (;;) {
        mpv_event *ev = wait_event(h, 0.25);
        if (ev->event_id == MPV_EVENT_SHUTDOWN)
            break;
        if (parent && WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) {
            CloseHandle(parent);
            parent = NULL;
            command(h, "quit");
        }
    }
    if (parent)
        CloseHandle(parent);
    destroy(h);
    return 0;
}
