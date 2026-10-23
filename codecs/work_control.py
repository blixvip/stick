"""Optional cooperative cancellation, scoped to one caller/thread/task.

The ordinary codec has no scheduler or transport dependency. Desktop service
requests install a check; offline callers keep the existing synchronous API.
Native/stdlib calls finish before the next safe checkpoint.
"""
from contextlib import contextmanager
from contextvars import ContextVar

_check = ContextVar("codec_cancellation", default=None)


def checkpoint():
    check = _check.get()
    if check is not None:
        check()


@contextmanager
def cancellation(check):
    token = _check.set(check)
    try:
        checkpoint()
        yield
    finally:
        _check.reset(token)
