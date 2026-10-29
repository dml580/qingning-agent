"""Portfolio demo backend: real app/data flow with deterministic OCR for one redacted fixture."""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'server'))

import db
import llm
import main
import uvicorn


async def demo_review(*_args, **_kwargs):
    return {"ok": True, "related": True, "reason": "已识别为脱敏租赁合同，可以分析。"}


async def demo_ocr(*_args, **_kwargs):
    return {
        "ok": True,
        "doc_type": "generic_document",
        "title": "脱敏房屋租赁合同",
        "summary": "月租 6500 元，押金 13000 元，租期届满后 7 个工作日内退还押金。",
        "confidence": "high",
        "key_points": ["月租 6500 元", "押金 13000 元", "提前退租需提前 30 日通知", "押金 7 个工作日内退还"],
        "raw_excerpt": "租赁期满且无违约、房屋无损坏，出租方应于 7 个工作日内无息退还押金。",
    }


with tempfile.TemporaryDirectory(prefix='qingning-demo-') as directory:
    db.DB_PATH = Path(directory) / 'agent.db'
    llm.RUNTIME_PATH = Path(directory) / 'llm.json'
    os.environ['ARK_API_KEY'] = ''
    os.environ['CALENDAR_SYNC_PROVIDER'] = 'feishu'
    os.environ['FEISHU_CALENDAR_ACCESS_TOKEN'] = ''
    os.environ['FEISHU_CALENDAR_ID'] = ''
    main.review_document_image = demo_review
    main.extract_document_image_ocr = demo_ocr
    uvicorn.run(main.app, host='127.0.0.1', port=18000)
