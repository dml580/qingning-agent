"""Run the real API against disposable data, without model/calendar credentials."""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'server'))

import main
import db
import llm
import uvicorn

with tempfile.TemporaryDirectory(prefix='qingning-e2e-') as directory:
    db.DB_PATH = Path(directory) / 'agent.db'
    llm.RUNTIME_PATH = Path(directory) / 'llm.json'
    os.environ['ARK_API_KEY'] = ''
    os.environ['CALENDAR_SYNC_PROVIDER'] = 'feishu'
    os.environ['FEISHU_CALENDAR_ACCESS_TOKEN'] = ''
    os.environ['FEISHU_CALENDAR_ID'] = ''
    uvicorn.run(main.app, host='127.0.0.1', port=18000)
