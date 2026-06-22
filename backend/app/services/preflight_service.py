from app.domain.preflight_engine import run_preflight
from app.schemas.preflight import PreflightRequest, PreflightResponse


class PreflightService:
    def run(self, request: PreflightRequest) -> PreflightResponse:
        return run_preflight(request)


preflight_service = PreflightService()
