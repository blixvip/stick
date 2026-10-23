"""Bounded, cancellable admission for memory-heavy local codec requests."""
from collections import OrderedDict, deque
from contextlib import contextmanager
from contextvars import ContextVar
import re
import threading
import time
import uuid

from work_control import cancellation

_current = ContextVar("codec_job", default=None)
_IDENTITY = re.compile(r"^[a-f0-9]{32}$")


class JobError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


class JobCancelled(JobError):
    def __init__(self):
        super().__init__(499, "cancelled", "The file operation was cancelled.")


def identity(value):
    if not isinstance(value, str) or not _IDENTITY.fullmatch(value):
        raise JobError(400, "invalid_job", "Invalid file operation identity.")
    return value


class Job:
    def __init__(self, owner, key, abort_transport):
        self.owner, self.key, self.abort_transport = owner, key, abort_transport
        self.cancelled = threading.Event()

    def check(self):
        if self.cancelled.is_set():
            raise JobCancelled()

    def cancel(self):
        self.cancelled.set()
        if self.abort_transport is not None:
            try:
                self.abort_transport()
            except OSError:
                pass  # The disconnected client may already have closed it.


@contextmanager
def publication():
    """Order cache publication against cancellation; no partially published data."""
    job = _current.get()
    if job is None:
        yield
    else:
        with job.owner.condition:
            job.check()
            yield


class JobRegistry:
    def __init__(self, capacity=16, recent_capacity=256, recent_seconds=120):
        self.capacity, self.recent_capacity, self.recent_seconds = capacity, recent_capacity, recent_seconds
        self.condition = threading.Condition()
        self.jobs, self.recent = {}, OrderedDict()
        self.queue = deque()
        self.active = None
        self.closed = False

    def _prune(self):
        now = time.monotonic()
        while self.recent and next(iter(self.recent.values())) <= now:
            self.recent.popitem(last=False)

    def cancel(self, key):
        identity(key)
        with self.condition:
            self._prune()
            job = self.jobs.get(key)
            if job is not None:
                job.cancel()
            # Cancellation may overtake headers on another HTTP connection.
            self.recent[key] = time.monotonic() + self.recent_seconds
            self.recent.move_to_end(key)
            while len(self.recent) > self.recent_capacity:
                self.recent.popitem(last=False)
            self.condition.notify_all()
            return job is not None

    @contextmanager
    def enter(self, key=None, *, abort_transport=None):
        key = uuid.uuid4().hex if key is None else identity(key)
        job = Job(self, key, abort_transport)
        with self.condition:
            self._prune()
            if self.closed:
                raise JobError(503, "backend_unavailable", "The file conversion service is closing.")
            if key in self.recent:
                raise JobCancelled()
            if key in self.jobs:
                raise JobError(409, "duplicate_job", "This file operation is already pending.")
            if len(self.jobs) >= self.capacity:
                raise JobError(503, "backend_busy", "Too many file operations are pending. Try again shortly.")
            self.jobs[key] = job
            self.queue.append(job)
        try:
            with self.condition:
                while self.active is not None or self.queue[0] is not job:
                    job.check()
                    self.condition.wait()
                job.check()
                self.queue.popleft()
                self.active = job
            token = _current.set(job)
            try:
                with cancellation(job.check):
                    yield job
            finally:
                _current.reset(token)
        finally:
            with self.condition:
                if self.active is job:
                    self.active = None
                if job in self.queue:
                    self.queue.remove(job)
                self.jobs.pop(key, None)
                self.condition.notify_all()

    def snapshot(self):
        with self.condition:
            self._prune()
            return {"active": int(self.active is not None), "queued": len(self.queue),
                    "capacity": self.capacity, "recentCancellations": len(self.recent)}

    def close(self):
        with self.condition:
            self.closed = True
            for job in self.jobs.values():
                job.cancel()
            self.condition.notify_all()
