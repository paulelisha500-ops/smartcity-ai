from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Optional
from datetime import datetime


class ComplaintIn(BaseModel):
    # max_length bounds storage, NLP cost and the size of the WebSocket event
    # every open dashboard receives; 2,000 chars is several paragraphs.
    text: str = Field(..., min_length=5, max_length=2000, description="Free-text citizen complaint")
    reporter_id: Optional[str] = Field(None, max_length=100)
    photo_ref: Optional[str] = Field(None, max_length=500)
    lat: Optional[float] = Field(None, ge=-90, le=90)
    lon: Optional[float] = Field(None, ge=-180, le=180)

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, v: str) -> str:
        # min_length counts whitespace, so "     " would pass it.
        v = v.strip()
        if len(v) < 5:
            raise ValueError("text must contain at least 5 non-space characters")
        return v

    @model_validator(mode="after")
    def _coords_together(self):
        if (self.lat is None) != (self.lon is None):
            raise ValueError("lat and lon must be provided together")
        return self


class ComplaintOut(BaseModel):
    id: int
    ts: datetime
    text: str
    category: Optional[str]
    sentiment: Optional[str]
    sentiment_score: Optional[float]
    priority: Optional[str]
    priority_score: Optional[float]
    department: Optional[str]
    status: str
    raw_location_text: Optional[str]
    lat: Optional[float] = None
    lon: Optional[float] = None

    class Config:
        from_attributes = True


class ComplaintAnalysis(BaseModel):
    """What ComplaintNLPService.analyze() returns, before persistence."""
    category: str
    sentiment: str
    sentiment_score: float
    priority: str
    priority_score: float
    department: str
    location_text: Optional[str]
    lat: Optional[float]
    lon: Optional[float]
