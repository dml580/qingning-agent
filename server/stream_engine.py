"""In-memory generation jobs: chunk buffer, cancel flag, resume by seq."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from llm import is_configured, stream_doubao


@dataclass
class StreamChunk:
    seq: int
    text: str


@dataclass
class GenerationJob:
    message_id: str
    session_id: str
    prompt: str
    history: List[Dict[str, str]] = field(default_factory=list)
    system_prompt: Optional[str] = None
    image_data_url: Optional[str] = None
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    chunks: List[StreamChunk] = field(default_factory=list)
    done: bool = False
    failed: bool = False
    error: Optional[str] = None
    waiters: List[asyncio.Event] = field(default_factory=list)

    def notify(self) -> None:
        for ev in self.waiters:
            ev.set()
        self.waiters.clear()

    def add_chunk(self, text: str) -> StreamChunk:
        seq = len(self.chunks)
        chunk = StreamChunk(seq=seq, text=text)
        self.chunks.append(chunk)
        self.notify()
        return chunk

    def chunks_from(self, from_seq: int) -> List[StreamChunk]:
        return [c for c in self.chunks if c.seq >= from_seq]

    async def wait_next(self, after_seq: int, timeout: float = 30.0) -> bool:
        if self.done or self.failed or self.cancel_event.is_set():
            return True
        if any(c.seq > after_seq for c in self.chunks):
            return True
        ev = asyncio.Event()
        self.waiters.append(ev)
        try:
            await asyncio.wait_for(ev.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            if ev in self.waiters:
                self.waiters.remove(ev)
            return False


_jobs: Dict[str, GenerationJob] = {}


def get_job(message_id: str) -> Optional[GenerationJob]:
    return _jobs.get(message_id)


def register_job(job: GenerationJob) -> None:
    _jobs[job.message_id] = job


def remove_job(message_id: str) -> None:
    _jobs.pop(message_id, None)


def cancel_job(message_id: str) -> bool:
    job = _jobs.get(message_id)
    if not job:
        return False
    job.cancel_event.set()
    job.notify()
    return True


_DEMO_PARAGRAPHS = [
    "（演示模式）未配置 ARK_API_KEY，当前输出为本地假流，用于验证状态机与虚拟列表。",
    "在 server/.env 写入火山方舟密钥后，将改为豆包真流式回答。",
    "连接建立后进入 generating，只有收到 done 才能落库为 completed。",
    "中途断开时内容可能半截，状态必须是 failed 或 cancelled，不能写成成功。",
    "每个 chunk 带单调递增 seq；前端用 lastSeq 去重，重连从 from_seq 续传。",
    "长回复拆成多段虚拟行，滚动时只挂视口附近的节点。",
]


def build_reply_tokens(prompt: str) -> List[str]:
    header = f"收到：「{prompt[:80]}」\n\n"
    body_parts: List[str] = []
    for i in range(24):
        p = _DEMO_PARAGRAPHS[i % len(_DEMO_PARAGRAPHS)]
        body_parts.append(f"[{i + 1}] {p}\n")
    full = header + "".join(body_parts)
    tokens: List[str] = []
    i = 0
    while i < len(full):
        step = 12 if (i // 12) % 3 else 8
        tokens.append(full[i : i + step])
        i += step
    return tokens


async def _emit(job: GenerationJob, text: str, persist_chunk) -> None:
    chunk = job.add_chunk(text)
    await persist_chunk(chunk.seq, chunk.text)


async def run_generation(job: GenerationJob, persist_chunk, settle) -> None:
    """
    Produce tokens from Doubao when configured, else demo corpus.
    Guarantees: never settle(completed) after cancel/fail.
    """
    try:
        if is_configured():
            async for text in stream_doubao(
                job.prompt,
                history=job.history,
                should_cancel=lambda: job.cancel_event.is_set(),
                system_prompt=job.system_prompt,
                image_data_url=job.image_data_url,
            ):
                if job.cancel_event.is_set():
                    job.done = True
                    job.notify()
                    await settle("cancelled")
                    return
                if not text:
                    continue
                await _emit(job, text, persist_chunk)
        else:
            for text in build_reply_tokens(job.prompt):
                if job.cancel_event.is_set():
                    job.done = True
                    job.notify()
                    await settle("cancelled")
                    return
                await _emit(job, text, persist_chunk)
                await asyncio.sleep(0.035)

        if job.cancel_event.is_set():
            job.done = True
            job.notify()
            await settle("cancelled")
            return

        job.done = True
        job.notify()
        await settle("completed")
    except Exception as exc:  # noqa: BLE001
        if job.cancel_event.is_set():
            job.done = True
            job.notify()
            await settle("cancelled")
            return
        job.failed = True
        job.error = str(exc)
        job.notify()
        await settle("failed", error=str(exc))
    finally:
        await asyncio.sleep(60)
        remove_job(job.message_id)
