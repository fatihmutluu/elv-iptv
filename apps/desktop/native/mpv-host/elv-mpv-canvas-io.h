/*
 * Wire parser, overlapped named-pipe framing, and parent NT handle tracker for elv-mpv canvas mode.
 */
#ifndef ELV_MPV_CANVAS_IO_H_
#define ELV_MPV_CANVAS_IO_H_

#include <errno.h>
#include <stdlib.h>

#define CANVAS_MAX_PENDING 64

typedef struct PendingDup {
    unsigned int gen;
    unsigned int slot;
    HANDLE dup;
} PendingDup;

typedef struct PendingDupTable {
    PendingDup items[CANVAS_MAX_PENDING];
    int count;
} PendingDupTable;

static void canvas_close(HANDLE *h)
{
    if (*h) {
        CloseHandle(*h);
        *h = NULL;
    }
}

static void canvas_join(HANDLE *t, DWORD timeout_ms, int *ok)
{
    if (*t) {
        if (WaitForSingleObject(*t, timeout_ms) != WAIT_OBJECT_0)
            *ok = 0;
        CloseHandle(*t);
        *t = NULL;
    }
}

static int canvas_clamp_u32(unsigned int v, unsigned int lo, unsigned int hi)
{
    if (v < lo) return (int)lo;
    if (v > hi) return (int)hi;
    return (int)v;
}

static int canvas_parse_u32(const char *s, unsigned int *out, const char **next)
{
    unsigned long val;
    char *end = NULL;
    if (!s || *s < '0' || *s > '9')
        return 0;
    errno = 0;
    val = strtoul(s, &end, 10);
    if (errno != 0 || end == s)
        return 0;
    *out = (unsigned int)val;
    *next = end;
    return 1;
}

static int canvas_parse_u32_pair(const char *s, unsigned int *a, unsigned int *b)
{
    const char *p = NULL;
    if (!canvas_parse_u32(s, a, &p) || *p != ' ')
        return 0;
    if (!canvas_parse_u32(p + 1, b, &p) || *p != '\0')
        return 0;
    return 1;
}

static void canvas_close_parent_handle(HANDLE parent, HANDLE dup)
{
    if (parent && dup)
        DuplicateHandle(parent, dup, NULL, NULL, 0, FALSE, DUPLICATE_CLOSE_SOURCE);
}

static int pending_dup_add(PendingDupTable *t, unsigned int gen, unsigned int slot, HANDLE dup)
{
    if (!dup || t->count >= CANVAS_MAX_PENDING)
        return 0;
    t->items[t->count].gen = gen;
    t->items[t->count].slot = slot;
    t->items[t->count].dup = dup;
    t->count++;
    return 1;
}

static HANDLE pending_dup_take(PendingDupTable *t, unsigned int gen, unsigned int slot)
{
    int i;
    for (i = 0; i < t->count; i++) {
        if (t->items[i].gen == gen && t->items[i].slot == slot) {
            HANDLE dup = t->items[i].dup;
            t->count--;
            if (i < t->count)
                t->items[i] = t->items[t->count];
            return dup;
        }
    }
    return NULL;
}

static void pending_dup_close_all(PendingDupTable *t, HANDLE parent)
{
    int i;
    for (i = 0; i < t->count; i++)
        canvas_close_parent_handle(parent, t->items[i].dup);
    t->count = 0;
}

/* Returns 1 on bytes > 0, 0 if cancelled by stop_ev or timeout, -1 on pipe EOF/error. */
static int canvas_wait_io(
    HANDLE pipe, HANDLE stop_ev, HANDLE io_ev, OVERLAPPED *ov,
    BOOL started, DWORD timeout_ms, DWORD *bytes)
{
    if (!started) {
        HANDLE waits[2] = { stop_ev, io_ev };
        if (GetLastError() != ERROR_IO_PENDING)
            return -1;
        if (WaitForMultipleObjects(2, waits, FALSE, timeout_ms) != WAIT_OBJECT_0 + 1) {
            CancelIoEx(pipe, ov);
            GetOverlappedResult(pipe, ov, bytes, TRUE);
            return 0;
        }
    }
    return (GetOverlappedResult(pipe, ov, bytes, FALSE) && *bytes > 0) ? 1 : -1;
}

/* Returns 1 on full write, 0 on stop/timeout, -1 on pipe error. */
static int canvas_write_buf(
    HANDLE pipe, CRITICAL_SECTION *write_cs, HANDLE stop_ev, HANDLE write_ev,
    const char *buf, size_t len, DWORD timeout_ms)
{
    size_t off = 0;
    int status = 1;
    if (WaitForSingleObject(stop_ev, 0) == WAIT_OBJECT_0)
        return 0;
    EnterCriticalSection(write_cs);
    while (off < len && status > 0) {
        OVERLAPPED ov = { 0 };
        DWORD written = 0;
        ov.hEvent = write_ev;
        ResetEvent(write_ev);
        status = canvas_wait_io(
            pipe, stop_ev, write_ev, &ov,
            WriteFile(pipe, buf + off, (DWORD)(len - off), NULL, &ov), timeout_ms, &written);
        if (status > 0)
            off += (size_t)written;
    }
    LeaveCriticalSection(write_cs);
    return status;
}

/* Reads \n-delimited lines until stop_ev (returns 0) or pipe EOF/error (returns -1). */
static int canvas_read_lines(
    HANDLE pipe, HANDLE stop_ev, HANDLE read_ev, void (*on_line)(void *, const char *), void *ctx)
{
    char chunk[512], line[256];
    size_t line_len = 0;
    int overflow = 0;

    for (;;) {
        OVERLAPPED ov = { 0 };
        DWORD got = 0, i;
        int res;
        if (WaitForSingleObject(stop_ev, 0) == WAIT_OBJECT_0)
            return 0;
        ov.hEvent = read_ev;
        ResetEvent(read_ev);
        res = canvas_wait_io(
            pipe, stop_ev, read_ev, &ov,
            ReadFile(pipe, chunk, (DWORD)sizeof(chunk), NULL, &ov), INFINITE, &got);
        if (res <= 0)
            return res;
        for (i = 0; i < got; i++) {
            char ch = chunk[i];
            if (ch == '\n') {
                if (!overflow) {
                    if (line_len > 0 && line[line_len - 1] == '\r')
                        line_len--;
                    line[line_len] = '\0';
                    on_line(ctx, line);
                }
                line_len = 0;
                overflow = 0;
            } else if (!overflow) {
                if (line_len + 1 < sizeof(line))
                    line[line_len++] = ch;
                else
                    overflow = 1;
            }
        }
    }
}

static HANDLE canvas_connect_pipe(const wchar_t *path, DWORD timeout_ms)
{
    ULONGLONG deadline = GetTickCount64() + timeout_ms;
    for (;;) {
        HANDLE p = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                               OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
        DWORD err;
        ULONGLONG now;
        if (p != INVALID_HANDLE_VALUE)
            return p;
        err = GetLastError();
        now = GetTickCount64();
        if ((err != ERROR_PIPE_BUSY && err != ERROR_FILE_NOT_FOUND) || now >= deadline)
            return INVALID_HANDLE_VALUE;
        if (err == ERROR_PIPE_BUSY)
            WaitNamedPipeW(path, (deadline - now) > 200 ? 200 : (DWORD)(deadline - now));
        else
            Sleep(25);
    }
}

#endif
