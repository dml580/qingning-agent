import chromadb
from typing import List, Dict, Any, Optional
from pathlib import Path

# 使用 chromadb 默认的轻量级 Embedding 或 sentence-transformers。
# 这里改为懒加载，避免服务启动时因为外网下载模型而卡住。
try:
    from sentence_transformers import SentenceTransformer
except Exception:
    SentenceTransformer = None

_EMBEDDING_MODEL = None
_EMBEDDING_ATTEMPTED = False


def _get_embedding_model():
    global _EMBEDDING_MODEL, _EMBEDDING_ATTEMPTED
    if _EMBEDDING_ATTEMPTED:
        return _EMBEDDING_MODEL
    _EMBEDDING_ATTEMPTED = True
    if SentenceTransformer is None:
        return None
    try:
        _EMBEDDING_MODEL = SentenceTransformer(
            "all-MiniLM-L6-v2",
            local_files_only=True,
        )
    except Exception:
        _EMBEDDING_MODEL = None
    return _EMBEDDING_MODEL

DATA_DIR = Path(__file__).parent / "data" / "vector_db"
DATA_DIR.mkdir(parents=True, exist_ok=True)

class VectorStore:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(VectorStore, cls).__new__(cls)
            cls._instance._init_db()
        return cls._instance

    def _init_db(self):
        self.client = chromadb.PersistentClient(path=str(DATA_DIR))
        # 默认集合
        self.collection = self.client.get_or_create_collection(
            name="lime_agent_docs",
            metadata={"hnsw:space": "cosine"}
        )

    def add_document(self, doc_id: str, text: str, metadata: Dict[str, Any]):
        """将长文切块并存入向量库"""
        from rag import chunk_text
        chunks = chunk_text(text, size=400, overlap=50)

        ids = [f"{doc_id}_chunk_{i}" for i in range(len(chunks))]
        metadatas = [metadata for _ in chunks]

        model = _get_embedding_model()
        if model is not None:
            embeddings = model.encode(chunks).tolist()
            self.collection.add(
                documents=chunks,
                embeddings=embeddings,
                metadatas=metadatas,
                ids=ids
            )
        else:
            self.collection.add(
                documents=chunks,
                metadatas=metadatas,
                ids=ids
            )

    def query(self, query_text: str, top_k: int = 4, filter_metadata: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        """向量搜索"""
        kwargs = {
            "query_texts": [query_text],
            "n_results": top_k,
        }
        model = _get_embedding_model()
        if model is not None:
            kwargs["query_embeddings"] = [model.encode([query_text])[0].tolist()]
            del kwargs["query_texts"]

        if filter_metadata:
            kwargs["where"] = filter_metadata

        results = self.collection.query(**kwargs)

        output = []
        if not results or not results['documents']:
            return output

        # 转换格式
        docs = results['documents'][0]
        metas = results['metadatas'][0]
        distances = results['distances'][0] if 'distances' in results else [0.0] * len(docs)

        for i in range(len(docs)):
            output.append({
                "text": docs[i],
                "metadata": metas[i],
                "score": 1.0 - distances[i] # 粗略转为相似度
            })
        return output

    def clear_collection(self):
        self.client.delete_collection("lime_agent_docs")
        self._init_db()

vector_store = VectorStore()
