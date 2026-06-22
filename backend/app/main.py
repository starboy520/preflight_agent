from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.preflight import router as preflight_router


app = FastAPI(title="Agent Run Preflight Workbench")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(preflight_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
