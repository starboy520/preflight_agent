from fastapi import APIRouter

from app.schemas.preflight import PreflightRequest, PreflightResponse
from app.services.preflight_service import preflight_service


router = APIRouter(prefix="/api/v1/platform/runtime/agent-runs", tags=["preflight"])


@router.post("/preflight", response_model=PreflightResponse)
def run_preflight(request: PreflightRequest) -> PreflightResponse:
    return preflight_service.run(request)
